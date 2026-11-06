//! 저장분에서 알려진 secret 값을 마스킹한다.
//!
//! 요청이 보낸 secret 을 API 가 응답에 echo 하면 그 평문이 팀 공유 이력·MCP 로 샌다. 저장하는 쪽만 가린다
//! (실행한 본인에게 돌려주는 즉시 응답은 실값 그대로). API 가 새로 발급한 값은 secret 인지 몰라 못 가린다.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

use crate::variables::VarMap;

const MASK: &str = "***";
/// 너무 짧은 값은 우연히 일치하기 쉬워 제외한다. 길이는 JS string.length(UTF-16).
const MIN_LEN: usize = 4;

/// text 안 secret 값 각각을 리터럴 치환으로 마스킹.
pub fn scrub_secrets(text: Option<&str>, secret_values: &[String]) -> Option<String> {
    let mut out = text?.to_string();
    for v in secret_values {
        if v.is_empty() || crate::js::len16(v) < MIN_LEN {
            continue;
        }
        if out.contains(v.as_str()) {
            out = out.replace(v.as_str(), MASK);
        }
    }
    Some(out)
}

/// 구조 안의 모든 문자열 값에 마스킹. **직렬화하기 전에** 쓴다 — 직렬화 뒤에 치환하면 이스케이프된 시크릿은
/// 못 지우고, 'true'·'null' 같은 시크릿은 JSON 구조까지 망가뜨린다. 키는 우리가 만든 필드명이라 그대로 둔다.
pub fn scrub_json(value: &Value, secret_values: &[String]) -> Value {
    match value {
        Value::String(s) => Value::String(scrub_secrets(Some(s), secret_values).unwrap_or_default()),
        Value::Array(a) => Value::Array(a.iter().map(|v| scrub_json(v, secret_values)).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), scrub_json(v, secret_values))).collect::<Map<_, _>>()),
        other => other.clone(),
    }
}

/// 헤더 (이름, 값) 목록의 각 값에 마스킹. 순서는 그대로.
pub fn scrub_headers(headers: Option<&[(String, String)]>, secret_values: &[String]) -> Option<Vec<(String, String)>> {
    Some(headers?.iter().map(|(k, v)| (k.clone(), scrub_secrets(Some(v), secret_values).unwrap_or_else(|| v.clone()))).collect())
}

/// VarMap 에서 secret 인 값들만(스크럽 대상). 순서는 Object.values 순서.
pub fn secret_values_of(vars: &VarMap) -> Vec<String> {
    vars.iter().filter(|(_, v)| v.secret && !v.value.is_empty()).map(|(_, v)| v.value.clone()).collect()
}

/// 값이 자격증명일 가능성이 큰 헤더 이름(소문자). export·이력 저장 시 리터럴 값 마스킹 대상.
const CREDENTIAL_HEADERS: &[&str] = &[
    "authorization", "proxy-authorization", "cookie", "set-cookie",
    "x-api-key", "api-key", "x-auth-token", "x-access-token", "x-amz-security-token",
];

pub fn is_credential_header(name: &str) -> bool {
    let n = crate::js::trim(name).to_lowercase();
    CREDENTIAL_HEADERS.contains(&n.as_str())
}

/// JS 의 `\s`(유니코드 모드) — regex 크레이트의 \s 와 글자 집합이 조금 달라 직접 적는다.
pub const JS_SPACE: &str = r"[\t\n\x0B\x0C\r \u{A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]";
/// 변수 이름에 쓸 수 있는 글자 — variables.ts 의 VAR_NAME_CHARS.
pub const VAR_NAME_CHARS: &str = r"[\p{L}\p{N}_.$-]";

/// {{var}}·{{var|json}} 참조를 포함하는가. variables.ts PATTERN 과 같은 모양이어야 {{k|json}} 이 리터럴로 오마스킹되지 않는다.
fn has_var_ref(v: &str) -> bool {
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        let s = JS_SPACE;
        Regex::new(&format!(r"\{{\{{{s}*{VAR_NAME_CHARS}+{s}*(\|{s}*json)?{s}*\}}\}}")).expect("변수 참조 정규식")
    });
    RE.is_match(v)
}

