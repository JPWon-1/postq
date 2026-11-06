//! 실행 이력 — `/api/executions`, `/api/executions/{id}`, `/api/executions/{id}/pin`, `/api/requests/{id}/executions`.
//!
//! 바뀐 점 하나: 목록의 ?limit 에 상한([`MAX_LIMIT`])을 둔다. Node 는 받은 값을 그대로 LIMIT 에 넣어
//! ?limit=100000000 이면 이력 전체(응답 본문 포함)를 메모리에 올렸다. 화면이 쓰는 값은 80~200 이라
//! 상한 안에서는 동작이 같다. 기본값(전역 100·요청별 50)은 그대로다.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use rusqlite::types::Value as Sql;
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::js;
use crate::jsval::{ok, reply};
use crate::records::{parse_execution, read, select_list, to_client_request, EXECUTION_COLS, FOLDER_COLS, REQUEST_COLS};
use crate::routes::input::{bad, read_json};
use crate::AppState;

/// 목록 한 번에 돌려줄 최대 행 수. 실행 행에는 응답 본문이 통째로 들어 있어 행 수가 곧 메모리다.
pub const MAX_LIMIT: i64 = 500;

const STATUS_FILTERS: [&str; 5] = ["ok", "error", "4xx", "5xx", "failed"];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/executions", get(list))
        .route("/api/executions/{id}", get(one))
        .route("/api/executions/{id}/pin", post(pin))
        .route("/api/requests/{id}/executions", get(by_request))
}

/// LIMIT 에 넣을 값. 정수는 상한으로 자르고, 소수·NaN 은 SQLite 에 그대로 넘긴다
/// (better-sqlite3 가 REAL·NULL 로 바인딩해 'datatype mismatch' 로 실패했다 — 상태 코드를 같게 둔다).
/// 음수는 SQLite 에서 '제한 없음' 이라 상한으로 바꾼다 — 그게 이 상한을 두는 이유다.
fn limit_param(n: f64) -> Sql {
    if n.is_nan() {
        Sql::Null
    } else if n < 0.0 || n >= MAX_LIMIT as f64 {
        Sql::Integer(MAX_LIMIT)
    } else if n.fract() == 0.0 {
        Sql::Integer(n as i64)
    } else {
        Sql::Real(n)
    }
}

/// 숫자 비교 값 — 정수면 정수로(인덱스·비교가 Node 와 같게), 아니면 REAL.
fn num_param(n: f64) -> Sql {
    if n.fract() == 0.0 && n.abs() < 9.0e15 {
        Sql::Integer(n as i64)
    } else {
        Sql::Real(n)
    }
}

fn status_condition(status: &str) -> &'static str {
    match status {
        // 실패의 정의는 crate::execution_outcome 과 같다 — 반드시 같이 고친다.
        "failed" => r#"("executions"."error" is not null or "executions"."check_passed" = 0 or ("executions"."check_passed" is null and "executions"."response_status" >= 400))"#,
        // 실패의 여집합. NOT(실패) 로 쓰면 3값 논리 때문에 checkPassed 가 NULL 인 행이 양쪽에서 빠진다.
        "ok" => r#"("executions"."error" is null and ("executions"."check_passed" = 1 or ("executions"."check_passed" is null and ("executions"."response_status" is null or "executions"."response_status" < 400))))"#,
        "error" => r#""executions"."error" is not null"#,
        "4xx" => r#"("executions"."response_status" >= 400 and "executions"."response_status" < 500)"#,
        _ => r#"("executions"."response_status" >= 500 and "executions"."response_status" < 600)"#,
    }
}

