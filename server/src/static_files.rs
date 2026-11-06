//! 화면(Next 정적 내보내기 결과 out/)을 Rust 가 직접 내준다.
//!
//! 모든 화면이 클라이언트 컴포넌트라 서버가 그릴 것이 없다 — `npm run build:static` 이 만든 파일을 그대로 내준다.
//!
//! 규칙:
//! - `/api`·`/api/…` 는 절대 여기서 받지 않는다 — 없는 API 에 화면 HTML 이 200 으로 나가면 클라이언트가
//!   JSON 을 기대하다 엉뚱하게 깨진다. 그대로 [`api_not_found`](404 JSON).
//! - GET·HEAD 만. 화면 주소에 다른 메서드가 오면 역시 [`api_not_found`].
//! - `/_next/static/…` 은 파일 이름에 해시가 들어 있어 1년 캐시(immutable). HTML 은 no-cache — 앱을 새로 깔면
//!   바로 새 화면이 떠야 한다(예전 HTML 이 캐시에 남으면 지워진 청크를 불러 하얀 화면이 된다).
//! - 확장자가 없는 경로(화면 주소)는 `<경로>.html` → `<경로>/index.html` → 없으면 404.html 로 404.
//!   확장자가 있거나 `/_next/` 아래면 파일로만 찾고, 없으면 404 — 빠진 청크를 index.html 로 메우면 브라우저가
//!   HTML 을 스크립트로 읽다 알 수 없는 문법 오류를 낸다.
//! - `/docs` 는 `/?docs=1` 로 307 — 옛 Node 의 docs/page.tsx(server redirect)와 같은 응답이다.
//! - 끝 슬래시(`/sub-page/`)는 308 로 뗀다 — Next(trailingSlash: false)와 같다.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::request::Parts;
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};

use crate::AppState;

/// 라우터의 fallback — 옮긴 API 라우트가 못 받은 요청이 여기로 온다.
pub async fn fallback(State(state): State<AppState>, req: Request) -> Response {
    if let Some(dir) = state.config.static_dir.clone() {
        if matches!(*req.method(), Method::GET | Method::HEAD) && !is_api(req.uri().path()) {
            // 본문(Body)은 Sync 가 아니라 &Request 를 await 너머로 들고 갈 수 없다 — 머리만 떼어 쓴다(GET·HEAD 라 본문은 버린다).
            let (parts, _) = req.into_parts();
            return serve(&dir, &parts).await;
        }
    }
    api_not_found().await
}

/// 옮긴 라우트도 화면도 아닌 요청 — `{"error":"없는 경로입니다"}` 404.
pub async fn api_not_found() -> Response {
    (StatusCode::NOT_FOUND, axum::Json(serde_json::json!({ "error": "없는 경로입니다" }))).into_response()
}

fn is_api(path: &str) -> bool {
    path == "/api" || path.starts_with("/api/")
}

/// 경로의 %XX 를 푼다(+ 는 그대로 — 쿼리가 아니라 경로다). 깨진 % 나 UTF-8 이 아니면 None.
fn percent_decode(path: &str) -> Option<String> {
    let b = path.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = b.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// 풀어 낸 경로를 폴더 안 상대 경로로. `.`·`..`·역슬래시·NUL 이 든 조각이 하나라도 있으면 None —
/// 정규화해서 받아 주지 않고 아예 거절한다(`%2e%2e` 로 감싸 폴더 밖 파일을 읽으려는 시도).
fn relative(decoded: &str) -> Option<String> {
    let mut parts = Vec::new();
    for seg in decoded.split('/') {
        if seg.is_empty() {
            continue;
        }
        if seg == "." || seg == ".." || seg.contains('\\') || seg.contains('\0') {
            return None;
        }
        parts.push(seg);
    }
    Some(parts.join("/"))
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "application/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") | Some("map") => "application/json; charset=utf-8",
        // 정적 내보내기의 RSC 조각(.txt) — Next 클라이언트는 export 빌드에서 text/plain 을 RSC 응답으로 받는다.
        Some("txt") => "text/plain; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("ico") => "image/x-icon",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        Some("wasm") => "application/wasm",
        Some("webmanifest") => "application/manifest+json",
        _ => "application/octet-stream",
    }
}

fn cache_control(rel: &str, file: &Path) -> &'static str {
    if rel.starts_with("_next/static/") {
        "public, max-age=31536000, immutable"
    } else if file.extension().is_some_and(|e| e == "html") {
        "no-cache"
    } else {
        // favicon·public/ 의 그림 — 이름에 해시가 없으니 매번 확인하게(Next 의 기본값과 같다).
        "public, max-age=0"
    }
}