/// 알려진 자격증명 헤더의 '리터럴' 값을 마스킹한다({{var}} 참조는 비밀이 아니라 보존).
/// 객체를 받아 key·value 만 보고, 다른 필드(enabled 등)는 그대로 둔다.
pub fn mask_credential_headers(headers: &[Value]) -> Vec<Value> {
    headers
        .iter()
        .map(|h| {
            let key = h.get("key").and_then(Value::as_str).unwrap_or("");
            match h.get("value").and_then(Value::as_str) {
                Some(v) if !v.is_empty() && is_credential_header(key) && !has_var_ref(v) => {
                    let mut o = h.as_object().cloned().unwrap_or_default();
                    o.insert("value".into(), MASK.into());
                    Value::Object(o)
                }
                _ => h.clone(),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::variables::Var;
    use serde_json::json;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }
    fn mask1(key: &str, value: &str) -> Value {
        mask_credential_headers(&[json!({ "key": key, "value": value })])[0]["value"].clone()
    }

    #[test]
    fn 리터럴_자격증명_헤더는_마스킹_참조는_보존() {
        let out = mask_credential_headers(&[
            json!({ "key": "Authorization", "value": "Bearer abc123literal", "enabled": true }),
            json!({ "key": "Authorization", "value": "Bearer {{token}}", "enabled": true }),
            json!({ "key": "X-Api-Key", "value": "sk-live-xyz", "enabled": true }),
            json!({ "key": "Cookie", "value": "sid=deadbeef", "enabled": true }),
            json!({ "key": "Content-Type", "value": "application/json", "enabled": true }),
        ]);
        assert_eq!(out[0]["value"], "***");
        assert_eq!(out[1]["value"], "Bearer {{token}}");
        assert_eq!(out[2]["value"], "***");
        assert_eq!(out[3]["value"], "***");
        assert_eq!(out[4]["value"], "application/json");
        assert_eq!(out[0]["enabled"], true);
        assert_eq!(mask1("Authorization", ""), "");
    }

    #[test]
    fn 자격증명_헤더_인식() {
        assert!(is_credential_header("AUTHORIZATION"));
        assert!(is_credential_header("x-api-key"));
        assert!(!is_credential_header("Accept"));
    }

    #[test]
    fn scrub_secrets_치환() {
        assert_eq!(scrub_secrets(Some(r#"{"token":"SECRET-abc-123"}"#), &s(&["SECRET-abc-123"])).unwrap(), r#"{"token":"***"}"#);
        assert_eq!(scrub_secrets(Some("a=AAAA b=AAAA c=BBBB"), &s(&["AAAA", "BBBB"])).unwrap(), "a=*** b=*** c=***");
        assert_eq!(scrub_secrets(Some("x=ab"), &s(&["ab"])).unwrap(), "x=ab");
        assert_eq!(scrub_secrets(Some("nothing here"), &s(&["ZZZZ"])).unwrap(), "nothing here");
        assert_eq!(scrub_secrets(None, &s(&["x"])), None);
    }

    #[test]
    fn secret_values_of_는_secret_만() {
        let mut m = VarMap::new();
        m.insert("a", Var { value: "X".into(), secret: true });
        m.insert("b", Var { value: "Y".into(), secret: false });
        m.insert("c", Var { value: "".into(), secret: true });
        assert_eq!(secret_values_of(&m), ["X"]);
    }

    #[test]
    fn scrub_headers_마스킹() {
        let h = vec![("Authorization".to_string(), "Bearer TOKEN-1234".to_string())];
        assert_eq!(scrub_headers(Some(&h), &s(&["TOKEN-1234"])).unwrap(), vec![("Authorization".to_string(), "Bearer ***".to_string())]);
        assert_eq!(scrub_headers(None, &s(&["x"])), None);
    }

    #[test]
    fn json_필터_참조도_인식() {
        assert_eq!(mask1("X-Api-Key", "{{apiKey}}"), "{{apiKey}}");
        assert_eq!(mask1("X-Api-Key", "{{apiKey|json}}"), "{{apiKey|json}}");
        assert_eq!(mask1("X-Api-Key", "{{ 토큰 | json }}"), "{{ 토큰 | json }}");
        assert_eq!(mask1("X-Api-Key", "literal-secret"), "***");
    }

    #[test]
    fn scrub_json_은_직렬화_전에_마스킹() {
        let secret = "ABCD\nEF\"GH";
        let results = json!([{ "pass": true, "actual": secret, "message": format!("실제: {secret}") }]);
        let stored = scrub_json(&results, &s(&[secret])).to_string();
        assert!(!stored.contains("ABCD"));
        assert_eq!(serde_json::from_str::<Value>(&stored).unwrap()[0]["actual"], "***");

        let results = json!([{ "pass": true, "actual": "ok" }]);
        let stored: Value = scrub_json(&results, &s(&["true"]));
        assert_eq!(stored[0]["pass"], true);
        assert_eq!(stored[0]["actual"], "ok");

        let out = scrub_json(&json!({ "assertion": { "expected": "topsecret" }, "list": ["topsecret", 1, null] }), &s(&["topsecret"]));
        assert_eq!(out, json!({ "assertion": { "expected": "***" }, "list": ["***", 1, null] }));
    }
}
