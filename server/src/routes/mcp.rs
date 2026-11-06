//! MCP 전송.
//!
//! 사용자의 Claude(Code/Desktop)가 postq 를 도구로 부린다. 서버는 LLM 을 부르지 않는다(비용 0).
//! 연결: `claude mcp add --transport http postq http://localhost:3000/api/mcp/mcp`
//!
//! 경로(mcp-handler 의 basePath 규칙)
//! - `/api/mcp/mcp` — streamable HTTP. sessionIdGenerator 를 안 줬으니 **무상태**: POST 마다 새 서버, 세션 헤더 없음.
//!   응답은 SSE 한 줄기(`event: message`)로, 요청이 없는 POST(알림·응답뿐)는 202. GET 은 405.
//! - `/api/mcp/sse` + `/api/mcp/message?sessionId=` — 예전(2024-11-05) SSE 전송. Node 는 이걸 Redis pub/sub 로 잇는데
//!   REDIS_URL 이 없는 이 앱에선 연결이 매달린 채 끝나지 않았다. 여기서는 한 프로세스라 Redis 없이 메모리로 잇는다 —
//!   응답 모양(endpoint 이벤트·202 Accepted·message 이벤트)과 최대 60초(maxDuration 기본값)는 mcp-handler 그대로다.
//! - 그 밖의 `/api/mcp/*` — 404 "Not found".
//!
//! 인증: 앱에 로그인이 없다. 선택으로 `MCP_TOKEN` 을 주면 `/api/mcp/*` 만 `Authorization: Bearer <MCP_TOKEN>` 을
//! 요구한다 — 앞단 프록시로 SSO 를 붙이고 쿠키가 없는 헤드리스 MCP 클라이언트만 그 프록시를 건너뛰게 할 때 쓴다
//! (docs/auth.md). 다른 `/api` 경로는 막지 않으므로, 이것만으로 앱을 바깥에 열어도 되는 것은 아니다.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{Path, RawQuery, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::mcp::{classify, handle_request, is_initialize_request, Message, SUPPORTED_PROTOCOL_VERSIONS};
use crate::{js, AppState};

const SSE_MESSAGE_ENDPOINT: &str = "/api/mcp/message";
/// mcp-handler 에 maxDuration 을 안 넘기면 60초 뒤 SSE 연결을 닫는다.
const SSE_MAX_DURATION: Duration = Duration::from_secs(60);

pub fn router() -> Router<AppState> {
    Router::new().route("/api/mcp/{transport}", get(transport).post(transport)).route("/api/mcp-info", get(mcp_info))
}

/// `MCP_TOKEN` — 비었으면 토큰 검사 없음. 기동 뒤에 바꿔도 다음 요청부터 따른다.
fn mcp_token() -> Option<String> {
    std::env::var("MCP_TOKEN").ok().filter(|t| !t.is_empty())
}

/// 길이가 같으면 끝까지 비교한다 — 앞 글자부터 맞춰 보는 시간 차로 토큰을 알아내지 못하게.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// 토큰을 정하지 않았으면 통과, 정했으면 `Bearer <토큰>` 이 정확히 맞아야 통과.
fn token_ok(token: Option<&str>, headers: &HeaderMap) -> bool {
    let Some(t) = token else { return true };
    let got = headers.get(header::AUTHORIZATION).map(|v| v.as_bytes()).unwrap_or_default();
    ct_eq(got, format!("Bearer {t}").as_bytes())
}

/// 연결 안내 — 화면(Claude 에서 쓰기)이 연결 명령에 토큰 헤더 자리를 넣을지 정한다. 토큰 값은 내려보내지 않는다:
/// 이 경로는 토큰 검사 밖이라, 값을 주면 /api/mcp 를 프록시 밖으로 뺀 배포에서 누구나 토큰을 읽어 갈 수 있다.
async fn mcp_info() -> Response {
    plain(StatusCode::OK, Some("application/json"), &js::stringify(&json!({ "tokenRequired": mcp_token().is_some() })))
}

