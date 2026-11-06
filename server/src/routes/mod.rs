//! API 라우트. 여기 없는 `/api` 경로는 [`crate::static_files::api_not_found`] 가 404 JSON 으로 답한다.
//!
//! 응답 모양·상태 코드·오류 문장은 화면과 E2E 가 기대고 있다 — 바꿀 때는 그쪽도 같이 본다.

mod cookies;
mod data_io;
mod diagnostics;
mod environments;
mod execute;
mod executions;
mod flows;
mod folder_sync;
/// 스케줄러(crate::scheduler)가 시나리오 실행을 직접 부른다.
pub(crate) mod flow_run;
mod folders;
mod global_vars;
mod health;
pub mod input;
mod logs;
mod mcp;
mod mock;
mod request_extras;
mod requests;
mod schedules;
mod secrets;
mod sse;
mod workspace_detail;
mod workspaces;

use axum::extract::DefaultBodyLimit;
use axum::Router;

use crate::AppState;

/// 서버가 뜬 시각을 적어 둔다 — [설정 → 진단] 의 가동 시간이 첫 요청이 아니라 기동부터 세지게.
pub fn mark_started() {
    diagnostics::mark_start();
}

pub fn router() -> Router<AppState> {
    // 요청 저장 본문은 바디(최대 1MB)를 JSON 으로 한 번 더 감싸 2MB 를 넘을 수 있다. axum 기본 상한(2MB)이면
    // 큰 저장이 413 으로 깨진다 — 넉넉히 받되, 무한정은 아니게 상한을 둔다.
    //
    // 상한은 라우터 전체에 같은 값으로 둔다. 요청만 올리고 나머지를 axum 기본(2MB)에 두면 큰 시나리오·변수 저장이
    // 413 이 된다. 쿠키 가져오기는 추출기에서 413 이 나면 핸들러의 CORS 헤더도 못 붙인다. 경로별로 더 좁힌 곳은 그대로 둔다.
    let requests = requests::router().merge(request_extras::router());
    Router::new()
        .merge(workspaces::router())
        .merge(workspace_detail::router())
        .merge(logs::router())
        .merge(health::router())
        .merge(global_vars::router())
        .merge(folders::router())
        .merge(folder_sync::router())
        .merge(requests)
        .merge(environments::router())
        .merge(cookies::router())
        .merge(secrets::router())
        .merge(flows::router())
        .merge(schedules::router())
        .merge(data_io::router())
        .merge(executions::router())
        .merge(execute::router())
        .merge(sse::router())
        .merge(mock::router())
        .merge(diagnostics::router())
        .merge(flow_run::router())
        .merge(mcp::router())
        .layer(DefaultBodyLimit::max(request_extras::BODY_LIMIT))
}
