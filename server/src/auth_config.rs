//! 주의: 앱 접속 인증(로그인)이 아니다 — 요청이 바깥 API 로 보낼 인증값을 다룬다. 앱에는 로그인이 없다(docs/auth.md).
//!
//! 요청·폴더 인증(AuthConfig) 의 정규화·마스킹·병합.
//!
//! 실행(Authorization 계산·OAuth 토큰 발급)은 [`crate::request_auth`] 가 맡는다. 여기는 저장·내보내기·조회에서
//! '무엇을 저장하고 무엇을 보여주나' 만 다룬다. 라우트를 나눠 옮기면서 세 벌(request_auth·auth_secrets·여기)이
//! 생겼었다 — 비밀값을 지우는 규칙이 경로마다 조금씩 다르면 한쪽 화면에서만 토큰이 새므로 하나로 모은다.
//!
//! AuthConfig 는 JSON 그대로(serde_json::Value) 다룬다. 저장 문자열의 키 순서가 Node 가 쓴 것과
//! 같아야 하므로, 객체를 만들 때 TS 의 객체 리터럴 순서를 그대로 따른다.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{json, Value};

use crate::js;
use crate::scrub::{JS_SPACE, VAR_NAME_CHARS};

/// 종류별 비밀 필드. none·inherit 은 없다.
fn secret_field(auth: &Value) -> Option<&'static str> {
    match auth.get("type")?.as_str()? {
        "bearer" => Some("token"),
        "basic" => Some("password"),
        "apikey" => Some("value"),
        "oauth2cc" => Some("clientSecret"),
        _ => None,
    }
}

/// 폴더 공통 인증 입력 정규화 — 유효한 타입만(폴더는 inherit 불가), 필드도 타입별로 추리고 문자열로 강제.
/// 클라이언트가 보낸 임의 JSON 을 그대로 저장하지 않으려는 것. 무효·미지정이면 `{ type: 'none' }`.
pub fn sanitize_folder_auth(input: Option<&Value>) -> Value {
    // `!input || typeof input !== 'object'` — 배열도 객체라 통과하지만 type 이 없어 none 이 된다.
    let Some(o) = input.and_then(Value::as_object) else { return json!({ "type": "none" }) };
    let s = |k: &str| o.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    match o.get("type").and_then(Value::as_str) {
        Some("bearer") => json!({ "type": "bearer", "token": s("token") }),
        Some("basic") => json!({ "type": "basic", "username": s("username"), "password": s("password") }),
        Some("apikey") => json!({
            "type": "apikey", "key": s("key"), "value": s("value"),
            "in": if o.get("in").and_then(Value::as_str) == Some("query") { "query" } else { "header" },
        }),
        Some("oauth2cc") => json!({
            "type": "oauth2cc", "tokenUrl": s("tokenUrl"), "clientId": s("clientId"), "clientSecret": s("clientSecret"),
            "scope": s("scope"),
            "clientAuth": if o.get("clientAuth").and_then(Value::as_str) == Some("basic") { "basic" } else { "body" },
        }),
        _ => json!({ "type": "none" }),
    }
}

/// 요청 인증 입력 정규화 — 폴더와 달리 'inherit'(폴더 공통 인증 상속)을 받는다. 그 외는 폴더와 같다.
pub fn sanitize_request_auth(input: Option<&Value>) -> Value {
    if input.and_then(|v| v.get("type")).and_then(Value::as_str) == Some("inherit") && input.map_or(false, Value::is_object) {
        return json!({ "type": "inherit" });
    }
    sanitize_folder_auth(input)
}

/// `/\{\{\s*[\p{L}\p{N}_.$-]+\s*\}\}/u` — {{변수}} 참조인가. 여기는 `|json` 꼬리를 받지 않는다.
fn is_var_ref(v: &str) -> bool {
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        let s = JS_SPACE;
        Regex::new(&format!(r"\{{\{{{s}*{VAR_NAME_CHARS}+{s}*\}}\}}")).expect("변수 참조 정규식")
    });
    RE.is_match(v)
}

