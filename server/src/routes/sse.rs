//! `/api/sse`. SSE·스트리밍 프록시.
//!
//! 브라우저 EventSource 는 인증 헤더를 못 붙여서 서버가 대신 붙여 연결하고, 업스트림 본문을 **모으지 않고**
//! 그대로 흘린다(text/event-stream·chunked NDJSON). 끝나지 않는 스트림이라 모으면 응답이 영영 안 나간다.
//!
//! 보안 경계 — TS 와 글자 하나까지 같은 순서로 막는다:
//!   1. http/https 만(file://·ftp:// 는 '우연히' 막히던 것을 명시적으로)
//!   2. SSRF 가드(메타데이터는 언제나, BLOCK_PRIVATE_NETWORKS=1 이면 사설망까지)
//!   3. 리다이렉트는 따라가지 않고 400 — 3xx 의 Location 으로 가드를 우회하지 못하게
//! 한계: 호스트명이 사설 IP 로 해석되는 DNS 리바인딩은 이 문자열 검사로 못 막는다.

use axum::body::{Body, Bytes};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use futures_util::TryStreamExt;
use serde_json::{json, Value};

use crate::jsval::reply;
use crate::ssrf_guard::{block_private_networks, is_blocked_host, scheme_problem};
use crate::{js, outbound, AppState};

pub fn router() -> Router<AppState> {
    Router::new().route("/api/sse", post(sse))
}

fn err(status: StatusCode, msg: &str) -> Response {
    reply(status, &json!({ "error": msg }))
}

/// Headers 가 값 앞뒤의 HTTP 공백(탭·LF·CR·스페이스)을 걷어 내는 규칙.
fn http_trim(s: &str) -> &str {
    s.trim_matches(|c| matches!(c, '\t' | '\n' | '\r' | ' '))
}

/// `{ accept: ..., [h.key]: h.value }` 를 `new Headers(record)` 로 — 같은 키는 객체에서 덮어쓰이고,
/// 대소문자만 다른 키는 Headers 가 ", " 로 이어 붙인다.
fn build_headers(list: Option<&Value>) -> Vec<(String, String)> {
    let mut record: Vec<(String, String)> = vec![("accept".into(), "text/event-stream".into())];
    // 비배열 headers 면 for..of 가 500 이었다 — 배열만 받는다.
    if let Some(Value::Array(items)) = list {
        for h in items {
            if !js::truthy(h.get("enabled")) || !js::truthy(h.get("key")) {
                continue;
            }
            let k = js::to_string(&h["key"]);
            if k == "__proto__" {
                continue; // 객체 리터럴에서 이 키는 프로토타입을 바꿀 뿐 헤더가 되지 않는다
            }
            let v = h.get("value").map_or_else(|| "undefined".to_string(), js::to_string);
            match record.iter_mut().find(|(n, _)| *n == k) {
                Some(slot) => slot.1 = v,
                None => record.push((k, v)),
            }
        }
    }
    let mut merged: Vec<(String, String)> = vec![];
    for (k, v) in record {
        let v = http_trim(&v).to_string();
        match merged.iter_mut().find(|(n, _)| n.eq_ignore_ascii_case(&k)) {
            Some(slot) => slot.1 = format!("{}, {v}", slot.1),
            None => merged.push((k.to_ascii_lowercase(), v)),
        }
    }
    merged
}

