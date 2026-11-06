//! 스펙 받기 — OpenAPI 문서 하나를 받아 JSON·번들로 만든다. 폴더 동기화([`crate::routes`] 의 folders/{id}/sync)와
//! 응답 스키마 검증([`crate::schema_validate`])이 같이 쓴다.
//! 번들은 JSON 값 그대로 다룬다 — operation 은 스펙의 원본 노드를 그대로 싣는다.

use std::time::Duration;

use serde_json::{json, Value};

use crate::openapi::METHODS;
use crate::ssrf_guard::{block_private_networks, is_blocked_host, scheme_problem};
use crate::js;

// ── 번들 ──────────────────────────────────────────────────────────────────────

fn get<'a>(v: Option<&'a Value>, k: &str) -> Option<&'a Value> {
    v?.as_object()?.get(k)
}

/// `v ?? null`
fn or_null(v: Option<&Value>) -> Value {
    v.filter(|x| !x.is_null()).cloned().unwrap_or(Value::Null)
}

/// OpenAPI 문서 → 번들(specToBundle). paths 가 없거나 이상해도 터지지 않는다.
pub fn spec_to_bundle(service: &str, spec: &Value) -> Value {
    let mut endpoints = vec![];
    if let Some(paths) = get(Some(spec), "paths").and_then(Value::as_object) {
        for path in js::object_keys(paths) {
            let item = paths.get(path);
            for m in METHODS {
                let Some(op) = get(item, m).filter(|o| js::truthy(Some(o))) else { continue };
                endpoints.push(json!({
                    "method": m.to_uppercase(),
                    "path": path,
                    "summary": or_null(get(Some(op), "summary")),
                    "operationId": or_null(get(Some(op), "operationId")),
                    "tags": get(Some(op), "tags").filter(|t| t.is_array()).cloned().unwrap_or(json!([])),
                    "deprecated": get(Some(op), "deprecated") == Some(&Value::Bool(true)),
                    "operation": op,
                }));
            }
        }
    }
    let schemas = or_null(get(get(Some(spec), "components"), "schemas"));
    let schemas = if schemas.is_null() { json!({}) } else { schemas };
    json!({ "service": service, "reachable": true, "endpoints": endpoints, "schemas": schemas })
}

// ── specFetch.ts ─────────────────────────────────────────────────────────────

/// 스펙 본문 상한 — Node 는 제한이 없었지만, 한 번에 메모리에 올리는 크기는 묶는다.
const SPEC_MAX_BYTES: usize = 50 * 1024 * 1024;


/// `await fetch(url, { signal: AbortSignal.timeout(ms) })` + `res.json()` 이 실패한 모양.
#[derive(Debug)]
pub enum SpecFetchError {
    Timeout,
    /// 연결 자체가 안 됨(주소·서버 다운). Node 의 메시지는 언제나 'fetch failed' 였다.
    Network,
    Status(u16),
    /// 본문이 JSON 이 아님 — V8 의 SyntaxError 문장(근사).
    NotJson(String),
    /// SSRF 가드에 걸림(스킴 또는 메타데이터/사설망 주소) — 처음 주소든 리다이렉트 목적지든. 문장은 사용자에게 그대로 보인다.
    Blocked(String),
}

impl SpecFetchError {
    /// Node 의 e.message 에 해당하는 문장.
    pub fn message(&self) -> String {
        match self {
            SpecFetchError::Timeout => crate::executor::FetchError::timeout_message().into(),
            SpecFetchError::Network => crate::executor::FetchError::FETCH_FAILED.into(),
            SpecFetchError::Status(s) => format!("HTTP {s}"),
            SpecFetchError::NotJson(m) => m.clone(),
            SpecFetchError::Blocked(m) => m.clone(),
        }
    }
}

/// JSON.parse 실패 문장의 근사 — V8 은 첫 글자와 앞부분을 보여 준다. 글자 단위 일치는 하지 않는다.
fn json_syntax_message(text: &str) -> String {
    let t = text.trim_start();
    let Some(c) = t.chars().next() else { return "Unexpected end of JSON input".into() };
    if js::len16(text) <= 40 {
        format!("Unexpected token '{c}', \"{text}\" is not valid JSON")
    } else {
        format!("Unexpected token '{c}', \"{}\"... is not valid JSON", js::slice16(text, 10))
    }
}

/// 스펙을 받을 때 따라가는 리다이렉트 상한 — 예전 `follow()` 클라이언트(reqwest 기본 정책)와 같은 10번.
const SPEC_MAX_REDIRECTS: usize = 10;

