//! `/api/schedules`, `/api/schedules/{id}`.
//!
//! 스케줄러 자체(1분 tick·실행·알림)는 이제 이 프로세스의 [`crate::scheduler`] 가 맡는다. 그래서 그 상태를 묻는
//! `GET ?runtime=1` 과 지금 바로 실행하는 `POST /api/schedules/{id}` 도 여기서 답한다.
//! 스케줄러는 매 tick DB 를 다시 읽으므로 여기서 고친 행이 그대로 다음 tick 에 반영된다.

use axum::body::Bytes;
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use axum::Router;
use rusqlite::types::Value as Sql;
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::error::ApiResult;
use crate::jsval::ok;
use crate::routes::input::{fail, read_json, require_text, respond, Out};
use crate::rows::{self, Col};
use crate::schedule_fields::{parse_interval_minutes, MAX_INTERVAL_MINUTES};
use crate::{js, AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/schedules", get(list).post(create))
        .route("/api/schedules/{id}", put(update).delete(remove).post(run_now))
}

const SCHEDULE_COLS: &[(&str, usize, Col)] = &[
    ("id", 0, Col::Plain),
    ("workspaceId", 1, Col::Plain),
    ("flowId", 2, Col::Plain),
    ("environmentId", 3, Col::Plain),
    ("intervalMinutes", 4, Col::Plain),
    ("slackWebhookUrl", 5, Col::Plain),
    ("notifyOn", 6, Col::Plain),
    ("enabled", 7, Col::Bool),
    ("lastRunAt", 8, Col::Plain),
    ("lastStatus", 9, Col::Plain),
];

/// 슬랙 웹훅 URL 은 그 자체가 자격증명이다 — 아는 사람은 누구나 그 채널에 글을 올릴 수 있다.
/// 화면은 '알림 보낼 곳이 있는지' 만 쓰므로 값은 아예 안 내려보낸다.
/// (Node 의 `({ slackWebhookUrl, ...s }) => ({ ...s, slackWebhookUrl: null, hasWebhook })` — 그래서 키가 뒤로 간다)
pub(crate) fn list_schedules(c: &Connection, ws: &str) -> anyhow::Result<Vec<Value>> {
    let mut st = c.prepare_cached(
        r#"select "id", "workspace_id", "flow_id", "environment_id", "interval_minutes", "slack_webhook_url", "notify_on", "enabled", "last_run_at", "last_status" from "schedules" where "schedules"."workspace_id" = ?"#,
    )?;
    let rows = st.query_map([ws], |r| rows::object(r, SCHEDULE_COLS))?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows
        .into_iter()
        .map(|mut s| {
            let hook = s.shift_remove("slackWebhookUrl");
            s.insert("slackWebhookUrl".into(), Value::Null);
            s.insert("hasWebhook".into(), Value::Bool(js::truthy(hook.as_ref())));
            Value::Object(s)
        })
        .collect())
}

async fn list(State(s): State<AppState>, req: Request) -> Response {
    let q = req.uri().query().map(str::to_string);
    if js::query_get(q.as_deref(), "runtime").as_deref() == Some("1") {
        return ok(&crate::scheduler::scheduler_state());
    }
    let ws = js::query_get(q.as_deref(), "workspaceId").unwrap_or_else(|| "default".into());
    match s.db.run(move |c| list_schedules(c, &ws)).await {
        Ok(list) => ok(&Value::Array(list)),
        Err(e) => crate::error::ApiError::from(e).into_response(),
    }
}

/// 지금 즉시 실행(수동 트리거) — 선점에 지거나(이미 실행 중) 시나리오가 없으면 400.
async fn run_now(State(s): State<AppState>, Path(id): Path<String>) -> Response {
    let r = crate::scheduler::run_schedule(&s, &id).await;
    if !r.ran {
        return respond((StatusCode::BAD_REQUEST, json!({ "error": r.error })));
    }
    ok(&r.to_json())
}

fn exists(c: &Connection, sql: &str, params: impl rusqlite::Params) -> anyhow::Result<bool> {
    Ok(c.prepare_cached(sql)?.query_row(params, |_| Ok(())).optional()?.is_some())
}

const ENV_IN_WS: &str = r#"select "id" from "environments" where ("environments"."id" = ? and "environments"."workspace_id" = ?)"#;

