//! `/api/workspaces`.

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;

use crate::error::{ApiError, ApiResult};
use crate::routes::input::{read_json, require_text};
use crate::AppState;

#[derive(Serialize)]
struct Workspace {
    id: String,
    name: String,
}

pub fn router() -> Router<AppState> {
    Router::new().route("/api/workspaces", get(list).post(create))
}

async fn list(State(s): State<AppState>) -> ApiResult<Json<Vec<Workspace>>> {
    let rows = s
        .db
        .run(|c| {
            let mut st = c.prepare_cached("SELECT id, name FROM workspaces")?;
            let mut rows: Vec<Workspace> = st.query_map([], |r| Ok(Workspace { id: r.get(0)?, name: r.get(1)? }))?.collect::<Result<_, _>>()?;
            // 마이그레이션 전 신규 DB 방어 — default 가 없으면 만들어 준다.
            if !rows.iter().any(|w| w.id == "default") {
                c.execute("INSERT INTO workspaces (id, name) VALUES ('default', '기본') ON CONFLICT DO NOTHING", [])?;
                rows.insert(0, Workspace { id: "default".into(), name: "기본".into() });
            }
            Ok(rows)
        })
        .await?;
    Ok(Json(rows))
}

async fn create(State(s): State<AppState>, body: axum::body::Bytes) -> ApiResult<(StatusCode, Json<Workspace>)> {
    // TS 는 `if (!b)` 로 먼저 거른다 — null·false·0·"" 도 'JSON 이 아니다' 로 답한다(name 검사까지 가지 않는다).
    let Some(b) = read_json(&body).filter(|b| crate::js::truthy(Some(b))) else {
        return Err(ApiError::bad_request("본문이 올바른 JSON 이 아닙니다"));
    };
    let Some(name) = require_text(b.get("name"), 200) else {
        return Err(ApiError::bad_request("name 은 비어 있지 않은 문자열이어야 합니다"));
    };
    let row = Workspace { id: uuid::Uuid::new_v4().to_string(), name };
    let (id, name) = (row.id.clone(), row.name.clone());
    s.db.run(move |c| Ok(c.execute("INSERT INTO workspaces (id, name) VALUES (?1, ?2)", rusqlite::params![id, name])?)).await?;
    Ok((StatusCode::CREATED, Json(row)))
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use serde_json::Value;
    use tower::ServiceExt;

    #[tokio::test]
    async fn falsy_본문은_json_이_아니라고_답한다() {
        let st = crate::state(crate::Config {
            host: "127.0.0.1".into(),
            port: 0,
            db_path: ":memory:".into(),
            migrations_dir: std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../drizzle"),
            static_dir: None,
        })
        .unwrap();
        let app = super::router().with_state(st);
        for body in ["null", "false", "0", "\"\""] {
            let req = Request::post("/api/workspaces").header("content-type", "application/json").body(Body::from(body)).unwrap();
            let res = app.clone().oneshot(req).await.unwrap();
            assert_eq!(res.status(), StatusCode::BAD_REQUEST, "{body}");
            let v: Value = serde_json::from_slice(&axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap()).unwrap();
            assert_eq!(v["error"], "본문이 올바른 JSON 이 아닙니다", "{body}");
        }
    }
}