async fn transport(
    State(s): State<AppState>,
    Path(t): Path<String>,
    method: Method,
    RawQuery(q): RawQuery,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !token_ok(mcp_token().as_deref(), &headers) {
        let mut r = plain(StatusCode::UNAUTHORIZED, Some("application/json"), r#"{"error":"unauthorized"}"#);
        r.headers_mut().insert(header::WWW_AUTHENTICATE, axum::http::HeaderValue::from_static("Bearer"));
        return r;
    }
    match t.as_str() {
        "mcp" if method == Method::POST => streamable_post(s, &headers, &body).await,
        "mcp" => plain(StatusCode::METHOD_NOT_ALLOWED, None, &js::stringify(&rpc_error_body(-32000, "Method not allowed."))),
        "sse" => sse_open(&method, &headers),
        "message" => sse_message(s, q.as_deref(), &headers, &body),
        _ => plain(StatusCode::NOT_FOUND, None, "Not found"),
    }
}

fn plain(status: StatusCode, content_type: Option<&str>, body: &str) -> Response {
    let mut b = Response::builder().status(status);
    if let Some(ct) = content_type {
        b = b.header(header::CONTENT_TYPE, ct);
    }
    b.body(Body::from(body.to_string())).unwrap_or_default()
}

fn rpc_error_body(code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "error": { "code": code, "message": message }, "id": null })
}

/// SDK 의 createJsonErrorResponse.
fn json_error(status: u16, code: i64, message: &str) -> Response {
    let st = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST);
    plain(st, Some("application/json"), &js::stringify(&rpc_error_body(code, message)))
}

fn header_str<'a>(h: &'a HeaderMap, k: &str) -> Option<&'a str> {
    h.get(k).and_then(|v| v.to_str().ok())
}

fn sse_event(v: &Value) -> String {
    format!("event: message\ndata: {}\n\n", js::stringify(v))
}

fn sse_response(rx: mpsc::UnboundedReceiver<String>, cache_control: &str, first: Option<String>, guard: Option<SessionGuard>) -> Response {
    struct St {
        rx: mpsc::UnboundedReceiver<String>,
        first: Option<String>,
        deadline: Option<tokio::time::Instant>,
        _guard: Option<SessionGuard>,
    }
    let deadline = guard.as_ref().map(|_| tokio::time::Instant::now() + SSE_MAX_DURATION);
    let st = St { rx, first, deadline, _guard: guard };
    let stream = futures_util::stream::unfold(st, |mut st| async move {
        if let Some(f) = st.first.take() {
            return Some((Ok::<Bytes, std::convert::Infallible>(Bytes::from(f)), st));
        }
        let next = match st.deadline {
            Some(d) => tokio::time::timeout_at(d, st.rx.recv()).await.ok().flatten(),
            None => st.rx.recv().await,
        };
        next.map(|m| (Ok(Bytes::from(m)), st))
    });
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, cache_control)
        .header(header::CONNECTION, "keep-alive")
        .body(Body::from_stream(stream))
        .unwrap_or_default()
}

// ── streamable HTTP(무상태) ────────────────────────────────────────────

async fn streamable_post(s: AppState, headers: &HeaderMap, body: &Bytes) -> Response {
    let accept = header_str(headers, "accept").unwrap_or("");
    if !accept.contains("application/json") || !accept.contains("text/event-stream") {
        return json_error(406, -32000, "Not Acceptable: Client must accept both application/json and text/event-stream");
    }
    if !header_str(headers, "content-type").map_or(false, |c| c.contains("application/json")) {
        return json_error(415, -32000, "Unsupported Media Type: Content-Type must be application/json");
    }
    // Node(mcp-handler)는 깨진 JSON 에서 req.json() 이 던진 채 응답을 못 쓰고 매달렸다. 매달리는 대신 SDK 의 문장으로 400.
    let Some(raw) = js::parse_body(body) else {
        return json_error(400, -32700, "Parse error: Invalid JSON");
    };
    let items: Vec<Value> = match raw {
        Value::Array(a) => a,
        one => vec![one],
    };
    let mut messages = Vec::with_capacity(items.len());
    for m in &items {
        match classify(m) {
            Some(x) => messages.push(x),
            None => return json_error(400, -32700, "Parse error: Invalid JSON-RPC message"),
        }
    }
    let has_init = items.iter().any(is_initialize_request);
    if has_init && items.len() > 1 {
        return json_error(400, -32600, "Invalid Request: Only one initialization request is allowed");
    }
    if !has_init {
        if let Some(v) = headers.get("mcp-protocol-version") {
            let v = String::from_utf8_lossy(v.as_bytes()).into_owned();
            if !SUPPORTED_PROTOCOL_VERSIONS.contains(&v.as_str()) {
                return json_error(
                    400,
                    -32000,
                    &format!("Bad Request: Unsupported protocol version: {v} (supported versions: {})", SUPPORTED_PROTOCOL_VERSIONS.join(", ")),
                );
            }
        }
    }
    let requests: Vec<(Value, String, Option<Value>)> = messages
        .into_iter()
        .filter_map(|m| match m {
            Message::Request { id, method, params } => Some((id, method, params)),
            _ => None,
        })
        .collect();
    if requests.is_empty() {
        // 알림·응답뿐이면 202 — 무상태라 받은 알림(initialized 등)으로 바뀌는 것도 없다.
        return plain(StatusCode::ACCEPTED, None, "");
    }
    // 헤더를 먼저 보내고 도구가 끝나는 대로 이벤트를 쓴다 — 실행이 오래 걸려도 클라이언트가 연결을 안 끊게.
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        for (id, method, params) in requests {
            let reply = handle_request(&s, &id, &method, params.as_ref()).await;
            if tx.send(sse_event(&reply)).is_err() {
                break;
            }
        }
    });
    sse_response(rx, "no-cache", None, None)
}