/// 빈 값(null·'')인지 — `v != null && v !== ''` 의 반대.
fn blank(v: Option<&Value>) -> bool {
    matches!(v, None | Some(Value::Null)) || v.and_then(Value::as_str) == Some("")
}

fn interval_error() -> Out {
    fail(StatusCode::BAD_REQUEST, format!("intervalMinutes 는 1 ~ {MAX_INTERVAL_MINUTES} 사이의 숫자여야 합니다"))
}

pub(crate) fn create_schedule(c: &Connection, body: &[u8]) -> anyhow::Result<Out> {
    let Some(b) = read_json(body).filter(|b| js::truthy(Some(b))) else {
        return Ok(fail(StatusCode::BAD_REQUEST, "본문이 올바른 JSON 이 아닙니다"));
    };
    // `if (!b.flowId)` 는 숫자 999 를 통과시킨다 — 실제로 flowId=999 짜리 스케줄이 201 로 만들어졌다.
    // 스케줄은 사람이 안 볼 때 도는 것이라 잘못 만들어져도 새벽에 조용히 실패할 때까지 아무도 모른다.
    let Some(flow_id) = require_text(b.get("flowId"), 64) else {
        return Ok(fail(StatusCode::BAD_REQUEST, "flowId 는 비어 있지 않은 문자열이어야 합니다"));
    };
    if !exists(c, r#"select "id" from "flows" where "flows"."id" = ?"#, [&flow_id])? {
        return Ok(fail(StatusCode::NOT_FOUND, format!("시나리오를 찾을 수 없습니다 (flowId: {flow_id})")));
    }
    let hook_in = b.get("slackWebhookUrl");
    let webhook = if blank(hook_in) { None } else { require_text(hook_in, 2048) };
    // 문자열이 아닌 값을 '알림 없음' 으로 넘기면 알림을 켰다고 믿는데 안 온다 — 조용한 실패라 거절한다.
    if !blank(hook_in) && webhook.is_none() {
        return Ok(fail(StatusCode::BAD_REQUEST, "slackWebhookUrl 은 문자열이어야 합니다"));
    }
    let workspace_id = require_text(b.get("workspaceId"), 200).unwrap_or_else(|| "default".into());

    // 없는 환경을 가리키면 새벽 실행이 변수를 하나도 못 채워 {{baseUrl}} 이 문자 그대로 나간다.
    // 남의 프로젝트 환경을 가리키는 것도 막는다(그쪽 값으로 실행되면 더 나쁘다).
    let env_in = b.get("environmentId");
    let environment_id = require_text(env_in, 64);
    if !blank(env_in) && environment_id.is_none() {
        return Ok(fail(StatusCode::BAD_REQUEST, "environmentId 는 문자열이어야 합니다"));
    }
    if let Some(env) = &environment_id {
        if !exists(c, ENV_IN_WS, [env, &workspace_id])? {
            return Ok(fail(StatusCode::NOT_FOUND, "이 프로젝트에 그 환경이 없습니다"));
        }
    }

    // 오타를 조용히 60분으로 바꾸지 않는다 — 5분마다 돌 줄 알았는데 한 시간마다 돌면 모른다.
    let interval = match b.get("intervalMinutes") {
        None => 60,
        v => match parse_interval_minutes(v) {
            Some(i) => i,
            None => return Ok(interval_error()),
        },
    };
    let notify_on = if b.get("notifyOn").and_then(Value::as_str) == Some("always") { "always" } else { "failure" };
    // `b.enabled ?? true` 는 "false" 같은 문자열을 그대로 담는다 — 켜짐/꺼짐만 남긴다.
    let enabled = match b.get("enabled") {
        None => true,
        Some(v) => v == &Value::Bool(true),
    };
    let id = uuid::Uuid::new_v4().to_string();
    c.prepare_cached(
        r#"insert into "schedules" ("id", "workspace_id", "flow_id", "environment_id", "interval_minutes", "slack_webhook_url", "notify_on", "enabled", "last_run_at", "last_status") values (?, ?, ?, ?, ?, ?, ?, ?, null, null)"#,
    )?
    .execute(rusqlite::params![id, workspace_id, flow_id, environment_id, interval, webhook, notify_on, enabled as i64])?;
    Ok((
        StatusCode::CREATED,
        json!({
            "id": id, "workspaceId": workspace_id, "flowId": flow_id, "environmentId": environment_id,
            "intervalMinutes": interval, "slackWebhookUrl": null, "notifyOn": notify_on, "enabled": enabled,
            "lastRunAt": null, "lastStatus": null, "hasWebhook": webhook.is_some(),
        }),
    ))
}