/// 폴더 안의 실제 파일인가 — 심볼릭 링크로 폴더 밖을 가리키는 것도 막는다.
fn inside(root: &Path, candidate: &Path) -> Option<PathBuf> {
    let root = root.canonicalize().ok()?;
    let real = candidate.canonicalize().ok()?;
    (real.starts_with(&root) && real.is_file()).then_some(real)
}

fn redirect(status: StatusCode, location: &str) -> Response {
    let mut res = status.into_response();
    if let Ok(v) = HeaderValue::from_str(location) {
        res.headers_mut().insert(header::LOCATION, v);
    }
    res
}

async fn serve(root: &Path, req: &Parts) -> Response {
    let raw = req.uri.path();
    if raw == "/docs" {
        return redirect(StatusCode::TEMPORARY_REDIRECT, "/?docs=1");
    }
    let Some(decoded) = percent_decode(raw) else { return not_found(root, req).await };
    // 풀어 보니 /api 였다(`/%61pi/…`) — 화면으로 메우지 않는다.
    if is_api(&decoded) {
        return proxy_less_404();
    }
    if raw.len() > 1 && raw.ends_with('/') {
        // 앞 슬래시를 하나로 줄인다 — `//evil.com/` 을 그대로 떼면 Location 이 `//evil.com` 이 되어 남의 사이트로 간다.
        // 역슬래시도 슬래시로 본다 — 브라우저(WHATWG URL)는 `/\evil.com` 을 `//evil.com` 으로 읽는다(codex 최종 대조).
        let unified = raw.replace('\\', "/");
        let trimmed = format!("/{}", unified.trim_matches('/'));
        let location = match req.uri.query() {
            Some(q) => format!("{trimmed}?{q}"),
            None => trimmed,
        };
        return redirect(StatusCode::PERMANENT_REDIRECT, &location);
    }
    let Some(rel) = relative(&decoded) else { return not_found(root, req).await };
    let last = rel.rsplit('/').next().unwrap_or("");
    let asset = rel.starts_with("_next/") || last.contains('.');
    let candidates: Vec<String> = if rel.is_empty() {
        vec!["index.html".into()]
    } else if asset {
        vec![rel.clone()]
    } else {
        // 없는 화면 주소는 첫 화면으로 메우지 않고 404 — Node(Next)와 같다. 이 앱의 화면 이동은 ?쿼리 로 하지 경로로 하지 않는다.
        vec![format!("{rel}.html"), format!("{rel}/index.html")]
    };
    for c in &candidates {
        if let Some(file) = inside(root, &root.join(c)) {
            return file_response(req, &file, cache_control(c, &file), StatusCode::OK).await;
        }
    }
    not_found(root, req).await
}

/// 없는 파일 — 내보내기의 404.html 이 있으면 그 화면을 404 로(Next 와 같다), 없으면 글자 한 줄.
async fn not_found(root: &Path, req: &Parts) -> Response {
    if let Some(file) = inside(root, &root.join("404.html")) {
        return file_response(req, &file, "no-cache", StatusCode::NOT_FOUND).await;
    }
    (StatusCode::NOT_FOUND, [(header::CONTENT_TYPE, "text/plain; charset=utf-8")], "Not Found").into_response()
}

fn proxy_less_404() -> Response {
    (StatusCode::NOT_FOUND, axum::Json(serde_json::json!({ "error": "없는 경로입니다" }))).into_response()
}

