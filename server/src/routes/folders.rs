//! `/api/folders`.
//!
//! `[id]/sync`(스펙 동기화)는 routes/folder_sync.rs, `[id]/run`(폴더 실행)은 routes/flow_run.rs 에 있다.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::Router;
use rusqlite::types::{Value as Sql, ValueRef};
use rusqlite::{params_from_iter, Connection};
use serde_json::{json, Value};

use crate::auth_config::{auth_for_client, merge_auth_secrets, sanitize_folder_auth};
use crate::error::{ApiError, ApiResult};
use crate::json_cols::{safe_json_ref, to_kv_array, to_string_array};
use crate::jsval::{self, reply};
use crate::openapi_export::{file_name, folder_to_openapi, ReqLike};
use crate::routes::input::{bad_request, read_json, require_text};
use crate::rows;
use crate::secretbox::{decrypt_auth_config_with, encrypt_auth_config_with, Keys};
use crate::sort_order::{apply_reorder, Item, GAP};
use crate::records::{read, select_list, FOLDER_COLS};
use crate::{js, AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/folders", get(list).post(create))
        .route("/api/folders/reorder", post(reorder))
        .route("/api/folders/{id}", put(update).delete(remove))
        .route("/api/folders/{id}/openapi", get(openapi))
}

/// drizzle 의 `select().from(folders)` 열 — schema.ts 에 적힌 순서 그대로(응답 키 순서가 된다). 열 목록은 records 한 곳에 둔다.
fn folder_select() -> String {
    select_list("folders", FOLDER_COLS)
}

/// `parseSharedAuth` — sanitize(유효 타입·필드만) 뒤 secret 복호화. 무효·미지정이면 none.
fn parse_shared_auth(v: ValueRef<'_>, keys: &Keys) -> Value {
    decrypt_auth_config_with(keys, &sanitize_folder_auth(safe_json_ref(v).as_ref()))
}

/// `parseFolderRow` — 공통 헤더는 KV 정규화, 공통 인증은 비밀값을 지우고 내려준다(요청 인증과 같은 이유).
fn parse_folder_row(r: &rusqlite::Row<'_>, keys: &Keys) -> rusqlite::Result<Value> {
    let mut m = read(r, FOLDER_COLS, 0)?;
    m.insert("sharedHeaders".into(), Value::Array(to_kv_array(safe_json_ref(r.get_ref(6)?).as_ref())));
    m.insert("sharedAuth".into(), auth_for_client(&parse_shared_auth(r.get_ref(7)?, keys)));
    Ok(Value::Object(m))
}

/// JS 값 → 바인딩 값 — 규칙은 [`jsval::bind`] 하나. 바인딩 오류는 500.
fn bind(v: &Value) -> Result<Sql, ApiError> {
    jsval::bind(Some(v)).map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e))
}

/// `req.json()` 이 실패했거나 `!b`(null·false·0·"") 이면 None.
fn truthy_body(body: &[u8]) -> Option<Value> {
    read_json(body).filter(|b| js::truthy(Some(b)))
}

// ── GET /api/folders ────────────────────────────────────────────────────

async fn list(State(s): State<AppState>, RawQuery(q): RawQuery) -> ApiResult<Response> {
    let ws = js::query_get(q.as_deref(), "workspaceId").unwrap_or_else(|| "default".into());
    let out = s.db.run(move |c| list_folders(c, &ws, &Keys::from_env())).await?;
    Ok(reply(StatusCode::OK, &out))
}

