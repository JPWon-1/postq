//! 요청 행에 들어갈 값의 허용 범위.
//!
//! SQLite 는 enum 을 강제하지 않는다. 안 막으면 엉뚱한 bodyType 이 그대로 저장되고, method 는
//! 실행할 때에야 fetch 가 던진다. 저장 라우트들이 같은 규칙을 쓰게 한곳에 둔다.

use serde_json::Value;

pub const BODY_TYPES: [&str; 7] = ["none", "json", "form", "raw", "graphql", "multipart", "binary"];

pub fn is_body_type(v: &Value) -> bool {
    v.as_str().map_or(false, |s| BODY_TYPES.contains(&s))
}

/// HTTP 메서드로 쓸 수 있는 글자인지(RFC 7230 token, 20자 이하). 목록으로 가두지는 않는다 —
/// 사내 API 가 흔치 않은 메서드를 쓸 수도 있다.
pub fn is_http_method(v: &Value) -> bool {
    let Some(s) = v.as_str() else { return false };
    !s.is_empty() && s.len() <= 20 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+.^_`|~-".contains(&b))
}

/// 400 문장에 들어가는 목록 — `BODY_TYPES.join(' · ')`.
pub fn body_types_text() -> String {
    BODY_TYPES.join(" · ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn body_type_은_아는_값만() {
        for t in BODY_TYPES {
            assert!(is_body_type(&json!(t)));
        }
        for v in [json!("아무거나"), json!("JSON"), json!(""), json!(null), json!(1), json!({})] {
            assert!(!is_body_type(&v));
        }
    }

    #[test]
    fn method_는_token_만() {
        for m in ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "PURGE", "MKCOL"] {
            assert!(is_http_method(&json!(m)));
        }
        for v in [json!("엉뚱한메서드"), json!("GET POST"), json!("GET\r\nX: 1"), json!(""), json!(" "), json!(null), json!(42)] {
            assert!(!is_http_method(&v), "{v}");
        }
        assert!(!is_http_method(&json!("A".repeat(21))));
        assert!(is_http_method(&json!("A".repeat(20))));
    }
}