// ── SSE(2024-11-05) ────────────────────────────────────────────────────

static SESSIONS: LazyLock<Mutex<HashMap<String, mpsc::UnboundedSender<String>>>> = LazyLock::new(Default::default);

/// SSE 연결이 끝나면(클라이언트가 끊거나 60초) 세션을 지운다 — 남겨 두면 /message 가 죽은 연결로 보낸다.
struct SessionGuard(String);

impl Drop for SessionGuard {
    fn drop(&mut self) {
        if let Ok(mut m) = SESSIONS.lock() {
            m.remove(&self.0);
        }
    }
}

fn sse_open(method: &Method, headers: &HeaderMap) -> Response {
    if method != Method::GET {
        return plain(StatusCode::METHOD_NOT_ALLOWED, Some("text/plain"), "Method Not Allowed");
    }
    if let Some(a) = header_str(headers, "accept") {
        if !a.contains("text/event-stream") && !a.contains("*/*") && !a.contains("text/*") {
            return plain(StatusCode::NOT_ACCEPTABLE, Some("text/plain"), "Not Acceptable");
        }
    }
    let session_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::unbounded_channel();
    if let Ok(mut m) = SESSIONS.lock() {
        m.insert(session_id.clone(), tx);
    }
    let endpoint = format!("event: endpoint\ndata: {SSE_MESSAGE_ENDPOINT}?sessionId={session_id}\n\n");
    sse_response(rx, "no-cache, no-transform", Some(endpoint), Some(SessionGuard(session_id)))
}

