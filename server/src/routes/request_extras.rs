//! 요청 하나에 딸린 것들.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use rusqlite::types::Value as Sql;
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Map, Value};

use crate::error::ApiResult;
use crate::execution_outcome::{is_failed_row, FAILED_SQL};
use crate::jsval::{bind, reply, str_or};
use crate::records::{num, parse_execution, read, select_list, select_request, to_client_request, Cols, EXECUTION_COLS};
use crate::routes::input::{fail, read_json, respond, Out};
use crate::routes::requests::{field, insert_version};
use crate::rows::{self, Col};
use crate::server_log::{self, Level};
use crate::{js, secretbox, AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/requests/{id}/versions", get(versions).post(restore))
        .route("/api/requests/{id}/examples", get(examples))
        .route("/api/requests/{id}/status", get(status))
        .route("/api/requests/{id}/validate", get(validate_get).post(validate_post))
}

fn request_exists(c: &Connection, id: &str) -> rusqlite::Result<bool> {
    Ok(c.prepare_cached(r#"SELECT "id" FROM "requests" WHERE "requests"."id" = ?1"#)?.query_row([id], |_| Ok(())).optional()?.is_some())
}

// ── 저장본(versions) ────────────────────────────────────────────────────

const VERSION_COLS: &Cols = &[
    ("id", "id", Col::Plain),
    ("requestId", "request_id", Col::Plain),
    ("snapshot", "snapshot", Col::Plain),
    ("createdAt", "created_at", Col::Plain),
    ("author", "author", Col::Plain),
];

/// 복원할 때 저장본에서 되돌리는 칸 — (JSON 필드, SQL 열).
const RESTORE_FIELDS: &[(&str, &str)] = &[
    ("name", "name"), ("method", "method"), ("url", "url"), ("params", "params"), ("headers", "headers"),
    ("bodyType", "body_type"), ("body", "body"), ("description", "description"), ("assertions", "assertions"),
    ("preSteps", "pre_steps"), ("postSteps", "post_steps"), ("auth", "auth"), ("tags", "tags"), ("settings", "settings"), ("vars", "vars"),
];

fn select_version(c: &Connection, request_id: &str, version_id: &str) -> rusqlite::Result<Option<Map<String, Value>>> {
    let sql = format!(
        r#"SELECT {} FROM "request_versions" WHERE ("request_versions"."request_id" = ?1 AND "request_versions"."id" = ?2)"#,
        select_list("request_versions", VERSION_COLS)
    );
    c.prepare_cached(&sql)?.query_row([request_id, version_id], |r| read(r, VERSION_COLS, 0)).optional()
}

/// 저장본 문자열 → 행. JSON.parse 가 실패하거나(키가 틀려 복호화가 '' 를 돌려준 경우 포함) null 이면 Err —
/// Node 는 null 에서 `row.owner` 를 읽다 TypeError 를 던졌다. 객체가 아닌 원시값은 펼치면 빈 객체다.
fn parse_snapshot(stored: &str) -> Result<Map<String, Value>, ()> {
    match serde_json::from_str::<Value>(&secretbox::decrypt_secret(stored)) {
        Ok(Value::Object(m)) => Ok(m),
        Ok(Value::Null) | Err(_) => Err(()),
        Ok(_) => Ok(Map::new()),
    }
}

/// 목록(최근 100개) 또는 ?versionId= 하나(본문 포함).
async fn versions(State(s): State<AppState>, Path(id): Path<String>, RawQuery(q): RawQuery) -> ApiResult<Response> {
    let version_id = js::query_get(q.as_deref(), "versionId").filter(|v| !v.is_empty());
    let out = s
        .db
        .run(move |c| {
            if !request_exists(c, &id)? {
                return Ok(fail(StatusCode::NOT_FOUND, "요청이 없습니다"));
            }
            if let Some(vid) = version_id {
                let Some(mut row) = select_version(c, &id, &vid)? else { return Ok(fail(StatusCode::NOT_FOUND, "저장본이 없습니다")) };
                let Ok(snap) = parse_snapshot(&str_or(row.get("snapshot"), "")) else {
                    return Ok(fail(StatusCode::INTERNAL_SERVER_ERROR, "저장본을 읽지 못했습니다. 암호화 키를 확인하세요."));
                };
                row.insert("snapshot".into(), to_client_request(&snap));
                return Ok((StatusCode::OK, Value::Object(row)));
            }
            let mut st = c.prepare_cached(
                r#"SELECT "id", "created_at", "author" FROM "request_versions" WHERE "request_versions"."request_id" = ?1 ORDER BY "request_versions"."created_at" DESC LIMIT 100"#,
            )?;
            let rows = st.query_map([&id], |r| rows::object(r, &[("id", 0, Col::Plain), ("createdAt", 1, Col::Plain), ("author", 2, Col::Plain)]))?;
            let list = rows.map(|r| r.map(Value::Object)).collect::<Result<Vec<_>, _>>()?;
            Ok((StatusCode::OK, Value::Array(list)))
        })
        .await?;
    Ok(respond(out))
}

/// 저장본으로 되돌린다 — 되돌리기 전의 현재 행도 저장본으로 남긴다(되돌리기를 되돌릴 수 있게).
async fn restore(State(s): State<AppState>, Path(id): Path<String>, body: Bytes) -> ApiResult<Response> {
    let b = read_json(&body).unwrap_or(Value::Null);
    let version_id = field(&b, "versionId").and_then(Value::as_str).map(str::to_string);
    let if_updated = field(&b, "ifUpdatedAt").and_then(Value::as_f64).filter(|v| v.is_finite());
    let (Some(version_id), Some(if_updated)) = (version_id, if_updated) else {
        return Ok(respond(fail(StatusCode::BAD_REQUEST, "저장본과 현재 수정 시각이 필요합니다")));
    };
    // 되돌린 사람 — 외부 API 호출자가 보낸 이름(외부 API 메타데이터). 없으면 빈 값.
    let author = match field(&b, "updatedBy") {
        Some(Value::String(u)) if !u.trim().is_empty() => u.trim().to_string(),
        _ => String::new(),
    };
    let out = s
        .db
        .run(move |c| {
            // 읽고-검사하고-쓰기를 한 트랜잭션에서 — 그 사이 다른 저장이 끼면 409 가 의미를 잃는다.
            let tx = c.unchecked_transaction()?;
            let Some(current) = select_request(&tx, &id)? else { return Ok(fail(StatusCode::NOT_FOUND, "요청이 없습니다")) };
            if num(current.get("updatedAt")) != Some(if_updated) {
                return Ok(fail(StatusCode::CONFLICT, "다른 사람이 수정했습니다. 다시 열어 확인하세요."));
            }
            let Some(version) = select_version(&tx, &id, &version_id)? else { return Ok(fail(StatusCode::NOT_FOUND, "저장본이 없습니다")) };
            let snapshot = match serde_json::from_str::<Value>(&secretbox::decrypt_secret(&str_or(version.get("snapshot"), ""))) {
                Ok(Value::Object(m)) => m,
                // null 은 Node 에서 snapshot.aiExecutionAllowed 를 읽다 TypeError(500) 였다.
                Ok(Value::Null) => anyhow::bail!("Cannot read properties of null (reading 'aiExecutionAllowed')"),
                Ok(_) => Map::new(),
                Err(_) => return Ok(fail(StatusCode::INTERNAL_SERVER_ERROR, "저장본을 복호화하지 못했습니다")),
            };
            let updated_at = (js::now_ms() as f64).max(num(current.get("updatedAt")).unwrap_or(0.0) + 1.0);
            let mut set: Vec<(&str, Sql)> = vec![
                ("updated_at", Sql::Real(updated_at)),
                ("updated_by", Sql::Text(author.clone())),
                ("ai_execution_allowed", Sql::Integer((snapshot.get("aiExecutionAllowed") == Some(&Value::Bool(true))) as i64)),
            ];
            // 저장본에 없는 칸(undefined)은 drizzle 이 SET 에서 뺀다 — 그 칸은 지금 값 그대로.
            for (k, col) in RESTORE_FIELDS {
                if let Some(v) = snapshot.get(*k) {
                    set.push((col, bind(Some(v)).map_err(anyhow::Error::msg)?));
                }
            }
            let snap_now = secretbox::encrypt_secret(&js::stringify(&Value::Object(current.clone())));
            insert_version(&tx, &id, &snap_now, &current)?;
            let sql = format!(
                r#"UPDATE "requests" SET {} WHERE "requests"."id" = ?{}"#,
                set.iter().enumerate().map(|(i, (col, _))| format!(r#""{col}" = ?{}"#, i + 1)).collect::<Vec<_>>().join(", "),
                set.len() + 1
            );
            let mut params: Vec<Sql> = set.into_iter().map(|(_, v)| v).collect();
            params.push(Sql::Text(id.clone()));
            tx.prepare_cached(&sql)?.execute(rusqlite::params_from_iter(params))?;
            let restored = select_request(&tx, &id)?.ok_or_else(|| anyhow::anyhow!("복원한 요청을 다시 읽지 못했습니다"))?;
            tx.commit()?;
            Ok((StatusCode::OK, json!({ "ok": true, "updatedAt": updated_at, "request": to_client_request(&restored) })))
        })
        .await?;
    Ok(respond(out))
}

// ── 예시 응답(핀) ───────────────────────────────────────────────────────

/// 핀 예시는 최근 몇 개만. 상한이 없을 땐 예시 하나가 응답 본문 최대 1MB 라, 스무 개를 고정하면
/// 요청을 열 때마다 20MB 를 받았다 — 화면은 위에서 두어 개만 보는데도.
const MAX_EXAMPLES: i64 = 5;

async fn examples(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<Response> {
    let list = s
        .db
        .run(move |c| {
            let sql = format!(
                r#"SELECT {} FROM "executions" WHERE ("executions"."request_id" = ?1 AND "executions"."pinned" = 1) ORDER BY "executions"."executed_at" DESC LIMIT ?2"#,
                select_list("executions", EXECUTION_COLS)
            );
            let mut st = c.prepare_cached(&sql)?;
            let rows = st.query_map(rusqlite::params![id, MAX_EXAMPLES], |r| read(r, EXECUTION_COLS, 0))?;
            let mut out = Vec::new();
            for r in rows {
                out.push(parse_execution(r?));
            }
            Ok(Value::Array(out))
        })
        .await?;
    Ok(reply(StatusCode::OK, &list))
}

// ── 상태 요약 ───────────────────────────────────────────────────────────

/// 이 요청이 지금 어떤 상태인가 — 실행 화면에서 바로 보여줄 요약(한 번의 호출로).
/// 스펙 변경·성공률·실패가 각기 다른 화면에 흩어져 있어 아무도 안 봤다. 요청을 여는 순간
/// "3일 전에 스펙이 바뀌었고, 어젯밤 한 번 500 이 났다" 를 알면 실행 전에 손을 멈출 수 있다.
async fn status(State(s): State<AppState>, Path(id): Path<String>, RawQuery(q): RawQuery) -> Response {
    let hours_raw = js::query_get(q.as_deref(), "hours").map_or(24.0, |h| js::number(&h));
    let hours = if hours_raw.is_finite() && hours_raw > 0.0 && hours_raw <= 24.0 * 90.0 { hours_raw } else { 24.0 };
    let since = js::now_ms() as f64 - hours * 3_600_000.0;
    match s.db.run(move |c| status_in_db(c, &id, hours, since)).await {
        Ok(out) => respond(out),
        Err(e) => {
            // jsonError 와 같다 — 콘솔과 앱 안 서버 로그에 함께 남기고, 원인을 담아 500.
            const PREFIX: &str = "요청 상태 조회 중 서버 오류";
            let msg = e.to_string();
            eprintln!("[route] {PREFIX}: {msg}");
            server_log::log(Level::Error, PREFIX, &msg, None, None);
            respond(fail(StatusCode::INTERNAL_SERVER_ERROR, &format!("{PREFIX}: {msg}")))
        }
    }
}

fn status_in_db(c: &Connection, id: &str, hours: f64, since: f64) -> anyhow::Result<Out> {
    if !request_exists(c, id)? {
        return Ok(fail(StatusCode::NOT_FOUND, "요청이 없습니다"));
    }
    // 집계에는 본문이 필요 없다 — responseBody(행당 최대 1MB)를 끌어오지 않는다. 행도 모으지 않고 센다.
    let mut st = c.prepare_cached(
        r#"SELECT "response_status", "error" IS NULL, "check_passed" FROM "executions" WHERE ("executions"."request_id" = ?1 AND "executions"."executed_at" >= ?2)"#,
    )?;
    let mut rows = st.query(rusqlite::params![id, since])?;
    let (mut total, mut failed) = (0u64, 0u64);
    while let Some(r) = rows.next()? {
        total += 1;
        // 실패 판정은 crate::execution_outcome 과 같은 규칙 — 여기만 HTTP 코드로 세면 다른 화면과 말이 갈린다.
        if is_failed_row(r.get::<_, bool>(1)?, rows::boolean(r, 2)?, num(Some(&rows::raw(r.get_ref(0)?)))) {
            failed += 1;
        }
    }
    drop(rows);
    // 마지막 실패는 창(hours) 밖이어도 보여준다 — '최근엔 괜찮은데 지난주에 깨졌다' 도 알아야 할 사실이다.
    let last_failure = c
        .prepare_cached(&format!(
            r#"SELECT "executed_at", "response_status", "error" FROM "executions" WHERE ("executions"."request_id" = ?1 AND {FAILED_SQL}) ORDER BY "executions"."executed_at" DESC LIMIT 1"#
        ))?
        .query_row([id], |r| rows::object(r, &[("executedAt", 0, Col::Plain), ("status", 1, Col::Plain), ("error", 2, Col::Plain)]))
        .optional()?
        .map_or(Value::Null, Value::Object);
    // 이 요청에 마지막으로 붙은 스펙 변경. new 는 '가져왔다' 는 뜻이라 알림거리가 아니다.
    let spec_change = c
        .prepare_cached(
            r#"SELECT "change_type", "created_at", "detail" FROM "spec_changes" WHERE ("spec_changes"."request_id" = ?1 AND ("spec_changes"."change_type" = 'changed' OR "spec_changes"."change_type" = 'deprecated')) ORDER BY "spec_changes"."created_at" DESC LIMIT 1"#,
        )?
        .query_row([id], |r| rows::object(r, &[("changeType", 0, Col::Plain), ("createdAt", 1, Col::Plain), ("detail", 2, Col::Plain)]))
        .optional()?
        .map_or(Value::Null, Value::Object);
    Ok((
        StatusCode::OK,
        json!({ "window": { "hours": hours, "since": since }, "total": total, "failed": failed, "lastFailure": last_failure, "specChange": spec_change }),
    ))
}

// ── 응답 스키마 검사(validate) ──────────────────────────────────────────
//
// 스키마 선택·대조는 [`crate::schema_validate`] — 시나리오·스케줄 스텝도 같은 판정을 쓴다.

use crate::schema_validate::{schema_for, validate_request_response, Found};

/// 이 응답 상태에 검사할 스키마가 있나.
async fn validate_get(State(s): State<AppState>, Path(id): Path<String>, RawQuery(q): RawQuery) -> Response {
    let status = js::query_get(q.as_deref(), "status").map_or(0.0, |v| js::number(&v));
    if !(status.is_finite() && status.fract() == 0.0 && (100.0..=599.0).contains(&status)) {
        return reply(StatusCode::OK, &json!({ "available": false, "reason": "응답 상태 코드가 없습니다" }));
    }
    let ct = js::query_get(q.as_deref(), "contentType").filter(|c| !c.is_empty()).unwrap_or_else(|| "application/json".into());
    match schema_for(&s, &id, status as u16, &ct).await {
        Ok(Found::Schema { .. }) => reply(StatusCode::OK, &json!({ "available": true })),
        Ok(Found::Reason(r)) => reply(StatusCode::OK, &json!({ "available": false, "reason": r })),
        Err(e) => reply(StatusCode::BAD_GATEWAY, &json!({ "available": false, "reason": e.message() })),
    }
}

/// 응답 본문 상한 — 본문은 보통 1MB 이하지만 Node 는 상한을 두지 않았다. 무한정 받지는 않는다.
pub const BODY_LIMIT: usize = 64 * 1024 * 1024;

/// 실제 응답을 스펙 스키마와 대조한다.
async fn validate_post(State(s): State<AppState>, Path(id): Path<String>, req: Request) -> Response {
    let Ok(bytes) = axum::body::to_bytes(req.into_body(), BODY_LIMIT).await else {
        return reply(StatusCode::PAYLOAD_TOO_LARGE, &json!({ "error": "본문이 너무 큽니다" }));
    };
    let b = read_json(&bytes).filter(|b| js::truthy(Some(b)));
    let status = b
        .as_ref()
        .and_then(|b| field(b, "responseStatus"))
        .and_then(Value::as_f64)
        .filter(|v| v.fract() == 0.0 && (100.0..=599.0).contains(v));
    let (Some(b), Some(status)) = (b, status) else {
        return reply(StatusCode::BAD_REQUEST, &json!({ "error": "실제 응답 상태 코드가 필요합니다" }));
    };
    // 숫자 contentType 이 그대로 통과해 split 에서 터지고 502 로 보였다 — 부르는 쪽 잘못은 400 이다.
    if field(&b, "contentType").map_or(false, |v| !v.is_string()) {
        return reply(StatusCode::BAD_REQUEST, &json!({ "error": "contentType 은 문자열이어야 합니다" }));
    }
    if field(&b, "responseBody").map_or(false, |v| !v.is_null() && !v.is_string()) {
        return reply(StatusCode::BAD_REQUEST, &json!({ "error": "responseBody 는 문자열이어야 합니다" }));
    }
    let body = field(&b, "responseBody").and_then(Value::as_str);
    let ct = field(&b, "contentType").and_then(Value::as_str);
    match validate_request_response(&s, &id, None, Some(status as u16), body, ct).await {
        Ok(mut v) => {
            // 수동 검사에서는 건너뛴 것을 성공으로 치지 않는다(ok:false).
            if v.skipped.is_some() {
                v.ok = false;
            }
            reply(StatusCode::OK, &v.to_json())
        }
        Err(e) => reply(StatusCode::BAD_GATEWAY, &json!({ "error": e.message() })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request as HttpRequest;
    use tower::ServiceExt;

    fn app() -> (Router, crate::Db) {
        let db = crate::variables::tests::test_db();
        let state = AppState {
            db: db.clone(),
            config: crate::Config { host: "127.0.0.1".into(), port: 0, db_path: ":memory:".into(), migrations_dir: "drizzle".into(), static_dir: None },
        };
        (crate::routes::router().with_state(state), db)
    }

    async fn call(app: &Router, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
        let req = HttpRequest::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .body(body.map_or(axum::body::Body::empty(), |b| axum::body::Body::from(b.to_string())))
            .unwrap();
        let res = app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    fn exec(db: &crate::Db, sql: &'static str) {
        db.with(move |c| Ok(c.execute_batch(sql)?)).unwrap();
    }

    #[tokio::test]
    async fn 저장본_목록_조회_복원() {
        let (app, db) = app();
        exec(&db, "INSERT INTO folders (id, name) VALUES ('f', 'f'); INSERT INTO requests (id, folder_id, name, updated_at) VALUES ('r', 'f', 'v1', 10);");
        call(&app, "PUT", "/api/requests/r", Some(json!({"name": "v2"}))).await;
        let (_, list) = call(&app, "GET", "/api/requests/r/versions", None).await;
        assert_eq!(list.as_array().unwrap().len(), 1);
        let vid = list[0]["id"].as_str().unwrap().to_string();
        assert_eq!(list[0]["createdAt"], json!(10));
        let (_, one) = call(&app, "GET", &format!("/api/requests/r/versions?versionId={vid}"), None).await;
        assert_eq!(one["snapshot"]["name"], json!("v1"));
        assert_eq!(one["snapshot"]["params"], json!([]));
        let (st, _) = call(&app, "GET", "/api/requests/r/versions?versionId=nope", None).await;
        assert_eq!(st, StatusCode::NOT_FOUND);

        let (st, _) = call(&app, "POST", "/api/requests/r/versions", Some(json!({"versionId": vid, "ifUpdatedAt": 1}))).await;
        assert_eq!(st, StatusCode::CONFLICT);
        let (st, _) = call(&app, "POST", "/api/requests/r/versions", Some(json!({"versionId": vid}))).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        let now: i64 = db.with(|c| Ok(c.query_row("SELECT updated_at FROM requests WHERE id = 'r'", [], |r| r.get(0))?)).unwrap();
        let (st, r) = call(&app, "POST", "/api/requests/r/versions", Some(json!({"versionId": vid, "ifUpdatedAt": now}))).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(r["request"]["name"], json!("v1"));
        assert_eq!(r["request"]["updatedBy"], json!(""));
        let (_, list) = call(&app, "GET", "/api/requests/r/versions", None).await;
        assert_eq!(list.as_array().unwrap().len(), 2);
        // API 호출자가 수정자를 보내면 되돌린 사람으로 남는다.
        let vid2 = list[1]["id"].as_str().unwrap().to_string();
        let now = r["updatedAt"].clone();
        let (st, r) = call(&app, "POST", "/api/requests/r/versions", Some(json!({"versionId": vid2, "ifUpdatedAt": now, "updatedBy": " 민지 "}))).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(r["request"]["updatedBy"], json!("민지"));
    }

    #[tokio::test]
    async fn 예시_상태() {
        let (app, db) = app();
        exec(&db, "INSERT INTO folders (id, name) VALUES ('f', 'f'); INSERT INTO requests (id, folder_id, name, updated_at) VALUES ('r', 'f', 'n', 1);");
        let now = js::now_ms();
        db.with(move |c| {
            for (i, (st, err, cp, pin)) in [(Some(200), None, None, 1), (Some(500), None, None, 0), (Some(404), None, Some(1), 1), (None, Some("x"), None, 0)].iter().enumerate() {
                c.execute(
                    "INSERT INTO executions (id, request_id, executed_by, executed_at, resolved, response_status, error, check_passed, pinned) VALUES (?1, 'r', 'u', ?2, '{bad', ?3, ?4, ?5, ?6)",
                    rusqlite::params![format!("e{i}"), now - i as i64, st, err, cp, pin],
                )?;
            }
            Ok(())
        })
        .unwrap();
        let (_, ex) = call(&app, "GET", "/api/requests/r/examples", None).await;
        assert_eq!(ex.as_array().unwrap().len(), 2);
        assert_eq!(ex[0]["resolved"], json!({}));
        assert_eq!(ex[0]["pinned"], json!(true));
        let (_, stt) = call(&app, "GET", "/api/requests/r/status?hours=abc", None).await;
        assert_eq!(stt["window"]["hours"], json!(24));
        assert_eq!((stt["total"].clone(), stt["failed"].clone()), (json!(4), json!(2)));
        assert_eq!(stt["lastFailure"]["status"], json!(500));
        assert_eq!(stt["specChange"], Value::Null);
        let (st, _) = call(&app, "GET", "/api/requests/nope/status", None).await;
        assert_eq!(st, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn 검사는_db_로_답할_수_있는_것만() {
        let (app, db) = app();
        exec(&db, "INSERT INTO folders (id, name) VALUES ('f', 'f'); INSERT INTO requests (id, folder_id, name, updated_at) VALUES ('r', 'f', 'n', 1);");
        let (st, v) = call(&app, "GET", "/api/requests/r/validate", None).await;
        assert_eq!((st, v), (StatusCode::OK, json!({"available": false, "reason": "응답 상태 코드가 없습니다"})));
        let (st, v) = call(&app, "GET", "/api/requests/r/validate?status=200", None).await;
        assert_eq!((st, v), (StatusCode::OK, json!({"available": false, "reason": crate::schema_validate::UNLINKED})));
        let (st, v) = call(&app, "GET", "/api/requests/x/validate?status=200", None).await;
        assert_eq!((st, v), (StatusCode::BAD_GATEWAY, json!({"available": false, "reason": crate::schema_validate::MISSING})));
        let (st, _) = call(&app, "POST", "/api/requests/r/validate", Some(json!({"responseStatus": 99}))).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        let (st, _) = call(&app, "POST", "/api/requests/r/validate", Some(json!({"responseStatus": 200, "contentType": 1}))).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        let (st, v) = call(&app, "POST", "/api/requests/r/validate", Some(json!({"responseStatus": 200, "responseBody": null}))).await;
        assert_eq!((st, v.to_string()), (StatusCode::OK, r#"{"ok":false,"issues":[],"skipped":"연결된 OpenAPI 정의가 없습니다"}"#.to_string()));
    }

    #[tokio::test]
    async fn 스펙이_연결된_요청은_스펙_문서를_받아_검사한다() {
        let spec = json!({ "openapi": "3.0.0", "paths": { "/orders/{id}": { "get": { "responses": { "200": { "content": { "application/json": {
            "schema": { "$ref": "#/components/schemas/Order" } } } } } } } },
            "components": { "schemas": { "Order": { "type": "object", "required": ["id"], "properties": { "id": { "type": "integer" } } } } } });
        let body = crate::js::stringify(&spec);
        let m = crate::executor::tests::mock(move |_, _, _| crate::executor::tests::resp("200 OK", &[("content-type", "application/json")], body.as_bytes())).await;
        let (app, db) = app();
        let sql = format!(
            "INSERT INTO folders (id, name, spec_source_type, spec_source_url) VALUES ('f', 'f', 'url', '{}/spec.json');
             INSERT INTO requests (id, folder_id, name, spec_operation_key, updated_at) VALUES ('r', 'f', 'n', 'GET /orders/{{id}}', 1),
                                                                                        ('q', 'f', 'n', 'GET /nope', 1);",
            m.base
        );
        db.with(move |c| Ok(c.execute_batch(&sql)?)).unwrap();
        let (st, v) = call(&app, "GET", "/api/requests/r/validate?status=200", None).await;
        assert_eq!((st, v), (StatusCode::OK, json!({ "available": true })));
        let (_, v) = call(&app, "GET", "/api/requests/r/validate?status=500", None).await;
        assert_eq!(v, json!({ "available": false, "reason": "HTTP 500 응답의 application/json 스키마가 없습니다" }));
        let (_, v) = call(&app, "GET", "/api/requests/q/validate?status=200", None).await;
        assert_eq!(v["reason"], json!("OpenAPI에서 이 요청을 찾지 못했습니다. 스펙 동기화를 확인하세요"));
        let (st, v) = call(&app, "POST", "/api/requests/r/validate", Some(json!({ "responseStatus": 200, "responseBody": "{\"id\":1}" }))).await;
        assert_eq!((st, v), (StatusCode::OK, json!({ "ok": true, "issues": [] })));
        let (_, v) = call(&app, "POST", "/api/requests/r/validate", Some(json!({ "responseStatus": 200, "responseBody": "{\"id\":\"x\"}" }))).await;
        assert_eq!(v, json!({ "ok": false, "issues": [{ "path": "id", "message": "타입 불일치 — 스펙 integer, 실제 string" }] }));
        let (_, v) = call(&app, "POST", "/api/requests/r/validate", Some(json!({ "responseStatus": 200, "responseBody": "" }))).await;
        assert_eq!(v, json!({ "ok": false, "issues": [{ "path": "", "message": "응답 바디 없음" }], "skipped": "응답 바디 없음" }));
    }
}