async fn create(State(s): State<AppState>, body: Bytes) -> ApiResult<Response> {
    Ok(respond(s.db.run(move |c| create_schedule(c, &body)).await?))
}

pub(crate) fn update_schedule(c: &Connection, id: &str, body: &[u8]) -> anyhow::Result<Out> {
    let Some(b) = read_json(body).filter(|b| js::truthy(Some(b))) else {
        return Ok(fail(StatusCode::BAD_REQUEST, "invalid json"));
    };
    // 없는 스케줄에 200 을 주면 다른 사람이 지운 스케줄을 껐다고 믿게 된다.
    let cur_ws: Option<Value> = c
        .prepare_cached(r#"select "workspace_id" from "schedules" where "schedules"."id" = ?"#)?
        .query_row([id], |r| Ok(rows::raw(r.get_ref(0)?)))
        .optional()?;
    let Some(cur_ws) = cur_ws else {
        return Ok(fail(StatusCode::NOT_FOUND, "스케줄이 없습니다 — 다른 사람이 지웠을 수 있습니다"));
    };

    let mut sets: Vec<(&str, Sql)> = Vec::new();
    // 만들 때와 같은 규칙 — 여기만 빠지면 '만들 땐 막고 고칠 땐 통과' 가 된다.
    if let Some(v) = b.get("intervalMinutes") {
        match parse_interval_minutes(Some(v)) {
            Some(i) => sets.push(("interval_minutes", Sql::Integer(i))),
            None => return Ok(interval_error()),
        }
    }
    if let Some(v) = b.get("slackWebhookUrl") {
        if !blank(Some(v)) && !v.is_string() {
            return Ok(fail(StatusCode::BAD_REQUEST, "slackWebhookUrl 은 문자열이어야 합니다"));
        }
        // `b.slackWebhookUrl || null` — 여기서는 trim 하지 않는다.
        sets.push(("slack_webhook_url", v.as_str().filter(|s| !s.is_empty()).map_or(Sql::Null, |s| Sql::Text(s.into()))));
    }
    if let Some(v) = b.get("notifyOn") {
        sets.push(("notify_on", Sql::Text(if v.as_str() == Some("always") { "always" } else { "failure" }.into())));
    }
    if let Some(v) = b.get("enabled") {
        sets.push(("enabled", Sql::Integer(js::truthy(Some(v)) as i64)));
    }
    if let Some(v) = b.get("environmentId") {
        // `b.environmentId || null`
        if js::truthy(Some(v)) {
            let Some(env) = v.as_str() else {
                return Ok(fail(StatusCode::BAD_REQUEST, "environmentId 는 문자열이어야 합니다"));
            };
            // 만들 때와 같은 이유 — 없는 환경을 가리키면 새벽 실행이 변수를 못 채운다.
            let ws = match &cur_ws {
                Value::String(s) => Sql::Text(s.clone()),
                other => crate::routes::flows::bind_text(other, "schedules.workspace_id")?,
            };
            if !exists(c, ENV_IN_WS, rusqlite::params![env, ws])? {
                return Ok(fail(StatusCode::NOT_FOUND, "이 프로젝트에 그 환경이 없습니다"));
            }
            sets.push(("environment_id", Sql::Text(env.into())));
        } else {
            sets.push(("environment_id", Sql::Null));
        }
    }
    if !sets.is_empty() {
        let sql = format!(
            r#"update "schedules" set {} where "schedules"."id" = ?"#,
            sets.iter().map(|(col, _)| format!(r#""{col}" = ?"#)).collect::<Vec<_>>().join(", ")
        );
        let mut params: Vec<Sql> = sets.into_iter().map(|(_, v)| v).collect();
        params.push(Sql::Text(id.to_string()));
        c.prepare_cached(&sql)?.execute(rusqlite::params_from_iter(params))?;
    }
    Ok((StatusCode::OK, json!({ "ok": true })))
}

async fn update(State(s): State<AppState>, Path(id): Path<String>, body: Bytes) -> ApiResult<Response> {
    Ok(respond(s.db.run(move |c| update_schedule(c, &id, &body)).await?))
}

async fn remove(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<Response> {
    s.db
        .run(move |c| Ok(c.prepare_cached(r#"delete from "schedules" where "schedules"."id" = ?"#)?.execute([&id])?))
        .await?;
    Ok(ok(&json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::variables::tests::test_db;

    fn setup(c: &Connection) {
        c.execute_batch(
            "INSERT INTO flows (id, workspace_id, name, updated_at) VALUES ('fl', 'default', 'F', 1);
             INSERT INTO environments (id, workspace_id, name) VALUES ('env-d', 'default', 'E'), ('env-o', 'other', 'O');",
        )
        .unwrap();
    }

    fn post(c: &Connection, body: Value) -> Out {
        create_schedule(c, body.to_string().as_bytes()).unwrap()
    }

    // schedule.test.ts '스케줄 수정/삭제' 의 DB 쪽.
    #[test]
    fn 만들고_고치고_목록에서_웹훅은_가린다() {
        let db = test_db();
        db.with(|c| {
            setup(c);
            let (st, s) = post(c, json!({ "flowId": "fl", "slackWebhookUrl": " https://hooks.test/x ", "notifyOn": "failure" }));
            assert_eq!(st, StatusCode::CREATED);
            assert_eq!((s["intervalMinutes"].as_i64(), s["hasWebhook"].as_bool(), s["slackWebhookUrl"].is_null()), (Some(60), Some(true), true));
            let id = s["id"].as_str().unwrap();
            let hook: String = c.query_row("SELECT slack_webhook_url FROM schedules WHERE id = ?1", [id], |r| r.get(0))?;
            assert_eq!(hook, "https://hooks.test/x");

            let (st, _) = update_schedule(c, id, br#"{"enabled":false,"intervalMinutes":120}"#)?;
            assert_eq!(st, StatusCode::OK);
            let list = list_schedules(c, "default")?;
            let u = list.iter().find(|x| x["id"] == id).unwrap();
            assert_eq!((u["enabled"].as_bool(), u["intervalMinutes"].as_i64()), (Some(false), Some(120)));
            let keys: Vec<&str> = u.as_object().unwrap().keys().map(String::as_str).collect();
            assert_eq!(keys.last(), Some(&"hasWebhook"));
            assert_eq!(keys[keys.len() - 2], "slackWebhookUrl");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn 잘못된_입력은_등록_시점에_막는다() {
        let db = test_db();
        db.with(|c| {
            setup(c);
            assert_eq!(post(c, json!({ "flowId": 999 })).0, StatusCode::BAD_REQUEST);
            assert_eq!(post(c, json!({ "flowId": "없음" })).1["error"], "시나리오를 찾을 수 없습니다 (flowId: 없음)");
            assert_eq!(post(c, json!({ "flowId": "fl", "slackWebhookUrl": 5 })).0, StatusCode::BAD_REQUEST);
            assert_eq!(post(c, json!({ "flowId": "fl", "environmentId": "env-o" })).0, StatusCode::NOT_FOUND);
            assert_eq!(post(c, json!({ "flowId": "fl", "environmentId": "env-d" })).0, StatusCode::CREATED);
            assert_eq!(post(c, json!({ "flowId": "fl", "intervalMinutes": "5분" })).1["error"], "intervalMinutes 는 1 ~ 44640 사이의 숫자여야 합니다");
            assert_eq!(post(c, json!({ "flowId": "fl", "enabled": "false" })).1["enabled"], false);
            let (_, s) = post(c, json!({ "flowId": "fl" }));
            let id = s["id"].as_str().unwrap();
            assert_eq!(update_schedule(c, "nope", br#"{"enabled":true}"#)?.0, StatusCode::NOT_FOUND);
            assert_eq!(update_schedule(c, id, br#"{"intervalMinutes":0}"#)?.0, StatusCode::BAD_REQUEST);
            assert_eq!(update_schedule(c, id, br#"{"environmentId":"env-o"}"#)?.0, StatusCode::NOT_FOUND);
            assert_eq!(update_schedule(c, id, br#"{"environmentId":7}"#)?.0, StatusCode::BAD_REQUEST);
            assert_eq!(update_schedule(c, id, br#"{"slackWebhookUrl":false}"#)?.0, StatusCode::BAD_REQUEST);
            Ok(())
        })
        .unwrap();
    }
}