/// 이 주소로 나가도 되는지 — 스킴(http/https)과 호스트(메타데이터는 언제나, `block_private` 면 사설망까지).
/// `hop` 은 문장만 바꾼다(리다이렉트 목적지인지).
fn spec_url_problem(url: &reqwest::Url, block_private: bool, hop: bool) -> Option<String> {
    let lead = if hop { "리다이렉트 대상 " } else { "" };
    if let Some(p) = scheme_problem(&format!("{}:", url.scheme())) {
        return Some(format!("{lead}{p}"));
    }
    if is_blocked_host(url.host_str().unwrap_or(""), block_private) {
        return Some(format!("{lead}차단된 주소입니다(메타데이터/사설망)"));
    }
    None
}

/// 스펙 하나를 받아 JSON 으로. 상태 코드가 2xx 가 아니면 본문은 읽지 않는다.
///
/// 스펙을 받아 오는 모든 길(폴더 동기화·스키마 검증 번들)이 이 함수 하나를 지나므로
/// SSRF 가드도 여기서 건다. 리다이렉트는 손으로 따라가며 홉마다 스킴·호스트를 다시 본다 —
/// 자동 추종이면 공개 주소가 302 로 127.0.0.1·메타데이터를 가리켜도 그대로 받아 왔다(codex 리뷰).
/// 시간 제한(`timeout_ms`)은 홉 전체에 한 번 — 예전 클라이언트의 요청 시간 제한과 같다.
pub async fn fetch_spec_json(url: &str, timeout_ms: u64) -> Result<Value, SpecFetchError> {
    fetch_spec_json_with(url, timeout_ms, block_private_networks()).await
}

async fn fetch_spec_json_with(url: &str, timeout_ms: u64, block_private: bool) -> Result<Value, SpecFetchError> {
    // 주소가 아니면 예전처럼 연결 실패(reqwest 가 보내기 전에 던지던 자리)로 둔다.
    let Ok(mut current) = reqwest::Url::parse(url) else { return Err(SpecFetchError::Network) };
    if let Some(p) = spec_url_problem(&current, block_private, false) {
        return Err(SpecFetchError::Blocked(p));
    }
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
    let mut hops = 0usize;
    let res = loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        if left.is_zero() {
            return Err(SpecFetchError::Timeout);
        }
        let res = match crate::outbound::no_redirect().get(current.clone()).timeout(left).send().await {
            Ok(r) => r,
            Err(e) if crate::outbound::is_abort_timeout(&e) => return Err(SpecFetchError::Timeout),
            Err(_) => return Err(SpecFetchError::Network),
        };
        let status = res.status().as_u16();
        let location = res.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok()).map(str::to_string);
        let Some(location) = location.filter(|_| crate::outbound::is_redirect(status)) else { break res };
        drop(res);
        hops += 1;
        if hops > SPEC_MAX_REDIRECTS {
            return Err(SpecFetchError::Network); // reqwest 의 '리다이렉트가 너무 많다' 도 연결 실패로 왔다
        }
        let Ok(next) = current.join(&location) else { return Err(SpecFetchError::Network) };
        if let Some(p) = spec_url_problem(&next, block_private, true) {
            return Err(SpecFetchError::Blocked(p));
        }
        current = next;
    };
    if !res.status().is_success() {
        return Err(SpecFetchError::Status(res.status().as_u16()));
    }
    if res.content_length().map_or(false, |n| n as usize > SPEC_MAX_BYTES) {
        return Err(SpecFetchError::NotJson("스펙이 너무 큽니다".into()));
    }
    let bytes = match res.bytes().await {
        Ok(b) => b,
        Err(e) if crate::outbound::is_abort_timeout(&e) => return Err(SpecFetchError::Timeout),
        Err(_) => return Err(SpecFetchError::Network),
    };
    if bytes.len() > SPEC_MAX_BYTES {
        return Err(SpecFetchError::NotJson("스펙이 너무 큽니다".into()));
    }
    js::parse_body(&bytes).ok_or_else(|| SpecFetchError::NotJson(json_syntax_message(&String::from_utf8_lossy(&bytes))))
}

fn failed(service: &str, problem: String) -> Value {
    json!({ "service": service, "reachable": false, "endpoints": [], "schemas": {}, "problem": problem })
}

