//! 브라우저가 보내는 남의 요청을 막는다.
//!
//! 로그인이 없으므로 이 서버에 닿는 요청은 전부 주인의 요청으로 취급된다. 루프백에만 열어도 그 컴퓨터의 브라우저는
//! 닿는다 — 다른 웹사이트(다른 포트의 로컬 페이지 포함)가 응답은 못 읽어도 `/api/execute` 같은 쓰기 요청을 보낼 수
//! 있고(CSRF), 자기 도메인을 127.0.0.1 로 풀리게 바꿔 응답까지 읽을 수 있다(DNS 리바인딩). 그래서 두 가지를 본다.
//!
//! 1. **Host** — `Host` 와 (프록시가 붙인) `X-Forwarded-Host` 가 모두 루프백 이름(`localhost`, `*.localhost`,
//!    127.0.0.1, ::1)이거나 `POSTQ_ALLOWED_HOSTS` 에 적은 이름이어야 한다. 리바인딩한 페이지는 Host 가 자기
//!    도메인이라 떨어진다. Next 개발 프록시는 Host 를 백엔드 주소로 바꾸고 원래 값을 X-Forwarded-Host 에 남긴다.
//! 2. **`/api/*` 의 출처** — `Origin` 이 있으면 요청이 향한 주소(X-Forwarded-Host, 없으면 Host)와 호스트·포트가
//!    **정확히** 같아야 한다(브라우저 확장은 허용). 같은 컴퓨터의 다른 포트 페이지도 다른 출처다.
//!    그리고 `Sec-Fetch-Site` 는 없거나 `same-origin`·`none` 이어야 한다 — 브라우저가 스킴까지 보고 매기는 값이라
//!    http 페이지가 https 서버로 보내는 요청, Origin 없는 `<img src>` 같은 GET 도 여기서 떨어진다.
//!
//! curl·스크립트·MCP 클라이언트는 `Origin` 도 `Sec-Fetch-Site` 도 보내지 않으므로 그대로 통과한다.

use axum::extract::Request;
use axum::http::{header, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde_json::json;
use std::sync::OnceLock;

/// `POSTQ_ALLOWED_HOSTS` — 쉼표로 나눈 호스트 이름(포트 없이). 앞단 프록시 뒤에 둘 때 그 도메인을 적는다.
fn extra_hosts() -> &'static [String] {
    static EXTRA: OnceLock<Vec<String>> = OnceLock::new();
    EXTRA.get_or_init(|| parse_hosts(&std::env::var("POSTQ_ALLOWED_HOSTS").unwrap_or_default()))
}

fn parse_hosts(raw: &str) -> Vec<String> {
    raw.split(',').map(|h| h.trim().trim_end_matches('.').to_ascii_lowercase()).filter(|h| !h.is_empty()).collect()
}

/// `host:port`·`[::1]:port`·`host` 를 (호스트 이름, 포트) 로. 모양이 틀리면 None — 엄격하게 본다.
fn split_authority(authority: &str) -> Option<(String, Option<u16>)> {
    let a = authority.trim();
    let (name, port) = if let Some(rest) = a.strip_prefix('[') {
        let (inner, after) = rest.split_once(']')?;
        let port = match after {
            "" => None,
            p => Some(p.strip_prefix(':')?),
        };
        (inner, port)
    } else {
        match a.split_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (a, None),
        }
    };
    let port = match port {
        Some(p) => Some(p.parse::<u16>().ok()?),
        None => None,
    };
    let name = name.trim_end_matches('.').to_ascii_lowercase();
    if name.is_empty() || name.contains(['/', '@', ' ', '[', ']']) {
        return None;
    }
    Some((name, port))
}