/// content-type 패키지의 parse 결과(type) — 실패면 그 오류 문장(String(error)).
fn media_type(ct: &str) -> Result<String, String> {
    if ct.is_empty() {
        return Err("TypeError: argument obj is required".into());
    }
    let t = ct.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    let token = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+.^_`|~-".contains(&b));
    match t.split_once('/') {
        Some((a, b)) if token(a) && token(b) => Ok(t),
        _ => Err("TypeError: invalid media type".into()),
    }
}

fn sse_message(s: AppState, query: Option<&str>, headers: &HeaderMap, body: &Bytes) -> Response {
    let session_id = js::query_get(query, "sessionId").unwrap_or_default();
    if session_id.is_empty() {
        return plain(StatusCode::BAD_REQUEST, None, "No sessionId provided");
    }
    let tx = SESSIONS.lock().ok().and_then(|m| m.get(&session_id).cloned());
    // Node 는 그 세션을 쥔 연결이 없으면 10초 기다렸다 408 을 냈다. 기다려도 생기지 않으니 바로 같은 응답을.
    let Some(tx) = tx else {
        return plain(StatusCode::REQUEST_TIMEOUT, None, "Request timed out");
    };
    match media_type(header_str(headers, "content-type").unwrap_or("")) {
        Ok(t) if t == "application/json" => {}
        Ok(t) => return plain(StatusCode::BAD_REQUEST, None, &format!("Error: Unsupported content-type: {t}")),
        Err(e) => return plain(StatusCode::BAD_REQUEST, None, &e),
    }
    // mcp-handler 는 본문을 한 번 JSON.parse 해 넘기고(되면 다시 stringify) SDK 가 다시 읽는다 — 오류 문장의 본문도 그 글자다.
    let text = String::from_utf8_lossy(body).into_owned();
    let parsed = js::parse_json(&text);
    let shown = match &parsed {
        Some(Value::String(inner)) => inner.clone(),
        Some(v) => js::stringify(v),
        None => text,
    };
    let msg = match &parsed {
        Some(Value::String(_)) | None => None,
        Some(v) => classify(v),
    };
    let Some(msg) = msg else {
        return plain(StatusCode::BAD_REQUEST, None, &format!("Invalid message: {shown}"));
    };
    if let Message::Request { id, method, params } = msg {
        tokio::spawn(async move {
            let reply = handle_request(&s, &id, &method, params.as_ref()).await;
            let _ = tx.send(sse_event(&reply));
        });
    }
    plain(StatusCode::ACCEPTED, None, "Accepted")
}

#[cfg(test)]
mod tests {
    #[test]
    fn mcp_token_은_정했을_때만_bearer_를_정확히_요구한다() {
        use super::token_ok;
        use axum::http::{HeaderMap, HeaderValue};
        let with = |v: &'static str| {
            let mut h = HeaderMap::new();
            h.insert("authorization", HeaderValue::from_static(v));
            h
        };
        assert!(token_ok(None, &HeaderMap::new()));
        assert!(token_ok(None, &with("Bearer anything")));
        assert!(token_ok(Some("tok"), &with("Bearer tok")));
        for bad in ["Bearer tok2", "Bearer to", "bearer tok", "tok", "Bearer  tok"] {
            assert!(!token_ok(Some("tok"), &with(bad)), "{bad}");
        }
        assert!(!token_ok(Some("tok"), &HeaderMap::new()));
    }

    use super::*;
    use axum::http::Request;
    use futures_util::StreamExt;
    use tower::ServiceExt;

    fn app() -> Router {
        router().with_state(crate::mcp_tools::tests::state())
    }

    async fn post(app: &Router, uri: &str, headers: &[(&str, &str)], body: &str) -> (StatusCode, HeaderMap, String) {
        let mut b = Request::post(uri);
        for (k, v) in headers {
            b = b.header(*k, *v);
        }
        let res = app.clone().oneshot(b.body(Body::from(body.to_string())).unwrap()).await.unwrap();
        let (st, h) = (res.status(), res.headers().clone());
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
        (st, h, String::from_utf8_lossy(&bytes).into_owned())
    }

    const OK_HEADERS: [(&str, &str); 2] = [("accept", "application/json, text/event-stream"), ("content-type", "application/json")];

    // 기대값은 Node(mcp-handler)에 같은 요청을 넣어 받은 응답에서 옮겼다.
    #[tokio::test]
    async fn streamable_http_는_node_와_같은_응답() {
        let app = app();
        let (st, h, body) = post(&app, "/api/mcp/mcp", &OK_HEADERS, r#"{"jsonrpc":"2.0","id":3,"method":"ping"}"#).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(h["content-type"], "text/event-stream");
        assert_eq!(h["cache-control"], "no-cache");
        assert_eq!(body, "event: message\ndata: {\"result\":{},\"jsonrpc\":\"2.0\",\"id\":3}\n\n");

        let (st, _, body) = post(&app, "/api/mcp/mcp", &OK_HEADERS, r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#).await;
        assert_eq!((st, body.as_str()), (StatusCode::ACCEPTED, ""));

        let (st, _, body) =
            post(&app, "/api/mcp/mcp", &OK_HEADERS, r#"[{"jsonrpc":"2.0","id":10,"method":"ping"},{"jsonrpc":"2.0","id":11,"method":"nope"}]"#).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(
            body,
            "event: message\ndata: {\"result\":{},\"jsonrpc\":\"2.0\",\"id\":10}\n\nevent: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":11,\"error\":{\"code\":-32601,\"message\":\"Method not found\"}}\n\n"
        );

        let (st, h, body) = post(&app, "/api/mcp/mcp", &OK_HEADERS, r#"{"foo":1}"#).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert_eq!(h["content-type"], "application/json");
        assert_eq!(body, r#"{"jsonrpc":"2.0","error":{"code":-32700,"message":"Parse error: Invalid JSON-RPC message"},"id":null}"#);

        let (st, _, body) = post(&app, "/api/mcp/mcp", &[("accept", "application/json"), ("content-type", "application/json")], "{}").await;
        assert_eq!(st, StatusCode::NOT_ACCEPTABLE);
        assert!(body.contains("Not Acceptable: Client must accept both application/json and text/event-stream"));

        let (st, _, body) = post(&app, "/api/mcp/mcp", &[("accept", "application/json, text/event-stream"), ("content-type", "text/plain")], "{}").await;
        assert_eq!(st, StatusCode::UNSUPPORTED_MEDIA_TYPE);
        assert!(body.contains("Unsupported Media Type"));

        let mut hs = OK_HEADERS.to_vec();
        hs.push(("mcp-protocol-version", "1999"));
        let (st, _, body) = post(&app, "/api/mcp/mcp", &hs, r#"{"jsonrpc":"2.0","id":3,"method":"ping"}"#).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(body.contains("Bad Request: Unsupported protocol version: 1999 (supported versions: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07)"));

        let res = app.clone().oneshot(Request::get("/api/mcp/mcp").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), StatusCode::METHOD_NOT_ALLOWED);
        let res = app.clone().oneshot(Request::get("/api/mcp/zzz").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);

        let (st, _, body) = post(&app, "/api/mcp/mcp", &OK_HEADERS, r#"{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"search_requests","arguments":{"query":""}}}"#).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(
            body,
            "event: message\ndata: {\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"{\\n  \\\"total\\\": 0,\\n  \\\"requests\\\": []\\n}\"}]},\"jsonrpc\":\"2.0\",\"id\":8}\n\n"
        );
    }

    #[tokio::test]
    async fn sse_전송은_endpoint_를_알리고_응답을_스트림으로() {
        let app = app();
        let res = app.clone().oneshot(Request::get("/api/mcp/sse").header("accept", "text/event-stream").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers()["cache-control"], "no-cache, no-transform");
        let mut stream = res.into_body().into_data_stream();
        let first = String::from_utf8(stream.next().await.unwrap().unwrap().to_vec()).unwrap();
        let path = first.strip_prefix("event: endpoint\ndata: ").unwrap().trim_end().to_string();
        assert!(path.starts_with("/api/mcp/message?sessionId="));

        let (st, _, body) = post(&app, &path, &[("content-type", "application/json")], r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#).await;
        assert_eq!((st, body.as_str()), (StatusCode::ACCEPTED, "Accepted"));
        let ev = String::from_utf8(stream.next().await.unwrap().unwrap().to_vec()).unwrap();
        assert_eq!(ev, "event: message\ndata: {\"result\":{},\"jsonrpc\":\"2.0\",\"id\":1}\n\n");

        let (st, _, body) = post(&app, &path, &[("content-type", "text/plain")], "{}").await;
        assert_eq!((st, body.as_str()), (StatusCode::BAD_REQUEST, "Error: Unsupported content-type: text/plain"));
        let (st, _, body) = post(&app, &path, &[("content-type", "application/json")], r#"{"a":1}"#).await;
        assert_eq!((st, body.as_str()), (StatusCode::BAD_REQUEST, r#"Invalid message: {"a":1}"#));
        let (st, _, body) = post(&app, "/api/mcp/message", &[], "").await;
        assert_eq!((st, body.as_str()), (StatusCode::BAD_REQUEST, "No sessionId provided"));

        // 연결이 끝나면 세션도 사라진다.
        drop(stream);
        let (st, _, _) = post(&app, &path, &[("content-type", "application/json")], r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#).await;
        assert_eq!(st, StatusCode::REQUEST_TIMEOUT);

        let res = app.clone().oneshot(Request::post("/api/mcp/sse").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), StatusCode::METHOD_NOT_ALLOWED);
        let res = app.clone().oneshot(Request::get("/api/mcp/sse").header("accept", "application/json").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), StatusCode::NOT_ACCEPTABLE);
    }
}