fn list_folders(c: &Connection, ws: &str, keys: &Keys) -> anyhow::Result<Value> {
    // 요청 목록과 같은 규칙 — sortOrder, 동률이면 id. (workspace_id, sort_order, id) 인덱스를 그대로 탄다.
    let mut st = c.prepare_cached(&format!(r#"SELECT {} FROM "folders" WHERE "workspace_id" = ?1 ORDER BY "sort_order" ASC, "id" ASC"#, folder_select()))?;
    let rows = st.query_map([ws], |r| parse_folder_row(r, keys))?.collect::<Result<Vec<_>, _>>()?;
    Ok(Value::Array(rows))
}

// ── POST /api/folders ───────────────────────────────────────────────────

async fn create(State(s): State<AppState>, body: Bytes) -> ApiResult<Response> {
    // 깨진 바디에 500 을 내면 클라이언트 잘못을 서버 잘못처럼 알리게 된다.
    let Some(b) = truthy_body(&body) else { return Err(bad_request("본문이 올바른 JSON 이 아닙니다")) };
    let Some(name) = require_text(b.get("name"), 200) else {
        return Err(bad_request("name 은 비어 있지 않은 문자열이어야 합니다"));
    };
    // 모르는 스펙 소스 종류는 거절한다 — 열에 박히면 중복 판정·동기화가 엉뚱한 길로 빠진다.
    check_spec_source_type(&or_default(b.get("specSourceType"), json!("none")))?;
    let (status, v) = s.db.run(move |c| create_folder(c, &b, name, &Keys::from_env()).map_err(|e| anyhow::anyhow!(e.message))).await?;
    Ok(reply(status, &v))
}

/// `x ?? d` — undefined·null 이면 d.
fn or_default(v: Option<&Value>, d: Value) -> Value {
    match v {
        None | Some(Value::Null) => d,
        Some(x) => x.clone(),
    }
}

fn create_folder(c: &Connection, b: &Value, name: String, keys: &Keys) -> Result<(StatusCode, Value), ApiError> {
    let description = b.get("description").and_then(Value::as_str).unwrap_or("");
    let workspace_id = or_default(b.get("workspaceId"), json!("default"));
    let spec_source_type = or_default(b.get("specSourceType"), json!("none"));
    let spec_source_url = or_default(b.get("specSourceUrl"), Value::Null);

    // 같은 스펙을 가리키는 폴더가 이미 있으면 새로 만들지 않고 그것을 돌려준다.
    //
    // 카탈로그의 [가져오기] 가 검사 없이 매번 POST 해서, 누를 때마다 같은 폴더가 하나씩
    // 생겼다 — 같은 폴더가 수십 개, 불필요한 요청이 천 개 넘게 쌓였다.
    // 호출부를 고쳐도 다음 호출부에서 또 나므로 여기서 막는다.
    // (스펙 소스가 없는 손수 만든 폴더는 같은 이름을 여러 개 둘 이유가 있으므로 그대로 둔다)
    if spec_source_type != json!("none") {
        // specSourceUrl ?? '' — 위에서 null 로 채웠으니 null 이면 ''.
        let val = if spec_source_url.is_null() { Sql::Text(String::new()) } else { bind(&spec_source_url)? };
        // drizzle 이 만드는 것과 같은 모양 — 순서 없는 `.all()[0]` 이라 같은 계획(인덱스)을 타야 같은 행이 나온다.
        let sql = format!(r#"SELECT {} FROM "folders" WHERE ("folders"."workspace_id" = ?1 AND "folders"."spec_source_type" = ?2 AND "folders"."spec_source_url" = ?3)"#, folder_select());
        let mut st = c.prepare_cached(&sql)?;
        let mut rs = st.query(params_from_iter([bind(&workspace_id)?, bind(&spec_source_type)?, val]))?;
        if let Some(r) = rs.next()? {
            return Ok((StatusCode::OK, parse_folder_row(r, keys)?));
        }
    }

    let last: Option<Sql> = c
        .prepare_cached(r#"SELECT "sort_order" FROM "folders" WHERE "workspace_id" = ?1 ORDER BY "sort_order" DESC LIMIT 1"#)?
        .query_row([bind(&workspace_id)?], |r| r.get::<_, Sql>(0))
        .map(Some)
        .or_else(|e| if e == rusqlite::Error::QueryReturnedNoRows { Ok(None) } else { Err(e) })?;
    // (last?.v ?? 0) + GAP — 새 폴더는 맨 뒤
    let sort_order = match last {
        Some(Sql::Integer(i)) => json!(i + GAP),
        Some(Sql::Real(f)) => json!(f + GAP as f64),
        _ => json!(GAP),
    };
    let id = uuid::Uuid::new_v4().to_string();
    let sort_sql = match &sort_order {
        Value::Number(n) if n.is_i64() => Sql::Integer(n.as_i64().unwrap_or(0)),
        v => bind(v)?,
    };
    c.prepare_cached(
        r#"INSERT INTO "folders" ("id", "workspace_id", "name", "spec_source_type", "spec_source_url", "sort_order", "shared_headers", "shared_auth", "description") VALUES (?1, ?2, ?3, ?4, ?5, ?6, '[]', '{"type":"none"}', ?7)"#,
    )?
    .execute(params_from_iter([
        Sql::Text(id.clone()),
        bind(&workspace_id)?,
        Sql::Text(name.clone()),
        bind(&spec_source_type)?,
        bind(&spec_source_url)?,
        sort_sql,
        Sql::Text(description.to_string()),
    ]))?;
    // 넣은 값 그대로 돌려준다.
    let row = json!({
        "id": id, "workspaceId": workspace_id, "name": name,
        "specSourceType": spec_source_type, "specSourceUrl": spec_source_url,
        "sortOrder": sort_order, "description": description,
    });
    Ok((StatusCode::CREATED, row))
}

// ── PUT /api/folders/:id ────────────────────────────────────────────────

/// 스키마의 enum 과 같은 목록 — 여기서만 검증하면 되도록 한곳에 둔다.
const SPEC_SOURCE_TYPES: [&str; 2] = ["none", "url"];

fn check_spec_source_type(v: &Value) -> Result<&str, ApiError> {
    v.as_str()
        .filter(|t| SPEC_SOURCE_TYPES.contains(t))
        .ok_or_else(|| bad_request(format!("specSourceType 은 {} 중 하나여야 합니다", SPEC_SOURCE_TYPES.join(" · "))))
}

async fn update(State(s): State<AppState>, Path(id): Path<String>, body: Bytes) -> ApiResult<Response> {
    let Some(b) = truthy_body(&body) else { return Err(bad_request("본문이 올바른 JSON 이 아닙니다")) };
    s.db.run(move |c| Ok(update_folder(c, &id, &b, &Keys::from_env()))).await?.map(|v| reply(StatusCode::OK, &v))
}

fn update_folder(c: &Connection, id: &str, b: &Value, keys: &Keys) -> ApiResult<Value> {
    // 없는 폴더에도 200 을 돌려주고 있었다 — UPDATE 가 0행을 고치고 조용히 성공한다.
    // 다른 사람이 지운 폴더의 이름을 바꾸면 '바꿨다' 고 뜨고 아무 일도 안 일어난다.
    let cur_auth: Option<Sql> = c
        .prepare_cached(r#"SELECT "shared_auth" FROM "folders" WHERE "id" = ?1"#)?
        .query_row([id], |r| r.get::<_, Sql>(0))
        .map(Some)
        .or_else(|e| if e == rusqlite::Error::QueryReturnedNoRows { Ok(None) } else { Err(e) })?;
    let Some(cur_auth) = cur_auth else {
        return Err(ApiError::not_found("폴더가 없습니다 — 다른 사람이 지웠을 수 있습니다"));
    };

    let mut set: Vec<(&str, Sql)> = vec![];
    if let Some(v) = b.get("description") {
        let text = v.as_str().ok_or_else(|| bad_request("description 은 문자열이어야 합니다"))?;
        set.push(("description", Sql::Text(text.to_owned())));
    }
    // `!== undefined` — JSON 의 null 은 '있다' 로 본다.
    if let Some(v) = b.get("name") {
        let Some(name) = require_text(Some(v), 200) else { return Err(bad_request("name 은 비어 있지 않은 문자열이어야 합니다")) };
        set.push(("name", Sql::Text(name)));
    }
    // enum 컬럼인데 아무 문자열이나 그대로 들어갔다(SQLite 는 enum 을 강제하지 않는다).
    // 엉뚱한 값이 박히면 폴더 중복 판정은 '스펙 소스가 있다' 로 보고, 동기화는 카탈로그도
    // URL 도 아닌 길로 빠져 영문 모를 오류만 남는다. 여기서 거절한다.
    if let Some(v) = b.get("specSourceType") {
        let t = check_spec_source_type(v)?;
        set.push(("spec_source_type", Sql::Text(t.to_string())));
    }
    if let Some(v) = b.get("specSourceUrl") {
        let val = match v {
            Value::Null => Sql::Null,
            Value::String(s) => Sql::Text(s.clone()),
            _ => return Err(bad_request("specSourceUrl 은 문자열이거나 null 이어야 합니다")),
        };
        set.push(("spec_source_url", val));
    }
    if let Some(v) = b.get("sharedHeaders") {
        // 이 문장만 영어다 — Node 가 그렇게 돌려준다(화면·E2E 가 문장을 본다).
        let Value::Array(_) = v else { return Err(bad_request("sharedHeaders must be array")) };
        set.push(("shared_headers", Sql::Text(js::stringify(v))));
    }
    if let Some(v) = b.get("sharedAuth") {
        // 요청 인증과 같은 규약 — 조회에서 지운 비밀값이 그대로 돌아오므로, 빈 값은 '그대로 두라'.
        // Node 는 parseSharedAuth(이미 복호화) 뒤에 한 번 더 decryptAuthConfig 한다 — 평문은 그대로라 결과가 같고, 그대로 따른다.
        let stored = decrypt_auth_config_with(keys, &parse_shared_auth(sql_ref(&cur_auth), keys));
        let merged = merge_auth_secrets(&sanitize_folder_auth(Some(v)), &stored);
        let enc = encrypt_auth_config_with(keys, &merged).map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e))?;
        set.push(("shared_auth", Sql::Text(js::stringify(&enc))));
    }
    if !set.is_empty() {
        let cols: Vec<String> = set.iter().enumerate().map(|(i, (col, _))| format!(r#""{col}" = ?{}"#, i + 1)).collect();
        let sql = format!(r#"UPDATE "folders" SET {} WHERE "folders"."id" = ?{}"#, cols.join(", "), set.len() + 1);
        let mut vals: Vec<Sql> = set.into_iter().map(|(_, v)| v).collect();
        vals.push(Sql::Text(id.to_string()));
        c.prepare_cached(&sql)?.execute(params_from_iter(vals))?;
    }
    Ok(json!({ "ok": true }))
}

fn sql_ref(v: &Sql) -> ValueRef<'_> {
    match v {
        Sql::Null => ValueRef::Null,
        Sql::Integer(i) => ValueRef::Integer(*i),
        Sql::Real(f) => ValueRef::Real(*f),
        Sql::Text(t) => ValueRef::Text(t.as_bytes()),
        Sql::Blob(b) => ValueRef::Blob(b),
    }
}

// ── DELETE /api/folders/:id ─────────────────────────────────────────────

async fn remove(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<Response> {
    s.db.run(move |c| delete_folder(c, &id)).await?;
    Ok(reply(StatusCode::OK, &json!({ "ok": true })))
}

fn delete_folder(c: &Connection, id: &str) -> anyhow::Result<()> {
    let tx = c.unchecked_transaction()?;
    // id 를 뽑아 다시 파라미터로 넘기지 않는다 — 요청이 3만 개를 넘으면 SQLite 의 바인딩
    // 한계(32,766)에 걸려 '폴더를 지울 수 없다' 가 된다. 서브쿼리는 그 천장이 없다.
    let sub = r#"(SELECT "id" FROM "requests" WHERE "requests"."folder_id" = ?1)"#;
    tx.prepare_cached(&format!(r#"DELETE FROM "executions" WHERE "executions"."request_id" IN {sub}"#))?.execute([id])?;
    // 요청 버전(복원용 스냅샷)도 같이 지운다. request_versions 에는 외래키·cascade 가 없어서
    // 여기서 안 지우면 요청만 사라지고 스냅샷(헤더·인증 설정 포함)은 DB 에 남는다.
    tx.prepare_cached(&format!(r#"DELETE FROM "request_versions" WHERE "request_versions"."request_id" IN {sub}"#))?.execute([id])?;
    tx.prepare_cached(r#"DELETE FROM "requests" WHERE "requests"."folder_id" = ?1"#)?.execute([id])?;
    tx.prepare_cached(r#"DELETE FROM "folders" WHERE "folders"."id" = ?1"#)?.execute([id])?;
    tx.commit()?;
    Ok(())
}

// ── POST /api/folders/reorder ───────────────────────────────────────────

/// 폴더의 자리를 옮긴다. 순서 값을 서버가 정하는 이유는 requests/reorder 와 같다.
/// 폴더는 중첩이 없어 프로젝트(workspace) 안에서 앞뒤만 바뀐다.
/// body: { id, beforeId } — beforeId 앞으로. null 이면 맨 뒤.
async fn reorder(State(s): State<AppState>, body: Bytes) -> ApiResult<Response> {
    let Some(b) = truthy_body(&body) else { return Err(bad_request("본문이 올바른 JSON 이 아닙니다")) };
    let id = b.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    if id.is_empty() {
        return Err(bad_request("id 는 문자열이어야 합니다"));
    }
    let before_id = b.get("beforeId").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
    if before_id.as_deref() == Some(id.as_str()) {
        return Err(bad_request("자기 자신 앞으로는 옮길 수 없습니다"));
    }
    let v = s.db.run(move |c| Ok(reorder_folder(c, &id, before_id.as_deref()))).await??;
    Ok(reply(StatusCode::OK, &v))
}

fn reorder_folder(c: &Connection, id: &str, before_id: Option<&str>) -> ApiResult<Value> {
    let ws: Option<Sql> = c
        .prepare_cached(r#"SELECT "workspace_id" FROM "folders" WHERE "id" = ?1"#)?
        .query_row([id], |r| r.get::<_, Sql>(0))
        .map(Some)
        .or_else(|e| if e == rusqlite::Error::QueryReturnedNoRows { Ok(None) } else { Err(e) })?;
    let Some(ws) = ws else { return Err(ApiError::not_found("폴더를 찾을 수 없습니다")) };

    // 프로젝트를 클라이언트에서 받지 않는다 — 옮기는 폴더 자신이 이미 알고 있고,
    // 받으면 남의 프로젝트 폴더를 내 트리로 끌어오는 요청을 만들 수 있다.
    let siblings = c
        .prepare_cached(r#"SELECT "id", "sort_order" FROM "folders" WHERE "workspace_id" = ?1 ORDER BY "sort_order" ASC, "id" ASC"#)?
        .query_map([ws], |r| {
            let sort_order = match r.get_ref(1)? {
                ValueRef::Integer(i) => i,
                ValueRef::Real(f) => f as i64,
                _ => 0,
            };
            Ok(Item { id: rows::text(r, 0)?, sort_order })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let re = apply_reorder(&siblings, id, before_id);

    let tx = c.unchecked_transaction()?;
    for u in &re.updates {
        tx.prepare_cached(r#"UPDATE "folders" SET "sort_order" = ?1 WHERE "folders"."id" = ?2"#)?.execute(rusqlite::params![u.sort_order, u.id])?;
    }
    tx.commit()?;
    Ok(json!({ "ok": true, "reindexed": re.reindexed, "updated": re.updates.len() }))
}

// ── GET /api/folders/:id/openapi ────────────────────────────────────────

/// 폴더 → OpenAPI 3.0 다운로드. 자격증명 값은 내보내지 않는다(인증 헤더 제외).
async fn openapi(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<Response> {
    let Some((name, doc)) = s.db.run(move |c| openapi_doc(c, &id)).await? else {
        return Err(ApiError::not_found("folder not found"));
    };
    let disposition = format!("attachment; filename=\"{}\"", file_name(&js::to_string(&name)));
    Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json".to_string()), (header::CONTENT_DISPOSITION, disposition)],
        js::stringify_pretty(&doc, 2),
    )
        .into_response())
}

fn openapi_doc(c: &Connection, id: &str) -> anyhow::Result<Option<(Value, Value)>> {
    let name: Option<Value> = c
        .prepare_cached(r#"SELECT "name" FROM "folders" WHERE "id" = ?1"#)?
        .query_row([id], |r| Ok(rows::raw(r.get_ref(0)?)))
        .map(Some)
        .or_else(|e| if e == rusqlite::Error::QueryReturnedNoRows { Ok(None) } else { Err(e) })?;
    let Some(name) = name else { return Ok(None) };
    // 순서 없는 select — Node 와 같은 모양의 질의라 같은 계획(같은 순서)으로 읽힌다.
    // 내보내기에 쓰는 열만 읽는다. 폴더 하나의 요청이라 전부 들고 있어도 크기는 폴더가 정한다.
    let mut st = c.prepare_cached(
        r#"SELECT "name", "method", "url", "description", "params", "headers", "body_type", "body", "tags" FROM "requests" WHERE "requests"."folder_id" = ?1"#,
    )?;
    let reqs = st
        .query_map([id], |r| {
            let params = safe_json_ref(r.get_ref(4)?);
            let headers = safe_json_ref(r.get_ref(5)?);
            let tags = safe_json_ref(r.get_ref(8)?);
            Ok(ReqLike {
                name: rows::raw(r.get_ref(0)?),
                method: rows::text(r, 1)?,
                url: rows::text(r, 2)?,
                description: rows::text(r, 3)?,
                params: to_kv_array(params.as_ref()),
                headers: to_kv_array(headers.as_ref()),
                body_type: rows::text(r, 6)?,
                body: rows::text(r, 7)?,
                tags: to_string_array(tags.as_ref()),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let description: String = c.query_row("SELECT description FROM folders WHERE id = ?1", [id], |r| r.get(0))?;
    let mut doc = folder_to_openapi(&name, &reqs);
    if !description.is_empty() { doc["info"]["description"] = json!(description); }
    Ok(Some((name.clone(), doc)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::variables::tests::test_db;

    fn no_keys() -> Keys {
        Keys::new(None, &[])
    }

    fn insert(c: &Connection, id: &str, ws: &str, name: &str, ty: &str, url: Option<&str>, order: i64) {
        c.execute(
            "INSERT INTO folders (id, workspace_id, name, spec_source_type, spec_source_url, sort_order) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![id, ws, name, ty, url, order],
        )
        .unwrap();
    }

    #[test]
    fn folder_description_roundtrip() {
        let db = test_db();
        db.with(|c| {
            let (_, row) = create_folder(c, &json!({"description": "Initial notes"}), "Notes".into(), &no_keys()).map_err(|e| anyhow::anyhow!(e.message))?;
            let id = row["id"].as_str().unwrap();
            assert_eq!(list_folders(c, "default", &no_keys())?[0]["description"], "Initial notes");
            update_folder(c, id, &json!({"description": "Updated\nnotes"}), &no_keys()).map_err(|e| anyhow::anyhow!(e.message))?;
            assert_eq!(list_folders(c, "default", &no_keys())?[0]["description"], "Updated\nnotes");
            assert!(update_folder(c, id, &json!({"description": 3}), &no_keys()).is_err());
            update_folder(c, id, &json!({"description": ""}), &no_keys()).map_err(|e| anyhow::anyhow!(e.message))?;
            assert_eq!(list_folders(c, "default", &no_keys())?[0]["description"], "");
            Ok(())
        }).unwrap();
    }

    #[test]
    fn 폴더_행은_손상된_json_열을_방어한다() {
        let db = test_db();
        db.with(|c| {
            insert(c, "f1", "w", "x", "none", None, 0);
            c.execute("UPDATE folders SET shared_headers = 'oops', shared_auth = 'oops'", [])?;
            let v = list_folders(c, "w", &no_keys())?;
            assert_eq!(v[0]["sharedHeaders"], json!([]));
            assert_eq!(v[0]["sharedAuth"], json!({ "type": "none" }));
            assert_eq!(v[0]["name"], "x");
            c.execute(r#"UPDATE folders SET shared_headers = '[null,3,{"key":"H","value":"V"}]', shared_auth = '{"type":"bearer","token":{"x":1}}'"#, [])?;
            let v = list_folders(c, "w", &no_keys())?;
            assert_eq!(v[0]["sharedHeaders"], json!([{ "key": "H", "value": "V", "enabled": true }]));
            assert_eq!(v[0]["sharedAuth"], json!({ "type": "bearer", "token": "" }));
            // 열 순서 = schema.ts 순서
            let keys: Vec<&String> = v[0].as_object().unwrap().keys().collect();
            assert_eq!(keys, ["id", "workspaceId", "name", "specSourceType", "specSourceUrl", "sortOrder", "sharedHeaders", "sharedAuth", "description"]);
            Ok(())
        })
        .unwrap();
    }

    // 라우트가 쓰는 판정을 그대로 친다.
    #[test]
    fn 스펙_소스_폴더는_프로젝트당_하나() {
        let db = test_db();
        db.with(|c| {
            let k = no_keys();
            let base = json!({ "workspaceId": "w1", "specSourceType": "url", "specSourceUrl": "https://shop.example/v3/api-docs" });
            let (st, a) = create_folder(c, &base, "shop".into(), &k).map_err(|e| anyhow::anyhow!(e.message))?;
            assert_eq!(st, StatusCode::CREATED);
            assert_eq!(a["sortOrder"], json!(1024));
            // 같은 URL — 이름이 달라도 같은 폴더
            let (st, again) = create_folder(c, &base, "다른 이름".into(), &k).map_err(|e| anyhow::anyhow!(e.message))?;
            assert_eq!((st, &again["id"]), (StatusCode::OK, &a["id"]));
            assert_eq!(again["name"], "shop");
            // 다른 URL·다른 프로젝트면 새 폴더
            let other = json!({ "workspaceId": "w1", "specSourceType": "url", "specSourceUrl": "https://other/v3/api-docs" });
            let (st, o) = create_folder(c, &other, "shop".into(), &k).map_err(|e| anyhow::anyhow!(e.message))?;
            assert_eq!(st, StatusCode::CREATED);
            assert_eq!(o["sortOrder"], json!(2048));
            let w2 = json!({ "workspaceId": "w2", "specSourceType": "url", "specSourceUrl": "https://shop.example/v3/api-docs" });
            assert_eq!(create_folder(c, &w2, "shop".into(), &k).map_err(|e| anyhow::anyhow!(e.message))?.0, StatusCode::CREATED);
            // 모르는 스펙 소스 종류는 거절한다
            assert_eq!(check_spec_source_type(&json!("legacy")).err().map(|e| e.status), Some(StatusCode::BAD_REQUEST));
            assert_eq!(check_spec_source_type(&json!("url")).ok(), Some("url"));
            // 손수 만든 폴더는 같은 이름을 여러 개 둘 수 있다
            let plain = json!({ "workspaceId": "w1" });
            assert_eq!(create_folder(c, &plain, "수동".into(), &k).map_err(|e| anyhow::anyhow!(e.message))?.0, StatusCode::CREATED);
            assert_eq!(create_folder(c, &plain, "수동".into(), &k).map_err(|e| anyhow::anyhow!(e.message))?.0, StatusCode::CREATED);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn 새_폴더_응답은_넣은_값_그대로() {
        let db = test_db();
        db.with(|c| {
            let (_, row) = create_folder(c, &json!({ "name": "x" }), "x".into(), &no_keys()).map_err(|e| anyhow::anyhow!(e.message))?;
            let keys: Vec<&String> = row.as_object().unwrap().keys().collect();
            assert_eq!(keys, ["id", "workspaceId", "name", "specSourceType", "specSourceUrl", "sortOrder", "description"]);
            assert_eq!(row["workspaceId"], "default");
            assert_eq!(row["specSourceType"], "none");
            assert_eq!(row["specSourceUrl"], Value::Null);
            let stored: (String, String) = c.query_row("SELECT shared_headers, shared_auth FROM folders", [], |r| Ok((r.get(0)?, r.get(1)?)))?;
            assert_eq!(stored, ("[]".into(), r#"{"type":"none"}"#.into()));
            Ok(())
        })
        .unwrap();
    }

    // crud.test.ts·folderAuth.test.ts 의 폴더 부분.
    #[test]
    fn 수정은_검증하고_없는_폴더는_404() {
        let db = test_db();
        db.with(|c| {
            let k = no_keys();
            assert_eq!(update_folder(c, "nope", &json!({ "name": "x" }), &k).err().unwrap().status, StatusCode::NOT_FOUND);
            insert(c, "f", "w", "원본이름", "none", None, 1024);
            let e = update_folder(c, "f", &json!({ "name": "  " }), &k).err().unwrap();
            assert_eq!((e.status, e.message.as_str()), (StatusCode::BAD_REQUEST, "name 은 비어 있지 않은 문자열이어야 합니다"));
            let e = update_folder(c, "f", &json!({ "specSourceType": "ftp" }), &k).err().unwrap();
            assert_eq!(e.message, "specSourceType 은 none · url 중 하나여야 합니다");
            let e = update_folder(c, "f", &json!({ "specSourceUrl": 5 }), &k).err().unwrap();
            assert_eq!(e.message, "specSourceUrl 은 문자열이거나 null 이어야 합니다");
            let e = update_folder(c, "f", &json!({ "sharedHeaders": {} }), &k).err().unwrap();
            assert_eq!(e.message, "sharedHeaders must be array");
            // 이름은 그대로, URL 만 바뀐다
            update_folder(c, "f", &json!({ "specSourceUrl": "https://example.com/spec.json", "sharedHeaders": [{ "key": "X", "value": "1.0", "n": 1.0 }] }), &k).map_err(|e| anyhow::anyhow!(e.message))?;
            let v = list_folders(c, "w", &k)?;
            assert_eq!(v[0]["name"], "원본이름");
            assert_eq!(v[0]["specSourceUrl"], "https://example.com/spec.json");
            let raw: String = c.query_row("SELECT shared_headers FROM folders", [], |r| r.get(0))?;
            assert_eq!(raw, r#"[{"key":"X","value":"1.0","n":1}]"#);
            // 폴더는 inherit 불가 → none 으로 저장
            update_folder(c, "f", &json!({ "sharedAuth": { "type": "inherit" } }), &k).map_err(|e| anyhow::anyhow!(e.message))?;
            assert_eq!(list_folders(c, "w", &k)?[0]["sharedAuth"], json!({ "type": "none" }));
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn 공통_인증은_암호화해_두고_빈_값은_유지한다() {
        let db = test_db();
        db.with(|c| {
            let k = Keys::new(Some("folder-auth-test-key"), &[]);
            insert(c, "f", "w", "a", "none", None, 0);
            update_folder(c, "f", &json!({ "sharedAuth": { "type": "bearer", "token": "FOLDER-TOKEN" } }), &k).map_err(|e| anyhow::anyhow!(e.message))?;
            let raw: String = c.query_row("SELECT shared_auth FROM folders", [], |r| r.get(0))?;
            assert!(!raw.contains("FOLDER-TOKEN"));
            assert!(crate::secretbox::is_encrypted(serde_json::from_str::<Value>(&raw)?["token"].as_str().unwrap()));
            // 조회는 지워서 내려간다
            assert_eq!(list_folders(c, "w", &k)?[0]["sharedAuth"], json!({ "type": "bearer", "token": "", "hasStoredSecret": true }));
            // 마스킹된 그대로 다시 저장해도 토큰이 남는다
            update_folder(c, "f", &json!({ "sharedAuth": { "type": "bearer", "token": "" } }), &k).map_err(|e| anyhow::anyhow!(e.message))?;
            let raw: String = c.query_row("SELECT shared_auth FROM folders", [], |r| r.get(0))?;
            let tok = serde_json::from_str::<Value>(&raw)?["token"].as_str().unwrap().to_string();
            assert_eq!(crate::secretbox::decrypt_with(&k, &tok), "FOLDER-TOKEN");
            Ok(())
        })
        .unwrap();
    }

    // deleteCleanup.test.ts 의 폴더 부분.
    #[test]
    fn 폴더를_지우면_요청과_딸린_기록도_지운다() {
        let db = test_db();
        db.with(|c| {
            insert(c, "f", "w", "a", "none", None, 0);
            insert(c, "g", "w", "b", "none", None, 0);
            for (rid, fid) in [("r1", "f"), ("r2", "f"), ("r3", "g")] {
                c.execute("INSERT INTO requests (id, folder_id, name, updated_at) VALUES (?1, ?2, 'r', 0)", [rid, fid])?;
                c.execute("INSERT INTO request_versions (id, request_id, snapshot, created_at) VALUES (?1, ?1, '{}', 0)", [rid])?;
            }
            delete_folder(c, "f")?;
            let n = |sql: &str| -> i64 { c.query_row(sql, [], |r| r.get(0)).unwrap() };
            assert_eq!(n("SELECT count(*) FROM requests"), 1);
            assert_eq!(n("SELECT count(*) FROM request_versions"), 1);
            assert_eq!(n("SELECT count(*) FROM folders"), 1);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn 순서_바꾸기는_프로젝트_안에서만() {
        let db = test_db();
        db.with(|c| {
            insert(c, "a", "w", "a", "none", None, 1024);
            insert(c, "b", "w", "b", "none", None, 2048);
            insert(c, "c", "w", "c", "none", None, 3072);
            insert(c, "x", "other", "x", "none", None, 1500);
            assert_eq!(reorder_folder(c, "nope", None).err().unwrap().status, StatusCode::NOT_FOUND);
            assert_eq!(reorder_folder(c, "c", Some("a")).map_err(|e| anyhow::anyhow!(e.message))?, json!({ "ok": true, "reindexed": false, "updated": 1 }));
            let ids: Vec<String> = list_folders(c, "w", &no_keys())?.as_array().unwrap().iter().map(|f| f["id"].as_str().unwrap().to_string()).collect();
            assert_eq!(ids, ["c", "a", "b"]);
            // 제자리면 아무것도 안 바꾼다
            assert_eq!(reorder_folder(c, "c", Some("a")).map_err(|e| anyhow::anyhow!(e.message))?["updated"], 0);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn openapi_내보내기() {
        let db = test_db();
        db.with(|c| {
            assert!(openapi_doc(c, "nope")?.is_none());
            insert(c, "f", "w", "주문 API", "none", None, 0);
            c.execute(
                r#"INSERT INTO requests (id, folder_id, name, method, url, headers, body_type, body, tags, updated_at) VALUES ('r', 'f', '생성', 'POST', '{{baseUrl}}/orders', '[{"key":"Authorization","value":"x"},{"key":"X-T","value":"1"}]', 'json', '{"a":1.0}', '["t",1]', 0)"#,
                [],
            )?;
            c.execute("UPDATE folders SET description = 'API overview' WHERE id = 'f'", [])?;
            let (name, doc) = openapi_doc(c, "f")?.unwrap();
            assert_eq!(doc["info"]["description"], "API overview");
            assert_eq!(name, "주문 API");
            assert_eq!(
                js::stringify(&doc["paths"]),
                r#"{"/orders":{"post":{"summary":"생성","tags":["t"],"parameters":[{"name":"X-T","in":"header","required":false,"schema":{"type":"string"},"example":"1"}],"requestBody":{"content":{"application/json":{"example":{"a":1}}}},"responses":{"200":{"description":"OK"}}}}}"#
            );
            Ok(())
        })
        .unwrap();
    }
}