/// 전역 실행 이력 — 최근순. ?workspaceId= ?environmentId= ?executedBy= ?status= ?limit=(기본 100) ?offset= ?since=
async fn list(State(s): State<AppState>, RawQuery(q): RawQuery) -> ApiResult<Response> {
    let qp = |k: &str| js::query_get(q.as_deref(), k);
    let (executed_by, status, since) = (qp("executedBy"), qp("status"), qp("since"));
    let limit = qp("limit").map_or(100.0, |v| js::number(&v));
    let offset = qp("offset").map_or(0.0, |v| js::number(&v));
    if !offset.is_finite() || offset.fract() != 0.0 || offset < 0.0 {
        return Ok(bad("offset must be a non-negative integer"));
    }
    if let Some(st) = status.as_deref().filter(|s| !s.is_empty()) {
        if !STATUS_FILTERS.contains(&st) {
            return Ok(bad(&format!("status must be one of {}", STATUS_FILTERS.join("|"))));
        }
    }
    if !limit.is_finite() || limit <= 0.0 {
        return Ok(bad("limit must be a positive number"));
    }

    let mut conds: Vec<String> = vec![];
    let mut params: Vec<Sql> = vec![];
    // 프로젝트 경계 — executions 에는 workspaceId 가 없고 requests → folders 로 소속이 정해진다.
    if let Some(ws) = qp("workspaceId").filter(|w| !w.is_empty()) {
        conds.push(r#"("folders"."workspace_id" = ? or "executions"."request_id" = ?)"#.into());
        params.push(Sql::Text(ws.clone()));
        params.push(Sql::Text(format!("__adhoc__:{ws}")));
    }
    if let Some(env) = qp("environmentId") {
        if env.is_empty() {
            conds.push(r#""executions"."environment_id" is null"#.into());
        } else {
            conds.push(r#""executions"."environment_id" = ?"#.into());
            params.push(Sql::Text(env));
        }
    }
    if let Some(by) = executed_by.filter(|b| !b.is_empty()) {
        conds.push(r#""executions"."executed_by" = ?"#.into());
        params.push(Sql::Text(by));
    }
    if let Some(st) = status.filter(|s| !s.is_empty()) {
        conds.push(status_condition(&st).into());
    }
    if let Some(since) = since.filter(|s| !s.is_empty()) {
        let t = js::number(&since);
        if !t.is_finite() {
            return Ok(bad("since must be epoch ms"));
        }
        conds.push(r#""executions"."executed_at" >= ?"#.into());
        params.push(num_param(t));
    }
    let where_ = if conds.is_empty() { String::new() } else { format!(" where {}", conds.join(" and ")) };
    let sql = format!(
        r#"select {}, "requests"."name", "folders"."name" from "executions" left join "requests" on "executions"."request_id" = "requests"."id" left join "folders" on "requests"."folder_id" = "folders"."id"{where_} order by "executions"."executed_at" desc, "executions"."id" desc limit ? offset ?"#,
        select_list("executions", EXECUTION_COLS)
    );
    params.push(limit_param(limit));
    params.push(Sql::Integer(offset as i64));
    let rows = s
        .db
        .run(move |c| {
            let mut st = c.prepare_cached(&sql)?;
            let n = EXECUTION_COLS.len();
            let rows = st
                .query_map(rusqlite::params_from_iter(params.iter()), |r| {
                    Ok(json!({
                        "execution": parse_execution(read(r, EXECUTION_COLS, 0)?),
                        "requestName": crate::rows::raw(r.get_ref(n)?),
                        "folderName": crate::rows::raw(r.get_ref(n + 1)?),
                    }))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await?;
    Ok(ok(&Value::Array(rows)))
}

/// 실행 단건 — permalink(?exec=<id>) 복원용. 요청 메타와 그 요청이 속한 프로젝트를 함께 준다.
async fn one(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<Response> {
    let out = s
        .db
        .run(move |c| {
            let exec_sql = format!(r#"select {} from "executions" where "executions"."id" = ?"#, select_list("executions", EXECUTION_COLS));
            let exec = c.prepare_cached(&exec_sql)?.query_map([&id], |r| read(r, EXECUTION_COLS, 0))?.next().transpose()?;
            let Some(exec) = exec else { return Ok(Err((StatusCode::NOT_FOUND, "execution not found"))) };
            let request_id = exec.get("requestId").map(js::to_string).unwrap_or_default();
            let req_sql = format!(r#"select {} from "requests" where "requests"."id" = ?"#, select_list("requests", REQUEST_COLS));
            let req = c.prepare_cached(&req_sql)?.query_map([&request_id], |r| read(r, REQUEST_COLS, 0))?.next().transpose()?;
            let Some(req) = req else { return Ok(Err((StatusCode::NOT_FOUND, "request deleted"))) };
            let folder_id = req.get("folderId").map(js::to_string).unwrap_or_default();
            let folder_sql = format!(r#"select {} from "folders" where "folders"."id" = ?"#, select_list("folders", FOLDER_COLS));
            let folder = c.prepare_cached(&folder_sql)?.query_map([&folder_id], |r| read(r, FOLDER_COLS, 0))?.next().transpose()?;
            let ws = folder.and_then(|f| f.get("workspaceId").cloned()).filter(|w| !w.is_null()).unwrap_or_else(|| json!("default"));
            Ok(Ok(json!({ "execution": parse_execution(exec), "request": to_client_request(&req), "workspaceId": ws })))
        })
        .await?;
    Ok(match out {
        Ok(v) => ok(&v),
        Err((status, msg)) => reply(status, &json!({ "error": msg })),
    })
}

/// 실행을 '예시 응답' 으로 핀/해제 — body { pinned: boolean }.
async fn pin(State(s): State<AppState>, Path(id): Path<String>, body: Bytes) -> ApiResult<Response> {
    // readJson 뒤 `if (!b)` — 깨진 JSON 뿐 아니라 null·false·0·"" 도 같은 400.
    let Some(b) = read_json(&body).filter(|b| js::truthy(Some(b))) else {
        return Err(ApiError::bad_request("본문이 올바른 JSON 이 아닙니다"));
    };
    let Some(pinned) = b.get("pinned").and_then(Value::as_bool) else {
        return Ok(bad("pinned (boolean) required"));
    };
    let out = s
        .db
        .run(move |c| {
            let sql = format!(r#"select {} from "executions" where "executions"."id" = ?"#, select_list("executions", EXECUTION_COLS));
            let Some(mut row) = c.prepare_cached(&sql)?.query_map([&id], |r| read(r, EXECUTION_COLS, 0))?.next().transpose()? else {
                return Ok(None);
            };
            c.prepare_cached(r#"update "executions" set "pinned" = ? where "executions"."id" = ?"#)?.execute(rusqlite::params![pinned as i64, id])?;
            row.insert("pinned".into(), Value::Bool(pinned));
            Ok(Some(parse_execution(row)))
        })
        .await?;
    Ok(match out {
        Some(v) => ok(&v),
        None => reply(StatusCode::NOT_FOUND, &json!({ "error": "execution not found" })),
    })
}

/// 요청 하나의 실행 이력 — 최근순. ?limit=(기본 50) ?environmentId=(빈 값이면 환경 없음만)
async fn by_request(State(s): State<AppState>, Path(id): Path<String>, RawQuery(q): RawQuery) -> ApiResult<Response> {
    let limit = js::query_get(q.as_deref(), "limit").map_or(50.0, |v| js::number(&v));
    let env = js::query_get(q.as_deref(), "environmentId");
    let mut sql = format!(r#"select {} from "executions" where ("executions"."request_id" = ?"#, select_list("executions", EXECUTION_COLS));
    let mut params = vec![Sql::Text(id)];
    match env {
        Some(e) if !e.is_empty() => {
            sql.push_str(r#" and "executions"."environment_id" = ?"#);
            params.push(Sql::Text(e));
        }
        Some(_) => sql.push_str(r#" and "executions"."environment_id" is null"#),
        None => {}
    }
    sql.push_str(r#") order by "executions"."executed_at" desc limit ?"#);
    // Number('abc') = NaN — Node(drizzle)는 이때 제한 없이 돌려줬다(200). 여기서는 상한으로 받는다(예전엔 NULL 로 묶어 500).
    params.push(if limit.is_nan() { Sql::Integer(MAX_LIMIT) } else { limit_param(limit) });
    let rows = s
        .db
        .run(move |c| {
            let mut st = c.prepare_cached(&sql)?;
            let rows = st
                .query_map(rusqlite::params_from_iter(params.iter()), |r| Ok(parse_execution(read(r, EXECUTION_COLS, 0)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await?;
    Ok(ok(&Value::Array(rows)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limit_은_상한_안에서만_그대로() {
        assert_eq!(limit_param(100.0), Sql::Integer(100));
        assert_eq!(limit_param(100_000_000.0), Sql::Integer(MAX_LIMIT));
        assert_eq!(limit_param(f64::INFINITY), Sql::Integer(MAX_LIMIT));
        // 음수는 SQLite 에서 '제한 없음' — 상한으로 막는다
        assert_eq!(limit_param(-1.0), Sql::Integer(MAX_LIMIT));
        assert_eq!(limit_param(2.5), Sql::Real(2.5));
        assert_eq!(limit_param(f64::NAN), Sql::Null);
    }

    // 실패/성공 판정이 서로의 여집합인지, HTTP 코드가 아니라 검증 결과를 따르는지.
    #[test]
    fn 실패와_성공은_여집합이고_검증_결과를_따른다() {
        let db = crate::variables::tests::test_db();
        db.with(|c| {
            c.execute_batch(
                r#"INSERT INTO executions (id, request_id, executed_by, executed_at, resolved, response_status, check_passed, error) VALUES
                ('expected-404','r','t',1,'{}',404,1,NULL),
                ('assertion-broke-on-200','r','t',2,'{}',200,0,NULL),
                ('plain-500','r','t',3,'{}',500,NULL,NULL),
                ('plain-200','r','t',4,'{}',200,NULL,NULL),
                ('transport-error','r','t',5,'{}',NULL,NULL,'ECONNREFUSED');"#,
            )?;
            let ids = |status: &str| -> Vec<String> {
                let sql = format!(r#"select "executions"."id" from "executions" where {} order by "executions"."id""#, status_condition(status));
                c.prepare(&sql).unwrap().query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect()
            };
            assert_eq!(ids("failed"), ["assertion-broke-on-200", "plain-500", "transport-error"]);
            assert_eq!(ids("ok"), ["expected-404", "plain-200"]);
            assert_eq!(ids("4xx"), ["expected-404"]);
            assert_eq!(ids("5xx"), ["plain-500"]);
            assert_eq!(ids("error"), ["transport-error"]);
            Ok(())
        })
        .unwrap();
    }
}