/// 스펙 URL 하나를 받아 번들로(fetchSpecBundle). 실패하면 reachable:false 인 빈 번들 + 이유 —
/// VPN·오타·빈 스펙을 구분해 보여 준다.
pub async fn fetch_spec_bundle(service: &str, url: &str, timeout_ms: u64) -> Value {
    let Ok(parsed) = reqwest::Url::parse(url) else { return failed(service, "주소 형식이 올바르지 않습니다".into()) };
    // 스펙 URL 은 사용자가 등록한 값이고 {branch} 치환으로 모양이 바뀐다 — 다른 egress 와 같은 가드를 건다.
    if let Some(p) = scheme_problem(&format!("{}:", parsed.scheme())) {
        return failed(service, p);
    }
    if is_blocked_host(parsed.host_str().unwrap_or(""), block_private_networks()) {
        return failed(service, "차단된 주소입니다(메타데이터/사설망)".into());
    }
    let doc = match fetch_spec_json(url, timeout_ms).await {
        Ok(d) => d,
        // 타임아웃은 대개 VPN·방화벽, 연결 실패는 주소·서버 다운이다.
        Err(SpecFetchError::Timeout) => {
            return failed(service, format!("{}초 안에 응답이 없습니다 — VPN·방화벽을 확인하세요", (timeout_ms as f64 / 1000.0).round()))
        }
        Err(SpecFetchError::Network) => return failed(service, "연결하지 못했습니다 — fetch failed".into()),
        Err(SpecFetchError::Status(s)) => return failed(service, format!("스펙 주소가 {s} 를 돌려줍니다")),
        Err(SpecFetchError::NotJson(_)) => return failed(service, "응답이 JSON 이 아닙니다 — 로그인 페이지를 받았을 수 있습니다".into()),
        // 리다이렉트 목적지가 가드에 걸린 경우(처음 주소는 위에서 이미 걸렀다).
        Err(SpecFetchError::Blocked(p)) => return failed(service, p),
    };
    let mut bundle = spec_to_bundle(service, &doc);
    // 붙긴 했는데 엔드포인트가 0개 — 그대로 동기화하면 요청이 통째로 폐기된다. 경고로 올린다.
    if bundle["endpoints"].as_array().map_or(true, Vec::is_empty) {
        bundle["problem"] = json!("스펙은 받았지만 엔드포인트가 0개입니다 — 상류 확인이 필요합니다");
    }
    bundle
}

#[cfg(test)]
mod tests {
    use super::*;

    // specFetch.test.ts — 네트워크가 필요 없는 것만.
    #[tokio::test]
    async fn 주소_형식_스킴_차단은_네트워크_없이_이유를_말한다() {
        assert!(fetch_spec_bundle("svc", "not a url", 15_000).await["problem"].as_str().unwrap().contains("주소 형식"));
        let b = fetch_spec_bundle("svc", "file:///etc/passwd", 15_000).await;
        assert_eq!(b["reachable"], false);
        assert!(b["problem"].as_str().unwrap().contains("file:"));
        let b = fetch_spec_bundle("svc", "http://169.254.169.254/latest/meta-data", 15_000).await;
        assert!(b["problem"].as_str().unwrap().contains("차단된 주소"));
    }

