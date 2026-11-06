//! 요청 인증 계산 — 실효 인증(상속 포함)·Authorization 헤더 만들기·마스킹.
//! (저장·내보내기 쪽 정규화·마스킹은 [`crate::auth_config`] 에 있다)
//!
//! 공개 API
//! - [`resolve_effective_auth`] — 요청 인증이 inherit 이면 폴더 공통 인증으로.
//! - [`mask_authorization`] — 이력용 "Bearer ***".
//! - [`build_authorization`] → [`AuthResult`] — Authorization 값 계산. oauth2cc 는 토큰 URL 로 발급(+ 프로세스 메모리 캐시).
//!
//! AuthConfig 는 JSON 그대로(serde_json::Value) 받는다. /api/execute 는 클라이언트가 보낸 auth 를 정규화 없이 쓰므로
//! JS 의 분기(none·inherit·apikey 가 아니고 bearer·basic 도 아니면 전부 oauth2cc 로 취급)를 그대로 따른다 —
//! 모르는 type 이 조용히 '인증 없음' 이 되면 사용자는 토큰이 안 실린 이유를 모른다.
//!
//! 보안 규칙: 토큰 URL 도 다른 egress 와 같은 스킴·SSRF 검사를 거치고, 리다이렉트는 따라가지 않는다
//! (clientSecret 을 실어 보내는 자리라 302 → 메타데이터 우회를 막아야 한다). 캐시 키에는 clientSecret 의 해시를 넣어
//! secret 이 다른 호출이 남의 토큰을 재사용하지 못하게 한다.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use url::Url;

use crate::executor::{fetch, read_body_capped, FetchError, SendBody, MAX_BODY_CHARS};
use crate::js;
use crate::resolve::resolve_text;
use crate::ssrf_guard::{block_private_networks, is_blocked_host, scheme_problem};
use crate::variables::VarMap;

/// 요청 인증이 'inherit' 이면 폴더 공통 인증으로 해소한다. 폴더가 없거나 none/inherit 이면 인증 없음.
pub fn resolve_effective_auth(request_auth: Option<&Value>, folder_auth: Option<&Value>) -> Value {
    let req = match request_auth {
        None | Some(Value::Null) => json!({ "type": "none" }),
        Some(v) => v.clone(),
    };
    if type_of(&req) != Some("inherit") {
        return req;
    }
    if let Some(f) = folder_auth.filter(|f| !f.is_null()) {
        if !matches!(type_of(f), Some("none") | Some("inherit")) {
            return f.clone();
        }
    }
    json!({ "type": "none" })
}

pub fn type_of(auth: &Value) -> Option<&str> {
    auth.get("type").and_then(Value::as_str)
}

/// `auth.x ?? ''` 를 문자열로 — 손편집 값이 숫자여도 템플릿 치환 전에 String() 이 된다.
pub fn field(auth: &Value, k: &str) -> String {
    match auth.get(k) {
        None | Some(Value::Null) => String::new(),
        Some(v) => js::to_string(v),
    }
}

/// redacted 이력용 — 자격증명 부분만 마스킹("Bearer ***"). 공백이 없거나 맨 앞이면 통째로 "***".
pub fn mask_authorization(value: &str) -> String {
    match value.find(' ') {
        Some(sp) if sp > 0 => format!("{} ***", &value[..sp]),
        _ => "***".into(),
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct AuthResult {
    pub authorization: Option<String>,
    pub error: Option<String>,
}

impl AuthResult {
    fn ok(v: String) -> Self {
        AuthResult { authorization: Some(v), error: None }
    }
    fn err(e: impl Into<String>) -> Self {
        AuthResult { authorization: None, error: Some(e.into()) }
    }
}

/// btoa(unescape(encodeURIComponent(s))) — UTF-8 바이트의 base64.
fn b64(s: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(s.as_bytes())
}

/// OAuth2 토큰 캐시(서버 프로세스 메모리) — key: tokenUrl|clientId|scope|clientAuth|sha256(clientSecret) → (토큰, 만료 epoch ms).
static TOKEN_CACHE: LazyLock<Mutex<HashMap<String, (String, i64)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Number(v) — expires_in 이 문자열로 오는 IdP 도 있다.
fn js_number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => js::number(s),
        Some(other) => js::number(&js::to_string(other)),
    }
}

