//! `/api/workspaces/{id}` (이름 바꾸기·삭제), `/api/workspaces/{id}/ack-spec`, `/api/workspaces/{id}/flags`

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::{get, post, put};
use axum::Router;
use rusqlite::types::Value as Sql;
use rusqlite::Connection;
use serde_json::{json, Map, Value};

use crate::error::ApiResult;
use crate::jsval::ok;
use crate::routes::input::{fail, json_error, read_json, respond, Out};
use crate::variables::ALL_PROJECTS;
use crate::{js, rows, AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/workspaces/{id}", put(rename).delete(remove))
        .route("/api/workspaces/{id}/ack-spec", post(ack_spec))
        .route("/api/workspaces/{id}/flags", get(flags))
}

// ── 이름 바꾸기 ────────────────────────────────────────────────────────────

pub(crate) fn rename_workspace(c: &Connection, id: &str, body: &[u8]) -> anyhow::Result<Out> {
    // `if (!b?.name?.trim())` — name 이 문자열이 아니고 null 도 아니면 Node 는 `.trim is not a function` 으로 500 이었다.
    let b = read_json(body).filter(|b| js::truthy(Some(b)));
    let name = match b.as_ref().and_then(|b| b.get("name")) {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(js::trim(s).to_string()).filter(|t| !t.is_empty()),
        Some(_) => anyhow::bail!("b.name.trim is not a function"),
    };
    let Some(name) = name else { return Ok(fail(StatusCode::BAD_REQUEST, "name required")) };
    // 없는 id 여도 0행 갱신으로 200.
    c.prepare_cached(r#"update "workspaces" set "name" = ? where "workspaces"."id" = ?"#)?.execute([&name, id])?;
    Ok((StatusCode::OK, json!({ "ok": true })))
}

async fn rename(State(s): State<AppState>, Path(id): Path<String>, body: Bytes) -> ApiResult<Response> {
    Ok(respond(s.db.run(move |c| rename_workspace(c, &id, &body)).await?))
}

// ── 삭제 ─────────────────────────────────────────────────────────────────

/// 워크스페이스 삭제 — 그 프로젝트에 속한 것을 전부 지운다. default 는 삭제 불가.
///
/// 예전엔 폴더·요청·이력·환경·환경 변수·시나리오만 지웠고, 스케줄(시나리오 없이 1분마다 깨어나는 좀비)·
/// 전역 변수(시크릿 자리)·쿠키(로그인 세션)·실행 기록·스펙 이력·요청 저장본(헤더·인증 스냅샷)이
/// 남았다. '지웠다' 고 말했으면 정말 남지 않아야 한다.
pub(crate) fn delete_workspace(c: &Connection, id: &str) -> anyhow::Result<Out> {
    if id == "default" {
        return Ok(fail(StatusCode::BAD_REQUEST, "기본 프로젝트는 삭제할 수 없습니다"));
    }
    // '*' 는 프로젝트가 아니라 모든 프로젝트 공통(전역) 변수의 스코프 이름이다 — 지우면 global:* 가 통째로 날아간다.
    if id == ALL_PROJECTS {
        return Ok(fail(StatusCode::BAD_REQUEST, "'*' 는 프로젝트가 아닙니다"));
    }
    let tx = c.unchecked_transaction()?;
    // id 를 뽑아 다시 파라미터로 넘기지 않는다 — 요청이 3만 개를 넘으면 SQLite 바인딩 한계(32,766)에 걸린다.
    // 서브쿼리는 그 천장이 없다.
    const REQ_IDS: &str = r#"select "id" from "requests" where "requests"."folder_id" in (select "id" from "folders" where "folders"."workspace_id" = ?)"#;
    let by_ws = [
        format!(r#"delete from "executions" where "executions"."request_id" in ({REQ_IDS})"#),
        format!(r#"delete from "request_versions" where "request_versions"."request_id" in ({REQ_IDS})"#),
        r#"delete from "requests" where "requests"."folder_id" in (select "id" from "folders" where "folders"."workspace_id" = ?)"#.to_string(),
        r#"delete from "folders" where "folders"."workspace_id" = ?"#.to_string(),
        r#"delete from "variables" where "variables"."environment_id" in (select "id" from "environments" where "environments"."workspace_id" = ?)"#.to_string(),
        r#"delete from "environments" where "environments"."workspace_id" = ?"#.to_string(),
    ];
    for sql in &by_ws {
        tx.prepare_cached(sql)?.execute([id])?;
    }
    // 전역 변수는 환경이 아니라 'global:<워크스페이스>' 스코프에 달려 있어 위에서 안 지워진다.
    tx.prepare_cached(r#"delete from "variables" where "variables"."environment_id" = ?"#)?.execute([format!("global:{id}")])?;
    for table in ["flow_runs", "schedules", "flows", "cookies", "spec_changes"] {
        tx.prepare_cached(&format!(r#"delete from "{table}" where "{table}"."workspace_id" = ?"#))?.execute([id])?;
    }
    tx.prepare_cached(r#"delete from "workspaces" where "workspaces"."id" = ?"#)?.execute([id])?;
    tx.commit()?;
    Ok((StatusCode::OK, json!({ "ok": true })))
}

async fn remove(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<Response> {
    Ok(respond(s.db.run(move |c| delete_workspace(c, &id)).await?))
}

// ── 스펙 변경 확인 ──────────────────────────────────────────────────────────

/// '스펙 바뀐 것 봤다' 를 기록한다 — CHANGED 표시를 내린다. 알림은 지울 수 있어야 알림이다.
/// body: { requestIds?: string[] } — 없으면(또는 문자열이 하나도 없으면) 이 프로젝트의 changed 전부.
/// deprecated 는 건드리지 않는다 — '지금도 스펙에 없다' 는 상태라 확인했다고 사라지면 안 된다.
pub(crate) fn ack_spec_changes(c: &Connection, workspace_id: &str, body: &[u8]) -> anyhow::Result<Value> {
    // 깨진 바디는 '목록 없음' 과 같다(Node 의 readJson → null → body?.requestIds).
    let ids: Vec<String> = match read_json(body).as_ref().and_then(|b| b.get("requestIds")) {
        Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string).collect(),
        _ => Vec::new(),
    };
    // 폴더 id 를 뽑아 다시 넘기지 않는다 — 서브쿼리는 바인딩 한계가 없다.
    // (요청 id 는 화면이 보낸 목록이라 그대로 바인딩한다 — 한 번에 보내는 양이 현실적으로 작다)
    let mut cond = r#"("requests"."folder_id" in (select "id" from "folders" where "folders"."workspace_id" = ?) and "requests"."spec_state" = ?"#.to_string();
    let mut params: Vec<Sql> = vec![Sql::Text(workspace_id.into()), Sql::Text("changed".into())];
    if !ids.is_empty() {
        cond.push_str(&format!(r#" and "requests"."id" in ({}))"#, vec!["?"; ids.len()].join(", ")));
        params.extend(ids.into_iter().map(Sql::Text));
    } else {
        cond.push(')');
    }
    let acked = c
        .prepare_cached(&format!(r#"select "id" from "requests" where {cond}"#))?
        .query_map(rusqlite::params_from_iter(params.iter()), |_| Ok(()))?
        .count();
    if acked == 0 {
        return Ok(json!({ "acked": 0 }));
    }
    c.prepare_cached(&format!(r#"update "requests" set "spec_state" = ? where {cond}"#))?
        .execute(rusqlite::params_from_iter(std::iter::once(&Sql::Text("synced".into())).chain(params.iter())))?;
    Ok(json!({ "acked": acked }))
}

async fn ack_spec(State(s): State<AppState>, Path(id): Path<String>, body: Bytes) -> Response {
    match s.db.run(move |c| ack_spec_changes(c, &id, &body)).await {
        Ok(v) => ok(&v),
        Err(e) => json_error("스펙 변경 확인 처리 중 서버 오류", &e.to_string()),
    }
}

// ── 트리 표시 ──────────────────────────────────────────────────────────────

/// `Number(hours ?? 24)` 가 (0, 90일] 안이면 그 값, 아니면 24.
fn hours_of(raw: Option<&str>) -> f64 {
    let h = raw.map_or(24.0, js::number);
    if h.is_finite() && h > 0.0 && h <= 24.0 * 90.0 {
        h
    } else {
        24.0
    }
}

/// 이 프로젝트에서 '눈에 띄어야 하는' 요청만 — 트리에 표시를 달기 위한 것.
///  - failed: 최근 창(기본 24시간) 안에 실패한 실행이 있다(실패의 정의는 crate::execution_outcome 과 같다)
///  - spec: 스펙이 바뀌었거나(changed) 스펙에서 사라졌다(deprecated) — requests.specState 를 그대로 쓴다
///
/// 아무 일 없는 요청까지 실어 보내면 응답이 목록만큼 커진다. 표시할 게 있는 것만 돌려준다.
pub(crate) fn workspace_flags(c: &Connection, workspace_id: &str, hours_raw: Option<&str>, now: i64) -> anyhow::Result<Value> {
    let hours = hours_of(hours_raw);
    let since = now as f64 - hours * 3_600_000.0;

    // JS 객체처럼 — 같은 키는 자리를 지키고 값만 바뀐다. 숫자처럼 생긴 키의 순서는 응답을 쓸 때 js::stringify 가 맞춘다.
    let mut spec = Map::new();
    {
        let mut st = c.prepare_cached(
            r#"select "requests"."id", "requests"."spec_state" from "requests" inner join "folders" on "requests"."folder_id" = "folders"."id" where ("folders"."workspace_id" = ? and ("requests"."spec_state" = ? or "requests"."spec_state" = ?))"#,
        )?;
        let rows = st.query_map([workspace_id, "changed", "deprecated"], |r| Ok((rows::text(r, 0)?, rows::text(r, 1)?)))?;
        for row in rows {
            let (id, state) = row?;
            spec.insert(id, Value::String(state));
        }
    }

    // 최근 실패가 있는 요청 id. 본문은 안 읽는다(행당 최대 1MB). id 목록을 왕복시키지 않고 조인으로 푼다.
    let mut st = c.prepare_cached(
        r#"select "executions"."request_id", max("executions"."executed_at") from "executions" inner join "requests" on "executions"."request_id" = "requests"."id" inner join "folders" on "requests"."folder_id" = "folders"."id" where ("folders"."workspace_id" = ? and "executions"."executed_at" >= ? and ("executions"."error" is not null or "executions"."check_passed" = ? or ("executions"."check_passed" is null and "executions"."response_status" >= ?))) group by "executions"."request_id""#,
    )?;
    let rows = st
        .query_map(rusqlite::params![workspace_id, since, 0, 400], |r| Ok((rows::raw(r.get_ref(0)?), rows::raw(r.get_ref(1)?))))?
        .collect::<Result<Vec<_>, _>>()?;
    let failed: Vec<Value> = rows.iter().map(|(id, _)| id.clone()).collect();
    let mut latest = Map::new();
    for (id, at) in rows {
        latest.insert(js::to_string(&id), at);
    }
    Ok(json!({
        "window": { "hours": hours, "since": since },
        "failed": failed,
        "failedLatest": latest,
        "spec": spec,
    }))
}

async fn flags(State(s): State<AppState>, Path(id): Path<String>, RawQuery(q): RawQuery) -> Response {
    let hours = js::query_get(q.as_deref(), "hours");
    match s.db.run(move |c| workspace_flags(c, &id, hours.as_deref(), js::now_ms())).await {
        Ok(v) => ok(&v),
        Err(e) => json_error("요청 표시 조회 중 서버 오류", &e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::variables::tests::test_db;

    fn count(c: &Connection, sql: &str) -> i64 {
        c.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    // '프로젝트를 지웠다' 고 말했으면 정말 남지 않아야 한다.
    #[test]
    fn 워크스페이스를_지우면_그_프로젝트_것이_하나도_안_남는다() {
        let db = test_db();
        db.with(|c| {
            c.execute_batch(
                r#"INSERT INTO workspaces (id, name) VALUES ('w1', 'W'), ('w2', '남');
                INSERT INTO folders (id, workspace_id, name) VALUES ('f1', 'w1', 'F');
                INSERT INTO requests (id, folder_id, name, updated_at) VALUES ('r1', 'f1', 'R', 1);
                INSERT INTO executions (id, request_id, executed_by, executed_at, resolved) VALUES ('x1', 'r1', 't', 1, '{}');
                INSERT INTO request_versions (id, request_id, snapshot, created_at) VALUES ('v1', 'r1', '{}', 1);
                INSERT INTO environments (id, workspace_id, name) VALUES ('e1', 'w1', 'E');
                INSERT INTO variables (id, environment_id, key, value, secret) VALUES ('va', 'e1', 'k', 'x', 0), ('vb', 'global:w1', 'g', 'x', 1);
                INSERT INTO flows (id, workspace_id, name, steps, updated_at) VALUES ('fl1', 'w1', 'FL', '[]', 1);
                INSERT INTO flow_runs (id, workspace_id, flow_id, started_at, steps, executed_by) VALUES ('fr1', 'w1', 'fl1', 1, '[]', 't');
                INSERT INTO schedules (id, workspace_id, flow_id, interval_minutes, enabled) VALUES ('s1', 'w1', 'fl1', 5, 1);
                INSERT INTO cookies (id, workspace_id, domain, name, value, path, updated_at) VALUES ('ck1', 'w1', 'x.com', 'sid', 'v', '/', 1);
                INSERT INTO spec_changes (id, workspace_id, folder_id, request_id, operation_key, change_type, request_name, created_at) VALUES ('sc1', 'w1', 'f1', 'r1', 'GET /x', 'new', 'X', 1);"#,
            )?;
            assert_eq!(delete_workspace(c, "w1")?.0, StatusCode::OK);
            for t in ["executions", "request_versions", "requests", "folders", "environments", "flows", "flow_runs", "schedules", "cookies", "spec_changes"] {
                assert_eq!(count(c, &format!("SELECT count(*) FROM {t}")), 0, "{t} 가 남았다");
            }
            assert_eq!(count(c, "SELECT count(*) FROM variables"), 0);
            assert_eq!(count(c, "SELECT count(*) FROM workspaces WHERE id = 'w1'"), 0);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn default_와_별표는_지울_수_없다() {
        let db = test_db();
        db.with(|c| {
            assert_eq!(delete_workspace(c, "default")?.0, StatusCode::BAD_REQUEST);
            assert_eq!(delete_workspace(c, "*")?.0, StatusCode::BAD_REQUEST);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn 이름_바꾸기는_trim_하고_비면_400() {
        let db = test_db();
        db.with(|c| {
            c.execute("INSERT INTO workspaces (id, name) VALUES ('w', 'a')", [])?;
            assert_eq!(rename_workspace(c, "w", r#"{"name":"  새 이름 "}"#.as_bytes())?.0, StatusCode::OK);
            assert_eq!(c.query_row("SELECT name FROM workspaces WHERE id = 'w'", [], |r| r.get::<_, String>(0))?, "새 이름");
            assert_eq!(rename_workspace(c, "w", br#"{"name":"   "}"#)?.1["error"], "name required");
            assert_eq!(rename_workspace(c, "w", b"oops")?.0, StatusCode::BAD_REQUEST);
            assert!(rename_workspace(c, "w", br#"{"name":5}"#).is_err());
            Ok(())
        })
        .unwrap();
    }

    fn seed_requests(c: &Connection) {
        c.execute_batch(
            r#"INSERT INTO folders (id, workspace_id, name) VALUES ('ff', 'flags-test', 'F'), ('fo', 'other', 'O');
            INSERT INTO requests (id, folder_id, name, updated_at, spec_state) VALUES
              ('ra', 'ff', 'A', 1, 'changed'), ('rb', 'ff', 'B', 1, 'changed'), ('rc', 'ff', 'C', 1, 'deprecated'),
              ('rd', 'ff', 'D', 1, 'new'), ('ro', 'fo', 'O', 1, 'changed');"#,
        )
        .unwrap();
    }

    // 마지막 실패 시각을 싣고, 통과한 실행은 실패가 아니다.
    #[test]
    fn 실패_표시는_최근_실패_시각을_싣는다() {
        let db = test_db();
        db.with(|c| {
            seed_requests(c);
            let now = 1_700_000_000_000_i64;
            for (i, (off, status, passed)) in [(0, 500, Some(0)), (1, 200, Some(0)), (2, 200, Some(1))].iter().enumerate() {
                c.execute(
                    "INSERT INTO executions (id, request_id, executed_by, executed_at, resolved, response_status, check_passed) VALUES (?1, 'ra', 'test', ?2, '{}', ?3, ?4)",
                    rusqlite::params![format!("e{i}"), now + off, status, passed],
                )?;
            }
            // 창 밖의 실패는 안 센다
            c.execute("INSERT INTO executions (id, request_id, executed_by, executed_at, resolved, response_status) VALUES ('old', 'rb', 't', ?1, '{}', 500)", [now - 25 * 3_600_000])?;
            let v = workspace_flags(c, "flags-test", None, now + 10)?;
            assert_eq!(v["failed"], json!(["ra"]));
            assert_eq!(v["failedLatest"]["ra"], now + 1);
            // 창은 f64 로 계산한다 — 화면이 받는 글자(JSON.stringify 와 같은 표기)로 본다.
            assert_eq!(js::stringify(&v["window"]), format!(r#"{{"hours":24,"since":{}}}"#, now + 10 - 86_400_000));
            assert_eq!(v["spec"], json!({ "ra": "changed", "rb": "changed", "rc": "deprecated" }));
            let hours = |q: &str| js::stringify(&workspace_flags(c, "flags-test", Some(q), now).unwrap()["window"]["hours"]);
            assert_eq!(hours("abc"), "24");
            assert_eq!(hours("1.5"), "1.5");
            assert_eq!(hours("9999"), "24");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn 스펙_확인은_changed_만_내리고_deprecated_는_둔다() {
        let db = test_db();
        db.with(|c| {
            seed_requests(c);
            assert_eq!(ack_spec_changes(c, "flags-test", br#"{"requestIds":["rb",5,""]}"#)?, json!({ "acked": 1 }));
            assert_eq!(ack_spec_changes(c, "flags-test", br#"{"requestIds":["rb"]}"#)?, json!({ "acked": 0 }));
            // 목록이 없으면 이 프로젝트의 changed 전부(남의 프로젝트 것은 그대로)
            assert_eq!(ack_spec_changes(c, "flags-test", b"")?, json!({ "acked": 1 }));
            let state = |id: &str| c.query_row("SELECT spec_state FROM requests WHERE id = ?1", [id], |r| r.get::<_, String>(0)).unwrap();
            assert_eq!((state("ra"), state("rb"), state("rc"), state("ro")), ("synced".into(), "synced".into(), "deprecated".into(), "changed".into()));
            Ok(())
        })
        .unwrap();
    }
}