/// secret 필드(token/password/value/clientSecret)의 '리터럴' 값을 공란으로. {{var}} 참조는 남긴다 —
/// 그건 비밀이 아니라 '어디서 가져오는지' 이고, 지우면 사용자가 매번 다시 적어야 한다.
///
/// TS 에는 내보내기용 maskAuthSecrets(requestAuth.ts:65)와 화면 조회용 maskAuthForClient(authSecrets.ts:16)가
/// 따로 있지만 규칙(같은 정규식·같은 blank)이 한 글자도 다르지 않아 하나로 쓴다.
/// `{ ...auth, token: blank(auth.token) }` — 필드가 없으면 맨 뒤에 '' 로 붙는다.
pub fn mask_auth_secrets(auth: &Value) -> Value {
    let Some(field) = secret_field(auth) else { return auth.clone() };
    let Some(o) = auth.as_object() else { return auth.clone() };
    // `v && re.test(v) ? v : ''` — 문자열이 아닌 참 값은 정규식이 String(v) 로 본다(손상된 행의 숫자 토큰 등).
    let kept = match o.get(field) {
        Some(v) if js::truthy(Some(v)) && is_var_ref(&js::to_string(v)) => v.clone(),
        _ => Value::String(String::new()),
    };
    let mut out = o.clone();
    out.insert(field.to_string(), kept);
    Value::Object(out)
}

/// 화면에는 비밀값 대신 저장 여부만 전달한다. 스니펫이 마스킹된 빈칸을 인증 없음으로 오해하지 않게 한다.
pub fn auth_for_client(auth: &Value) -> Value {
    let mut out = mask_auth_secrets(auth);
    let stored = secret_field(auth).and_then(|key| auth.get(key)).and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty() && !is_var_ref(value));
    if stored {
        if let Some(object) = out.as_object_mut() { object.insert("hasStoredSecret".into(), json!(true)); }
    }
    out
}