/// Authorization 값을 계산한다. oauth2cc 는 토큰을 발급받는다(캐시 우선).
pub async fn build_authorization(auth: Option<&Value>, vars: &VarMap) -> AuthResult {
    // inherit 은 실행 전에 이미 해소돼야 한다 — 남아 있으면 인증 없음. apikey 는 Authorization 이 아니라 커스텀 헤더/쿼리라
    // apply_authorization 이 맡는다.
    let Some(auth) = auth.filter(|a| !a.is_null()) else { return AuthResult::default() };
    let ty = type_of(auth);
    if matches!(ty, Some("none") | Some("inherit") | Some("apikey")) {
        return AuthResult::default();
    }
    let r = |k: &str| resolve_text(&field(auth, k), vars, None);
    if ty == Some("bearer") {
        let t = r("token");
        return if t.is_empty() { AuthResult::default() } else { AuthResult::ok(format!("Bearer {t}")) };
    }
    if ty == Some("basic") {
        return AuthResult::ok(format!("Basic {}", b64(&format!("{}:{}", r("username"), r("password")))));
    }
    // oauth2cc (그리고 모르는 type — TS 와 같은 분기)
    let token_url = r("tokenUrl");
    let client_id = r("clientId");
    let client_secret = r("clientSecret");
    let scope = r("scope");
    let client_auth = match auth.get("clientAuth") {
        None | Some(Value::Null) => "body".to_string(),
        Some(v) => js::to_string(v),
    };
    if token_url.is_empty() || client_id.is_empty() {
        return AuthResult::err("OAuth2: 토큰 URL 과 Client ID 가 필요합니다");
    }
    let key = format!("{token_url}|{client_id}|{scope}|{client_auth}|{}", hex::encode(Sha256::digest(client_secret.as_bytes())));
    let now = js::now_ms();
    if let Some((tok, exp)) = TOKEN_CACHE.lock().ok().and_then(|c| c.get(&key).cloned()) {
        if exp > now + 5000 {
            return AuthResult::ok(format!("Bearer {tok}"));
        }
    }
    let Ok(parsed) = Url::parse(&token_url) else { return AuthResult::err("OAuth2: 토큰 URL 이 올바르지 않습니다") };
    if let Some(bad) = scheme_problem(&format!("{}:", parsed.scheme())) {
        return AuthResult::err(format!("OAuth2: 토큰 URL — {bad}"));
    }
    if is_blocked_host(parsed.host_str().unwrap_or(""), block_private_networks()) {
        return AuthResult::err("OAuth2: 토큰 URL 이 차단된 주소입니다(메타데이터/사설망)");
    }
    // URLSearchParams 순서: grant_type, scope, client_id, client_secret. Serializer 는 Send 가 아니라 await 전에 끝낸다.
    let mut headers = vec![("Content-Type".to_string(), "application/x-www-form-urlencoded".to_string()), ("Accept".to_string(), "application/json".to_string())];
    let body = {
        let mut form = form_urlencoded::Serializer::new(String::new());
        form.append_pair("grant_type", "client_credentials");
        if !scope.is_empty() {
            form.append_pair("scope", &scope);
        }
        if client_auth == "basic" {
            headers.push(("Authorization".into(), format!("Basic {}", b64(&format!("{client_id}:{client_secret}")))));
        } else {
            form.append_pair("client_id", &client_id);
            form.append_pair("client_secret", &client_secret);
        }
        SendBody::Text(form.finish())
    };
    // fetch 의 AbortSignal.timeout(15_000) 는 신호 하나라 연결·헤더와 res.json() 본문 읽기를 합쳐 15초다 —
    // 두 단계에 15초씩 따로 걸면 최대 30초가 된다. 마감 시각 하나를 두 단계가 같이 쓴다.
    // 본문 읽기가 끊기면 `.json().catch(() => null)` 이라 '발급 실패' 로.
    let deadline = tokio::time::Instant::now() + OAUTH_TIMEOUT;
    let sent = tokio::time::timeout_at(deadline, fetch(&parsed, "POST", &headers, Some(&body))).await;
    let res = match sent {
        Err(_) => return AuthResult::err(format!("OAuth2: 토큰 발급 요청 실패 — {}", FetchError::timeout_message())),
        Ok(Err(e)) => return AuthResult::err(format!("OAuth2: 토큰 발급 요청 실패 — {}", e.message)),
        Ok(Ok(res)) => res,
    };
    let status = res.status().as_u16();
    // redirect:'manual' — 허용 호스트가 302 로 내부 주소에 보내 SSRF 가드를 우회하는 것을 막는다.
    if (300..400).contains(&status) {
        return AuthResult::err("OAuth2: 토큰 URL 이 리다이렉트되었습니다(보안상 차단)");
    }
    let parsed_json = match tokio::time::timeout_at(deadline, read_body_capped(res, MAX_BODY_CHARS, false)).await {
        Ok(Ok((text, false))) => js::parse_json(&text),
        _ => None,
    };
    let access = parsed_json.as_ref().and_then(|j| j.get("access_token")).filter(|t| js::truthy(Some(t)));
    let Some(access) = access.filter(|_| (200..300).contains(&status)) else {
        return AuthResult::err(format!("OAuth2: 토큰 발급 실패 ({status})"));
    };
    let token = js::to_string(access);
    let ttl = js_number(parsed_json.as_ref().and_then(|j| j.get("expires_in")));
    let ttl = if ttl > 0.0 { ttl } else { 3600.0 };
    if let Ok(mut c) = TOKEN_CACHE.lock() {
        c.insert(key, (token.clone(), now + (ttl * 1000.0) as i64));
    }
    AuthResult::ok(format!("Bearer {token}"))
}