fn is_loopback_name(name: &str) -> bool {
    name == "localhost"
        || name.ends_with(".localhost")
        || name.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

fn host_allowed(authority: &str, extra: &[String]) -> bool {
    split_authority(authority).is_some_and(|(name, _)| is_loopback_name(&name) || extra.iter().any(|h| *h == name))
}

const EXTENSIONS: [&str; 3] = ["chrome-extension://", "moz-extension://", "safari-web-extension://"];

/// Origin 이 요청이 향한 주소(`scheme`, `target` = host[:port])와 같은가. 기본 포트는 생략된 쪽과 같게 본다.
fn same_origin(origin: &str, scheme: &str, target: &str) -> bool {
    let (rest, default_port) = if let Some(r) = origin.strip_prefix("http://") {
        (r, 80)
    } else if let Some(r) = origin.strip_prefix("https://") {
        (r, 443)
    } else {
        return false; // "null"(샌드박스 iframe·file://) 등
    };
    if !origin.starts_with(&format!("{scheme}://")) {
        return false; // http 페이지 → https 서버(또는 그 반대)는 다른 출처
    }
    if rest.contains('/') {
        return false;
    }
    match (split_authority(rest), split_authority(target)) {
        (Some((on, op)), Some((tn, tp))) => on == tn && op.unwrap_or(default_port) == tp.unwrap_or(default_port),
        _ => false,
    }
}

/// 막을 이유가 있으면 그 이유.
fn rejection(
    path: &str,
    host: Option<&str>,
    forwarded_host: Option<&str>,
    forwarded_proto: Option<&str>,
    origin: Option<&str>,
    fetch_site: Option<&str>,
    extra: &[String],
) -> Option<&'static str> {
    const BAD_HOST: &str = "허용되지 않은 Host 입니다. 이 이름으로 열려면 POSTQ_ALLOWED_HOSTS 에 적으세요";
    const CROSS: &str = "다른 사이트에서 보낸 요청은 받지 않습니다";
    if host.is_some_and(|h| !host_allowed(h, extra)) {
        return Some(BAD_HOST);
    }
    // 프록시를 여러 번 거치면 쉼표로 이어 붙는다 — 하나라도 남의 이름이면 거절.
    let forwarded: Vec<&str> = forwarded_host.map(|f| f.split(',').map(str::trim).collect()).unwrap_or_default();
    if forwarded.iter().any(|f| !host_allowed(f, extra)) {
        return Some(BAD_HOST);
    }
    if !path.starts_with("/api/") && path != "/api" {
        return None;
    }
    if origin.is_some_and(|o| EXTENSIONS.iter().any(|p| o.starts_with(p))) {
        return None;
    }
    // 브라우저가 스스로 매기는 출처 관계 — 스킴까지 본다(http 페이지 → https 서버도 같은 출처가 아니다).
    if !matches!(fetch_site, None | Some("same-origin") | Some("none")) {
        return Some(CROSS);
    }
    match origin {
        // 브라우저가 처음 향한 주소 — 프록시를 거쳤으면 X-Forwarded-Host 의 맨 앞.
        Some(o) => {
            let target = forwarded.first().copied().or(host);
            // 이 서버는 평문 HTTP 만 받는다 — https 는 앞단 프록시가 X-Forwarded-Proto 로 알려 줄 때뿐이다.
            let scheme = forwarded_proto.and_then(|p| p.split(',').next()).map(|p| p.trim().to_ascii_lowercase());
            let scheme = scheme.as_deref().unwrap_or("http");
            if target.is_some_and(|t| same_origin(o, scheme, t)) { None } else { Some(CROSS) }
        }
        None => None,
    }
}

