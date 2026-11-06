//! `/api/requests` 와 단건 경로.
//! 실행(execute)·미리보기(preview)·실행 이력(executions)은 다른 모듈(routes::execute 등)에 있다.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use rusqlite::types::Value as Sql;
use rusqlite::Connection;
use serde_json::{json, Map, Value};

use crate::auth_config::{merge_auth_secrets, sanitize_request_auth};
use crate::error::ApiResult;
use crate::json_cols::safe_json;
use crate::jsval::{bind, reply, str_or};
use crate::records::{num, read, select_list, select_request, to_client_request, REQUEST_COLS};
use crate::request_fields::{body_types_text, is_body_type, is_http_method};
use crate::routes::input::{fail, read_json, require_text, respond, Out};
use crate::sort_order::{apply_reorder, Item, GAP};
use crate::{js, secretbox, AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/requests", get(list).post(create))
        .route("/api/requests/reorder", post(reorder))
        .route("/api/requests/{id}", get(get_one).put(update).delete(remove))
        .route("/api/requests/{id}/duplicate", post(duplicate))
}

/// `b.<k>` — 본문이 객체가 아니면(문자열·배열 등) 어떤 필드도 없는 것과 같다.
pub(crate) fn field<'a>(b: &'a Value, k: &str) -> Option<&'a Value> {
    b.as_object().and_then(|o| o.get(k))
}

/// `if (!b)` — 깨진 JSON 뿐 아니라 null·false·0·"" 도 400 이다.
fn body_or_400(body: &[u8]) -> Result<Value, Out> {
    read_json(body).filter(|b| js::truthy(Some(b))).ok_or_else(|| fail(StatusCode::BAD_REQUEST, "본문이 올바른 JSON 이 아닙니다"))
}

/// `JSON.stringify(Array.isArray(v) ? v : [])`
fn array_text(v: Option<&Value>) -> String {
    match v {
        Some(a @ Value::Array(_)) => js::stringify(a),
        _ => "[]".into(),
    }
}

/// `JSON.stringify(v && typeof v === 'object' && !Array.isArray(v) ? v : {})`
fn object_text(v: Option<&Value>) -> String {
    match v {
        Some(o @ Value::Object(_)) => js::stringify(o),
        _ => "{}".into(),
    }
}

