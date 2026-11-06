//! DB 행 → JSON — drizzle(better-sqlite3)가 돌려주던 모양 그대로.
//!
//! 화면과 E2E 는 Node 가 내려주던 JSON 에 기대고 있다. drizzle 의 규칙:
//! - 열 이름은 schema.ts 의 camelCase 필드명(DB 는 snake_case). 열 순서도 schema.ts 에 적힌 순서다.
//! - `integer(.., { mode: 'boolean' })` 은 `Number(v) === 1` — 1 만 true, 2 는 false. NULL 은 null.
//! - 그냥 `integer` 와 시각(ms)은 숫자 그대로. 이 스키마에는 `mode: 'json'`·`mode: 'timestamp'` 열이 없다 —
//!   JSON 을 담은 text 열은 문자열로 내려가고, 라우트가 필요할 때 직접 JSON.parse 한다([`json_text`]).
//! - text 열은 문자열. SQLite 는 열 형식을 강제하지 않으므로, 값의 실제 저장형을 따른다
//!   (better-sqlite3 가 그렇다 — text 열에 정수가 들어 있으면 숫자로 나온다).

use rusqlite::types::ValueRef;
use rusqlite::Row;
use serde_json::{Map, Value};

use crate::js;

/// 열의 읽는 방식.
#[derive(Clone, Copy, Debug)]
pub enum Col {
    /// text·integer·real — 저장된 형식 그대로
    Plain,
    /// integer({ mode: 'boolean' })
    Bool,
}

/// Number.MAX_SAFE_INTEGER.
const MAX_SAFE: u64 = (1 << 53) - 1;

/// SQLite 값 → JSON (better-sqlite3 와 같은 형식). blob 은 Node 의 Buffer JSON 모양.
pub fn raw(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        // better-sqlite3 는 기본이 number 모드라 2^53 을 넘는 정수는 가장 가까운 double 로 반올림돼 나간다
        // (SELECT 9007199254740993 → 9007199254740992). 그대로 내보내면 Node 와 다른 숫자가 된다(codex 리뷰).
        ValueRef::Integer(i) if i.unsigned_abs() > MAX_SAFE => serde_json::Number::from_f64(i as f64).map(Value::Number).unwrap_or(Value::Null),
        ValueRef::Integer(i) => Value::from(i),
        ValueRef::Real(f) => serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => serde_json::json!({ "type": "Buffer", "data": b }),
    }
}

/// drizzle 의 boolean 열 — `Number(value) === 1`.
fn bool_of(v: ValueRef<'_>) -> Option<bool> {
    Some(match v {
        ValueRef::Null => return None,
        ValueRef::Integer(i) => i == 1,
        ValueRef::Real(f) => f == 1.0,
        ValueRef::Text(t) => js::number(&String::from_utf8_lossy(t)) == 1.0,
        ValueRef::Blob(_) => false,
    })
}

/// (JSON 필드명, 열 번호, 읽는 방식) 목록대로 한 행을 객체로. 필드 순서는 목록 순서.
pub fn object(row: &Row<'_>, cols: &[(&str, usize, Col)]) -> rusqlite::Result<Map<String, Value>> {
    let mut m = Map::with_capacity(cols.len());
    for &(name, idx, kind) in cols {
        let v = row.get_ref(idx)?;
        let j = match kind {
            Col::Plain => raw(v),
            Col::Bool => bool_of(v).map_or(Value::Null, Value::Bool),
        };
        m.insert(name.to_string(), j);
    }
    Ok(m)
}

/// 문자열로 읽는다 — 코드가 문자열로 다루는 열(키·값 등)용. NULL 은 빈 문자열.
pub fn text(row: &Row<'_>, idx: usize) -> rusqlite::Result<String> {
    Ok(match row.get_ref(idx)? {
        ValueRef::Null => String::new(),
        ValueRef::Integer(i) => i.to_string(),
        ValueRef::Real(f) => js::number_to_string(f),
        ValueRef::Text(t) | ValueRef::Blob(t) => String::from_utf8_lossy(t).into_owned(),
    })
}

/// boolean 열. NULL 은 None.
pub fn boolean(row: &Row<'_>, idx: usize) -> rusqlite::Result<Option<bool>> {
    Ok(bool_of(row.get_ref(idx)?))
}

/// JSON 을 담은 text 열을 읽는다 — 라우트가 `JSON.parse(row.x)` 하던 자리. 깨진 JSON 은 Err(Node 는 던졌다).
pub fn json_text(s: &str) -> Result<Value, serde_json::Error> {
    serde_json::from_str(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 큰_정수는_better_sqlite3_처럼_double_로_반올림한다() {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        let v: Value = c.query_row("SELECT 9007199254740993, 9007199254740991, -9007199254740993", [], |r| {
            Ok(serde_json::json!([raw(r.get_ref(0)?), raw(r.get_ref(1)?), raw(r.get_ref(2)?)]))
        }).unwrap();
        assert_eq!(crate::js::stringify(&v), "[9007199254740992,9007199254740991,-9007199254740992]");
    }

    #[test]
    fn drizzle_과_같은_모양() {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE t (a TEXT, b INTEGER, c INTEGER, d INTEGER, e TEXT); INSERT INTO t VALUES ('x', 5, 1, 2, NULL);").unwrap();
        let m = c
            .query_row("SELECT a, b, c, d, e FROM t", [], |r| {
                object(r, &[("aText", 0, Col::Plain), ("bNum", 1, Col::Plain), ("cOn", 2, Col::Bool), ("dTwo", 3, Col::Bool), ("eNull", 4, Col::Bool)])
            })
            .unwrap();
        assert_eq!(Value::Object(m).to_string(), r#"{"aText":"x","bNum":5,"cOn":true,"dTwo":false,"eNull":null}"#);
    }
}