pub async fn guard(req: Request, next: Next) -> Response {
    // 헤더를 빌린 채로 await 하지 않는다 — Body 가 Sync 가 아니라 &Request 를 쥔 future 는 Send 가 아니다.
    let why = {
        let headers = req.headers();
        let h = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
        rejection(
            req.uri().path(),
            h(header::HOST.as_str()),
            h("x-forwarded-host"),
            h("x-forwarded-proto"),
            h(header::ORIGIN.as_str()),
            h("sec-fetch-site"),
            extra_hosts(),
        )
    };
    if let Some(why) = why {
        return (StatusCode::FORBIDDEN, axum::Json(json!({ "error": why }))).into_response();
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONE: &[String] = &[];

    #[test]
    fn 루프백_host_는_통과하고_다른_이름은_막는다() {
        for h in ["localhost:3000", "127.0.0.1:3001", "[::1]:3000", "[::1]", "localhost", "app.localhost:39100", "LOCALHOST."] {
            assert!(host_allowed(h, NONE), "{h}");
        }
        for h in ["evil.example:3000", "192.168.0.10:3000", "localhost.evil.example", "[::2]:80", "[::1].evil.example:3000", "[::1]x", "localhost:abc", "127.0.0.1:3000:1", ""] {
            assert!(!host_allowed(h, NONE), "{h}");
        }
        let extra = parse_hosts(" API.example.com , ");
        assert!(host_allowed("api.example.com:443", &extra));
        assert!(!host_allowed("other.example.com", &extra));
    }

    #[test]
    fn 출처는_요청_주소와_정확히_같아야_한다() {
        assert!(same_origin("http://127.0.0.1:3000", "http", "127.0.0.1:3000"));
        assert!(same_origin("http://localhost:39100", "http", "localhost:39100"));
        assert!(same_origin("https://api.example.com", "https", "api.example.com"));
        assert!(same_origin("https://api.example.com", "https", "api.example.com:443"));
        assert!(!same_origin("http://api.example.com", "https", "api.example.com"), "http 페이지 → https 서버");
        assert!(!same_origin("http://localhost:8888", "http", "localhost:3000"), "다른 포트의 로컬 페이지");
        assert!(!same_origin("http://localhost:3000", "http", "127.0.0.1:3000"));
        assert!(!same_origin("https://evil.example", "http", "127.0.0.1:3000"));
        assert!(!same_origin("null", "http", "127.0.0.1:3000"));
    }

    #[test]
    fn 다른_사이트의_api_요청만_막는다() {
        let r = |path, host, fwd, origin, site| rejection(path, host, fwd, None, origin, site, NONE);
        // 화면·curl·MCP 클라이언트·확장
        assert!(r("/api/execute", Some("127.0.0.1:3000"), None, Some("http://127.0.0.1:3000"), Some("same-origin")).is_none());
        assert!(r("/api/execute", Some("localhost:3000"), None, None, None).is_none());
        assert!(r("/api/mcp/mcp", None, None, None, None).is_none());
        assert!(r("/api/cookies/import", Some("localhost:3000"), None, Some("chrome-extension://abc"), Some("cross-site")).is_none());
        // Next 개발 프록시 경유: Host 는 백엔드, 원래 주소는 X-Forwarded-Host
        assert!(r("/api/folders", Some("127.0.0.1:3001"), Some("127.0.0.1:3000"), Some("http://127.0.0.1:3000"), Some("same-origin")).is_none());
        // 다른 사이트의 fetch·form·img
        assert!(r("/api/execute", Some("127.0.0.1:3000"), None, Some("https://evil.example"), Some("cross-site")).is_some());
        assert!(r("/api/workspaces", Some("localhost:3000"), None, Some("http://localhost:8888"), Some("same-site")).is_some());
        assert!(r("/api/history", Some("127.0.0.1:3000"), None, None, Some("cross-site")).is_some());
        assert!(r("/api/history", Some("127.0.0.1:3000"), None, None, Some("same-site")).is_some());
        // 리바인딩: Host(또는 프록시가 남긴 원래 Host)가 남의 도메인
        assert!(r("/api/history", Some("evil.example:3000"), None, Some("http://evil.example:3000"), Some("same-origin")).is_some());
        assert!(r("/api/workspaces", Some("127.0.0.1:3001"), Some("evil.example:3000"), None, Some("same-origin")).is_some());
        assert!(r("/", Some("evil.example:3000"), None, None, None).is_some());
        // 같은 호스트의 http 페이지 → https 서버: Origin 의 호스트는 같아도 브라우저는 cross-site 로 매긴다.
        let extra = parse_hosts("api.example.com");
        assert!(rejection("/api/workspaces", Some("api.example.com"), None, Some("https"), Some("http://api.example.com"), Some("cross-site"), &extra).is_some());
        // Sec-Fetch-Site 를 안 보내는 브라우저여도 스킴으로 떨어진다.
        assert!(rejection("/api/workspaces", Some("api.example.com"), None, Some("https"), Some("http://api.example.com"), None, &extra).is_some());
        assert!(rejection("/api/workspaces", Some("api.example.com"), None, Some("https"), Some("https://api.example.com"), Some("same-origin"), &extra).is_none());
        // 프록시 없이 https Origin 이 오면(이 서버는 평문만 받는다) 다른 출처다.
        assert!(rejection("/api/workspaces", Some("localhost:3000"), None, None, Some("https://localhost:3000"), None, NONE).is_some());
        // 다른 사이트의 링크로 화면을 여는 건 된다(공유 링크).
        assert!(r("/", Some("127.0.0.1:3000"), None, None, Some("cross-site")).is_none());
    }
}
