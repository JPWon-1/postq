//! `/api/secrets/rekey`.
//!
//! 옛 키로만 읽히는 secret 을 현재 키로 옮긴다. 키를 바꾸면 그 전에 저장한 값은 못 읽고, 이 앱은 못 읽는 값을
//! 빈 값으로 흘려보내므로 증상이 없다 — 요청만 조용히 자격증명 없이 나가 401 을 받는다.
//! SECRET_ENCRYPTION_KEY_OLD 로 읽기는 되살렸지만 임시방편이다. 여기서 한 번에 옮기고 나면 옛 키를 지울 수 있다.
//!
//! GET  — 무엇이 몇 개인지만 센다(아무것도 안 바꾼다). 누르기 전에 보여줄 값.
//! POST — 실제로 옮긴다.
//! 평문은 이 프로세스 밖으로 나가지 않는다. 응답에도 개수만 담는다.

use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use rusqlite::Connection;
use serde_json::{json, Map, Value};

use crate::jsval::Js;
use crate::routes::input::json_error;
use crate::secretbox::{self, KeyState, Keys};
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/secrets/rekey", get(status).post(rekey))
}

/// secret 변수(variables.secret = 1)를 키 상태별로 센다. 키 순서는 Node 의 Counts 리터럴 그대로.
fn survey(c: &Connection, keys: &Keys) -> anyhow::Result<Map<String, Value>> {
    let (mut current, mut old, mut broken, mut plain) = (0, 0, 0, 0);
    let mut st = c.prepare_cached(r#"SELECT "value" FROM "variables" WHERE "variables"."secret" = 1"#)?;
    let mut rs = st.query([])?;
    while let Some(r) = rs.next()? {
        match secretbox::key_state_with(keys, &crate::rows::text(r, 0)?) {
            KeyState::Current => current += 1,
            KeyState::Old => old += 1,
            KeyState::Broken => broken += 1,
            KeyState::Plain => plain += 1,
        }
    }
    let mut m = Map::new();
    m.insert("current".into(), json!(current));
    m.insert("old".into(), json!(old));
    m.insert("broken".into(), json!(broken));
    m.insert("plain".into(), json!(plain));
    Ok(m)
}

async fn status(State(s): State<AppState>) -> Response {
    match s.db.run(|c| survey(c, &Keys::from_env())).await {
        Ok(m) => Js(Value::Object(m)).into_response(),
        Err(e) => json_error("secret 키 상태 조회 중 서버 오류", &e.to_string()),
    }
}

/// 옮기고 나서 지금 상태까지. 한 건이라도 실패하면 전부 되돌린다 — 반쯤 옮긴 상태가 제일 나쁘다.
fn rekey_all(c: &Connection, keys: &Keys) -> anyhow::Result<Map<String, Value>> {
    let rows: Vec<(String, String)> = {
        let mut st = c.prepare_cached(r#"SELECT "id", "value" FROM "variables" WHERE "variables"."secret" = 1"#)?;
        let v = st.query_map([], |r| Ok((crate::rows::text(r, 0)?, crate::rows::text(r, 1)?)))?.collect::<Result<_, _>>()?;
        v
    };
    let tx = c.unchecked_transaction()?;
    let mut moved = 0;
    for (id, value) in rows {
        let Some(next) = secretbox::rewrap_with(keys, &value) else { continue };
        tx.prepare_cached(r#"UPDATE "variables" SET "value" = ?1 WHERE "variables"."id" = ?2"#)?.execute([&next, &id])?;
        moved += 1;
    }
    tx.commit()?;
    // 옮긴 뒤의 실제 상태를 다시 읽어 돌려준다 — '몇 개 옮겼다' 보다 '지금 어떤가' 가 사용자가 알아야 할 것이다.
    let mut out = Map::new();
    out.insert("moved".into(), json!(moved));
    out.extend(survey(c, keys)?);
    Ok(out)
}

async fn rekey(State(s): State<AppState>) -> Response {
    match s.db.run(|c| rekey_all(c, &Keys::from_env())).await {
        Ok(m) => Js(Value::Object(m)).into_response(),
        Err(e) => json_error("secret 키 옮기기 중 서버 오류", &e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::variables::tests::test_db;

    #[test]
    fn 옛_키_값만_현재_키로_옮기고_상태를_다시_센다() {
        let db = test_db();
        let old = Keys::new(Some("old-key"), &[]);
        let keys = Keys::new(Some("new-key"), &["old-key"]);
        let other = Keys::new(Some("lost-key"), &[]);
        db.with(|c| {
            let put = |id: &str, v: &str, secret: bool| {
                c.execute("INSERT INTO variables (id, environment_id, key, value, secret) VALUES (?1, 'e', ?1, ?2, ?3)", rusqlite::params![id, v, secret]).unwrap();
            };
            put("a", &secretbox::encrypt_with(&old, "A"), true);
            put("b", &secretbox::encrypt_with(&keys, "B"), true);
            put("c", &secretbox::encrypt_with(&other, "C"), true);
            put("d", "plain", true);
            put("e", &secretbox::encrypt_with(&old, "E"), false); // secret 이 아닌 행은 안 센다
            assert_eq!(Value::Object(survey(c, &keys)?), json!({ "current": 1, "old": 1, "broken": 1, "plain": 1 }));
            let out = rekey_all(c, &keys)?;
            assert_eq!(Value::Object(out), json!({ "moved": 1, "current": 2, "old": 0, "broken": 1, "plain": 1 }));
            let a: String = c.query_row("SELECT value FROM variables WHERE id = 'a'", [], |r| r.get(0))?;
            assert_eq!(secretbox::decrypt_with(&Keys::new(Some("new-key"), &[]), &a), "A");
            Ok(())
        })
        .unwrap();
    }
}