async fn file_response(req: &Parts, file: &Path, cache: &'static str, status: StatusCode) -> Response {
    let Ok(meta) = tokio::fs::metadata(file).await else {
        return (StatusCode::NOT_FOUND, "Not Found").into_response();
    };
    let mtime = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs());
    let etag = format!("W/\"{:x}-{:x}\"", meta.len(), mtime);
    let mut builder = Response::builder()
        .header(header::CONTENT_TYPE, content_type(file))
        .header(header::CACHE_CONTROL, cache)
        .header(header::ETAG, &etag)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff");
    if status == StatusCode::OK {
        let fresh = req.headers.get_all(header::IF_NONE_MATCH).iter().filter_map(|v| v.to_str().ok()).flat_map(|v| v.split(',')).any(|t| {
            let t = t.trim();
            t == "*" || t == etag || t.trim_start_matches("W/") == etag.trim_start_matches("W/")
        });
        if fresh {
            return builder.status(StatusCode::NOT_MODIFIED).body(Body::empty()).unwrap_or_else(|_| StatusCode::NOT_MODIFIED.into_response());
        }
    }
    builder = builder.status(status).header(header::CONTENT_LENGTH, meta.len());
    if req.method == Method::HEAD {
        return builder.body(Body::empty()).unwrap_or_else(|_| status.into_response());
    }
    match tokio::fs::read(file).await {
        Ok(bytes) => builder.body(Body::from(bytes)).unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
        Err(_) => (StatusCode::NOT_FOUND, "Not Found").into_response(),
    }
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{HeaderMap, Request, StatusCode};
    use tower::ServiceExt;

    struct Site {
        _dir: tempfile::TempDir,
        root: std::path::PathBuf,
    }

    /// out/ 을 흉내 낸 폴더. 폴더 바로 바깥에 비밀 파일을 하나 두고, 안에서 그 파일을 가리키는 링크도 만든다.
    fn site() -> Site {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("out");
        let w = |p: &str, s: &str| {
            let f = root.join(p);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, s).unwrap();
        };
        w("index.html", "<html>INDEX</html>");
        w("404.html", "<html>NOT FOUND</html>");
        w("sub-page.html", "<html>SUBPAGE</html>");
        w("sub-page.txt", "RSC");
        w("_next/static/chunks/app-abc123.js", "console.log(1)");
        w("_next/static/css/x.css", "body{}");
        w("favicon.ico", "ICO");
        std::fs::write(dir.path().join("secret.txt"), "SECRET").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.path().join("secret.txt"), root.join("leak.txt")).unwrap();
        Site { _dir: dir, root }
    }

    fn app(site: &Site) -> axum::Router {
        let st = crate::state(crate::Config {
            host: "127.0.0.1".into(),
            port: 0,
            db_path: ":memory:".into(),
            migrations_dir: std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../drizzle"),
            static_dir: Some(site.root.clone()),
        })
        .unwrap();
        crate::app(st)
    }

    async fn call(app: &axum::Router, method: &str, path: &str, headers: &[(&str, &str)]) -> (StatusCode, HeaderMap, String) {
        let mut b = Request::builder().method(method).uri(path);
        for (k, v) in headers {
            b = b.header(*k, *v);
        }
        let res = app.clone().oneshot(b.body(Body::empty()).unwrap()).await.unwrap();
        let (status, headers) = (res.status(), res.headers().clone());
        let body = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
        (status, headers, String::from_utf8_lossy(&body).into_owned())
    }

    #[tokio::test]
    async fn 화면과_자산을_종류에_맞는_캐시로_내준다() {
        let s = site();
        let app = app(&s);
        let (st, h, body) = call(&app, "GET", "/", &[]).await;
        assert_eq!((st, body.as_str()), (StatusCode::OK, "<html>INDEX</html>"));
        assert_eq!(h["content-type"], "text/html; charset=utf-8");
        assert_eq!(h["cache-control"], "no-cache");
        let (st, _, body) = call(&app, "GET", "/sub-page", &[]).await;
        assert_eq!((st, body.as_str()), (StatusCode::OK, "<html>SUBPAGE</html>"));
        let (st, h, body) = call(&app, "GET", "/sub-page.txt?_rsc=1", &[]).await;
        assert_eq!((st, body.as_str()), (StatusCode::OK, "RSC"));
        assert_eq!(h["content-type"], "text/plain; charset=utf-8");
        let (st, h, _) = call(&app, "GET", "/_next/static/chunks/app-abc123.js", &[]).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(h["content-type"], "application/javascript; charset=utf-8");
        assert_eq!(h["cache-control"], "public, max-age=31536000, immutable");
        let (_, h, _) = call(&app, "GET", "/_next/static/css/x.css", &[]).await;
        assert_eq!(h["content-type"], "text/css; charset=utf-8");
        let (st, h, _) = call(&app, "GET", "/favicon.ico", &[]).await;
        assert_eq!((st, &h["cache-control"]), (StatusCode::OK, &"public, max-age=0".parse::<axum::http::HeaderValue>().unwrap()));
    }

    #[tokio::test]
    async fn 없는_화면_빠진_자산과_api_는_404() {
        let s = site();
        let app = app(&s);
        // 없는 화면 주소도 404 화면 — Node(Next 정적 내보내기)와 같다(codex 최종 대조). 첫 화면으로 메우지 않는다.
        let (st, _, body) = call(&app, "GET", "/some/deep/page", &[]).await;
        assert_eq!((st, body.as_str()), (StatusCode::NOT_FOUND, "<html>NOT FOUND</html>"));
        let (st, _, body) = call(&app, "GET", "/", &[]).await;
        assert_eq!((st, body.as_str()), (StatusCode::OK, "<html>INDEX</html>"));
        let (st, _, body) = call(&app, "GET", "/_next/static/chunks/gone.js", &[]).await;
        assert_eq!((st, body.as_str()), (StatusCode::NOT_FOUND, "<html>NOT FOUND</html>"));
        assert_eq!(call(&app, "GET", "/missing.png", &[]).await.0, StatusCode::NOT_FOUND);
        for p in ["/api/nope", "/api", "/%61pi/nope"] {
            let (st, h, body) = call(&app, "GET", p, &[]).await;
            assert_eq!(st, StatusCode::NOT_FOUND, "{p}");
            assert!(h["content-type"].to_str().unwrap().starts_with("application/json"), "{p}");
            assert!(!body.contains("INDEX"), "{p}");
        }
        // 옮긴 API 는 그대로 API 가 받는다.
        let (st, _, body) = call(&app, "GET", "/api/health", &[]).await;
        assert_eq!(st, StatusCode::OK);
        assert!(body.contains("postq"));
        // GET·HEAD 가 아니면 화면이 아니라 404 JSON.
        let (st, h, _) = call(&app, "POST", "/", &[]).await;
        assert_eq!(st, StatusCode::NOT_FOUND);
        assert!(h["content-type"].to_str().unwrap().starts_with("application/json"));
    }

    #[tokio::test]
    async fn docs_와_끝_슬래시는_node_처럼_돌려보낸다() {
        let s = site();
        let app = app(&s);
        let (st, h, _) = call(&app, "GET", "/docs", &[]).await;
        assert_eq!((st, &h["location"]), (StatusCode::TEMPORARY_REDIRECT, &"/?docs=1".parse::<axum::http::HeaderValue>().unwrap()));
        let (st, h, _) = call(&app, "GET", "/sub-page/?a=1", &[]).await;
        assert_eq!(st, StatusCode::PERMANENT_REDIRECT);
        assert_eq!(h["location"], "/sub-page?a=1");
        // 남의 사이트로 보내는 주소(//evil.com)가 되지 않는다.
        let (st, h, _) = call(&app, "GET", "//evil.com/", &[]).await;
        assert_eq!((st, h["location"].to_str().unwrap()), (StatusCode::PERMANENT_REDIRECT, "/evil.com"));
        // 역슬래시도 — 브라우저는 `/\evil.com` 을 `//evil.com` 으로 읽는다(codex 최종 대조: 예전엔 그대로 Location 에 실었다).
        for p in ["/\\evil.com/", "/\\/evil.com/", "\\\\evil.com/"] {
            let Ok(uri) = p.parse::<axum::http::Uri>() else { continue };
            let (st, h, _) = call(&app, "GET", &uri.to_string(), &[]).await;
            assert_eq!(st, StatusCode::PERMANENT_REDIRECT, "{p}");
            let loc = h["location"].to_str().unwrap();
            assert!(loc.starts_with('/') && !loc[1..].starts_with(['/', '\\']), "{p} → {loc}");
        }
    }

    #[tokio::test]
    async fn 폴더_밖의_파일은_어떤_모양으로도_못_읽는다() {
        let s = site();
        let app = app(&s);
        for p in ["/../secret.txt", "/%2e%2e/secret.txt", "/_next/%2e%2e/%2e%2e/secret.txt", "/..%2fsecret.txt", "/a%5c..%5csecret.txt", "/leak.txt", "/%zz"] {
            let (st, _, body) = call(&app, "GET", p, &[]).await;
            assert!(!body.contains("SECRET"), "{p}: {body}");
            assert_ne!(st, StatusCode::OK, "{p}");
        }
    }

    #[tokio::test]
    async fn head_와_etag() {
        let s = site();
        let app = app(&s);
        let (st, h, body) = call(&app, "HEAD", "/", &[]).await;
        assert_eq!((st, body.as_str()), (StatusCode::OK, ""));
        assert_eq!(h["content-length"], "18");
        let etag = h["etag"].to_str().unwrap().to_string();
        let (st, _, body) = call(&app, "GET", "/", &[("if-none-match", &etag)]).await;
        assert_eq!((st, body.as_str()), (StatusCode::NOT_MODIFIED, ""));
        assert_eq!(call(&app, "GET", "/", &[("if-none-match", "W/\"other\"")]).await.0, StatusCode::OK);
    }
}