/// 저장할 때 빈 비밀값은 '지우라' 가 아니라 '그대로 두라' — 위에서 비운 값이 화면을 돌아 그대로 오기 때문이다.
/// 이 짝이 없으면 마스킹을 넣는 순간 저장할 때마다 토큰이 지워진다. 방식이 바뀌면 이을 자리가 없으니 들어온 그대로.
///
/// authSecrets.ts 의 keep — `next === '' || next === undefined ? (prev ?? '') : next`. null·숫자는 ''/undefined 가
/// 아니므로 들어온 값을 그대로 두고, 저장된 값이 문자열이 아니어도(prev ?? '') 그대로 잇는다.
pub fn merge_auth_secrets(incoming: &Value, stored: &Value) -> Value {
    if incoming.get("type") != stored.get("type") {
        return incoming.clone();
    }
    let Some(field) = secret_field(incoming) else { return incoming.clone() };
    let empty = match incoming.get(field) {
        None => true,
        Some(Value::String(s)) => s.is_empty(),
        _ => false,
    };
    if !empty {
        return incoming.clone();
    }
    let prev = match stored.get(field) {
        None | Some(Value::Null) => Value::String(String::new()),
        Some(p) => p.clone(),
    };
    let mut out = incoming.clone();
    if let Some(o) = out.as_object_mut() {
        o.insert(field.to_string(), prev);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // requestAuth.test.ts 의 sanitizeFolderAuth·sanitizeRequestAuth 부분.
    #[test]
    fn sanitize_는_필드만_추린다() {
        assert_eq!(sanitize_folder_auth(Some(&json!({"type": "bearer", "token": "t", "junk": 1}))), json!({"type": "bearer", "token": "t"}));
        assert_eq!(
            sanitize_folder_auth(Some(&json!({"type": "basic", "username": "u", "password": "p"}))),
            json!({"type": "basic", "username": "u", "password": "p"})
        );
        let o = sanitize_folder_auth(Some(&json!({"type": "oauth2cc", "tokenUrl": "x", "clientId": "c", "clientSecret": "s", "clientAuth": "basic"})));
        assert_eq!(o.to_string(), r#"{"type":"oauth2cc","tokenUrl":"x","clientId":"c","clientSecret":"s","scope":"","clientAuth":"basic"}"#);
        assert_eq!(
            sanitize_folder_auth(Some(&json!({"type": "apikey", "key": "k", "value": "v", "in": "query"}))).to_string(),
            r#"{"type":"apikey","key":"k","value":"v","in":"query"}"#
        );
    }

    #[test]
    fn 폴더는_inherit_불가_요청은_가능_무효는_none() {
        assert_eq!(sanitize_folder_auth(Some(&json!({"type": "inherit"}))), json!({"type": "none"}));
        assert_eq!(sanitize_request_auth(Some(&json!({"type": "inherit"}))), json!({"type": "inherit"}));
        assert_eq!(sanitize_request_auth(Some(&json!({"type": "inherit", "token": "x"}))), json!({"type": "inherit"}));
        assert_eq!(sanitize_folder_auth(None), json!({"type": "none"}));
        assert_eq!(sanitize_folder_auth(Some(&Value::Null)), json!({"type": "none"}));
        assert_eq!(sanitize_folder_auth(Some(&json!("nope"))), json!({"type": "none"}));
        assert_eq!(sanitize_folder_auth(Some(&json!([1, 2]))), json!({"type": "none"}));
        assert_eq!(sanitize_folder_auth(Some(&json!({"type": "bearer"}))), json!({"type": "bearer", "token": ""}));
        assert_eq!(sanitize_folder_auth(Some(&json!({"type": "bearer", "token": 42}))), json!({"type": "bearer", "token": ""}));
        assert_eq!(
            sanitize_request_auth(Some(&json!({"type": "basic", "username": 5, "password": {}}))),
            json!({"type": "basic", "username": "", "password": ""})
        );
    }

    // requestAuth.test.ts(maskAuthSecrets)·authSecrets.test.ts(maskAuthForClient) — 같은 규칙이라 함께 본다.
    #[test]
    fn 리터럴_secret_은_공란_참조는_보존() {
        assert_eq!(mask_auth_secrets(&json!({"type": "bearer", "token": "literal-abc"})), json!({"type": "bearer", "token": ""}));
        assert_eq!(mask_auth_secrets(&json!({"type": "bearer", "token": "{{token}}"})), json!({"type": "bearer", "token": "{{token}}"}));
        assert_eq!(mask_auth_secrets(&json!({"type": "bearer", "token": "{{토큰}}"})), json!({"type": "bearer", "token": "{{토큰}}"}));
        assert_eq!(mask_auth_secrets(&json!({"type": "bearer", "token": "Bearer {{ t }}"}))["token"], "Bearer {{ t }}");
        // |json 꼬리는 여기선 참조로 안 본다(Node 의 isVarRef 와 같다)
        assert_eq!(mask_auth_secrets(&json!({"type": "bearer", "token": "{{t|json}}"}))["token"], "");
        assert_eq!(mask_auth_secrets(&json!({"type": "basic", "username": "u", "password": "pw"})), json!({"type": "basic", "username": "u", "password": ""}));
        assert_eq!(mask_auth_secrets(&json!({"type": "apikey", "key": "X", "value": "V", "in": "header"}))["value"], "");
        assert_eq!(
            mask_auth_secrets(&json!({"type": "oauth2cc", "tokenUrl": "x", "clientId": "c", "clientSecret": "sekret", "scope": "read", "clientAuth": "body"})),
            json!({"type": "oauth2cc", "tokenUrl": "x", "clientId": "c", "clientSecret": "", "scope": "read", "clientAuth": "body"})
        );
        assert_eq!(mask_auth_secrets(&json!({"type": "none"})), json!({"type": "none"}));
        assert_eq!(mask_auth_secrets(&json!({"type": "inherit"})), json!({"type": "inherit"}));
    }

    // authSecrets.test.ts 의 mergeAuthSecrets 부분.
    #[test]
    fn 병합_빈_값은_그대로_두라() {
        assert_eq!(merge_auth_secrets(&json!({"type": "bearer", "token": ""}), &json!({"type": "bearer", "token": "KEEP"})), json!({"type": "bearer", "token": "KEEP"}));
        assert_eq!(merge_auth_secrets(&json!({"type": "bearer"}), &json!({"type": "bearer", "token": "KEEP"})), json!({"type": "bearer", "token": "KEEP"}));
        assert_eq!(merge_auth_secrets(&json!({"type": "bearer", "token": "NEW"}), &json!({"type": "bearer", "token": "OLD"})), json!({"type": "bearer", "token": "NEW"}));
        assert_eq!(
            merge_auth_secrets(&json!({"type": "basic", "username": "u", "password": ""}), &json!({"type": "bearer", "token": "OLD"})),
            json!({"type": "basic", "username": "u", "password": ""})
        );
        assert_eq!(
            merge_auth_secrets(&json!({"type": "bearer", "token": "{{token}}"}), &json!({"type": "bearer", "token": "OLD"})),
            json!({"type": "bearer", "token": "{{token}}"})
        );
    }

    #[test]
    fn 마스킹_저장_왕복에서_값이_살아남는다() {
        let stored = json!({"type": "oauth2cc", "tokenUrl": "https://t", "clientId": "c", "clientSecret": "S"});
        let shown = mask_auth_secrets(&stored);
        assert_eq!(merge_auth_secrets(&shown, &stored), stored);
    }
}
