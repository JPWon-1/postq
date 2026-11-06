//! 라우트 입력 검증.

use serde_json::Value;

use crate::error::ApiError;
use crate::{js, jsval, server_log};

/// 바디를 읽되, 깨져 있으면 None — 호출부는 None 을 400 으로 돌려준다(500 은 '우리가 잘못했다' 는 신호다).
pub fn read_json(body: &[u8]) -> Option<Value> {
    js::parse_body(body)
}

/// 비어 있지 않은 문자열인지. 숫자·객체·배열·공백 문자열을 거르고, 통과하면 trim 한 값.
/// trim 과 길이는 JS 의 것(UTF-16 단위)으로 센다 — 같은 입력이 한쪽에서만 통과하면 안 된다.
pub fn require_text(v: Option<&Value>, max: usize) -> Option<String> {
    let t = js::trim(v?.as_str()?);
    if t.is_empty() || js::len16(t) > max {
        return None;
    }
    Some(t.to_string())
}

/// 400 응답 — 이유를 반드시 싣는다.
pub fn bad_request(reason: impl Into<String>) -> ApiError {
    ApiError::bad_request(reason)
}

/// 핸들러 결과 — (상태, 본문). 409 처럼 `{ error }` 가 아닌 모양도 있어서 ApiError 대신 이걸 쓴다.
pub type Out = (axum::http::StatusCode, Value);

/// `Response.json({ error: msg }, { status })`.
pub fn fail(status: axum::http::StatusCode, msg: impl Into<String>) -> Out {
    (status, serde_json::json!({ "error": msg.into() }))
}

/// `Response.json(v, { status })` — 본문은 JSON.stringify 와 같은 글자로([`jsval::reply`]).
pub fn respond(out: Out) -> axum::response::Response {
    jsval::reply(out.0, &out.1)
}

/// 400 `{ error }` 를 바로 응답으로 — 핸들러가 Response 를 돌려주는 자리용.
pub fn bad(msg: impl Into<String>) -> axum::response::Response {
    respond(fail(axum::http::StatusCode::BAD_REQUEST, msg))
}

/// 원인을 서버 콘솔과 로그 버퍼에 남기고 `{ error: '<prefix>: <원인>' }` 500.
/// 라우트마다 한 벌씩 생겼던 것을 하나로 — 로그를 남기는 자리가 경로마다 다르면 [서버 로그] 탭에서 원인이 빠진다.
pub fn json_error(prefix: &str, message: &str) -> axum::response::Response {
    json_error_status(axum::http::StatusCode::INTERNAL_SERVER_ERROR, prefix, message)
}

/// `jsonError(e, prefix, status)` — 상태 코드를 고르는 쪽(외부 연동 실패는 502).
pub fn json_error_status(status: axum::http::StatusCode, prefix: &str, message: &str) -> axum::response::Response {
    eprintln!("[route] {prefix}: {message}");
    server_log::log(server_log::Level::Error, prefix, message, None, None);
    jsval::reply(status, &serde_json::json!({ "error": format!("{prefix}: {message}") }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn 숫자는_이름이_될_수_없다() {
        assert_eq!(require_text(Some(&json!(123)), 200), None);
        assert_eq!(require_text(Some(&json!(0)), 200), None);
    }

    #[test]
    fn 문자열이_아닌_것은_전부_거른다() {
        for v in [json!(null), json!(true), json!([]), json!({}), json!(["이름"])] {
            assert_eq!(require_text(Some(&v), 200), None);
        }
        assert_eq!(require_text(None, 200), None);
    }

    #[test]
    fn 빈_문자열_공백만_있는_것도_거른다() {
        for s in ["", "   ", "\n\t"] {
            assert_eq!(require_text(Some(&json!(s)), 200), None);
        }
    }

    #[test]
    fn 앞뒤_공백은_잘라서_준다() {
        assert_eq!(require_text(Some(&json!("  주문 생성  ")), 200).as_deref(), Some("주문 생성"));
    }

    #[test]
    fn 길이_상한을_넘으면_거른다() {
        assert_eq!(require_text(Some(&json!("가".repeat(201))), 200), None);
        assert_eq!(require_text(Some(&json!("가".repeat(200))), 200), Some("가".repeat(200)));
        assert_eq!(require_text(Some(&json!("가".repeat(11))), 10), None);
    }

    #[test]
    fn 정상_json_은_그대로_깨진_json_은_none() {
        assert_eq!(read_json(br#"{"a":1}"#), Some(json!({"a": 1})));
        assert_eq!(read_json("깨진{{{".as_bytes()), None);
        assert_eq!(read_json(b""), None);
    }

    #[test]
    fn bad_request_는_400_과_이유() {
        let e = bad_request("name required");
        assert_eq!(e.status, axum::http::StatusCode::BAD_REQUEST);
        assert_eq!(e.message, "name required");
    }
}
