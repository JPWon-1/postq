//! postq 백엔드 — API 와 정적 화면(out/)을 함께 낸다. 데스크톱 앱은 이것을 같은 프로세스 안에서 띄우고,
//! 도커는 `postq-server` 실행 파일로 띄운다.
//!
//! 이 서버는 처음에 Node(Next.js API 라우트)로 만든 것을 옮겨 왔다. 주석에 남은 'Node'·'TS' 는 그 옛 구현을 뜻하고,
//! 화면·E2E 가 기대는 응답 모양(키 순서·상태 코드·오류 문장)을 왜 그렇게 두었는지 설명할 때만 남겼다.

pub mod api_contract;
pub mod assertions;
pub mod auth_config;
pub mod backup;
pub mod cli;
pub mod collection_run;
pub mod cookies;
pub mod db;
pub mod env_file;
pub mod error;
pub mod error_i18n;
pub mod exec_helpers;
pub mod execution_outcome;
pub mod execution_overrides;
pub mod execution_policy;
pub mod executor;
pub mod flow_chain;
pub mod graphql_introspect;
pub mod http_explain;
pub mod js;
pub mod json_cols;
pub mod json_format;
pub mod json_leaves;
pub mod jsval;
pub mod mcp;
pub mod mcp_tools;
pub mod multipart;
pub mod openapi;
pub mod openapi_export;
pub mod outbound;
pub mod postman_import;
pub mod records;
pub mod request_auth;
pub mod request_fields;
pub mod request_guard;
pub mod resolve;
pub mod routes;
pub mod rows;
pub mod schedule_fields;
pub mod scheduler;
pub mod schema_validate;
pub mod scrub;
pub mod secretbox;
pub mod server_log;
pub mod slack;
pub mod sort_order;
pub mod spec_fetch;
pub mod spec_sync;
pub mod ssrf_guard;
pub mod startup;
pub mod static_files;
pub mod steps;
pub mod variables;

use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::Result;
use axum::Router;

pub use db::Db;

#[derive(Clone, Debug)]
pub struct Config {
    pub host: String,
    pub port: u16,
    /// `DB_PATH` — 기본 `data/postq.db`.
    pub db_path: String,
    /// drizzle 마이그레이션 폴더.
    pub migrations_dir: PathBuf,
    /// 화면(정적 내보내기 out/) 폴더 — `POSTQ_STATIC_DIR`. 있으면 /api 밖의 GET·HEAD 를 여기서 내준다
    /// ([`static_files`]).
    pub static_dir: Option<PathBuf>,
}

impl Config {
    /// 환경 변수에서 읽는다(POSTQ_HOST·PORT·DB_PATH·MIGRATIONS_DIR·POSTQ_STATIC_DIR).
    pub fn from_env() -> Self {
        let get = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        Config {
            // 로그인이 없으므로 기본은 이 컴퓨터 안에서만 닿는 주소다. 바깥에 열려면 POSTQ_HOST 를 직접 준다.
            // HOSTNAME 은 읽지 않는다 — 리눅스 셸·도커가 기계 이름을 자동으로 넣어 두는 변수라, 모르는 새 바깥에 열린다.
            host: get("POSTQ_HOST").unwrap_or_else(|| "127.0.0.1".into()),
            port: get("PORT").and_then(|p| p.parse().ok()).unwrap_or(3000),
            db_path: get("DB_PATH").unwrap_or_else(|| "data/postq.db".into()),
            migrations_dir: get("MIGRATIONS_DIR").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("drizzle")),
            static_dir: get("POSTQ_STATIC_DIR").map(PathBuf::from),
        }
    }
}

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub config: Config,
}

/// 로그인이 없다 — 모든 요청이 그대로 라우트에 닿는다. 그래서 기본 바인딩이 127.0.0.1 이고([`Config::from_env`]),
/// 다른 웹사이트가 브라우저를 시켜 보내는 요청은 [`request_guard`] 가 막는다.
/// 바깥에 열어야 하면 앞단 프록시로 SSO 를 붙인다(docs/auth.md).
pub fn app(state: AppState) -> Router {
    routes::router()
        .fallback(static_files::fallback)
        .layer(axum::middleware::from_fn(error_i18n::translate_response))
        .layer(axum::middleware::from_fn(request_guard::guard))
        .with_state(state)
}

