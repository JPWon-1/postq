//! `/api/diagnostics`. [설정 → 진단] 이 서버 프로세스 상태를 본다.
//!
//! 응답 키는 화면(DiagnosticsSettings)이 읽는 그대로 둔다. Rust 에는 JS 힙이 없어서 heapUsed·heapTotal·
//! heapLimit 등은 0 이고, `node` 자리에는 서버 런타임 이름을 싣는다(화면 라벨이 '서버 런타임' 이다).
//! 설정값·요청 본문은 싣지 않는다 — 진단 복사가 그대로 슬랙에 붙기 때문이다.

use std::sync::OnceLock;
use std::time::Instant;

use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde_json::json;

use crate::jsval::ok;
use crate::{js, AppState};

pub fn router() -> Router<AppState> {
    Router::new().route("/api/diagnostics", get(diagnostics))
}

static STARTED: OnceLock<Instant> = OnceLock::new();

/// 기동 시각을 잡는다 — serve() 가 상태를 만들 때 부른다(가동 시간의 기준).
pub fn mark_start() {
    STARTED.get_or_init(Instant::now);
}

/// 상주 메모리(RSS) 바이트. 리눅스는 /proc, 그 밖(macOS)은 ps — 못 읽으면 0.
fn rss_bytes() -> u64 {
    if let Ok(s) = std::fs::read_to_string("/proc/self/status") {
        if let Some(kb) = s.lines().find_map(|l| l.strip_prefix("VmRSS:")).and_then(|v| v.trim().trim_end_matches("kB").trim().parse::<u64>().ok()) {
            return kb * 1024;
        }
    }
    std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<u64>().ok())
        .map_or(0, |kb| kb * 1024)
}

fn parent_pid() -> u32 {
    #[cfg(unix)]
    return std::os::unix::process::parent_id();
    #[cfg(not(unix))]
    0
}

async fn diagnostics() -> Response {
    let start = Instant::now();
    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    // 25ms 를 잤는데 더 걸린 만큼이 런타임이 밀린 시간이다(이벤트 루프 지연과 같은 뜻).
    let delay = (start.elapsed().as_secs_f64() * 1000.0 - 25.0).round().max(0.0);
    let uptime = STARTED.get_or_init(Instant::now).elapsed().as_secs();
    let rss = tokio::task::spawn_blocking(rss_bytes).await.unwrap_or(0);
    let body = json!({
        "at": js::iso_string(js::now_ms()),
        "pid": std::process::id(),
        "parentPid": parent_pid(),
        "uptimeSeconds": uptime,
        "node": format!("rust postq-server {}", env!("CARGO_PKG_VERSION")),
        "memory": { "rss": rss, "heapTotal": 0, "heapUsed": 0, "external": 0, "arrayBuffers": 0 },
        "heapLimit": 0,
        "eventLoopDelayMs": delay,
        "scope": "Rust 서버 프로세스 (앱 창·WebView 메모리는 제외)",
    });
    let mut res = ok(&body);
    res.headers_mut().insert(header::CACHE_CONTROL, header::HeaderValue::from_static("no-store"));
    res.into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn 프로세스_지표만_싣는다() {
        let res = diagnostics().await;
        assert_eq!(res.headers()[header::CACHE_CONTROL], "no-store");
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["pid"], json!(std::process::id()));
        assert!(v["memory"]["rss"].as_u64().unwrap() > 0);
        assert!(v["eventLoopDelayMs"].as_f64().unwrap() >= 0.0);
        let mut keys: Vec<&String> = v.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, ["at", "eventLoopDelayMs", "heapLimit", "memory", "node", "parentPid", "pid", "scope", "uptimeSeconds"]);
    }
}