/// 토큰 발급 전체(요청+본문)에 거는 시간. 테스트는 짧게 줄여 마감 공유를 확인한다.
#[cfg(not(test))]
const OAUTH_TIMEOUT: Duration = Duration::from_secs(15);
#[cfg(test)]
const OAUTH_TIMEOUT: Duration = Duration::from_millis(600);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::executor::tests::{mock, resp, split};
    use crate::variables::Var;

    fn vars() -> VarMap {
        let mut m = VarMap::new();
        m.insert("tok", Var { value: "T-1".into(), secret: true });
        m.insert("sec", Var { value: "S".into(), secret: true });
        m
    }

    #[tokio::test]
    async fn bearer_basic_none() {
        assert_eq!(build_authorization(Some(&json!({ "type": "none" })), &vars()).await, AuthResult::default());
        assert_eq!(build_authorization(None, &vars()).await, AuthResult::default());
        assert_eq!(build_authorization(Some(&json!({ "type": "bearer", "token": "{{tok}}" })), &vars()).await.authorization.as_deref(), Some("Bearer T-1"));
        assert_eq!(build_authorization(Some(&json!({ "type": "bearer", "token": "" })), &vars()).await, AuthResult::default());
        let b = build_authorization(Some(&json!({ "type": "basic", "username": "u", "password": "p" })), &vars()).await;
        assert_eq!(b.authorization.as_deref(), Some("Basic dTpw"));
        // 한글은 UTF-8 로
        let b = build_authorization(Some(&json!({ "type": "basic", "username": "한", "password": "" })), &vars()).await;
        assert_eq!(b.authorization.as_deref(), Some("Basic 7ZWcOg=="));
        assert_eq!(build_authorization(Some(&json!({ "type": "apikey", "key": "k", "value": "v" })), &vars()).await, AuthResult::default());
    }

    #[test]
    fn 상속과_마스킹() {
        let folder = json!({ "type": "bearer", "token": "F" });
        assert_eq!(resolve_effective_auth(Some(&json!({ "type": "inherit" })), Some(&folder)), folder);
        assert_eq!(resolve_effective_auth(Some(&json!({ "type": "inherit" })), Some(&json!({ "type": "none" }))), json!({ "type": "none" }));
        assert_eq!(resolve_effective_auth(Some(&json!({ "type": "inherit" })), None), json!({ "type": "none" }));
        assert_eq!(resolve_effective_auth(Some(&json!({ "type": "basic" })), Some(&folder)), json!({ "type": "basic" }));
        assert_eq!(resolve_effective_auth(None, Some(&folder)), json!({ "type": "none" }));
        assert_eq!(mask_authorization("Bearer abc"), "Bearer ***");
        assert_eq!(mask_authorization("abc"), "***");
        assert_eq!(mask_authorization(" abc"), "***");
    }

    #[tokio::test]
    async fn oauth2_필수값_url_차단() {
        let e = build_authorization(Some(&json!({ "type": "oauth2cc", "tokenUrl": "", "clientId": "c" })), &vars()).await;
        assert_eq!(e.error.as_deref(), Some("OAuth2: 토큰 URL 과 Client ID 가 필요합니다"));
        // 모르는 type 도 oauth2 분기로 간다
        let e = build_authorization(Some(&json!({ "type": "weird" })), &vars()).await;
        assert_eq!(e.error.as_deref(), Some("OAuth2: 토큰 URL 과 Client ID 가 필요합니다"));
        let e = build_authorization(Some(&json!({ "type": "oauth2cc", "tokenUrl": "nota url", "clientId": "c" })), &vars()).await;
        assert_eq!(e.error.as_deref(), Some("OAuth2: 토큰 URL 이 올바르지 않습니다"));
        let e = build_authorization(Some(&json!({ "type": "oauth2cc", "tokenUrl": "file:///etc/passwd", "clientId": "c" })), &vars()).await;
        assert!(e.error.unwrap().starts_with("OAuth2: 토큰 URL — file://"));
        let e = build_authorization(Some(&json!({ "type": "oauth2cc", "tokenUrl": "http://169.254.169.254/token", "clientId": "c" })), &vars()).await;
        assert_eq!(e.error.as_deref(), Some("OAuth2: 토큰 URL 이 차단된 주소입니다(메타데이터/사설망)"));
    }

    #[tokio::test]
    async fn oauth2_발급_캐시_리다이렉트_차단() {
        // 각 mock의 고유 URL로 캐시를 격리한다. 전역 clear는 병렬 테스트의 캐시를 지운다.
        let m = mock(|path, _req, _| match path {
            "/redir" => resp("302 Found", &[("location", "http://169.254.169.254/")], b""),
            "/fail" => resp("401 Unauthorized", &[("content-type", "application/json")], br#"{"error":"bad"}"#),
            _ => resp("200 OK", &[("content-type", "application/json")], br#"{"access_token":"AT-1","expires_in":"120"}"#),
        })
        .await;
        let cfg = json!({ "type": "oauth2cc", "tokenUrl": format!("{}/token", m.base), "clientId": "cid", "clientSecret": "{{sec}}", "scope": "a b" });
        let r = build_authorization(Some(&cfg), &vars()).await;
        assert_eq!(r.authorization.as_deref(), Some("Bearer AT-1"));
        let (head, body) = split(&m.seen.lock().unwrap()[0]);
        assert_eq!(body, "grant_type=client_credentials&scope=a+b&client_id=cid&client_secret=S");
        assert!(head.contains("content-type: application/x-www-form-urlencoded"));
        assert!(head.contains("accept: application/json"));
        // 두 번째는 캐시
        build_authorization(Some(&cfg), &vars()).await;
        assert_eq!(m.seen.lock().unwrap().len(), 1);
        // secret 이 다르면 캐시를 쓰지 않는다
        let mut other = vars();
        other.insert("sec", Var { value: "S2".into(), secret: true });
        build_authorization(Some(&cfg), &other).await;
        assert_eq!(m.seen.lock().unwrap().len(), 2);

        // basic clientAuth
        let cfg = json!({ "type": "oauth2cc", "tokenUrl": format!("{}/token2", m.base), "clientId": "cid", "clientSecret": "S", "clientAuth": "basic" });
        build_authorization(Some(&cfg), &vars()).await;
        let (head, body) = split(&m.seen.lock().unwrap()[2]);
        assert_eq!(body, "grant_type=client_credentials");
        assert!(head.contains(&format!("authorization: basic {}", b64("cid:S").to_lowercase())));

        let r = build_authorization(Some(&json!({ "type": "oauth2cc", "tokenUrl": format!("{}/redir", m.base), "clientId": "c" })), &vars()).await;
        assert_eq!(r.error.as_deref(), Some("OAuth2: 토큰 URL 이 리다이렉트되었습니다(보안상 차단)"));
        let r = build_authorization(Some(&json!({ "type": "oauth2cc", "tokenUrl": format!("{}/fail", m.base), "clientId": "c" })), &vars()).await;
        assert_eq!(r.error.as_deref(), Some("OAuth2: 토큰 발급 실패 (401)"));
    }

    #[tokio::test]
    async fn oauth2_접속_실패() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        let r = build_authorization(Some(&json!({ "type": "oauth2cc", "tokenUrl": format!("http://127.0.0.1:{port}/t"), "clientId": "c" })), &vars()).await;
        assert_eq!(r.error.as_deref(), Some("OAuth2: 토큰 발급 요청 실패 — fetch failed"));
    }

    #[tokio::test]
    async fn oauth2_시간_제한은_요청과_본문을_합친_하나다() {
        // 머리는 마감 2/3 에, 본문은 마감 4/3 에 — 단계별로 따로 재면 둘 다 통과하지만 합치면 넘는다.
        // requestAuth.ts 는 AbortSignal 하나라 res.json() 이 끊겨 null → '발급 실패 (200)'.
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let step = OAUTH_TIMEOUT * 2 / 3;
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let _ = s.read(&mut buf).await;
            tokio::time::sleep(step).await;
            let body = br#"{"access_token":"LATE"}"#;
            let head = format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n", body.len());
            let _ = s.write_all(head.as_bytes()).await;
            let _ = s.flush().await;
            tokio::time::sleep(step).await;
            let _ = s.write_all(body).await;
            tokio::time::sleep(OAUTH_TIMEOUT).await;
        });
        let t = std::time::Instant::now();
        let r = build_authorization(Some(&json!({ "type": "oauth2cc", "tokenUrl": format!("http://127.0.0.1:{port}/t"), "clientId": "slow" })), &vars()).await;
        assert_eq!(r.error.as_deref(), Some("OAuth2: 토큰 발급 실패 (200)"));
        assert!(t.elapsed() < OAUTH_TIMEOUT + step / 2, "{:?}", t.elapsed());
    }
}