pub fn state(config: Config) -> Result<AppState> {
    let db = Db::open(&config.db_path, &config.migrations_dir)?;
    // 스키마 다음 데이터 이관(encryptExistingSecrets).
    // 실패하면 띄우지 않는다: 평문 자격증명을 남긴 채 도는 것보다 낫다.
    db.with(|c| startup::run(c, &secretbox::Keys::from_env()))?;
    Ok(AppState { db, config })
}

/// 배경 작업을 끄라는 표시인가 — 사본 DB 로 띄운 검증 서버(scripts/e2e-safe.mjs)는 원래 서버와 같은 외부 호출을
/// 한 번 더 하면 안 된다(대상 API 에 요청이 두 번, 알림이 두 번).
pub fn background_disabled() -> bool {
    std::env::var("POSTQ_NO_BACKGROUND").map_or(false, |v| v == "1")
}

/// 주소를 잡고 끝날 때까지 돈다. 잡은 주소를 `on_bound` 로 먼저 알린다(데스크톱 앱이 창을 그리로 보낸다).
pub async fn serve(config: Config, on_bound: impl FnOnce(SocketAddr)) -> Result<()> {
    warn_if_exposed(&config.host);
    routes::mark_started();
    let state = state(config.clone())?;
    let listener = tokio::net::TcpListener::bind((config.host.as_str(), config.port)).await?;
    on_bound(listener.local_addr()?);
    start_background(&state);
    axum::serve(listener, app(state)).await?;
    Ok(())
}

/// 이미 잡아 둔 주소로 띄우고 `shutdown` 이 끝나면 새 연결을 받지 않고 돌아온다.
/// 사용자용 실행 파일([`cli`])이 빈 포트를 직접 찾아 잡은 뒤 넘긴다 — 잡았다 놓고 다시 잡으면 그 사이에 남이 가져갈 수 있다.
/// DB 를 먼저 연다(마이그레이션 실패면 주소를 알리기 전에 끝난다).
pub async fn serve_listener(
    config: Config,
    listener: tokio::net::TcpListener,
    on_bound: impl FnOnce(SocketAddr),
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
) -> Result<()> {
    warn_if_exposed(&config.host);
    routes::mark_started();
    let state = state(config)?;
    on_bound(listener.local_addr()?);
    start_background(&state);
    axum::serve(listener, app(state)).with_graceful_shutdown(shutdown).await?;
    Ok(())
}

fn warn_if_exposed(host: &str) {
    if !is_loopback(host) {
        eprintln!("[postq] ⚠ POSTQ_HOST={host} — 로그인이 없는 앱을 루프백 밖에 엽니다. 이 주소에 닿는 누구나 모든 요청·비밀값을 쓸 수 있습니다. 도커 안이면 호스트 쪽 포트를 127.0.0.1 에만 매핑하세요(docs/auth.md).");
    }
}

/// 배경 작업 — `scheduler` 스케줄 실행.
/// 사본 DB 로 띄운 검증용 서버(scripts/e2e-safe.mjs)는 POSTQ_NO_BACKGROUND=1 로 전부 끈다 — 사본에도 스케줄이
/// 그대로 있어서, 켜 두면 원래 서버와 같은 외부 호출을 한 번 더 한다(대상 API 에 두 번, 알림도 두 번).
fn start_background(state: &AppState) {
    if background_disabled() {
        eprintln!("[postq] 배경 작업(스케줄러) 끔 — POSTQ_NO_BACKGROUND=1");
        return;
    }
    scheduler::start(state.clone());
}

/// 이 주소에만 열면 같은 컴퓨터 밖에서는 닿지 않는가.
pub(crate) fn is_loopback(host: &str) -> bool {
    host == "localhost" || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 루프백_주소만_안쪽으로_본다() {
        for h in ["127.0.0.1", "::1", "localhost", "127.0.0.2"] {
            assert!(is_loopback(h), "{h}");
        }
        for h in ["0.0.0.0", "::", "192.168.0.10", "example.com"] {
            assert!(!is_loopback(h), "{h}");
        }
    }

    #[test]
    fn 기본_바인딩은_127_0_0_1() {
        // POSTQ_HOST 가 비어 있을 때의 기본값 — from_env 는 프로세스 환경을 읽으므로 기본값 경로만 직접 본다.
        if std::env::var("POSTQ_HOST").map_or(true, |v| v.is_empty()) {
            assert_eq!(Config::from_env().host, "127.0.0.1");
        }
    }
}
