//! 스펙 동기화.
//!
//! 폴더의 스펙 소스(OpenAPI URL)를 다시 읽어 초안을 만들고([`crate::openapi`]),
//! 기존 요청과 비교한 계획([`crate::spec_sync`])을 한 트랜잭션으로 적용한다. 변경 이력(spec_changes)도 같은
//! 트랜잭션에 쓴다 — 한 번의 동기화는 이력에서도 한 번이어야 한다.

use axum::extract::{Path, RawQuery, State};
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::post;
use axum::Router;
use rusqlite::types::Value as Sql;
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Map, Value};

use crate::spec_fetch::{fetch_spec_json, SpecFetchError};
use crate::jsval::{bind, ok, reply};
use crate::openapi::spec_to_drafts;
use crate::records::{parse_request_row, read, select_list, FOLDER_COLS, REQUEST_COLS};
use crate::routes::input::json_error;
use crate::sort_order::GAP;
use crate::spec_sync::plan_sync;
use crate::{js, AppState};

pub fn router() -> Router<AppState> {
    Router::new().route("/api/folders/{id}/sync", post(sync))
}

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    reply(status, &json!({ "error": msg.into() }))
}

fn load_folder(c: &Connection, id: &str) -> anyhow::Result<Option<Map<String, Value>>> {
    let sql = format!(r#"select {} from "folders" where "folders"."id" = ?"#, select_list("folders", FOLDER_COLS));
    Ok(c.prepare_cached(&sql)?.query_row([id], |r| read(r, FOLDER_COLS, 0)).optional()?)
}

fn load_spec_requests(c: &Connection, folder_id: &str) -> anyhow::Result<Vec<Value>> {
    let sql = format!(
        r#"select {} from "requests" where ("requests"."folder_id" = ? and "requests"."origin" = ?)"#,
        select_list("requests", REQUEST_COLS)
    );
    let rows = c
        .prepare_cached(&sql)?
        .query_map(rusqlite::params![folder_id, "spec"], |r| read(r, REQUEST_COLS, 0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows.iter().map(|r| Value::Object(parse_request_row(r))).collect())
}

fn b(v: Option<&Value>) -> anyhow::Result<Sql> {
    bind(v).map_err(anyhow::Error::msg)
}

async fn sync(State(s): State<AppState>, Path(id): Path<String>, RawQuery(q): RawQuery) -> Response {
    let id2 = id.clone();
    let folder = match s.db.run(move |c| load_folder(c, &id2)).await {
        Ok(v) => v,
        Err(e) => return json_error("서버 오류", &e.to_string()),
    };
    let Some(folder) = folder else { return err(StatusCode::NOT_FOUND, "folder not found") };
    let ty = folder.get("specSourceType").and_then(Value::as_str);
    if !(ty == Some("url") && js::truthy(folder.get("specSourceUrl"))) {
        return err(StatusCode::BAD_REQUEST, "folder has no spec source");
    }

    let spec = match fetch_spec_json(&js::to_string(&folder["specSourceUrl"]), 15_000).await {
        Ok(v) => v,
        Err(SpecFetchError::Status(st)) => return err(StatusCode::BAD_GATEWAY, format!("spec fetch {st}")),
        // 폴더에 저장된 주소(또는 그 리다이렉트 목적지)가 메타데이터/사설망 — 상류 탓이 아니라 설정 탓이다.
        Err(SpecFetchError::Blocked(why)) => return err(StatusCode::BAD_REQUEST, why),
        Err(e) => return err(StatusCode::BAD_GATEWAY, e.message()),
    };

    let drafts = spec_to_drafts(&spec);
    let id2 = id.clone();
    let existing = match s.db.run(move |c| load_spec_requests(c, &id2)).await {
        Ok(v) => v,
        Err(e) => return json_error("서버 오류", &e.to_string()),
    };

    // 상류 스펙이 일시적으로 비어 오면 planSync 가 기존 요청 전부를 폐기한다 — 실제로 140개가 이렇게 폐기됐다.
    // 이미 스펙 요청이 있는 폴더에 0개가 오는 건 정상이 아니므로 중단한다(force 로만 허용).
    let force = js::query_get(q.as_deref(), "force").as_deref() == Some("1");
    if drafts.is_empty() && !existing.is_empty() && !force {
        return reply(
            StatusCode::CONFLICT,
            &json!({
                "error": format!("스펙에서 엔드포인트를 하나도 읽지 못했습니다 — 상류(스펙 소스)가 응답하지 않는 것 같습니다. 기존 요청 {}개를 폐기하지 않고 중단했습니다. 스펙 주소가 응답하는지 확인한 뒤 다시 시도하세요.", existing.len()),
                "aborted": true,
                "existing": existing.len(),
            }),
        );
    }

    let plan = plan_sync(&existing, &drafts);
    let counts = json!({
        "added": plan.to_insert.len(), "changed": plan.to_update.len(),
        "deprecated": plan.to_deprecate.len(), "synced": plan.to_mark_synced.len(),
    });
    let ws = folder.get("workspaceId").cloned().unwrap_or(Value::Null);
    let now = js::now_ms();

    let res = s
        .db
        .run(move |c| {
            let tx = c.unchecked_transaction()?;
            let record = |rid: &Value, op_key: &Value, change_type: &str, name: &Value, changes: Option<&Vec<Value>>| -> anyhow::Result<()> {
                // 이전 → 이후는 changed 에만 — 새로 생긴 것과 폐기된 것엔 '이전' 이 없다.
                let detail = changes.filter(|c| !c.is_empty()).map(|c| js::stringify(&Value::Array(c.clone())));
                tx.prepare_cached(r#"insert into "spec_changes" ("id", "workspace_id", "folder_id", "request_id", "operation_key", "change_type", "request_name", "detail", "created_at") values (?, ?, ?, ?, ?, ?, ?, ?, ?)"#)?
                    .execute(rusqlite::params![uuid::Uuid::new_v4().to_string(), b(Some(&ws))?, id, b(Some(rid))?, b(Some(op_key))?, change_type, b(Some(name))?, detail, now])?;
                Ok(())
            };
            // 새로 들어오는 스펙은 기존 요청 뒤에 이어 붙인다 — 0 이면 손으로 잡아 둔 순서를 밀어낸다.
            let mut order = existing.iter().map(|e| e.get("sortOrder").and_then(Value::as_f64).unwrap_or(0.0)).fold(0.0, f64::max);
            for d in &plan.to_insert {
                let rid = json!(uuid::Uuid::new_v4().to_string());
                order += GAP as f64;
                let desc = d.get("description").filter(|v| !v.is_null()).cloned().unwrap_or(json!(""));
                tx.prepare_cached(r#"insert into "requests" ("id", "folder_id", "name", "method", "url", "params", "headers", "body_type", "body", "description", "sort_order", "origin", "spec_state", "spec_operation_key", "spec_fingerprint", "spec_contract", "updated_at") values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#)?
                    .execute(rusqlite::params![
                        b(Some(&rid))?, id, b(d.get("name"))?, b(d.get("method"))?, b(d.get("url"))?,
                        js::stringify(&d["params"]), js::stringify(&d["headers"]), b(d.get("bodyType"))?, b(d.get("body"))?,
                        b(Some(&desc))?, order, "spec", "new", b(d.get("operationKey"))?, b(d.get("fingerprint"))?,
                        js::stringify(d.get("specContract").unwrap_or(&Value::Null)), now,
                    ])?;
                record(&rid, &d["operationKey"], "new", &d["name"], None)?;
            }
            for u in &plan.to_update {
                let d = &u.draft;
                let contract = js::stringify(d.get("specContract").unwrap_or(&Value::Null));
                let params = js::stringify(&Value::Array(u.merged_params.clone()));
                let headers = js::stringify(&Value::Array(u.merged_headers.clone()));
                // 스펙 설명은 최신으로 — 스펙에 설명이 없으면 사용자가 쓴 설명을 덮지 않는다.
                if js::truthy(d.get("description")) {
                    tx.prepare_cached(r#"update "requests" set "method" = ?, "url" = ?, "params" = ?, "headers" = ?, "description" = ?, "spec_state" = ?, "spec_fingerprint" = ?, "spec_contract" = ?, "updated_at" = ? where "requests"."id" = ?"#)?
                        .execute(rusqlite::params![b(d.get("method"))?, b(d.get("url"))?, params, headers, b(d.get("description"))?, "changed", b(d.get("fingerprint"))?, contract, now, b(Some(&u.id))?])?;
                } else {
                    tx.prepare_cached(r#"update "requests" set "method" = ?, "url" = ?, "params" = ?, "headers" = ?, "spec_state" = ?, "spec_fingerprint" = ?, "spec_contract" = ?, "updated_at" = ? where "requests"."id" = ?"#)?
                        .execute(rusqlite::params![b(d.get("method"))?, b(d.get("url"))?, params, headers, "changed", b(d.get("fingerprint"))?, contract, now, b(Some(&u.id))?])?;
                }
                record(&u.id, &d["operationKey"], "changed", &d["name"], Some(&u.changes))?;
            }
            let find = |rid: &Value| existing.iter().find(|e| e.get("id") == Some(rid));
            for rid in &plan.to_deprecate {
                tx.prepare_cached(r#"update "requests" set "spec_state" = ?, "updated_at" = ? where "requests"."id" = ?"#)?.execute(rusqlite::params!["deprecated", now, b(Some(rid))?])?;
                let ex = find(rid);
                let key = ex.and_then(|e| e.get("specOperationKey")).filter(|k| !k.is_null()).cloned().unwrap_or(json!(""));
                let name = ex.and_then(|e| e.get("name")).filter(|k| !k.is_null()).cloned().unwrap_or(json!(""));
                record(rid, &key, "deprecated", &name, None)?;
            }
            for rid in &plan.to_mark_synced {
                let key = find(rid).and_then(|e| e.get("specOperationKey")).cloned();
                let contract = drafts.iter().find(|d| d.get("operationKey").cloned() == key).and_then(|d| d.get("specContract")).cloned().unwrap_or(Value::Null);
                tx.prepare_cached(r#"update "requests" set "spec_state" = ?, "spec_contract" = ? where "requests"."id" = ?"#)?.execute(rusqlite::params!["synced", js::stringify(&contract), b(Some(rid))?])?;
            }
            tx.commit()?;
            Ok(())
        })
        .await;
    match res {
        Ok(()) => ok(&counts),
        Err(e) => json_error("동기화 실패 — 아무것도 반영하지 않았습니다", &e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::variables::tests::test_db;
    use axum::body::Body;
    use axum::http::Request;
    use std::sync::{Arc, Mutex};
    use tower::ServiceExt;

    fn state() -> AppState {
        let config = crate::Config { host: "127.0.0.1".into(), port: 0, db_path: ":memory:".into(), migrations_dir: Default::default(), static_dir: None };
        AppState { db: test_db(), config }
    }

    async fn call(s: &AppState, uri: &str) -> (StatusCode, Value) {
        let req = Request::builder().method("POST").uri(uri).body(Body::empty()).unwrap();
        let res = router().with_state(s.clone()).oneshot(req).await.unwrap();
        let status = res.status();
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    /// 스펙을 내주는 작은 서버 — 값을 바꿔 가며 동기화를 돌린다.
    async fn spec_server(spec: Arc<Mutex<Value>>) -> String {
        let app = Router::new().route(
            "/o.json",
            axum::routing::get(move || {
                let spec = spec.clone();
                async move { axum::Json(spec.lock().unwrap().clone()) }
            }),
        );
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        format!("http://{addr}/o.json")
    }

    #[tokio::test]
    async fn 동기화는_추가_변경_폐기를_한_번에_적용하고_빈_스펙이면_멈춘다() {
        let spec = Arc::new(Mutex::new(json!({ "paths": {
            "/a": { "get": { "summary": "A", "parameters": [{ "name": "q", "in": "query" }] } },
            "/b": { "post": { "summary": "B" } },
        } })));
        let url = spec_server(spec.clone()).await;
        let s = state();
        s.db.run(move |c| {
            c.execute(r#"insert into folders (id, workspace_id, name, spec_source_type, spec_source_url) values ('f', 'default', 'F', 'url', ?1)"#, [url])?;
            c.execute(r#"insert into folders (id, workspace_id, name) values ('plain', 'default', 'P')"#, [])?;
            Ok(())
        })
        .await
        .unwrap();

        assert_eq!(call(&s, "/api/folders/nope/sync").await.0, StatusCode::NOT_FOUND);
        assert_eq!(call(&s, "/api/folders/plain/sync").await, (StatusCode::BAD_REQUEST, json!({ "error": "folder has no spec source" })));

        let (st, v) = call(&s, "/api/folders/f/sync").await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v, json!({ "added": 2, "changed": 0, "deprecated": 0, "synced": 0 }));
        // 사용자가 값을 채운다 — 다음 동기화에서 지켜져야 한다.
        s.db.run(|c| Ok(c.execute(r#"update requests set params = '[{"key":"q","value":"사용자","enabled":true}]' where spec_operation_key = 'GET /a'"#, [])?))
            .await
            .unwrap();

        *spec.lock().unwrap() = json!({ "paths": { "/a": { "get": { "summary": "A", "parameters": [{ "name": "q", "in": "query", "description": "검색어" }] } } } });
        let (_, v) = call(&s, "/api/folders/f/sync").await;
        assert_eq!(v, json!({ "added": 0, "changed": 1, "deprecated": 1, "synced": 0 }));
        let (params, state_b, changes): (String, String, i64) = s
            .db
            .run(|c| {
                let p = c.query_row("select params from requests where spec_operation_key = 'GET /a'", [], |r| r.get(0))?;
                let b = c.query_row("select spec_state from requests where spec_operation_key = 'POST /b'", [], |r| r.get(0))?;
                let n = c.query_row("select count(*) from spec_changes where folder_id = 'f'", [], |r| r.get(0))?;
                Ok((p, b, n))
            })
            .await
            .unwrap();
        assert_eq!(params, r#"[{"key":"q","value":"사용자","enabled":true,"description":"검색어"}]"#);
        assert_eq!(state_b, "deprecated");
        assert_eq!(changes, 4);

        *spec.lock().unwrap() = json!({ "paths": {} });
        let (st, v) = call(&s, "/api/folders/f/sync").await;
        assert_eq!(st, StatusCode::CONFLICT);
        assert_eq!(v["aborted"], true);
        assert_eq!(v["existing"], 2);
    }
}