    /// 스펙 서버 목 — /spec 은 OpenAPI, 나머지는 리다이렉트.
    async fn spec_server() -> crate::executor::tests::Mock {
        use crate::executor::tests::{mock, resp};
        mock(|path, _, port| match path {
            "/spec" => resp("200 OK", &[("content-type", "application/json")], br#"{"openapi":"3.0.1","paths":{"/a":{"get":{}}}}"#),
            "/to-spec" => resp("302 Found", &[("location", "/spec")], b""),
            "/to-meta" => resp("302 Found", &[("location", "http://169.254.169.254/latest/meta-data")], b""),
            "/to-file" => resp("302 Found", &[("location", "file:///etc/passwd")], b""),
            "/to-localhost" => resp("307 Temporary Redirect", &[("location", &format!("http://localhost:{port}/spec"))], b""),
            "/loop" => resp("302 Found", &[("location", "/loop")], b""),
            _ => resp("404 Not Found", &[], b""),
        })
        .await
    }

    // codex 리뷰 P1: fetch_spec_json 이 가드 없이 불려, BLOCK_PRIVATE_NETWORKS=1 에서도 127.0.0.1 스펙을 받아 왔다
    // (폴더 동기화·스펙 확인). 가드는 이제 이 함수 안에 있다 — 환경 변수는 테스트끼리 섞이므로 인자로 준다.
    #[tokio::test]
    async fn 하드닝_모드면_사설망_스펙을_받지_않는다() {
        let m = spec_server().await;
        let e = fetch_spec_json_with(&format!("{}/spec", m.base), 5_000, true).await.unwrap_err();
        assert!(matches!(&e, SpecFetchError::Blocked(why) if why.contains("차단된 주소")), "{e:?}");
        assert!(m.seen.lock().unwrap().is_empty(), "막힌 주소로 요청이 나갔다");
        // localhost 이름도 같은 규칙
        let e = fetch_spec_json_with(&m.base.replace("127.0.0.1", "localhost"), 5_000, true).await.unwrap_err();
        assert!(matches!(e, SpecFetchError::Blocked(_)));
        // 기본 모드는 사내 주소를 그대로 허용한다(기존 규칙)
        let v = fetch_spec_json_with(&format!("{}/spec", m.base), 5_000, false).await.unwrap();
        assert_eq!(v["openapi"], "3.0.1");
    }

    #[tokio::test]
    async fn 스펙_리다이렉트는_홉마다_가드를_다시_본다() {
        let m = spec_server().await;
        // 정상 리다이렉트는 따라간다
        let v = fetch_spec_json_with(&format!("{}/to-spec", m.base), 5_000, false).await.unwrap();
        assert!(v["paths"]["/a"].is_object());
        // 메타데이터로 튀면 막는다(기본 모드에서도)
        let e = fetch_spec_json_with(&format!("{}/to-meta", m.base), 5_000, false).await.unwrap_err();
        assert!(matches!(&e, SpecFetchError::Blocked(why) if why.contains("리다이렉트 대상") && why.contains("차단된 주소")), "{e:?}");
        // file:// 로 튀면 스킴 가드
        let e = fetch_spec_json_with(&format!("{}/to-file", m.base), 5_000, false).await.unwrap_err();
        assert!(matches!(&e, SpecFetchError::Blocked(why) if why.contains("file:")), "{e:?}");
        // 상한을 넘기면 연결 실패(예전 reqwest 정책과 같다) — 영원히 돌지 않는다
        let before = m.seen.lock().unwrap().len();
        let e = fetch_spec_json_with(&format!("{}/loop", m.base), 5_000, false).await.unwrap_err();
        assert!(matches!(e, SpecFetchError::Network), "{e:?}");
        assert_eq!(m.seen.lock().unwrap().len() - before, SPEC_MAX_REDIRECTS + 1);
        // 번들 경로도 리다이렉트 목적지 차단을 이유로 보여 준다(처음 주소만 보던 예전 검사로는 못 막았다)
        let b = fetch_spec_bundle("svc", &format!("{}/to-meta", m.base), 5_000).await;
        assert_eq!(b["reachable"], false);
        assert!(b["problem"].as_str().unwrap().contains("차단된 주소"), "{b}");
    }

    #[test]
    fn 하드닝_모드의_리다이렉트_목적지_검사() {
        // 공개 주소 → localhost 로 튀는 경우는 목 서버(언제나 loopback)로 재현할 수 없어 판정 함수를 직접 본다.
        let next = reqwest::Url::parse("http://localhost:9/spec").unwrap();
        assert!(spec_url_problem(&next, true, true).unwrap().starts_with("리다이렉트 대상 차단된 주소"));
        assert_eq!(spec_url_problem(&next, false, true), None);
        let public = reqwest::Url::parse("https://api.example.com/v3/api-docs").unwrap();
        assert_eq!(spec_url_problem(&public, true, false), None);
    }

    #[test]
    fn 번들_변환() {
        let b = spec_to_bundle("s", &json!({ "paths": { "/x": { "get": {}, "post": { "deprecated": true, "tags": ["T"] } } } }));
        let eps = b["endpoints"].as_array().unwrap();
        assert_eq!(eps.iter().map(|e| e["method"].clone()).collect::<Vec<_>>(), vec![json!("GET"), json!("POST")]);
        assert_eq!(eps[1]["deprecated"], true);
        assert_eq!(eps[1]["tags"], json!(["T"]));
        assert_eq!(spec_to_bundle("s", &json!({}))["endpoints"], json!([]));
        assert_eq!(spec_to_bundle("s", &Value::Null)["endpoints"], json!([]));
        assert_eq!(spec_to_bundle("s", &json!({ "paths": { "/x": null } }))["endpoints"], json!([]));
    }
}