async fn sse(body: Bytes) -> Response {
    let b = js::parse_body(&body);
    let raw_url = b.as_ref().and_then(|v| v.get("url"));
    if !js::truthy(raw_url) {
        return err(StatusCode::BAD_REQUEST, "url required");
    }
    // new URL(b.url) 은 문자열이 아니면 String() 으로 읽는다 — 같은 규칙.
    let Ok(parsed) = url::Url::parse(&js::to_string(raw_url.unwrap())) else {
        return err(StatusCode::BAD_REQUEST, "URL 이 올바르지 않습니다");
    };
    // 실행 경로와 같은 규칙 — 막는 이유를 사람이 읽을 문장으로.
    if let Some(bad) = scheme_problem(&format!("{}:", parsed.scheme())) {
        return err(StatusCode::BAD_REQUEST, &bad);
    }
    if is_blocked_host(parsed.host_str().unwrap_or(""), block_private_networks()) {
        return err(StatusCode::BAD_REQUEST, "차단된 주소입니다(메타데이터/사설망)");
    }

    // fetch 는 URL 에 아이디·비밀번호가 든 요청을 만들지 않고 던진다(→ 502). 예전엔 그대로 보내서 Node 와 달랐다(codex 리뷰).
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return err(StatusCode::BAD_GATEWAY, &format!("Request cannot be constructed from a URL that includes credentials: {parsed}"));
    }
    // fetch 처럼 압축을 풀어 주는 클라이언트 — 예전엔 압축을 풀지 않는 프록시용 클라이언트를 써서 gzip 바이트가 흘렀다.
    let mut req = outbound::no_redirect().get(parsed).timeout(std::time::Duration::from_secs(300));
    for (k, v) in build_headers(b.as_ref().and_then(|v| v.get("headers"))) {
        let name = match header::HeaderName::from_bytes(k.as_bytes()) {
            Ok(n) => n,
            Err(_) => return err(StatusCode::BAD_GATEWAY, &format!("Headers.append: \"{k}\" is an invalid header name.")),
        };
        let value = match header::HeaderValue::from_str(&v) {
            Ok(v) => v,
            Err(_) => return err(StatusCode::BAD_GATEWAY, &format!("Headers.append: \"{v}\" is an invalid header value.")),
        };
        req = req.header(name, value);
    }
    // 리다이렉트는 따라가지 않는다(no_redirect) — 아래에서 3xx 를 거절한다.
    let upstream = match req.send().await {
        Ok(r) => r,
        Err(e) => return err(StatusCode::BAD_GATEWAY, &outbound::fetch_error_message(&e)),
    };
    let status = upstream.status().as_u16();
    if (300..400).contains(&status) {
        return err(StatusCode::BAD_REQUEST, "리다이렉트되었습니다(보안상 차단)");
    }
    // `!upstream.ok || !upstream.body` — 본문이 없는 상태(204·205 등)는 fetch 에서 body 가 null 이라 실패로 본다.
    if !upstream.status().is_success() || matches!(status, 204 | 205) {
        return err(StatusCode::BAD_GATEWAY, &format!("업스트림 {status}"));
    }
    let content_type = upstream
        .headers()
        .get(header::CONTENT_TYPE)
        .cloned()
        .unwrap_or_else(|| header::HeaderValue::from_static("text/event-stream"));
    // 업스트림 본문을 그대로 흘린다 — 모으지 않는다.
    let stream = upstream.bytes_stream().map_err(std::io::Error::other);
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, content_type), (header::CACHE_CONTROL, header::HeaderValue::from_static("no-cache, no-transform"))],
        Body::from_stream(stream),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::variables::tests::test_db;
    use axum::http::Request;
    use tower::ServiceExt;

    fn state() -> AppState {
        let config = crate::Config { host: "127.0.0.1".into(), port: 0, db_path: ":memory:".into(), migrations_dir: Default::default(), static_dir: None };
        AppState { db: test_db(), config }
    }

    async fn call(body: Value) -> (StatusCode, Value) {
        let req = Request::post("/api/sse").body(Body::from(body.to_string())).unwrap();
        let res = router().with_state(state()).oneshot(req).await.unwrap();
        let status = res.status();
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    #[tokio::test]
    async fn 가드는_스킴_메타데이터_순서로() {
        assert_eq!(call(json!({})).await, (StatusCode::BAD_REQUEST, json!({ "error": "url required" })));
        assert_eq!(call(json!({ "url": "not a url" })).await.1, json!({ "error": "URL 이 올바르지 않습니다" }));
        let (st, body) = call(json!({ "url": "file:///etc/passwd" })).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("file://"));
        for u in ["http://169.254.169.254/latest", "http://[::ffff:a9fe:a9fe]/", "http://2852039166/", "http://metadata.google.internal/"] {
            assert_eq!(call(json!({ "url": u })).await, (StatusCode::BAD_REQUEST, json!({ "error": "차단된 주소입니다(메타데이터/사설망)" })), "{u}");
        }
    }

    /// 한 번 응답하고 닫는 작은 HTTP 서버 — 실제 외부 서비스를 부르지 않는다.
    async fn stub(response: &'static str) -> String {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let (mut sock, _) = l.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let _ = sock.read(&mut buf).await;
            sock.write_all(response.as_bytes()).await.unwrap();
        });
        format!("http://{addr}/")
    }

    #[tokio::test]
    async fn 리다이렉트는_따라가지_않는다() {
        let u = stub("HTTP/1.1 302 Found\r\nLocation: http://169.254.169.254/\r\nContent-Length: 0\r\n\r\n").await;
        assert_eq!(call(json!({ "url": u })).await, (StatusCode::BAD_REQUEST, json!({ "error": "리다이렉트되었습니다(보안상 차단)" })));
    }

    #[tokio::test]
    async fn 본문을_흘려보낸다() {
        let u = stub("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 12\r\n\r\ndata: hi\n\n\n\n").await;
        let req = Request::post("/api/sse").body(Body::from(json!({ "url": u }).to_string())).unwrap();
        let res = router().with_state(state()).oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers()[header::CACHE_CONTROL], "no-cache, no-transform");
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
        assert!(bytes.starts_with(b"data: hi"));
    }

    /// 바이트를 그대로 써 주는 스텁 — gzip 본문처럼 글자가 아닌 응답용.
    async fn stub_bytes(head: &'static str, body: Vec<u8>) -> String {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let (mut sock, _) = l.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let _ = sock.read(&mut buf).await;
            sock.write_all(format!("{head}Content-Length: {}\r\n\r\n", body.len()).as_bytes()).await.unwrap();
            sock.write_all(&body).await.unwrap();
        });
        format!("http://{addr}/")
    }

    #[tokio::test]
    async fn gzip_스트림은_풀어서_흘린다() {
        // codex 리뷰 재현: Node 는 'data: hello' 를, 예전 Rust 는 1f 8b 로 시작하는 gzip 원문을 내보냈다.
        use std::io::Write;
        let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        e.write_all(b"data: hello\n\n").unwrap();
        let u = stub_bytes("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Encoding: gzip\r\n", e.finish().unwrap()).await;
        let body = json!({ "url": u, "headers": [{ "key": "Accept-Encoding", "value": "gzip", "enabled": true }] });
        let req = Request::post("/api/sse").body(Body::from(body.to_string())).unwrap();
        let res = router().with_state(state()).oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
        assert_eq!(&bytes[..], b"data: hello\n\n");
    }

    #[tokio::test]
    async fn url_자격증명과_본문_없는_응답은_502() {
        let (st, body) = call(json!({ "url": "http://demo:pass@127.0.0.1:9/plain" })).await;
        assert_eq!(st, StatusCode::BAD_GATEWAY);
        assert_eq!(body["error"], "Request cannot be constructed from a URL that includes credentials: http://demo:pass@127.0.0.1:9/plain");
        let u = stub("HTTP/1.1 204 No Content\r\n\r\n").await;
        assert_eq!(call(json!({ "url": u })).await, (StatusCode::BAD_GATEWAY, json!({ "error": "업스트림 204" })));
    }

    #[test]
    fn 헤더는_객체처럼_덮고_대소문자만_다르면_잇는다() {
        let h = build_headers(Some(&json!([
            { "key": "Accept", "value": "application/json", "enabled": true },
            { "key": "X-A", "value": " 1 ", "enabled": true },
            { "key": "X-A", "value": "2", "enabled": true },
            { "key": "X-Off", "value": "x", "enabled": false },
        ])));
        assert_eq!(h, vec![("accept".to_string(), "text/event-stream, application/json".to_string()), ("x-a".to_string(), "2".to_string())]);
    }
}
