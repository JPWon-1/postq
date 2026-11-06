//! JSON 값을 JS 값처럼 다루는 작은 도구들 — 프로퍼티 읽기, String(), DB 바인딩, JSON 응답.
//!
//! 옮긴 라우트들은 신뢰할 수 없는 JSON(손편집 export 파일·Postman 컬렉션)을 받아 JS 의 느슨한 규칙대로
//! 읽었다. 숫자가 오면 문자열이 되고, null 의 프로퍼티를 읽으면 TypeError 로 500 이 났다. 그 규칙을
//! 한 곳에 모아 두어야 라우트마다 조금씩 다르게 옮기는 일이 없다.

use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use rusqlite::types::Value as Sql;
use serde_json::Value;

use crate::js;

/// `v.key` — 객체가 아니면(문자열·숫자·배열) 언제나 undefined. null 이면 JS 는 TypeError 를 던진다 —
/// 그 경우는 [`get_strict`] 를 쓴다.
pub fn get<'a>(v: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    v?.as_object()?.get(key)
}

/// `v.key` 를 그대로 — v 가 null·undefined 면 Node 와 같은 TypeError 문장으로 Err.
pub fn get_strict<'a>(v: Option<&'a Value>, key: &str) -> Result<Option<&'a Value>, String> {
    match v {
        None => Err(format!("Cannot read properties of undefined (reading '{key}')")),
        Some(Value::Null) => Err(format!("Cannot read properties of null (reading '{key}')")),
        Some(x) => Ok(x.as_object().and_then(|o| o.get(key))),
    }
}

/// `typeof v === 'string' ? v : undefined`
pub fn as_str(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str)
}

/// `v ?? null` 이 null·undefined 인가.
pub fn nullish(v: Option<&Value>) -> bool {
    matches!(v, None | Some(Value::Null))
}

/// `String(v)` — undefined 는 "undefined".
pub fn string_of(v: Option<&Value>) -> String {
    v.map_or_else(|| "undefined".into(), js::to_string)
}

/// import 쪽 `str(v, fallback)` — 문자열은 그대로, null·undefined 는 fallback, 나머지는 String(v).
pub fn str_or(v: Option<&Value>, fallback: &str) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        None | Some(Value::Null) => fallback.to_string(),
        Some(other) => js::to_string(other),
    }
}

/// drizzle → better-sqlite3 로 넘기던 값을 그대로 바인딩한다. 문자열은 text, 숫자는 언제나 REAL
/// (text 열에는 '5.0' 으로, integer 열에는 친화도 때문에 정수로 들어간다), null 은 NULL.
/// 불리언·객체·배열은 Node 에서 바인딩 오류(500)였다 — 같은 문장으로 Err.
pub fn bind(v: Option<&Value>) -> Result<Sql, String> {
    match v {
        None | Some(Value::Null) => Ok(Sql::Null),
        Some(Value::String(s)) => Ok(Sql::Text(s.clone())),
        Some(Value::Number(n)) => Ok(Sql::Real(n.as_f64().unwrap_or(0.0))),
        Some(Value::Bool(_)) => Err("SQLite3 can only bind numbers, strings, bigints, buffers, and null".into()),
        Some(_) => Err("Too few parameter values were provided".into()),
    }
}

/// Map·Set 의 키 비교(SameValueZero) 를 문자열 키로. 원시값은 값으로 같고(NaN 끼리도 같다),
/// 객체·배열은 서로 다른 것 — 따로 읽은 두 객체는 JS 에서도 같은 키가 아니다. uniq 는 그 구분용 카운터.
pub fn same_value_key(v: Option<&Value>, uniq: &mut usize) -> String {
    match v {
        None => "u".into(),
        Some(Value::Array(_) | Value::Object(_)) => {
            *uniq += 1;
            format!("o{uniq}")
        }
        Some(Value::Number(n)) => format!("n{}", js::number_to_string(n.as_f64().unwrap_or(f64::NAN))),
        Some(other) => format!("v{}", js::stringify(other)),
    }
}

/// `Response.json(v, { status })` — 본문은 JSON.stringify 와 같은 글자로(키 순서·숫자 표기).
pub fn reply(status: StatusCode, v: &Value) -> Response {
    (status, [(header::CONTENT_TYPE, "application/json")], js::stringify(v)).into_response()
}

pub fn ok(v: &Value) -> Response {
    reply(StatusCode::OK, v)
}

/// axum 의 `Json(v)` 자리에 그대로 쓰는 응답 — serde 로 쓰면 1.0 이 "1.0", -0 이 "-0.0" 으로 나가
/// Node 의 Response.json 과 글자가 갈린다. 핸들러 반환 형식(`(StatusCode, Js)` 등)을 바꾸지 않고 [`reply`] 로 보낸다.
pub struct Js(pub Value);

impl IntoResponse for Js {
    fn into_response(self) -> Response {
        reply(StatusCode::OK, &self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn 프로퍼티와_문자열화는_js_규칙() {
        let v = json!({ "a": 1 });
        assert_eq!(get(Some(&v), "a"), Some(&json!(1)));
        assert_eq!(get(Some(&json!("문자")), "a"), None);
        assert!(get_strict(Some(&Value::Null), "id").unwrap_err().contains("null (reading 'id')"));
        assert_eq!(str_or(Some(&json!(42)), ""), "42");
        assert_eq!(str_or(Some(&json!({"o": 1})), ""), "[object Object]");
        assert_eq!(str_or(None, "x"), "x");
        assert_eq!(string_of(None), "undefined");
        assert!(bind(Some(&json!(true))).is_err());
        assert_eq!(bind(Some(&json!(5))).unwrap(), Sql::Real(5.0));
    }
}
