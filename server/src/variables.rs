//! 변수 맵과 스코프.
//!
//! VarMap 은 Node 에서 평범한 JS 객체(Record)였다. 그 객체의 성질까지 옮긴다 — 응답의 순서가 거기서 나온다.
//! - 키 순서: 넣은 순서. 단, 정수 모양 키("0","12")는 JS 가 숫자 오름차순으로 맨 앞에 둔다.
//! - 같은 키를 다시 넣으면 값만 바뀌고 자리는 처음 그대로.
//! - "__proto__" 는 대입해도 자기 키가 되지 않는다(프로토타입이 바뀐다). 그래서 목록·병합에서는 안 보이지만
//!   `map[key]` 로 찾으면 보인다. Node 의 이 동작(버그에 가깝다)을 그대로 따른다.

use std::collections::HashMap;

use anyhow::Result;
use rusqlite::Connection;

use crate::js::is_index_key;
use crate::secretbox;

/// 모든 프로젝트가 함께 쓰는 '전역' 변수의 스코프. 프로젝트 id 는 uuid·'default' 라 '*' 와 겹치지 않는다.
pub const ALL_PROJECTS: &str = "*";

pub fn global_scope_id(workspace_id: &str) -> String {
    format!("global:{workspace_id}")
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Var {
    pub value: String,
    pub secret: bool,
}

#[derive(Clone, Debug, Default)]
pub struct VarMap {
    order: Vec<String>,
    map: HashMap<String, Var>,
    proto: Option<Var>,
}

impl VarMap {
    pub fn new() -> Self {
        Self::default()
    }

    /// `map[key] = v`
    pub fn insert(&mut self, key: &str, v: Var) {
        if key == "__proto__" {
            self.proto = Some(v);
            return;
        }
        if self.map.insert(key.to_string(), v).is_none() {
            self.order.push(key.to_string());
        }
    }

    /// `map[key]` — 자기 키만 본다. "__proto__" 는 위 주석대로 예외.
    pub fn get(&self, key: &str) -> Option<&Var> {
        if key == "__proto__" {
            return self.proto.as_ref();
        }
        self.map.get(key)
    }

    /// Object.entries 순서.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &Var)> {
        let mut idx: Vec<&String> = self.order.iter().filter(|k| is_index_key(k)).collect();
        idx.sort_by_key(|k| k.parse::<u64>().unwrap_or(0));
        let rest = self.order.iter().filter(|k| !is_index_key(k));
        idx.into_iter().chain(rest).map(|k| (k.as_str(), &self.map[k]))
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    /// `{ ...self, ...other }` — 자기 키만 복사한다(__proto__ 는 따라오지 않는다).
    pub fn spread(&mut self, other: &VarMap) {
        for (k, v) in other.iter() {
            self.insert(k, v.clone());
        }
    }
}

/// 한 스코프(환경 id 또는 global:<ws>)의 변수. secret 은 at-rest 암호문일 수 있어 복호화한다(레거시 평문은 그대로).
pub fn load_var_map(c: &Connection, environment_id: &str) -> Result<VarMap> {
    load_var_map_with(c, environment_id, &secretbox::Keys::from_env())
}

pub fn load_var_map_with(c: &Connection, environment_id: &str, keys: &secretbox::Keys) -> Result<VarMap> {
    // ORDER BY 가 없다 — drizzle 의 같은 질의와 같은 순서(rowid)로 나와야 응답 순서가 같다.
    let mut st = c.prepare_cached(r#"SELECT "key", "value", "secret" FROM "variables" WHERE "environment_id" = ?1"#)?;
    let mut rows = st.query([environment_id])?;
    let mut map = VarMap::new();
    while let Some(r) = rows.next()? {
        let key: String = crate::rows::text(r, 0)?;
        let value: String = crate::rows::text(r, 1)?;
        let secret = crate::rows::boolean(r, 2)?.unwrap_or(false);
        let value = if secret { secretbox::decrypt_with(keys, &value) } else { value };
        map.insert(&key, Var { value, secret });
    }
    Ok(map)
}

/// 실행용 변수 = 전역(모든 프로젝트) < 프로젝트 공통 < 환경. 같은 키는 뒤가 이긴다.
pub fn load_team_vars(c: &Connection, workspace_id: &str, environment_id: Option<&str>) -> Result<VarMap> {
    let keys = secretbox::Keys::from_env();
    let mut out = VarMap::new();
    out.spread(&load_var_map_with(c, &global_scope_id(ALL_PROJECTS), &keys)?);
    if workspace_id != ALL_PROJECTS {
        out.spread(&load_var_map_with(c, &global_scope_id(workspace_id), &keys)?);
    }
    // 빈 문자열 environmentId 는 JS 에서 거짓 — 환경 없음과 같다.
    if let Some(env) = environment_id.filter(|e| !e.is_empty()) {
        out.spread(&load_var_map_with(c, env, &keys)?);
    }
    Ok(out)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn test_db() -> crate::Db {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../drizzle");
        crate::Db::open(":memory:", &dir).unwrap()
    }

    fn put(c: &Connection, env: &str, key: &str, value: &str, secret: bool) {
        c.execute(
            "INSERT INTO variables (id, environment_id, key, value, secret) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![uuid::Uuid::new_v4().to_string(), env, key, value, secret],
        )
        .unwrap();
    }

    #[test]
    fn 키_순서는_js_객체와_같다() {
        let mut m = VarMap::new();
        for k in ["b", "10", "a", "2", "b", "01"] {
            m.insert(k, Var { value: k.into(), secret: false });
        }
        assert_eq!(m.iter().map(|(k, _)| k).collect::<Vec<_>>(), ["2", "10", "b", "a", "01"]);
    }

    #[test]
    fn proto_는_목록에_안_보이지만_찾으면_보인다() {
        let mut m = VarMap::new();
        m.insert("__proto__", Var { value: "x".into(), secret: true });
        assert_eq!(m.iter().count(), 0);
        assert_eq!(m.get("__proto__").map(|v| v.value.as_str()), Some("x"));
        let mut spread = VarMap::new();
        spread.spread(&m);
        assert!(spread.get("__proto__").is_none());
    }

    #[test]
    fn secret_은_복호화해서_싣는다() {
        let db = test_db();
        let keys = secretbox::Keys::new(Some("k"), &[]);
        let enc = secretbox::encrypt_with(&keys, "평문");
        db.with(|c| {
            put(c, "e1", "token", &enc, true);
            put(c, "e1", "legacy", "옛평문", true);
            put(c, "e1", "host", "h", false);
            let m = load_var_map_with(c, "e1", &keys)?;
            assert_eq!(m.get("token").unwrap(), &Var { value: "평문".into(), secret: true });
            assert_eq!(m.get("legacy").unwrap().value, "옛평문");
            assert_eq!(m.get("host").unwrap(), &Var { value: "h".into(), secret: false });
            Ok(())
        })
        .unwrap();
    }

    // globalVars.test.ts 의 병합 규칙을 옮긴 것.
    #[test]
    fn 전역_프로젝트_환경_순으로_뒤가_이긴다() {
        let db = test_db();
        db.with(|c| {
            put(c, "global:*", "gvAllOnly", "all", false);
            put(c, "global:*", "gvLayered", "all", false);
            put(c, "global:gv-ws3", "gvLayered", "project", false);
            put(c, "env3", "gvEnvWins", "env", false);
            put(c, "env3", "gvLayered", "env", false);
            let m = load_team_vars(c, "gv-ws3", Some("env3"))?;
            assert_eq!(m.get("gvAllOnly").unwrap().value, "all");
            assert_eq!(m.get("gvLayered").unwrap().value, "env");
            assert_eq!(m.get("gvEnvWins").unwrap().value, "env");
            let m = load_team_vars(c, "gv-ws3", None)?;
            assert_eq!(m.get("gvLayered").unwrap().value, "project");
            // 다른 프로젝트에서도 전역은 보이고, gv-ws3 의 프로젝트 공통은 안 보인다
            let other = load_team_vars(c, "gv-ws-other", None)?;
            assert_eq!(other.get("gvAllOnly").unwrap().value, "all");
            assert_eq!(other.get("gvLayered").unwrap().value, "all");
            // 순서: 전역에서 먼저 나온 키가 앞(덮여도 자리는 그대로)
            assert_eq!(load_team_vars(c, "gv-ws3", Some("env3"))?.iter().map(|(k, _)| k).collect::<Vec<_>>(), ["gvAllOnly", "gvLayered", "gvEnvWins"]);
            Ok(())
        })
        .unwrap();
    }
}
