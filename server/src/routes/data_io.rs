//! 내보내기·가져오기.
//!
//! 가져오기 파일은 사람이 손으로 고친 것일 수 있다. Node 는 무효 값을 정규화해 넣고, 정규화로도 못 넣는
//! 것(null 요소 등)은 TypeError 로 실패했다. 실패는 트랜잭션째 되돌려 '아무것도 저장하지 않았습니다' 를
//! 돌려준다 — 반쯤 들어간 상태에서 사용자가 다시 누르면 들어간 만큼이 중복으로 쌓인다.
//!
//! 본문 상한: axum 기본(2MB)으로는 큰 export 파일이 413 이 된다. Node 는 상한이 없었다 — 여기서는
//! [`IMPORT_MAX_BYTES`] 로 묶는다(한 번에 메모리에 올리는 크기).

use std::collections::{HashMap, HashSet};

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get as get_route, post};
use axum::Router;
use rusqlite::Connection;
use serde_json::{json, Map, Value};

use crate::auth_config::{mask_auth_secrets, sanitize_folder_auth, sanitize_request_auth};
use crate::error::ApiResult;
use crate::json_cols::{safe_json, to_kv_array};
use crate::jsval::{bind, get, get_strict, reply, same_value_key, str_or};
use crate::records::{read, select_list, FOLDER_COLS, REQUEST_COLS};
use crate::routes::input::{json_error, read_json};
use crate::scrub::mask_credential_headers;
use crate::sort_order::GAP;
use crate::variables::{global_scope_id, load_var_map, ALL_PROJECTS};
use crate::{api_contract, js, postman_import, secretbox, AppState};

pub const IMPORT_MAX_BYTES: usize = 64 * 1024 * 1024;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/export", get_route(export))
        .route("/api/import/postq", post(import_postq).layer(DefaultBodyLimit::max(IMPORT_MAX_BYTES)))
        .route("/api/import/postman", post(import_postman).layer(DefaultBodyLimit::max(IMPORT_MAX_BYTES)))
}

const IMPORT_FAILED: &str = "가져오기 실패 — 아무것도 저장하지 않았습니다";

// ── 내보내기 ─────────────────────────────────────────────────────────────

/// at-rest 암호문일 수 있는 auth 를 복호화한 뒤 마스킹 — {{var}} 참조는 보존, 리터럴 secret 만 공란.
/// 깨진 JSON 은 { type: 'none' }.
fn export_auth(raw: Option<&Value>) -> String {
    let parsed = match raw {
        Some(Value::Null) => Value::Null,
        other => safe_json(other).unwrap_or_else(|| json!({ "type": "none" })),
    };
    js::stringify(&mask_auth_secrets(&secretbox::decrypt_auth_config(&parsed)))
}

fn masked_var(key: &Value, value: &Value, secret: Option<bool>) -> Value {
    let secret_v = secret.map_or(Value::Null, Value::Bool);
    json!({ "key": key, "value": if secret == Some(true) { json!("") } else { value.clone() }, "secret": secret_v })
}

