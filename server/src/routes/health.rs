//! `/api/health`. 도커 healthcheck·데스크톱 앱이 '여기가 postq 이고 DB 가 산다' 를 본다.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Map, Value};

use crate::{secretbox, AppState};

pub fn router() -> Router<AppState> {
    Router::new().route("/api/health", get(health))
}

fn unhealthy(error: String) -> Response {
    (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "app": "postq", "ok": false, "error": error }))).into_response()
}

async fn health(State(s): State<AppState>) -> Response {
    if let Err(e) = s.db.run(|c| Ok(c.query_row("SELECT count(*) FROM (SELECT 1 FROM workspaces LIMIT 1)", [], |r| r.get::<_, i64>(0))?)).await {
        return unhealthy(e.to_string());
    }
    let (failures, on_old_key) = (secretbox::decrypt_failure_count(), secretbox::old_key_read_count());
    // 경로 전체가 아니라 파일명만 낸다.
    // 윈도우 경로(역슬래시)도 파일명만 남게 Path 로 자른다.
    let db = std::path::Path::new(&s.config.db_path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut out = Map::new();
    out.insert("app".into(), json!("postq"));
    out.insert("ok".into(), json!(true));
    out.insert("db".into(), json!(db));
    if failures > 0 {
        out.insert("secretFailures".into(), json!(failures));
    }
    if on_old_key > 0 {
        out.insert("secretsOnOldKey".into(), json!(on_old_key));
    }
    Json(Value::Object(out)).into_response()
}