/// 폴더의 마지막 자리 다음. 빈 폴더면 GAP.
fn next_order(c: &Connection, folder_id: &str) -> rusqlite::Result<f64> {
    let last: Option<Value> = c
        .prepare_cached(r#"SELECT "sort_order" FROM "requests" WHERE "folder_id" = ?1 ORDER BY "sort_order" DESC LIMIT 1"#)?
        .query_row([folder_id], |r| Ok(crate::rows::raw(r.get_ref(0)?)))
        .map(Some)
        .or_else(|e| if e == rusqlite::Error::QueryReturnedNoRows { Ok(None) } else { Err(e) })?;
    // `(last?.v ?? 0) + GAP`
    Ok(num(last.as_ref()).unwrap_or(0.0) + GAP as f64)
}

/// 폴더 안 형제들 — (sortOrder, id) 순.
fn siblings(c: &Connection, folder_id: &str) -> rusqlite::Result<Vec<Item>> {
    let mut st = c.prepare_cached(r#"SELECT "id", "sort_order" FROM "requests" WHERE "folder_id" = ?1 ORDER BY "sort_order", "id""#)?;
    let rows = st.query_map([folder_id], |r| {
        Ok(Item { id: crate::rows::text(r, 0)?, sort_order: num(Some(&crate::rows::raw(r.get_ref(1)?))).unwrap_or(0.0) as i64 })
    })?;
    rows.collect()
}

fn set_sort_orders(c: &Connection, updates: &[Item]) -> rusqlite::Result<()> {
    let mut st = c.prepare_cached(r#"UPDATE "requests" SET "sort_order" = ?1 WHERE "id" = ?2"#)?;
    for u in updates {
        st.execute(rusqlite::params![u.sort_order, u.id])?;
    }
    Ok(())
}

// ── GET /api/requests ───────────────────────────────────────────────────

/// 트리가 쓰는 칸만(slim). 바디는 행당 최대 1MB 라 여기서 빼는 것이 가장 크게 준다.
const SLIM: &[&str] = &["id", "folderId", "name", "method", "url", "origin", "specState", "sortOrder", "updatedAt"];

/// 요청 목록 — ?folderId=… 폴더 하나 / ?workspaceId=… 프로젝트 전체 / &slim=1 트리용 칸만.
/// 예전엔 폴더마다 한 번씩, 매번 바디까지 통째로 받아 첫 화면에 985KB 를 받았다.
async fn list(State(s): State<AppState>, RawQuery(q): RawQuery) -> ApiResult<Response> {
    let folder_id = js::query_get(q.as_deref(), "folderId").filter(|v| !v.is_empty());
    let workspace_id = js::query_get(q.as_deref(), "workspaceId").filter(|v| !v.is_empty());
    let slim = js::query_get(q.as_deref(), "slim").as_deref() == Some("1");
    if folder_id.is_none() && workspace_id.is_none() {
        return Ok(respond(fail(StatusCode::BAD_REQUEST, "folderId 또는 workspaceId 가 필요합니다")));
    }
    let rows = s
        .db
        .run(move |c| {
            let cols: Vec<(&'static str, &'static str, crate::rows::Col)> =
                // slim 은 Node 의 select({..}) 에 적힌 순서(=응답 키 순서)대로 — 스키마 순서와 다르다.
                if slim {
                    SLIM.iter().filter_map(|n| REQUEST_COLS.iter().find(|(m, _, _)| m == n).copied()).collect()
                } else {
                    REQUEST_COLS.to_vec()
                };
            // 같은 sortOrder 끼리 새로고침마다 자리를 바꾸지 않게 id 까지 정렬한다(화면의 bySortOrder 와 같은 규칙).
            let (sql, key) = match (&folder_id, &workspace_id) {
                (Some(f), _) => (
                    format!(r#"SELECT {} FROM "requests" WHERE "requests"."folder_id" = ?1 ORDER BY "requests"."sort_order" ASC, "requests"."id" ASC"#, select_list("requests", &cols)),
                    f.clone(),
                ),
                (None, Some(w)) => (
                    format!(
                        r#"SELECT {} FROM "requests" INNER JOIN "folders" ON "requests"."folder_id" = "folders"."id" WHERE "folders"."workspace_id" = ?1 ORDER BY "requests"."sort_order" ASC, "requests"."id" ASC"#,
                        select_list("requests", &cols)
                    ),
                    w.clone(),
                ),
                (None, None) => unreachable!(),
            };
            let mut st = c.prepare_cached(&sql)?;
            let rows = st.query_map([key], |r| read(r, &cols, 0))?;
            let mut out = Vec::new();
            for r in rows {
                let r = r?;
                out.push(if slim { Value::Object(r) } else { to_client_request(&r) });
            }
            Ok(Value::Array(out))
        })
        .await?;
    Ok(reply(StatusCode::OK, &rows))
}

// ── POST /api/requests ──────────────────────────────────────────────────

async fn create(State(s): State<AppState>, body: Bytes) -> ApiResult<Response> {
    let b = match body_or_400(&body) {
        Ok(b) => b,
        Err(o) => return Ok(respond(o)),
    };
    // truthy 검사는 문자열 검증이 아니다 — 숫자 123 이 통과해 목록에 '123.0' 이라는 요청이 생겼다.
    let folder_id = require_text(field(&b, "folderId"), 64);
    let name = require_text(field(&b, "name"), 200);
    let (Some(folder_id), Some(name)) = (folder_id, name) else {
        return Ok(respond(fail(StatusCode::BAD_REQUEST, "folderId, name 은 비어 있지 않은 문자열이어야 합니다")));
    };
    // SQLite 는 enum 을 강제하지 않는다 — 들어오는 자리에서 거절하는 편이 훨씬 싸다.
    if field(&b, "bodyType").map_or(false, |v| !is_body_type(v)) {
        return Ok(respond(fail(StatusCode::BAD_REQUEST, &format!("bodyType 은 {} 중 하나여야 합니다", body_types_text()))));
    }
    if field(&b, "method").map_or(false, |v| !is_http_method(v)) {
        return Ok(respond(fail(StatusCode::BAD_REQUEST, "method 는 공백 없는 영문/숫자 토큰이어야 합니다 (예: GET, POST)")));
    }
    // `b.x ?? ''` — null·없음만 기본값, 그 외는 받은 값 그대로(숫자면 REAL 로 저장된다 — Node 와 같다).
    let or = |k: &str, d: &str| match field(&b, k) {
        None | Some(Value::Null) => Value::String(d.into()),
        Some(v) => v.clone(),
    };
    let auth = match secretbox::encrypt_auth_config(&sanitize_request_auth(field(&b, "auth"))) {
        Ok(a) => js::stringify(&a),
        Err(e) => return Ok(respond(fail(StatusCode::INTERNAL_SERVER_ERROR, &e))),
    };
    // 행 — Node 의 객체 리터럴 순서 그대로(응답 키 순서가 여기서 나온다). sortOrder 는 DB 를 보고 채운다.
    let mut row = Map::new();
    row.insert("id".into(), json!(uuid::Uuid::new_v4().to_string()));
    row.insert("folderId".into(), json!(folder_id));
    row.insert("name".into(), json!(name));
    row.insert("method".into(), or("method", "GET"));
    row.insert("url".into(), or("url", ""));
    // 배열/객체 컬럼은 타입 보장 후 저장 — 비배열이 박히면 이후 export·병합이 .map/.filter 로 500 난다.
    row.insert("params".into(), json!(array_text(field(&b, "params"))));
    row.insert("headers".into(), json!(array_text(field(&b, "headers"))));
    row.insert("bodyType".into(), or("bodyType", "none"));
    row.insert("body".into(), or("body", ""));
    row.insert("description".into(), or("description", ""));
    row.insert("origin".into(), json!("manual"));
    row.insert("updatedAt".into(), json!(js::now_ms()));
    row.insert("updatedBy".into(), Value::Null);
    row.insert("sortOrder".into(), Value::Null);
    row.insert("assertions".into(), json!(array_text(field(&b, "assertions"))));
    row.insert("preSteps".into(), json!(array_text(field(&b, "preSteps"))));
    row.insert("postSteps".into(), json!(array_text(field(&b, "postSteps"))));
    row.insert("auth".into(), json!(auth));
    row.insert("tags".into(), json!(array_text(field(&b, "tags"))));
    row.insert("settings".into(), json!(object_text(field(&b, "settings"))));
    row.insert("vars".into(), json!(array_text(field(&b, "vars"))));

    let out = s
        .db
        .run(move |c| {
            let mut row = row;
            // 새 요청은 폴더 맨 뒤. 방금 만든 것이 목록 한가운데 나타나면 찾지 못한다.
            let order = next_order(c, row["folderId"].as_str().unwrap_or(""))?;
            // `(last?.v ?? 0) + GAP` — 마지막 자리가 소수면 결과도 소수다. 정수로 자르면 Node 와 다른 자리에 놓인다(codex 리뷰).
            row.insert("sortOrder".into(), if order.fract() == 0.0 { json!(order as i64) } else { json!(order) });
            const COLS: &[(&str, &str)] = &[
                ("id", "id"), ("folderId", "folder_id"), ("name", "name"), ("method", "method"), ("url", "url"),
                ("params", "params"), ("headers", "headers"), ("bodyType", "body_type"), ("body", "body"),
                ("description", "description"), ("origin", "origin"), ("updatedAt", "updated_at"), ("updatedBy", "updated_by"),
                ("sortOrder", "sort_order"), ("assertions", "assertions"), ("preSteps", "pre_steps"), ("postSteps", "post_steps"),
                ("auth", "auth"), ("tags", "tags"), ("settings", "settings"), ("vars", "vars"),
            ];
            let mut vals = Vec::with_capacity(COLS.len());
            for (k, _) in COLS {
                let v = &row[*k];
                // 정수 열(updatedAt·sortOrder)만 정수로. url·body 같은 text 열에 온 숫자는 bind 가 REAL 로 —
                // '5.0' 으로 저장돼야 한다.
                vals.push(match v {
                    Value::Number(n) if matches!(*k, "updatedAt" | "sortOrder") => n.as_i64().map_or_else(|| Sql::Real(n.as_f64().unwrap_or(0.0)), Sql::Integer),
                    other => match bind(Some(other)) {
                        Ok(x) => x,
                        Err(e) => return Ok(fail(StatusCode::INTERNAL_SERVER_ERROR, &e)),
                    },
                });
            }
            let sql = format!(
                r#"INSERT INTO "requests" ({}) VALUES ({})"#,
                COLS.iter().map(|(_, c)| format!(r#""{c}""#)).collect::<Vec<_>>().join(", "),
                (1..=COLS.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ")
            );
            c.prepare_cached(&sql)?.execute(rusqlite::params_from_iter(vals))?;
            row.insert("specState".into(), Value::Null);
            row.insert("specOperationKey".into(), Value::Null);
            row.insert("specFingerprint".into(), Value::Null);
            Ok((StatusCode::CREATED, to_client_request(&row)))
        })
        .await?;
    Ok(respond(out))
}

// ── GET /api/requests/[id] ──────────────────────────────────────────────

/// 단건 조회 — 공유 링크(?req=<id>)로 열 때. 소속 워크스페이스를 함께 내려 다른 프로젝트의
/// 요청을 열더라도 화면이 올바른 환경으로 전환하게 한다.
async fn get_one(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<Response> {
    let out = s
        .db
        .run(move |c| {
            let Some(row) = select_request(c, &id)? else { return Ok(fail(StatusCode::NOT_FOUND, "request not found")) };
            let folder_id = str_or(row.get("folderId"), "");
            let ws: Option<Value> = c
                .prepare_cached(r#"SELECT "workspace_id" FROM "folders" WHERE "folders"."id" = ?1"#)?
                .query_row([folder_id], |r| Ok(crate::rows::raw(r.get_ref(0)?)))
                .map(Some)
                .or_else(|e| if e == rusqlite::Error::QueryReturnedNoRows { Ok(None) } else { Err(e) })?;
            let mut v = to_client_request(&row);
            v["workspaceId"] = match ws {
                None | Some(Value::Null) => json!("default"),
                Some(w) => w,
            };
            Ok((StatusCode::OK, v))
        })
        .await?;
    Ok(respond(out))
}

// ── PUT /api/requests/[id] ──────────────────────────────────────────────

/// 저장. 두 가지를 지킨다.
/// - 없는 요청에 200 을 주지 않는다 — 삭제된 탭에서 ⌘S 를 누르면 '저장됨' 이 뜨고 작업이 사라졌다.
/// - 낙관적 잠금: 화면이 알던 updatedAt(ifUpdatedAt)과 다르면 409 — 조용한 덮어쓰기를 막는다.
async fn update(State(s): State<AppState>, Path(id): Path<String>, body: Bytes) -> ApiResult<Response> {
    let b = match body_or_400(&body) {
        Ok(b) => b,
        Err(o) => return Ok(respond(o)),
    };
    let out = s.db.run(move |c| update_in_db(c, &id, &b)).await?;
    Ok(respond(out))
}

fn update_in_db(c: &Connection, id: &str, b: &Value) -> anyhow::Result<Out> {
    // 존재 확인 겸 현재 행 — 아래 auth 병합이 '지금 저장된 비밀값' 을 알아야 한다.
    let Some(current) = select_request(c, id)? else {
        return Ok(fail(StatusCode::NOT_FOUND, "요청이 없습니다 — 다른 사람이 지웠을 수 있습니다"));
    };
    let f = |k: &str| field(b, k);
    // ifUpdatedAt 미제공(구형 클라이언트/내부 도구)은 무조건 저장. 제공했으면 엄격 비교(===) — 문자열 "123" 은 다르다.
    if let Some(if_u) = f("ifUpdatedAt") {
        let same = matches!((num(current.get("updatedAt")), if_u), (Some(a), Value::Number(n)) if n.as_f64() == Some(a));
        if !same {
            return Ok((
                StatusCode::CONFLICT,
                json!({ "error": "conflict", "updatedBy": current.get("updatedBy").cloned().unwrap_or(Value::Null), "updatedAt": current.get("updatedAt").cloned().unwrap_or(Value::Null) }),
            ));
        }
    }
    // POST 와 같은 규칙 — 여기만 빠지면 '만들 땐 막고 고칠 땐 통과' 가 된다.
    if f("bodyType").map_or(false, |v| !is_body_type(v)) {
        return Ok(fail(StatusCode::BAD_REQUEST, &format!("bodyType 은 {} 중 하나여야 합니다", body_types_text())));
    }
    if f("method").map_or(false, |v| !is_http_method(v)) {
        return Ok(fail(StatusCode::BAD_REQUEST, "method 는 공백 없는 영문/숫자 토큰이어야 합니다 (예: GET, POST)"));
    }
    for key in ["params", "headers", "assertions", "preSteps", "postSteps", "tags", "vars"] {
        if f(key).map_or(false, |v| !v.is_array()) {
            return Ok(fail(StatusCode::BAD_REQUEST, &format!("{key} 은 배열이어야 합니다. 기존 값은 유지됩니다")));
        }
    }
    if f("aiExecutionAllowed").map_or(false, |v| !v.is_boolean()) {
        return Ok(fail(StatusCode::BAD_REQUEST, "AI 실행 허용은 참 또는 거짓이어야 합니다"));
    }
    let current_updated = num(current.get("updatedAt")).unwrap_or(0.0);
    let now = (js::now_ms() as f64).max(current_updated + 1.0);
    let mut set: Vec<(&'static str, Sql)> = vec![("updated_at", Sql::Real(now))];
    let mut put = |col: &'static str, v: Sql| match set.iter_mut().find(|(c, _)| *c == col) {
        Some(slot) => slot.1 = v,
        None => set.push((col, v)),
    };
    if let Some(Value::Bool(on)) = f("aiExecutionAllowed") {
        put("ai_execution_allowed", Sql::Integer(*on as i64));
    }
    for (k, col) in [
        ("name", "name"), ("method", "method"), ("url", "url"), ("bodyType", "body_type"), ("body", "body"),
        ("description", "description"), ("folderId", "folder_id"), ("owner", "owner"),
    ] {
        let Some(v) = f(k) else { continue };
        // 문자열 열에 숫자가 들어가면 SQLite 가 숫자로 저장하고 목록에 '123.0' 이 뜬다 — 실제로 그렇게 바뀐 적이 있다.
        let Some(sv) = v.as_str() else { return Ok(fail(StatusCode::BAD_REQUEST, &format!("{k} 은 문자열이어야 합니다"))) };
        if k == "owner" && js::len16(sv) > 100 {
            return Ok(fail(StatusCode::BAD_REQUEST, "담당자는 100자 이하여야 합니다"));
        }
        put(col, Sql::Text(sv.to_string()));
    }
    for (k, col) in [("params", "params"), ("headers", "headers"), ("assertions", "assertions"), ("preSteps", "pre_steps"), ("postSteps", "post_steps")] {
        if f(k).is_some() {
            put(col, Sql::Text(array_text(f(k))));
        }
    }
    if let Some(a) = f("auth") {
        // 조회에서 비밀값을 지우고 내려주므로, 화면이 돌려보낸 빈 값을 '지우라' 로 읽으면 저장할 때마다
        // 토큰이 사라진다. 빈 값은 '그대로 두라'(환경 변수 secret 과 같은 규약).
        let stored = secretbox::decrypt_auth_config(&sanitize_request_auth(safe_json(current.get("auth")).as_ref()));
        let merged = merge_auth_secrets(&sanitize_request_auth(Some(a)), &stored);
        let enc = secretbox::encrypt_auth_config(&merged).map_err(anyhow::Error::msg)?;
        put("auth", Sql::Text(js::stringify(&enc)));
    }
    if f("tags").is_some() {
        put("tags", Sql::Text(array_text(f("tags"))));
    }
    if f("settings").is_some() {
        put("settings", Sql::Text(object_text(f("settings"))));
    }
    if f("vars").is_some() {
        put("vars", Sql::Text(array_text(f("vars"))));
    }
    // 수정자는 외부 API 호출자가 보낸 이름(외부 API 메타데이터) — 로그인이 없으니 자기신고다(협업용 표시, 감사 기록 아님).
    if let Some(Value::String(u)) = f("updatedBy") {
        put("updated_by", Sql::Text(u.clone()));
    }
    // 폴더를 옮기면 새 폴더의 맨 뒤로. 예전 자리 번호를 들고 가면 새 폴더 한가운데 끼어든다 —
    // 자리까지 지정하려면 reorder 를 쓴다.
    if let Some(Value::String(to)) = f("folderId") {
        if Some(to.as_str()) != current.get("folderId").and_then(Value::as_str) {
            put("sort_order", Sql::Real(next_order(c, to)?));
        }
    }
    let snapshot = secretbox::encrypt_secret(&js::stringify(&Value::Object(current.clone())));
    let tx = c.unchecked_transaction()?;
    insert_version(&tx, id, &snapshot, &current)?;
    let sql = format!(
        r#"UPDATE "requests" SET {} WHERE "requests"."id" = ?{}"#,
        set.iter().enumerate().map(|(i, (col, _))| format!(r#""{col}" = ?{}"#, i + 1)).collect::<Vec<_>>().join(", "),
        set.len() + 1
    );
    let mut params: Vec<Sql> = set.into_iter().map(|(_, v)| v).collect();
    params.push(Sql::Text(id.to_string()));
    tx.prepare_cached(&sql)?.execute(rusqlite::params_from_iter(params))?;
    tx.commit()?;
    Ok((StatusCode::OK, json!({ "ok": true, "updatedAt": now })))
}

/// 저장 직전의 행을 저장본으로 남긴다 — createdAt 은 그 행의 updatedAt, author 는 그 행의 updatedBy.
pub(crate) fn insert_version(c: &Connection, request_id: &str, snapshot: &str, current: &Map<String, Value>) -> anyhow::Result<()> {
    let created = bind(current.get("updatedAt")).map_err(anyhow::Error::msg)?;
    let author = bind(current.get("updatedBy")).map_err(anyhow::Error::msg)?;
    c.prepare_cached(r#"INSERT INTO "request_versions" ("id", "request_id", "snapshot", "created_at", "author") VALUES (?1, ?2, ?3, ?4, ?5)"#)?
        .execute(rusqlite::params![uuid::Uuid::new_v4().to_string(), request_id, snapshot, created, author])?;
    Ok(())
}

// ── DELETE /api/requests/[id] ───────────────────────────────────────────

/// 한 트랜잭션으로 지운다. 따로 돌리면 중간에 끊겼을 때 요청은 남고 이력만 사라진다.
async fn remove(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<Response> {
    s.db
        .run(move |c| {
            let tx = c.unchecked_transaction()?;
            tx.prepare_cached(r#"DELETE FROM "executions" WHERE "executions"."request_id" = ?1"#)?.execute([&id])?;
            tx.prepare_cached(r#"DELETE FROM "request_versions" WHERE "request_versions"."request_id" = ?1"#)?.execute([&id])?;
            tx.prepare_cached(r#"DELETE FROM "requests" WHERE "requests"."id" = ?1"#)?.execute([&id])?;
            tx.commit()?;
            Ok(())
        })
        .await?;
    Ok(reply(StatusCode::OK, &json!({ "ok": true })))
}

// ── POST /api/requests/reorder ──────────────────────────────────────────

/// 요청의 자리를 옮긴다 — 폴더 안 순서 바꾸기와 폴더 간 이동을 한 번에.
/// 순서 값은 서버가 정한다. 화면은 "무엇 앞에" 만 말한다 — 둘이 같은 자리에 동시에 놓으면
/// 같은 중간값을 계산해 보내 순서가 무너지기 때문이다.
async fn reorder(State(s): State<AppState>, body: Bytes) -> ApiResult<Response> {
    let b = match body_or_400(&body) {
        Ok(b) => b,
        Err(o) => return Ok(respond(o)),
    };
    let text = |k: &str| field(&b, k).and_then(Value::as_str).unwrap_or("").to_string();
    let (id, folder_id) = (text("id"), text("folderId"));
    if id.is_empty() || folder_id.is_empty() {
        return Ok(respond(fail(StatusCode::BAD_REQUEST, "id, folderId 는 문자열이어야 합니다")));
    }
    // undefined 와 null 을 구분하지 않는다 — 둘 다 '맨 뒤'. 문자열이 아니면 무시한다.
    let before_id = Some(text("beforeId")).filter(|v| !v.is_empty());
    if before_id.as_deref() == Some(id.as_str()) {
        return Ok(respond(fail(StatusCode::BAD_REQUEST, "자기 자신 앞으로는 옮길 수 없습니다")));
    }
    let out = s
        .db
        .run(move |c| {
            let moving: Option<Value> = c
                .prepare_cached(r#"SELECT "folder_id" FROM "requests" WHERE "requests"."id" = ?1"#)?
                .query_row([&id], |r| Ok(crate::rows::raw(r.get_ref(0)?)))
                .map(Some)
                .or_else(|e| if e == rusqlite::Error::QueryReturnedNoRows { Ok(None) } else { Err(e) })?;
            let Some(moving_folder) = moving else { return Ok(fail(StatusCode::NOT_FOUND, "요청을 찾을 수 없습니다")) };
            let moved = moving_folder.as_str() != Some(folder_id.as_str());
            let plan = apply_reorder(&siblings(c, &folder_id)?, &id, before_id.as_deref());
            // 재배번은 여러 행을 건드린다 — 중간에 끊기면 순서가 반쯤 섞인 채로 남는다.
            let tx = c.unchecked_transaction()?;
            set_sort_orders(&tx, &plan.updates)?;
            if moved {
                tx.prepare_cached(r#"UPDATE "requests" SET "folder_id" = ?1 WHERE "requests"."id" = ?2"#)?.execute([&folder_id, &id])?;
            }
            tx.commit()?;
            Ok((StatusCode::OK, json!({ "ok": true, "moved": moved, "reindexed": plan.reindexed, "updated": plan.updates.len() })))
        })
        .await?;
    Ok(respond(out))
}

// ── POST /api/requests/[id]/duplicate ───────────────────────────────────

/// 요청 복제 — 원본 바로 아래에 같은 내용으로.
///
/// 예전엔 화면이 트리의 slim 행을 POST /api/requests 로 다시 보내 헤더·바디·인증이 전부 빈 채로 복제됐다.
/// 그래서 DB 의 원본 행을 서버에서 그대로 베낀다 — 인증 비밀값도 암호문 그대로라 복호화가 필요 없다.
/// 스펙 연결(spec*)과 AI 실행 허용은 넘기지 않는다: 복제본은 사람이 만든 요청이고, 실행 권한은 복제로 넘기지 않는다.
async fn duplicate(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<Response> {
    let out = s
        .db
        .run(move |c| {
            let Some(src) = select_request(c, &id)? else { return Ok(fail(StatusCode::NOT_FOUND, "요청을 찾을 수 없습니다")) };
            let new_id = uuid::Uuid::new_v4().to_string();
            let src_folder = str_or(src.get("folderId"), "");
            let tx = c.unchecked_transaction()?;
            // 원본 행을 그대로 베끼되 바꿀 칸만 바꾼다. 저장형(text·integer)도 원본 그대로 옮겨진다 —
            // drizzle 이 읽어서 다시 쓰던 것과 같은 결과다. name 은 `${src.name} (copy)`.
            let copy: Vec<String> = REQUEST_COLS
                .iter()
                .map(|(_, col, _)| match *col {
                    "id" => "?1".to_string(),
                    "name" => r#""name" || ' (copy)'"#.to_string(),
                    "origin" => "'manual'".to_string(),
                    "spec_state" | "spec_operation_key" | "spec_fingerprint" | "spec_contract" | "updated_by" => "NULL".to_string(),
                    "ai_execution_allowed" => "0".to_string(),
                    "updated_at" => "?2".to_string(),
                    other => format!(r#""{other}""#),
                })
                .collect();
            let sql = format!(
                r#"INSERT INTO "requests" ({}) SELECT {} FROM "requests" WHERE "id" = ?3"#,
                REQUEST_COLS.iter().map(|(_, col, _)| format!(r#""{col}""#)).collect::<Vec<_>>().join(", "),
                copy.join(", ")
            );
            tx.prepare_cached(&sql)?.execute(rusqlite::params![new_id, js::now_ms(), id])?;
            let sibs = siblings(&tx, &src_folder)?;
            // 원본 바로 다음 행 앞에 = 원본 바로 아래. 원본이 맨 끝이면 맨 뒤(null).
            let others: Vec<&Item> = sibs.iter().filter(|s| s.id != new_id).collect();
            let before = others.iter().position(|s| s.id == id).and_then(|at| others.get(at + 1)).map(|s| s.id.clone());
            set_sort_orders(&tx, &apply_reorder(&sibs, &new_id, before.as_deref()).updates)?;
            tx.commit()?;
            let saved = select_request(c, &new_id)?.ok_or_else(|| anyhow::anyhow!("복제본을 다시 읽지 못했습니다"))?;
            Ok((StatusCode::CREATED, to_client_request(&saved)))
        })
        .await?;
    Ok(respond(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    fn app() -> (Router, crate::Db) {
        let db = crate::variables::tests::test_db();
        let state = AppState {
            db: db.clone(),
            config: crate::Config {
                host: "127.0.0.1".into(),
                port: 0,
                db_path: ":memory:".into(),
                migrations_dir: "drizzle".into(),
                static_dir: None,
            },
        };
        (crate::routes::router().with_state(state), db)
    }

    async fn call(app: &Router, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
        let req = Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .body(body.map_or(Body::empty(), |b| Body::from(b.to_string())))
            .unwrap();
        let res = app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    fn seed_folder(db: &crate::Db, id: &str) {
        let id = id.to_string();
        db.with(move |c| Ok(c.execute("INSERT INTO folders (id, workspace_id, name) VALUES (?1, 'default', 'f')", [id])?)).unwrap();
    }

    #[tokio::test]
    async fn 만들고_고치고_복제하고_지운다() {
        let (app, db) = app();
        seed_folder(&db, "f1");
        let (st, a) = call(&app, "POST", "/api/requests", Some(json!({"folderId": "f1", "name": " A ", "url": 5}))).await;
        assert_eq!(st, StatusCode::CREATED);
        assert_eq!(a["name"], json!("A"));
        assert_eq!(a["url"], json!(5)); // 응답은 받은 값 그대로
        assert_eq!(a["sortOrder"], json!(1024));
        assert!(a.get("aiExecutionAllowed").is_none()); // Node 의 POST 응답에도 없다
        let id = a["id"].as_str().unwrap().to_string();
        let stored: String = db.with({ let id = id.clone(); move |c| Ok(c.query_row("SELECT url FROM requests WHERE id = ?1", [id], |r| r.get(0))?) }).unwrap();
        assert_eq!(stored, "5.0"); // better-sqlite3 처럼 REAL 로 들어가 text 열에서 '5.0'

        let (_, b) = call(&app, "POST", "/api/requests", Some(json!({"folderId": "f1", "name": "B"}))).await;
        assert_eq!(b["sortOrder"], json!(2048));

        // 낙관적 잠금
        let (st, conflict) = call(&app, "PUT", &format!("/api/requests/{id}"), Some(json!({"name": "x", "ifUpdatedAt": 1}))).await;
        assert_eq!(st, StatusCode::CONFLICT);
        assert_eq!(conflict["error"], json!("conflict"));
        let (st, _) = call(&app, "PUT", &format!("/api/requests/{id}"), Some(json!({"name": 123}))).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        let (st, _) = call(&app, "PUT", &format!("/api/requests/{id}"), Some(json!({"params": {}}))).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        let (st, put) = call(
            &app,
            "PUT",
            &format!("/api/requests/{id}"),
            Some(json!({"name": "A2", "ifUpdatedAt": a["updatedAt"], "auth": {"type": "bearer", "token": "T"}, "settings": [1]})),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(put["ok"], json!(true));
        // 빈 토큰으로 다시 저장해도 남는다
        call(&app, "PUT", &format!("/api/requests/{id}"), Some(json!({"auth": {"type": "bearer", "token": ""}}))).await;
        let auth: String = db.with({ let id = id.clone(); move |c| Ok(c.query_row("SELECT auth FROM requests WHERE id = ?1", [id], |r| r.get(0))?) }).unwrap();
        assert_eq!(auth, r#"{"type":"bearer","token":"T"}"#);
        let (_, one) = call(&app, "GET", &format!("/api/requests/{id}"), None).await;
        assert_eq!(one["auth"], json!({"type": "bearer", "token": "", "hasStoredSecret": true})); // 화면에는 지워서
        assert_eq!(one["settings"], json!({}));
        assert_eq!(one["workspaceId"], json!("default"));
        let versions: i64 = db.with(|c| Ok(c.query_row("SELECT count(*) FROM request_versions", [], |r| r.get(0))?)).unwrap();
        assert_eq!(versions, 2);

        // 복제 — 원본 바로 아래
        let (st, dup) = call(&app, "POST", &format!("/api/requests/{id}/duplicate"), None).await;
        assert_eq!(st, StatusCode::CREATED);
        assert_eq!(dup["name"], json!("A2 (copy)"));
        assert_eq!(dup["aiExecutionAllowed"], json!(false));
        let (_, list) = call(&app, "GET", "/api/requests?folderId=f1&slim=1", None).await;
        let names: Vec<&str> = list.as_array().unwrap().iter().map(|r| r["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["A2", "A2 (copy)", "B"]);
        assert_eq!(list[0].as_object().unwrap().len(), 9);

        // 맨 앞으로
        let bid = b["id"].as_str().unwrap();
        let (_, r) = call(&app, "POST", "/api/requests/reorder", Some(json!({"id": bid, "folderId": "f1", "beforeId": id}))).await;
        assert_eq!(r, json!({"ok": true, "moved": false, "reindexed": false, "updated": 1}));
        let (_, list) = call(&app, "GET", "/api/requests?workspaceId=default", None).await;
        assert_eq!(list[0]["name"], json!("B"));

        let (_, d) = call(&app, "DELETE", &format!("/api/requests/{id}"), None).await;
        assert_eq!(d, json!({"ok": true}));
        let (st, _) = call(&app, "GET", &format!("/api/requests/{id}"), None).await;
        assert_eq!(st, StatusCode::NOT_FOUND);
        let (st, _) = call(&app, "PUT", &format!("/api/requests/{id}"), Some(json!({}))).await;
        assert_eq!(st, StatusCode::NOT_FOUND);
        let (st, e) = call(&app, "GET", "/api/requests", None).await;
        assert_eq!((st, e), (StatusCode::BAD_REQUEST, json!({"error": "folderId 또는 workspaceId 가 필요합니다"})));
    }
}