fn build_export(c: &Connection, now: i64) -> anyhow::Result<Value> {
    // 보이는 순서대로 뽑는다. 정렬 없이 뽑으면 손으로 맞춰 둔 순서가 왕복 한 번에 생성순으로 되돌아간다.
    let folders_sql = format!(r#"select {} from "folders" order by "folders"."sort_order" asc, "folders"."id" asc"#, select_list("folders", FOLDER_COLS));
    let folders = c
        .prepare_cached(&folders_sql)?
        .query_map([], |r| read(r, FOLDER_COLS, 0))?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(|mut f| {
            // 요소 모양까지 정규화 — [null]·{key:123} 요소가 마스킹에서 export 를 통째로 500 내던 것 방지.
            let headers = mask_credential_headers(&to_kv_array(safe_json(f.get("sharedHeaders")).as_ref()));
            f.insert("sharedHeaders".into(), Value::String(js::stringify(&Value::Array(headers))));
            let auth = export_auth(f.get("sharedAuth"));
            f.insert("sharedAuth".into(), Value::String(auth));
            Value::Object(f)
        })
        .collect::<Vec<_>>();
    let requests_sql = format!(r#"select {} from "requests" order by "requests"."sort_order" asc, "requests"."id" asc"#, select_list("requests", REQUEST_COLS));
    let requests = c
        .prepare_cached(&requests_sql)?
        .query_map([], |r| read(r, REQUEST_COLS, 0))?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(|mut r| {
            let params = to_kv_array(safe_json(r.get("params")).as_ref());
            let headers = mask_credential_headers(&to_kv_array(safe_json(r.get("headers")).as_ref()));
            let auth = export_auth(r.get("auth"));
            r.insert("params".into(), Value::Array(params));
            r.insert("headers".into(), Value::Array(headers));
            r.insert("auth".into(), Value::String(auth));
            Value::Object(r)
        })
        .collect::<Vec<_>>();

    // 같은 열 목록으로 읽는다 — drizzle 의 select() 와 같은 질의여야 ORDER BY 없는 순서도 같다.
    let envs: Vec<(Value, Value)> = c
        .prepare_cached(r#"select "execution_policy", "id", "workspace_id", "name", "updated_at" from "environments""#)?
        .query_map([], |r| Ok((crate::rows::raw(r.get_ref(1)?), crate::rows::raw(r.get_ref(3)?))))?
        .collect::<Result<_, _>>()?;
    // (environmentId 문자열, key, value, secret)
    let vars: Vec<(String, Value, Value, Option<bool>)> = c
        .prepare_cached(r#"select "id", "environment_id", "key", "value", "secret" from "variables""#)?
        .query_map([], |r| Ok((crate::rows::text(r, 1)?, crate::rows::raw(r.get_ref(2)?), crate::rows::raw(r.get_ref(3)?), crate::rows::boolean(r, 4)?)))?
        .collect::<Result<_, _>>()?;

    let environments: Vec<Value> = envs
        .iter()
        .map(|(id, name)| {
            let id_s = js::to_string(id);
            let vs: Vec<Value> = vars.iter().filter(|v| v.0 == id_s).map(|v| masked_var(&v.1, &v.2, v.3)).collect();
            json!({ "id": id, "name": name, "variables": vs })
        })
        .collect();
    // 프로젝트 공통(global:<ws>) 변수 — 가져오기는 한 프로젝트로 복원하므로 여러 프로젝트의 것을 키로 합친다
    // (마지막 값, 자리는 처음 것). 같은 키가 한 스코프에 물리적으로 두 줄 들어가면 {{키}} 해석이 비결정적이 된다.
    let all_scope = global_scope_id(ALL_PROJECTS);
    let mut global: Map<String, Value> = Map::new();
    let mut uniq = 0usize;
    for v in vars.iter().filter(|v| v.0.starts_with("global:") && v.0 != all_scope) {
        global.insert(same_value_key(Some(&v.1), &mut uniq), masked_var(&v.1, &v.2, v.3));
    }
    // 모든 프로젝트 공통(전역) 변수는 따로 싣는다 — 위에 섞으면 가져올 때 한 프로젝트의 것으로 바뀐다.
    let all_project: Vec<Value> = vars.iter().filter(|v| v.0 == all_scope).map(|v| masked_var(&v.1, &v.2, v.3)).collect();

    Ok(json!({
        "postq": 1,
        "exportedAt": js::iso_string(now),
        "folders": folders,
        "requests": requests,
        "environments": environments,
        "globalVars": global.into_iter().map(|(_, v)| v).collect::<Vec<_>>(),
        "allProjectVars": all_project,
    }))
}

/// 전체 export — 팀 이사·백업·공유용 postq JSON. secret 변수 값, 인증 비밀값, 헤더에 박힌 리터럴 자격증명은
/// 마스킹한다({{var}} 참조는 보존). 실행 이력은 넣지 않는다(개인 실행 기록이고 되돌릴 대상이 아니다).
async fn export(State(s): State<AppState>) -> ApiResult<Response> {
    let now = js::now_ms();
    let doc = s.db.run(move |c| build_export(c, now)).await?;
    let date = &js::iso_string(now)[..10];
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json".to_string()),
            (header::CONTENT_DISPOSITION, format!("attachment; filename=\"postq-export-{date}.json\"")),
        ],
        js::stringify_pretty(&doc, 2),
    )
        .into_response())
}

// ── postq 가져오기 ──────────────────────────────────────────────────────

/// 손편집 파일의 배열 자리 — 문자열이면 파싱해 보고, 배열이 아니면 [].
fn norm_array(v: Option<&Value>) -> Value {
    let parsed = match v {
        Some(Value::String(s)) => crate::js::parse_json(s),
        other => other.cloned(),
    };
    match parsed {
        Some(a @ Value::Array(_)) => a,
        _ => json!([]),
    }
}

/// 손편집 파일의 객체 자리 — 문자열이면 파싱해 보고, plain object 가 아니면 {}.
fn norm_object(v: Option<&Value>) -> Value {
    let parsed = match v {
        Some(Value::String(s)) => crate::js::parse_json(s),
        other => other.cloned(),
    };
    match parsed {
        Some(o @ Value::Object(_)) => o,
        _ => json!({}),
    }
}

/// `arr(v)` — 배열이 아니면 [](for..of 가 non-iterable 로 500 나던 것 방어).
fn arr(v: Option<&Value>) -> &[Value] {
    v.and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// `typeof x === 'string' ? x : null`
fn text_or_null(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).map(str::to_string)
}

/// `JSON.stringify(safeParse(s))` 를 거친 인증 — 신뢰 못 하는 파일이라 항상 sanitize 후 at-rest 암호화.
fn stored_auth(v: Option<&Value>, request: bool) -> Result<String, String> {
    let parsed = match v {
        Some(Value::String(s)) => crate::js::parse_json(s),
        other => other.cloned(),
    };
    let clean = if request { sanitize_request_auth(parsed.as_ref()) } else { sanitize_folder_auth(parsed.as_ref()) };
    Ok(js::stringify(&secretbox::encrypt_auth_config(&clean)?))
}

struct Counts {
    folders: usize,
    requests: usize,
    environments: usize,
}

fn import_doc(c: &Connection, doc: &Value) -> Result<Counts, String> {
    let e = |x: rusqlite::Error| x.to_string();
    // `doc.workspaceId ?? 'default'` — 형식은 그대로. 넣을 때 바인딩 규칙을 따른다(객체면 그때 500).
    let ws = match doc.get("workspaceId") {
        None | Some(Value::Null) => json!("default"),
        Some(v) => v.clone(),
    };
    let now = js::now_ms();
    let mut folder_ids: HashMap<String, String> = HashMap::new();
    let mut uniq = 0usize;
    let mut request_count = 0;
    let mut environment_count = 0;

    // 파일에 적힌 순서를 그대로 옮긴다 — 내보낸 트리와 가져온 트리가 달라 보이면 무엇이 빠졌는지 대조할 수 없다.
    let mut folder_order = 0i64;
    for f in arr(doc.get("folders")) {
        let fid = get_strict(Some(f), "id")?;
        let new_id = uuid::Uuid::new_v4().to_string();
        folder_ids.insert(same_value_key(fid, &mut uniq), new_id.clone());
        folder_order += GAP;
        let mut spec_type = get(Some(f), "specSourceType").and_then(Value::as_str).unwrap_or("none").to_string();
        let mut spec_url = text_or_null(get(Some(f), "specSourceUrl"));
        // 모르는 종류는 연결 없는 폴더로 들인다(모르는 종류가 열에 박히면 동기화가 엉뚱한 길로 빠진다).
        if spec_type != "none" && spec_type != "url" {
            spec_type = "none".into();
            spec_url = None;
        }
        c.prepare_cached(r#"insert into "folders" ("id", "workspace_id", "name", "spec_source_type", "spec_source_url", "sort_order", "shared_headers", "shared_auth", "description") values (?, ?, ?, ?, ?, ?, ?, ?, ?)"#)
            .map_err(e)?
            .execute(rusqlite::params![
                new_id,
                bind(Some(&ws))?,
                str_or(get(Some(f), "name"), ""),
                spec_type,
                spec_url,
                folder_order,
                // 요청 params/headers 와 같이 항상 정규화 — 손편집 문자열이 열에 박혀 폴더 목록 GET 이 깨지지 않게.
                js::stringify(&norm_array(get(Some(f), "sharedHeaders"))),
                stored_auth(get(Some(f), "sharedAuth"), false)?,
                f.get("description").and_then(Value::as_str).unwrap_or(""),
            ])
            .map_err(e)?;
    }

    let mut req_order: HashMap<String, i64> = HashMap::new();
    for r in arr(doc.get("requests")) {
        let key = same_value_key(get_strict(Some(r), "folderId")?, &mut uniq);
        let Some(folder_id) = folder_ids.get(&key).cloned() else { continue }; // 고아 요청 — 건너뛰고 개수로 알린다
        let ro = req_order.get(&folder_id).copied().unwrap_or(0) + GAP;
        req_order.insert(folder_id.clone(), ro);
        let g = |k: &str| get(Some(r), k);
        let method = str_or(g("method"), "");
        let owner = g("owner").and_then(Value::as_str).map_or(String::new(), |o| js::slice16(o, 100));
        c.prepare_cached(r#"insert into "requests" ("id", "folder_id", "name", "method", "url", "params", "headers", "body_type", "body", "description", "sort_order", "origin", "spec_state", "spec_operation_key", "spec_fingerprint", "spec_contract", "owner", "updated_at", "assertions", "pre_steps", "post_steps", "auth", "tags", "settings", "vars") values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#)
            .map_err(e)?
            .execute(rusqlite::params![
                uuid::Uuid::new_v4().to_string(),
                folder_id,
                // 스칼라 열은 문자열로 강제(객체·불리언 손편집 → 바인딩 500 방지)
                str_or(g("name"), ""),
                if method.is_empty() { "GET".to_string() } else { method },
                str_or(g("url"), ""),
                js::stringify(&norm_array(g("params"))),
                js::stringify(&norm_array(g("headers"))),
                g("bodyType").and_then(Value::as_str).unwrap_or("none"),
                str_or(g("body"), ""),
                str_or(g("description"), ""),
                ro,
                g("origin").and_then(Value::as_str).unwrap_or("manual"),
                text_or_null(g("specState")),
                text_or_null(g("specOperationKey")),
                text_or_null(g("specFingerprint")),
                // JSON.stringify(parseContract(..)) — 못 읽으면 'null' 문자열이 들어간다.
                js::stringify(&api_contract::parse_contract(g("specContract")).unwrap_or(Value::Null)),
                owner,
                now,
                js::stringify(&norm_array(g("assertions"))),
                js::stringify(&norm_array(g("preSteps"))),
                js::stringify(&norm_array(g("postSteps"))),
                stored_auth(g("auth"), true)?,
                js::stringify(&norm_array(g("tags"))),
                js::stringify(&norm_object(g("settings"))),
                js::stringify(&norm_array(g("vars"))),
            ])
            .map_err(e)?;
        request_count += 1;
    }

    for env in arr(doc.get("environments")) {
        let env_id = uuid::Uuid::new_v4().to_string();
        let name = get_strict(Some(env), "name")?;
        c.prepare_cached(r#"insert into "environments" ("id", "workspace_id", "name") values (?, ?, ?)"#)
            .map_err(e)?
            .execute(rusqlite::params![env_id, bind(Some(&ws))?, str_or(name, "")])
            .map_err(e)?;
        for v in arr(get(Some(env), "variables")) {
            // key 는 NOT NULL — 무효 요소는 건너뛴다.
            let Some(key) = get(Some(v), "key").and_then(Value::as_str).filter(|k| !k.is_empty()) else { continue };
            let secret = js::truthy(get(Some(v), "secret"));
            c.prepare_cached(r#"insert into "variables" ("id", "environment_id", "key", "value", "secret") values (?, ?, ?, ?, ?)"#)
                .map_err(e)?
                .execute(rusqlite::params![uuid::Uuid::new_v4().to_string(), env_id, key, secretbox::store_secret_value(&str_or(get(Some(v), "value"), ""), secret), secret as i64])
                .map_err(e)?;
        }
        environment_count += 1;
    }

    // 전역 변수 복원 — 스코프마다 '키 단위 upsert'. 파일에 있는 키만 바꾸고 파일에 없는 기존 값은 둔다.
    // 프로젝트 공통(globalVars)은 이 프로젝트에, 모든 프로젝트 공통(allProjectVars)은 global:* 에.
    let scopes = [(global_scope_id(&js::to_string(&ws)), arr(doc.get("globalVars"))), (global_scope_id(ALL_PROJECTS), arr(doc.get("allProjectVars")))];
    for (scope, list) in scopes {
        // 복호화된 기존 값 — 빈 secret 재가져오기 때 실값을 지킬지 판단한다. 앞 스코프에서 쓴 것까지 보인다(같은 연결).
        let prev = load_var_map(c, &scope).map_err(|x| x.to_string())?;
        let mut seen: HashSet<String> = HashSet::new();
        for v in list {
            let Some(key) = get(Some(v), "key").and_then(Value::as_str).filter(|k| !k.is_empty()) else { continue };
            if !seen.insert(key.to_string()) {
                continue;
            }
            let secret = js::truthy(get(Some(v), "secret"));
            let p = prev.get(key);
            // export 는 secret 값을 '' 로 내보낸다 — 왕복 한 번에 실값이 ''로 덮이지 않게(global-vars PUT 과 같은 가드).
            let keep = get(Some(v), "value").and_then(Value::as_str) == Some("") && (secret || p.map_or(false, |p| p.secret)) && p.map_or(false, |p| !p.value.is_empty());
            let raw = if keep { p.unwrap().value.clone() } else { str_or(get(Some(v), "value"), "") };
            c.prepare_cached(r#"delete from "variables" where ("variables"."environment_id" = ? and "variables"."key" = ?)"#)
                .map_err(e)?
                .execute(rusqlite::params![scope, key])
                .map_err(e)?;
            c.prepare_cached(r#"insert into "variables" ("id", "environment_id", "key", "value", "secret") values (?, ?, ?, ?, ?)"#)
                .map_err(e)?
                .execute(rusqlite::params![uuid::Uuid::new_v4().to_string(), scope, key, secretbox::store_secret_value(&raw, secret), secret as i64])
                .map_err(e)?;
        }
    }
    Ok(Counts { folders: folder_ids.len(), requests: request_count, environments: environment_count })
}

/// 한 트랜잭션으로 돌리고, 실패하면 되돌린다.
fn in_transaction<T>(c: &Connection, f: impl FnOnce(&Connection) -> Result<T, String>) -> anyhow::Result<Result<T, String>> {
    let tx = c.unchecked_transaction()?;
    match f(&tx) {
        Ok(v) => {
            tx.commit()?;
            Ok(Ok(v))
        }
        Err(msg) => {
            drop(tx); // 롤백
            Ok(Err(msg))
        }
    }
}

/// postq export JSON 가져오기 — 폴더·요청·환경을 전부 새 id 로 만든다(기존 데이터 불변, 병합 아님).
async fn import_postq(State(s): State<AppState>, body: Bytes) -> ApiResult<Response> {
    let Some(doc) = read_json(&body) else {
        return Ok(reply(StatusCode::BAD_REQUEST, &json!({ "error": "invalid json" })));
    };
    if doc.is_null() {
        // Node 는 doc.postq 에서 TypeError(처리되지 않은 500)였다.
        return Ok(json_error("서버 오류", "Cannot read properties of null (reading 'postq')"));
    }
    if doc.get("postq").and_then(Value::as_f64) != Some(1.0) {
        return Ok(reply(StatusCode::BAD_REQUEST, &json!({ "error": "not an postq export (postq: 1)" })));
    }
    let total_requests = arr(doc.get("requests")).len();
    let res = s.db.run(move |c| in_transaction(c, |tx| import_doc(tx, &doc))).await?;
    match res {
        Ok(n) => {
            let mut out = json!({ "folderCount": n.folders, "requestCount": n.requests, "environmentCount": n.environments });
            let orphans = total_requests - n.requests;
            if orphans > 0 {
                out["skippedOrphanRequests"] = json!(orphans);
            }
            Ok(reply(StatusCode::CREATED, &out))
        }
        Err(msg) => Ok(json_error(IMPORT_FAILED, &msg)),
    }
}

// ── Postman 가져오기 ──────────────────────────────────────────────────────

fn import_postman_tx(c: &Connection, b: &Value) -> Result<Value, String> {
    let e = |x: rusqlite::Error| x.to_string();
    let ws = match b.get("workspaceId") {
        None | Some(Value::Null) => json!("default"),
        Some(v) => v.clone(),
    };
    // { requestCount: 0 } 에서 시작해 folderId·requestCount·summary·environmentId 순으로 채운다(키 순서).
    let mut result = Map::new();
    result.insert("requestCount".into(), json!(0));
    if let Some(col) = b.get("collection").filter(|v| js::truthy(Some(v))) {
        let parsed = postman_import::collection_to_drafts(col)?;
        let folder_id = uuid::Uuid::new_v4().to_string();
        c.prepare_cached(r#"insert into "folders" ("id", "workspace_id", "name", "description") values (?, ?, ?, ?)"#)
            .map_err(e)?
            .execute(rusqlite::params![folder_id, bind(Some(&ws))?, parsed.name,
                col.pointer("/info/description").and_then(|v| v.as_str().or_else(|| v.get("content").and_then(Value::as_str))).unwrap_or("")
            ])
            .map_err(e)?;
        let now = js::now_ms();
        // 컬렉션에 적힌 순서 그대로 — Postman 에서 정리해 둔 순서가 흐트러지지 않게.
        let mut order = 0i64;
        for d in &parsed.drafts {
            order += GAP;
            let auth = secretbox::encrypt_auth_config(d.auth.as_ref().unwrap_or(&json!({ "type": "none" })))?;
            c.prepare_cached(r#"insert into "requests" ("id", "folder_id", "name", "method", "url", "params", "headers", "body_type", "body", "description", "sort_order", "origin", "updated_at", "auth") values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#)
                .map_err(e)?
                .execute(rusqlite::params![
                    uuid::Uuid::new_v4().to_string(),
                    folder_id,
                    d.name,
                    d.method,
                    d.url,
                    js::stringify(&Value::Array(d.params.clone())),
                    js::stringify(&Value::Array(d.headers.clone())),
                    d.body_type,
                    bind(Some(&d.body))?,
                    d.description,
                    order,
                    "postman-import",
                    now,
                    js::stringify(&auth),
                ])
                .map_err(e)?;
        }
        result.insert("folderId".into(), json!(folder_id));
        result.insert("requestCount".into(), json!(parsed.drafts.len()));
        result.insert("summary".into(), parsed.summary);
    }
    if let Some(env) = b.get("environment").filter(|v| js::truthy(Some(v))) {
        let (name, vars) = postman_import::environment_to_vars(env)?;
        let env_id = uuid::Uuid::new_v4().to_string();
        c.prepare_cached(r#"insert into "environments" ("id", "workspace_id", "name") values (?, ?, ?)"#)
            .map_err(e)?
            .execute(rusqlite::params![env_id, bind(Some(&ws))?, name])
            .map_err(e)?;
        for v in vars {
            c.prepare_cached(r#"insert into "variables" ("id", "environment_id", "key", "value", "secret") values (?, ?, ?, ?, ?)"#)
                .map_err(e)?
                .execute(rusqlite::params![uuid::Uuid::new_v4().to_string(), env_id, v.key, secretbox::store_secret_value(&v.value, v.secret), v.secret as i64])
                .map_err(e)?;
        }
        result.insert("environmentId".into(), json!(env_id));
    }
    Ok(Value::Object(result))
}

async fn import_postman(State(s): State<AppState>, body: Bytes) -> ApiResult<Response> {
    // readJson 뒤 `if (!b)` — 깨진 JSON 뿐 아니라 null·false·0·"" 도 같은 400.
    let Some(b) = read_json(&body).filter(|b| js::truthy(Some(b))) else {
        return Ok(reply(StatusCode::BAD_REQUEST, &json!({ "error": "본문이 올바른 JSON 이 아닙니다" })));
    };
    if !js::truthy(b.get("collection")) && !js::truthy(b.get("environment")) {
        return Ok(reply(StatusCode::BAD_REQUEST, &json!({ "error": "collection or environment required" })));
    }
    let res = s.db.run(move |c| in_transaction(c, |tx| import_postman_tx(tx, &b))).await?;
    Ok(match res {
        Ok(v) => reply(StatusCode::CREATED, &v),
        Err(msg) => json_error(IMPORT_FAILED, &msg),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::variables::tests::test_db;

    fn import(c: &Connection, doc: Value) -> Result<Counts, String> {
        in_transaction(c, |tx| import_doc(tx, &doc)).unwrap()
    }

    // DB 수준에서 같은 규칙을 본다.
    #[test]
    fn 왕복_새_id_로_복원_secret_실값_미포함() {
        let db = test_db();
        db.with(|c| {
            c.execute_batch(
                r#"INSERT INTO folders (id, workspace_id, name, sort_order, shared_headers, shared_auth) VALUES ('f1','default','exp-folder',1024,'[{"key":"X-Api-Key","value":"LITERAL-API-KEY","enabled":true}]','{"type":"oauth2cc","tokenUrl":"https://idp/t","clientId":"cid","clientSecret":"LITERAL-CLIENT-SECRET"}');
                   INSERT INTO requests (id, folder_id, name, method, url, params, headers, auth, updated_at) VALUES ('r1','f1','exp-req','POST','{{baseUrl}}/x','[{"key":"a","value":"1","enabled":true}]','[{"key":"Authorization","value":"Bearer HARDCODED-TOKEN","enabled":true},null]','{"type":"bearer","token":"LITERAL-BEARER"}',1);
                   INSERT INTO environments (id, workspace_id, name) VALUES ('e1','default','exp-env');
                   INSERT INTO variables (id, environment_id, key, value, secret) VALUES ('v1','e1','baseUrl','http://real',0),('v2','e1','token','TOP-SECRET',1),
                     ('g1','global:dw-a','dupKey','A',0),('g2','global:dw-b','dupKey','B',0),('g3','global:*','apvShared','S',0);"#,
            )?;
            c.execute("UPDATE folders SET description = 'Exported notes' WHERE id = 'f1'", [])?;
            let doc = build_export(c, 0)?;
            let raw = js::stringify(&doc);
            for secret in ["TOP-SECRET", "LITERAL-API-KEY", "LITERAL-CLIENT-SECRET", "HARDCODED-TOKEN", "LITERAL-BEARER"] {
                assert!(!raw.contains(secret), "{secret} 가 export 에 실렸다");
            }
            assert!(raw.contains("cid"));
            assert_eq!(doc["environments"][0]["variables"][1], json!({ "key": "token", "value": "", "secret": true }));
            // 전역변수는 키로 합쳐 마지막 값, 모든 프로젝트 공통은 따로
            assert_eq!(doc["globalVars"], json!([{ "key": "dupKey", "value": "B", "secret": false }]));
            assert_eq!(doc["allProjectVars"], json!([{ "key": "apvShared", "value": "S", "secret": false }]));
            assert_eq!(doc["requests"][0]["headers"].as_array().unwrap().len(), 1);

            let mut again = doc.clone();
            again["workspaceId"] = json!("imp");
            let n = import(c, again).unwrap();
            assert_eq!((n.folders, n.requests, n.environments), (1, 1, 1));
            let new_folder: String = c.query_row("SELECT id FROM folders WHERE workspace_id = 'imp'", [], |r| r.get(0))?;
            assert_ne!(new_folder, "f1");
            let note: String = c.query_row("SELECT description FROM folders WHERE id = ?1", [&new_folder], |r| r.get(0))?;
            assert_eq!(note, "Exported notes");
            let (name, url): (String, String) = c.query_row("SELECT name, url FROM requests WHERE folder_id = ?1", [&new_folder], |r| Ok((r.get(0)?, r.get(1)?)))?;
            assert_eq!((name.as_str(), url.as_str()), ("exp-req", "{{baseUrl}}/x"));
            let dup: i64 = c.query_row("SELECT count(*) FROM variables WHERE environment_id = 'global:imp' AND key = 'dupKey'", [], |r| r.get(0))?;
            assert_eq!(dup, 1);
            let apv: i64 = c.query_row("SELECT count(*) FROM variables WHERE environment_id = 'global:imp' AND key = 'apvShared'", [], |r| r.get(0))?;
            assert_eq!(apv, 0, "모든 프로젝트 공통 변수가 한 프로젝트의 것으로 바뀌면 안 된다");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn 손편집_파일은_정규화해_넣고_null_요소는_통째로_실패() {
        let db = test_db();
        db.with(|c| {
            let doc = json!({ "postq": 1, "workspaceId": "he-ws",
                "folders": [{ "id": "F", "name": "he", "sharedHeaders": "oops" }],
                "requests": [
                    { "folderId": "F", "name": { "obj": 1 }, "method": ["GET"], "url": 42, "body": { "a": 1 }, "tags": "smoke", "settings": "", "assertions": "oops", "params": "{}", "headers": "oops", "specState": {}, "specOperationKey": [], "specFingerprint": true },
                    { "folderId": "없음", "name": "고아" },
                ],
                "environments": [{ "name": "e", "variables": {} }], "globalVars": {} });
            let n = import(c, doc).unwrap();
            assert_eq!((n.folders, n.requests, n.environments), (1, 1, 1));
            let row: (String, String, String, String, String, String, String, Option<String>) = c.query_row(
                "SELECT r.name, r.method, r.url, r.body, r.tags, r.settings, r.params, r.spec_state FROM requests r JOIN folders f ON r.folder_id = f.id WHERE f.workspace_id = 'he-ws'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?)),
            )?;
            assert_eq!(row, ("[object Object]".into(), "GET".into(), "42".into(), "[object Object]".into(), "[]".into(), "{}".into(), "[]".into(), None));
            let sh: String = c.query_row("SELECT shared_headers FROM folders WHERE workspace_id = 'he-ws'", [], |r| r.get(0))?;
            assert_eq!(sh, "[]");

            // null 요소는 Node 에서 TypeError — 앞서 넣은 폴더까지 되돌린다.
            let bad = json!({ "postq": 1, "workspaceId": "rb-ws", "folders": [{ "id": "A", "name": "남으면 안 됨" }], "requests": [null] });
            assert!(import(c, bad).is_err());
            let left: i64 = c.query_row("SELECT count(*) FROM folders WHERE workspace_id = 'rb-ws'", [], |r| r.get(0))?;
            assert_eq!(left, 0);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn 전역변수_가져오기는_키_단위_upsert_빈_secret_은_실값_유지() {
        let db = test_db();
        db.with(|c| {
            c.execute_batch(
                "INSERT INTO variables (id, environment_id, key, value, secret) VALUES ('a','global:gd','keep','KEEP',0),('b','global:gd','k','old',0),('c','global:gd','apiToken','REAL-SECRET',1);",
            )?;
            let doc = json!({ "postq": 1, "workspaceId": "gd", "globalVars": [
                { "key": "k", "value": "new", "secret": false }, { "key": "apiToken", "value": "", "secret": true }, { "value": "x" }, { "key": "k", "value": "두번째는 무시" },
            ] });
            import(c, doc).unwrap();
            let m = load_var_map(c, "global:gd")?;
            assert_eq!(m.get("k").unwrap().value, "new");
            assert_eq!(m.get("keep").unwrap().value, "KEEP");
            assert_eq!(m.get("apiToken").unwrap().value, "REAL-SECRET");
            let n: i64 = c.query_row("SELECT count(*) FROM variables WHERE environment_id = 'global:gd' AND key = 'k'", [], |r| r.get(0))?;
            assert_eq!(n, 1);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn postman_컬렉션과_환경() {
        let db = test_db();
        db.with(|c| {
            let b = json!({ "workspaceId": "pm", "collection": { "info": { "name": "Route Test", "description": { "content": "Imported overview" } }, "item": [
                { "name": "ping", "request": { "method": "GET", "url": "{{baseUrl}}/ping" } },
                { "name": "pong", "request": { "method": "POST", "url": "{{baseUrl}}/pong", "body": { "mode": "raw", "raw": "{\"a\":1}", "options": { "raw": { "language": "json" } } } } },
            ] }, "environment": { "name": "env1", "values": [{ "key": "baseUrl", "value": "https://x", "enabled": true }] } });
            let out = in_transaction(c, |tx| import_postman_tx(tx, &b)).unwrap().unwrap();
            let description: String = c.query_row("SELECT description FROM folders WHERE id = ?1", [out["folderId"].as_str().unwrap()], |r| r.get(0))?;
            assert_eq!(description, "Imported overview");
            let keys: Vec<&String> = out.as_object().unwrap().keys().collect();
            assert_eq!(keys, ["requestCount", "folderId", "summary", "environmentId"]);
            assert_eq!(out["requestCount"], 2);
            let origins: Vec<(String, String, i64)> = c
                .prepare("SELECT origin, body_type, sort_order FROM requests WHERE folder_id = ?1 ORDER BY sort_order")?
                .query_map([out["folderId"].as_str().unwrap()], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<Result<_, _>>()?;
            assert_eq!(origins, [("postman-import".into(), "none".into(), 1024), ("postman-import".into(), "json".into(), 2048)]);

            // 환경이 실패하면 컬렉션 폴더도 남지 않는다
            let bad = json!({ "collection": { "info": { "name": "롤백_컬렉션" }, "item": [{ "name": "a", "request": { "method": "GET", "url": "/a" } }] }, "environment": { "values": [null] } });
            assert!(in_transaction(c, |tx| import_postman_tx(tx, &bad)).unwrap().is_err());
            let left: i64 = c.query_row("SELECT count(*) FROM folders WHERE name = '롤백_컬렉션'", [], |r| r.get(0))?;
            assert_eq!(left, 0);
            Ok(())
        })
        .unwrap();
    }
}
