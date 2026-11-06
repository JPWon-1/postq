//! 요청 실행 라우트 — `/api/execute`(ad-hoc), `/api/requests/{id}/execute`(저장 요청 실행),
//! `/api/requests/{id}/preview`(보내지 않고 최종 요청만), `/api/graphql/introspect`.
//!
//! 순서(바꾸면 보안 규칙이 깨진다)
//! 1. 정책 가드 — 자격증명·네트워크·pre-step 보다 먼저. 거부는 감사 행을 남기고 403.
//! 2. 폴더 공통 헤더 병합(치환 전) → 변수 스코프(전역 < 환경 < 요청 < 개인 + 동적변수 + pre-step).
//! 3. 실행 입력 덮어쓰기(overrides)는 헤더·자격증명에 닿지 않는다 — 해석 뒤 헤더를 기준선으로 되돌리고,
//!    URL 의 오리진·자격증명이 바뀌면 거부한다.
//! 4. 인증 주입(real 은 실값, redacted 는 마스킹) → 쿠키 jar 주입 → 송신(SSRF·리다이렉트 규칙은 executor).
//! 5. 이력에는 스크럽한 것만(자격증명 헤더·echo 된 secret), 실행한 본인에게는 실 응답.
//!
//! 실행 출처는 HTTP 로 들어온 요청이라 'ui' 다(Node 도 AsyncLocalStorage 가 비어 있으면 'ui').
//! 예외는 MCP 도구가 서버 안에서 이 라우트를 부를 때뿐이다 — [`crate::mcp_tools`] 가 요청 extensions 에
//! [`ExecutionSource::Mcp`] 를 넣는다. extensions 는 네트워크로 실어 보낼 수 없으니(헤더·JSON 이 아니다)
//! Node 의 AsyncLocalStorage 처럼 바깥에서 출처를 사칭할 길이 없다.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::post;
use axum::{Extension, Router};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Map, Value};

use crate::assertions::check_response;
use crate::auth_config::{sanitize_folder_auth, merge_auth_secrets};
use crate::exec_helpers::{apply_authorization, build_stored_execution, inject_jar_cookies, merge_folder_headers, save_set_cookies, url_host};
use crate::execution_overrides::{apply_execution_overrides, overlay_execution_vars, parse_overrides};
use crate::execution_policy::{execution_target_error, guard_execution, insert_execution, parameter_type_error, ExecutionSource, GuardInput};
use crate::executor::{execute_request, headers_to_json, ExecResult};
use crate::graphql_introspect::{simplify_schema, INTROSPECTION_QUERY};
use crate::json_cols::{safe_json, to_kv_array};
use crate::jsval::reply;
use crate::records::{parse_execution, parse_request_row, select_request};
use crate::request_auth::resolve_effective_auth;
use crate::resolve::{apply_personal_vars, normalize_request_input, overlay_kv_vars, resolve_request, Kv, NameSet, RequestInput, RequestSettings};
use crate::routes::input::{json_error, read_json};
use crate::scrub::{mask_credential_headers, scrub_json, secret_values_of};
use crate::steps::{apply_post_steps, build_exec_vars};
use crate::variables::{load_team_vars, VarMap};
use crate::{js, secretbox, AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/execute", post(adhoc))
        .route("/api/requests/{id}/execute", post(execute_saved))
        .route("/api/requests/{id}/preview", post(preview))
        .route("/api/graphql/introspect", post(introspect))
}

const BAD_INPUT: &str = "input 의 method·url 이 올바르지 않습니다";

fn status(code: u16) -> StatusCode {
    StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
}

fn out(code: u16, v: Value) -> Response {
    reply(status(code), &v)
}

/// `b.x` — b 가 객체가 아니면 undefined.
fn get<'a>(b: &'a Value, k: &str) -> Option<&'a Value> {
    b.get(k).filter(|v| !v.is_null())
}

/// `b.x ?? fallback` 를 문자열로(환경 id·작업공간 id).
fn opt_string(v: Option<&Value>) -> Option<String> {
    match v {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(o) => Some(js::to_string(o)),
    }
}

/// 배열이면 그 원소, 아니면 빈 목록 — 손상·모양 틀린 값 하나로 실행이 500 이 나지 않게.
fn arr(v: Option<&Value>) -> Vec<Value> {
    v.and_then(Value::as_array).cloned().unwrap_or_default()
}

/// `[...new Set([...a, ...b])].sort()`
fn merge_missing(pre: &NameSet, req: &[String]) -> Vec<String> {
    let mut all = pre.clone();
    all.extend(req.iter());
    all.sorted()
}

/// 저장 요청·폴더에서 읽어 오는 실행 문맥.
pub(super) struct Saved {
    pub(super) parsed_row: Option<Map<String, Value>>,
    pub(super) ai_allowed: bool,
    pub(super) workspace_id: String,
    pub(super) shared_headers: Vec<Kv>,
    pub(super) folder_auth: Value,
}

/// 시나리오·폴더 실행(flow_run)도 같은 규칙으로 읽는다 — 폴더 공통 헤더·인증의 해석이 경로마다 다르면 안 된다.
pub(super) fn load_saved(c: &Connection, id: &str) -> anyhow::Result<Saved> {
    let row = select_request(c, id)?;
    let ai_allowed = row.as_ref().map_or(false, |r| js::truthy(r.get("aiExecutionAllowed")));
    let folder_id = row.as_ref().and_then(|r| r.get("folderId")).and_then(Value::as_str).map(str::to_string);
    let folder: Option<(String, Option<String>, Option<String>)> = match folder_id {
        Some(fid) => c
            .prepare_cached(r#"SELECT "workspace_id", "shared_headers", "shared_auth" FROM "folders" WHERE "folders"."id" = ?1"#)?
            .query_row([fid], |r| Ok((crate::rows::text(r, 0)?, r.get(1)?, r.get(2)?)))
            .optional()?,
        None => None,
    };
    let (workspace_id, shared_headers, folder_auth) = match folder {
        Some((ws, sh, sa)) => {
            let sh = sh.map(Value::String);
            let sa = sa.map(Value::String);
            let headers = to_kv_array(safe_json(sh.as_ref()).as_ref()).iter().map(Kv::from_json).collect();
            let auth = secretbox::decrypt_auth_config(&sanitize_folder_auth(safe_json(sa.as_ref()).as_ref()));
            (ws, headers, auth)
        }
        // parseSharedAuth(undefined) — none
        None => ("default".to_string(), vec![], json!({ "type": "none" })),
    };
    Ok(Saved { parsed_row: row.as_ref().map(parse_request_row), ai_allowed, workspace_id, shared_headers, folder_auth })
}

/// `b.x ?? parsedRow?.x ?? fallback`
fn pick<'a>(b: &'a Value, row: Option<&'a Map<String, Value>>, k: &str) -> Option<&'a Value> {
    get(b, k).or_else(|| row.and_then(|r| r.get(k)).filter(|v| !v.is_null()))
}

// ── POST /api/requests/{id}/execute ─────────────────────────────────────

async fn execute_saved(
    State(s): State<AppState>,
    Path(id): Path<String>,
    src: Option<Extension<ExecutionSource>>,
    body: Bytes,
) -> Response {
    let source = src.map_or(ExecutionSource::Ui, |Extension(x)| x);
    const PREFIX: &str = "요청 실행 중 서버 오류";
    // `await req.json()` — catch 가 없어 깨진 JSON 은 라우트의 try/catch 로 500.
    let Some(mut b) = read_json(&body) else {
        return json_error(PREFIX, if body.is_empty() { "Unexpected end of JSON input" } else { "Unexpected token in JSON" });
    };
    if !b.is_object() {
        if b.is_null() {
            return json_error(PREFIX, "Cannot read properties of null (reading 'input')");
        }
        b = Value::Object(Map::new()); // 원시값의 프로퍼티는 undefined
    }
    if !js::truthy(b.get("input")) {
        return out(400, json!({ "error": "input required" }));
    }
    let Some(safe_input) = normalize_request_input(b.get("input")) else { return out(400, json!({ "error": BAD_INPUT })) };
    match run_saved(&s, id, b, safe_input, source).await {
        Ok(r) => r,
        Err(e) => json_error(PREFIX, &e.to_string()),
    }
}

async fn run_saved(s: &AppState, id: String, b: Value, safe_input: RequestInput, source: ExecutionSource) -> anyhow::Result<Response> {
    let executed_by = b.get("executedBy").and_then(Value::as_str).unwrap_or_default().to_string();
    let env_id = opt_string(b.get("environmentId"));
    let confirmed = b.get("confirmed") == Some(&Value::Bool(true));

    // 1. 정책 가드 + 저장 문맥 + 팀 변수(한 번에 DB 에서)
    let (saved, denied, team) = {
        let (id, env_id, executed_by, method) = (id.clone(), env_id.clone(), executed_by.clone(), safe_input.method.clone());
        s.db
            .run(move |c| {
                let saved = load_saved(c, &id)?;
                let denied = guard_execution(
                    c,
                    &GuardInput {
                        request_id: Some(&id),
                        method: &method,
                        environment_id: env_id.as_deref(),
                        workspace_id: &saved.workspace_id,
                        validation_error: None,
                        executed_by: &executed_by,
                        source,
                        ai_execution_allowed: saved.ai_allowed,
                        confirmed,
                    },
                )?;
                let team = if denied.is_none() { load_team_vars(c, &saved.workspace_id, env_id.as_deref())? } else { VarMap::new() };
                Ok((saved, denied, team))
            })
            .await?
    };
    if let Some(d) = denied {
        return Ok(out(403, d));
    }
    let row = saved.parsed_row.as_ref();

    // 2. 폴더 공통 헤더(치환 전) — resolved 에 병합 결과가 남아 실제 송신 내용이 이력에 보존된다.
    let mut input = RequestInput { headers: merge_folder_headers(&safe_input.headers, &saved.shared_headers), ..safe_input };
    let team = overlay_kv_vars(&team, &arr(pick(&b, row, "vars")));
    let pre_steps = arr(pick(&b, row, "preSteps"));
    let mut pre_missing = NameSet::new();
    let baseline_vars = build_exec_vars(&team, get(&b, "personalVars"), &pre_steps, Some(&mut pre_missing));
    let baseline = resolve_request(&input, &baseline_vars);

    // 3. 실행 입력 덮어쓰기 — 헤더·자격증명에는 닿지 않는다.
    let Some(overrides) = parse_overrides(b.get("overrides")) else {
        return Ok(out(400, json!({ "error": "실행 입력이 잘못되었습니다: vars/params/body/bodyMerge 만 허용하며 body 와 bodyMerge 는 배타적입니다" })));
    };
    input = match apply_execution_overrides(&input, &overrides) {
        Ok(i) => i,
        Err(_) => return Ok(out(400, json!({ "error": "body 는 JSON 문자열, bodyMerge 는 저장된 JSON 객체에 적용할 객체여야 합니다" }))),
    };
    let vars = overlay_execution_vars(&baseline_vars, overrides.vars.as_deref());
    let resolved = resolve_request(&input, &vars);
    let (mut real, mut redacted) = (resolved.real, resolved.redacted);
    real.headers = baseline.real.headers.clone();
    redacted.headers = baseline.redacted.headers.clone();
    let missing = merge_missing(&pre_missing, &resolved.missing);

    // parameterTypeError 는 MCP 전용 — AI 가 스펙과 다른 타입(숫자 자리에 문자 등)을 넣으면 보내기 전에 거부한다.
    let validation_error = execution_target_error(&baseline.real.url, &real.url).or_else(|| {
        if source == ExecutionSource::Mcp {
            parameter_type_error(row.and_then(|r| r.get("specContract")).filter(|v| !v.is_null()), &real)
        } else {
            None
        }
    });
    if let Some(validation_error) = validation_error {
        let (id, env_id, executed_by, method, ws) = (id.clone(), env_id.clone(), executed_by.clone(), real.method.clone(), saved.workspace_id.clone());
        let denied = s
            .db
            .run(move |c| {
                Ok(guard_execution(
                    c,
                    &GuardInput {
                        request_id: Some(&id),
                        method: &method,
                        environment_id: env_id.as_deref(),
                        workspace_id: &ws,
                        validation_error: Some(validation_error),
                        executed_by: &executed_by,
                        source,
                        ai_execution_allowed: false,
                        confirmed: false,
                    },
                )?)
            })
            .await?;
        return Ok(out(403, denied.unwrap_or(Value::Null)));
    }

    // 4. 인증 — b.auth 는 클라 평문, 저장 열은 parse_request_row 가 복호화했다. inherit 은 폴더 인증으로.
    let req_auth = pick(&b, row, "auth").cloned().unwrap_or_else(|| json!({ "type": "none" }));
    let req_auth = if req_auth.get("hasStoredSecret") == Some(&Value::Bool(true)) {
        merge_auth_secrets(&req_auth, &row.and_then(|r| r.get("auth")).cloned().unwrap_or(Value::Null))
    } else { req_auth };
    let auth_cfg = resolve_effective_auth(Some(&req_auth), Some(&saved.folder_auth));
    let auth_error = apply_authorization(&auth_cfg, &baseline_vars, &mut real, Some(&mut redacted)).await;

    // 쿠키 jar — 스코프는 (workspaceId, cookieEnv). 환경 미선택이면 '' 공용 스코프.
    let workspace_id = saved.workspace_id.clone();
    let cookie_env = env_id.clone().unwrap_or_default();
    let host = url_host(&real.url).unwrap_or_default();
    if !host.is_empty() {
        let (ws, ce, h, mut r) = (workspace_id.clone(), cookie_env.clone(), host.clone(), real);
        real = s
            .db
            .run(move |c| {
                inject_jar_cookies(c, &ws, &ce, &h, &mut r)?;
                Ok(r)
            })
            .await?;
    }

    // 인증 실패(oauth2 토큰 발급 등)면 메인 요청을 보내지 않고 그 오류를 이력에 남긴다.
    let settings = RequestSettings::from_json(pick(&b, row, "settings"));
    let result = match auth_error {
        Some(e) => ExecResult { duration_ms: 0, error: Some(e), ..Default::default() },
        None => execute_request(&real, &settings).await,
    };

    // 5. 이력 저장분 — secret echo 스크럽 + 리터럴 자격증명 헤더 마스킹.
    let mut secret_vals = secret_values_of(&baseline_vars);
    secret_vals.extend(secret_values_of(&vars));
    let stored = build_stored_execution(&redacted, &result, &secret_vals);
    let rules = arr(pick(&b, row, "assertions"));
    let (check_passed, assertion_results) = check_response(&rules, &result);
    let row_json = json!({
        "id": uuid::Uuid::new_v4().to_string(), "requestId": id, "executedBy": executed_by,
        "executedAt": js::now_ms(), "environmentId": env_id,
        "executionSource": source.as_str(), "denialReason": null,
        "resolved": stored.resolved,
        "responseStatus": result.status,
        "responseHeaders": stored.response_headers,
        "responseBody": stored.response_body,
        "durationMs": result.duration_ms, "error": result.error,
        "checkPassed": check_passed, "assertionResults": js::stringify(&scrub_json(&Value::Array(assertion_results.clone()), &secret_vals)),
        "missingVariables": js::stringify(&json!(missing)),
    });
    let Value::Object(mut exec_row) = row_json else { unreachable!() };
    {
        let (r, ws, ce, h, lines) = (exec_row.clone(), workspace_id, cookie_env, host, result.set_cookies.clone());
        s.db
            .run(move |c| {
                save_set_cookies(c, &ws, &ce, &h, &lines)?;
                insert_execution(c, &r)?;
                Ok(())
            })
            .await?;
    }

    // post-step — 응답에서 값 추출(변수).
    let post_steps = arr(pick(&b, row, "postSteps"));
    let post = apply_post_steps(result.body.as_deref(), result.headers.as_deref(), &post_steps);

    // 실행 본인에게는 실 응답(저장분만 스크럽). 이력을 다시 열면 스크럽된 값이 보인다.
    exec_row.insert("responseBody".into(), result.body.clone().map_or(Value::Null, Value::String));
    exec_row.insert("responseHeaders".into(), result.headers.as_ref().map_or(Value::Null, |h| Value::String(js::stringify(&headers_to_json(h)))));
    exec_row.insert("pinned".into(), Value::Bool(false));
    let mut resp = parse_execution(exec_row);
    resp["assertionResults"] = Value::Array(assertion_results);
    resp["extracted"] = Value::Array(post.extracted);
    resp["extractMissing"] = json!(post.missing);
    resp["truncated"] = Value::Bool(result.truncated.unwrap_or(false));
    Ok(out(200, resp))
}

// ── POST /api/requests/{id}/preview ─────────────────────────────────────

async fn preview(State(s): State<AppState>, Path(id): Path<String>, body: Bytes) -> Response {
    let b = read_json(&body).unwrap_or(Value::Null);
    if !js::truthy(b.get("input")) {
        return out(400, json!({ "error": "input required" }));
    }
    let Some(safe_input) = normalize_request_input(b.get("input")) else { return out(400, json!({ "error": BAD_INPUT })) };
    match run_preview(&s, id, b, safe_input).await {
        Ok(r) => r,
        Err(e) => json_error("미리보기 중 서버 오류", &e.to_string()),
    }
}

async fn run_preview(s: &AppState, id: String, b: Value, safe_input: RequestInput) -> anyhow::Result<Response> {
    let env_id = opt_string(b.get("environmentId"));
    let cookie_env = env_id.clone().unwrap_or_default();
    let (saved, team) = s
        .db
        .run(move |c| {
            let saved = load_saved(c, &id)?;
            let team = load_team_vars(c, &saved.workspace_id, env_id.as_deref())?;
            Ok((saved, team))
        })
        .await?;
    let row = saved.parsed_row.as_ref();
    let input = RequestInput { headers: merge_folder_headers(&safe_input.headers, &saved.shared_headers), ..safe_input };
    let team = overlay_kv_vars(&team, &arr(pick(&b, row, "vars")));
    let pre_steps = arr(pick(&b, row, "preSteps"));
    // pre-step 인자에서 못 채운 변수도 함께 — 실행 전에 알아야 의미가 있다.
    let mut pre_missing = NameSet::new();
    let vars = build_exec_vars(&team, get(&b, "personalVars"), &pre_steps, Some(&mut pre_missing));
    let resolved = resolve_request(&input, &vars);
    let (mut real, mut redacted) = (resolved.real, resolved.redacted);
    let missing = merge_missing(&pre_missing, &resolved.missing);
    let req_auth = pick(&b, row, "auth").cloned().unwrap_or_else(|| json!({ "type": "none" }));
    let req_auth = if req_auth.get("hasStoredSecret") == Some(&Value::Bool(true)) {
        merge_auth_secrets(&req_auth, &row.and_then(|r| r.get("auth")).cloned().unwrap_or(Value::Null))
    } else { req_auth };
    let auth_cfg = resolve_effective_auth(Some(&req_auth), Some(&saved.folder_auth));
    let snippet = b.get("purpose").and_then(Value::as_str) == Some("snippet");
    let reveal = snippet && b.get("revealSecrets") == Some(&Value::Bool(true));
    let mut safe_vars = vars.clone();
    for (key, value) in vars.iter() {
        if value.secret { safe_vars.insert(key, crate::variables::Var { value: format!("{{{{{key}}}}}"), secret: true }); }
    }
    let mut safe_auth = auth_cfg.clone();
    // Passive snippet refresh must never issue an OAuth token request.
    if safe_auth.get("type").and_then(Value::as_str) == Some("oauth2cc") {
        safe_auth = json!({"type": "bearer", "token": "{{oauthToken}}"});
    } else {
        let (field, fallback) = match safe_auth.get("type").and_then(Value::as_str) {
            Some("bearer") => ("token", "bearerToken"), Some("basic") => ("password", "password"),
            Some("apikey") => ("value", "apiKey"), _ => ("", ""),
        };
        if !field.is_empty() {
            let value = safe_auth.get(field).and_then(Value::as_str).unwrap_or("");
            if !value.is_empty() && !value.contains("{{") { safe_auth[field] = json!(format!("{{{{{fallback}}}}}")); }
        }
    }
    let host = url_host(&real.url).unwrap_or_default();
    let auth_error = if snippet && !reveal {
        real = redacted.clone();
        apply_authorization(&safe_auth, &safe_vars, &mut real, None).await
    } else {
        apply_authorization(&auth_cfg, &vars, &mut real, Some(&mut redacted)).await
    };
    let had_cookie = real.headers.iter().any(|h| h.enabled && h.key.eq_ignore_ascii_case("cookie"));
    let ws = saved.workspace_id.clone();
    real = s.db.run(move |c| { inject_jar_cookies(c, &ws, &cookie_env, &host, &mut real)?; Ok(real) }).await?;
    // Retain variable references, but never expose literal credentials in passive snippets.
    if snippet && !reveal {
        for h in &mut real.headers {
            if crate::scrub::is_credential_header(&h.key) && (!h.value.contains("{{") || (!had_cookie && h.key.eq_ignore_ascii_case("cookie"))) && !h.value.is_empty() {
                let prefix = if h.value.starts_with("Bearer ") { "Bearer " } else if h.value.starts_with("Basic ") { "Basic " } else { "" };
                h.value = format!("{prefix}{{{{header_{}}}}}", h.key.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect::<String>());
            }
        }
    }
    let prepared = crate::executor::prepared_input(&real).map_err(|e| anyhow::anyhow!(e.describe()))?;
    if snippet {
        let has_secrets = prepared.to_json().to_string().contains("{{");
        return Ok(out(200, json!({"snippet": prepared.to_json(), "hasSecrets": has_secrets, "missing": missing, "authError": auth_error})));
    }
    // Preview gets the same final header list; real credential values stay masked.
    if let Some(cookie) = real.headers.iter().find(|h| h.enabled && h.key.eq_ignore_ascii_case("cookie")) {
        if !redacted.headers.iter().any(|h| h.enabled && h.key.eq_ignore_ascii_case("cookie")) {
            redacted.headers.push(Kv::new(&cookie.key, "***"));
        }
    }
    let mut preview = crate::executor::prepared_input(&redacted).map_err(|e| anyhow::anyhow!(e.describe()))?.to_json();
    preview["headers"] = Value::Array(mask_credential_headers(preview["headers"].as_array().map(Vec::as_slice).unwrap_or(&[])));
    Ok(out(200, json!({ "preview": preview, "missing": missing, "authError": auth_error })))
}

// ── POST /api/execute (ad-hoc) ──────────────────────────────────────────

async fn adhoc(State(s): State<AppState>, body: Bytes) -> Response {
    let b = read_json(&body).unwrap_or(Value::Null);
    if !js::truthy(b.get("input")) {
        return out(400, json!({ "error": "input required" }));
    }
    let Some(safe_input) = normalize_request_input(b.get("input")) else { return out(400, json!({ "error": BAD_INPUT })) };
    match run_adhoc(&s, b, safe_input).await {
        Ok(r) => r,
        // Node 라우트에는 try/catch 가 없어 Next 기본 500 이었다.
        Err(e) => json_error("요청 실행 중 서버 오류", &e.to_string()),
    }
}

async fn run_adhoc(s: &AppState, b: Value, safe_input: RequestInput) -> anyhow::Result<Response> {
    let ws = opt_string(b.get("workspaceId")).unwrap_or_else(|| "default".into());
    let env_id = opt_string(b.get("environmentId"));
    let confirmed = b.get("confirmed") == Some(&Value::Bool(true));
    let method = safe_input.method.clone();
    let (denied, team) = s
        .db
        .run(move |c| {
            let denied = guard_execution(
                c,
                &GuardInput {
                    request_id: None,
                    method: &method,
                    environment_id: env_id.as_deref(),
                    workspace_id: &ws,
                    validation_error: None,
                    executed_by: "익명",
                    source: ExecutionSource::Ui,
                    ai_execution_allowed: false,
                    confirmed,
                },
            )?;
            let team = if denied.is_none() { load_team_vars(c, &ws, env_id.as_deref())? } else { VarMap::new() };
            Ok((denied, team))
        })
        .await?;
    if let Some(d) = denied {
        return Ok(out(403, d));
    }
    let mut pre_missing = NameSet::new();
    let vars = build_exec_vars(&team, get(&b, "personalVars"), &arr(get(&b, "preSteps")), Some(&mut pre_missing));
    let resolved = resolve_request(&safe_input, &vars);
    let mut real = resolved.real;
    let missing = merge_missing(&pre_missing, &resolved.missing);
    // 인증 헤더 주입(요청에 없을 때만) — 단건 실행·시나리오와 같은 헬퍼.
    if let Some(auth) = b.get("auth").filter(|a| js::truthy(Some(a))) {
        if let Some(error) = apply_authorization(auth, &vars, &mut real, None).await {
            return Ok(out(
                200,
                json!({ "responseStatus": null, "responseHeaders": null, "responseBody": null, "durationMs": 0, "error": error, "missingVariables": missing, "extracted": [], "extractMissing": [] }),
            ));
        }
    }
    let result = execute_request(&real, &RequestSettings::from_json(get(&b, "settings"))).await;
    let post = apply_post_steps(result.body.as_deref(), result.headers.as_deref(), &arr(get(&b, "postSteps")));
    Ok(out(
        200,
        json!({
            "responseStatus": result.status,
            "responseHeaders": result.headers_json(),
            "responseBody": result.body,
            "durationMs": result.duration_ms,
            "error": result.error,
            "missingVariables": missing,
            "extracted": post.extracted,
            "extractMissing": post.missing,
        }),
    ))
}

// ── POST /api/graphql/introspect ────────────────────────────────────────

async fn introspect(State(s): State<AppState>, body: Bytes) -> Response {
    let b = read_json(&body).unwrap_or(Value::Null);
    if !js::truthy(b.get("url")) {
        return out(400, json!({ "error": "url required" }));
    }
    match run_introspect(&s, b).await {
        Ok(r) => r,
        Err(e) => json_error("스키마 조회 중 서버 오류", &e.to_string()),
    }
}

async fn run_introspect(s: &AppState, b: Value) -> anyhow::Result<Response> {
    let ws = opt_string(b.get("workspaceId")).unwrap_or_else(|| "default".into());
    let env_id = opt_string(b.get("environmentId"));
    let (denied, team) = s
        .db
        .run(move |c| {
            let denied = guard_execution(
                c,
                &GuardInput {
                    request_id: None,
                    method: "POST",
                    environment_id: env_id.as_deref(),
                    workspace_id: &ws,
                    validation_error: None,
                    executed_by: "스키마 조회",
                    source: ExecutionSource::Ui,
                    ai_execution_allowed: false,
                    confirmed: false,
                },
            )?;
            let team = if denied.is_none() { load_team_vars(c, &ws, env_id.as_deref())? } else { VarMap::new() };
            Ok((denied, team))
        })
        .await?;
    if let Some(d) = denied {
        return Ok(out(403, d));
    }
    // 실행 경로와 같은 우선순위: 전역 < 환경 < 요청 < 개인. 개인 값이 빠지면 실행은 되는데 스키마 조회만 실패한다.
    let team = overlay_kv_vars(&team, &arr(get(&b, "vars")));
    let vars = apply_personal_vars(&team, get(&b, "personalVars"));
    let input = RequestInput {
        method: "POST".into(),
        url: js::to_string(&b["url"]),
        params: vec![],
        headers: arr(get(&b, "headers")).iter().filter_map(Kv::from_raw).collect(),
        body_type: "graphql".into(),
        body: INTROSPECTION_QUERY.into(),
    };
    let resolved = resolve_request(&input, &vars);
    if !resolved.missing.is_empty() {
        return Ok(out(400, json!({ "error": format!("미해석 변수: {}", resolved.missing.join(", ")) })));
    }
    let mut real = resolved.real;
    if let Some(auth) = b.get("auth").filter(|a| js::truthy(Some(a))) {
        if let Some(error) = apply_authorization(auth, &vars, &mut real, None).await {
            return Ok(out(400, json!({ "error": error })));
        }
    }
    let result = execute_request(&real, &RequestSettings::default()).await;
    if let Some(e) = result.error {
        return Ok(out(502, json!({ "error": e })));
    }
    let Some(parsed) = js::parse_json(result.body.as_deref().unwrap_or("")) else {
        return Ok(out(502, json!({ "error": "응답이 JSON 이 아닙니다" })));
    };
    match simplify_schema(&parsed) {
        Some(schema) => Ok(out(200, json!({ "schema": schema }))),
        None => Ok(out(422, json!({ "error": "introspection 응답에서 스키마를 찾지 못했습니다(비활성화됐을 수 있음)" }))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::executor::tests::{mock, resp, split};
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    fn app() -> (Router, crate::Db) {
        let db = crate::variables::tests::test_db();
        let state = AppState {
            db: db.clone(),
            config: crate::Config { host: "127.0.0.1".into(), port: 0, db_path: ":memory:".into(), migrations_dir: "drizzle".into(), static_dir: None },
        };
        (crate::routes::router().with_state(state), db)
    }

    async fn call(app: &Router, uri: &str, body: Value) -> (StatusCode, Value) {
        let req = Request::post(uri).header("content-type", "application/json").body(Body::from(body.to_string())).unwrap();
        let res = app.clone().oneshot(req).await.unwrap();
        let st = res.status();
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
        (st, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    fn seed(db: &crate::Db, sql: &'static str) {
        db.with(move |c| Ok(c.execute_batch(sql)?)).unwrap();
    }

    async fn echo() -> crate::executor::tests::Mock {
        mock(|path, req, _| {
            let (h, b) = split(req);
            match path {
                "/cookie" => resp("200 OK", &[("set-cookie", "sid=S1; Path=/")], b"ok"),
                "/gql" => resp("200 OK", &[("content-type", "application/json")], br#"{"data":{"__schema":{"queryType":{"name":"Query"},"mutationType":null,"types":[{"kind":"OBJECT","name":"Query","fields":[{"name":"me","type":{"kind":"SCALAR","name":"String"},"args":[]}]}]}}}"#),
                _ => resp("200 OK", &[("content-type", "application/json")], json!({ "path": path, "head": h, "body": b }).to_string().as_bytes()),
            }
        })
        .await
    }

    #[tokio::test]
    async fn 저장_요청_실행은_스크럽한_이력을_남기고_본인에게는_실값() {
        let (app, db) = app();
        let m = echo().await;
        seed(&db, r#"INSERT INTO folders (id, workspace_id, name, shared_headers) VALUES ('f1', 'ws', 'f', '[{"key":"X-Folder","value":"fv","enabled":true}]');
            INSERT INTO requests (id, folder_id, name, method, url, updated_at) VALUES ('r1', 'f1', 'r', 'GET', 'x', 0);
            INSERT INTO environments (id, workspace_id, name) VALUES ('e1', 'ws', 'dev');"#);
        db.with(|c| {
            c.execute("INSERT INTO variables (id, environment_id, key, value, secret) VALUES ('v1', 'e1', 'tok', ?1, 1)", [crate::secretbox::encrypt_secret("SECRET-TOKEN")])?;
            Ok(())
        })
        .unwrap();
        let input = json!({ "method": "GET", "url": format!("{}/echo", m.base), "headers": [{ "key": "X-Echo", "value": "{{tok}}" }], "params": [], "bodyType": "none", "body": "" });
        let (st, r) = call(
            &app,
            "/api/requests/r1/execute",
            json!({ "environmentId": "e1", "input": input, "auth": { "type": "bearer", "token": "{{tok}}" }, "assertions": [{ "target": "status", "op": "eq", "expected": "200" }], "postSteps": [{ "name": "p", "source": "jsonPath", "path": "path" }] }),
        )
        .await;
        assert_eq!(st, StatusCode::OK, "{r}");
        assert_eq!(r["responseStatus"], 200);
        assert_eq!(r["checkPassed"], true);
        assert_eq!(r["truncated"], false);
        assert_eq!(r["extracted"][0]["value"], "/echo");
        assert_eq!(r["executionSource"], "ui");
        assert_eq!(r["executedBy"], "");
        // 본인 응답은 실값(대상이 echo 한 토큰 그대로)
        let body: Value = serde_json::from_str(r["responseBody"].as_str().unwrap()).unwrap();
        let head = body["head"].as_str().unwrap();
        assert!(head.contains("authorization: bearer secret-token"));
        assert!(head.contains("x-folder: fv"));
        // 이력은 스크럽·마스킹
        let (stored_body, resolved): (String, String) = db.with(|c| Ok(c.query_row("SELECT response_body, resolved FROM executions WHERE request_id = 'r1'", [], |r| Ok((r.get(0)?, r.get(1)?)))?)).unwrap();
        assert!(!stored_body.contains("SECRET-TOKEN"));
        assert!(!resolved.contains("SECRET-TOKEN"));
        assert!(resolved.contains(r#"{"key":"Authorization","value":"***","enabled":true}"#) || resolved.contains("Bearer ***"));
        assert!(resolved.contains("{{tok}}"));
    }

    #[tokio::test]
    async fn 정책_거부_입력_오류_대상_변경() {
        let (app, db) = app();
        seed(&db, r#"INSERT INTO folders (id, workspace_id, name) VALUES ('f1', 'ws', 'f');
            INSERT INTO requests (id, folder_id, name, method, url, updated_at) VALUES ('r1', 'f1', 'r', 'POST', 'x', 0);
            INSERT INTO environments (execution_policy, id, workspace_id, name) VALUES ('read-only', 'e1', 'ws', 'prod');
            INSERT INTO environments (id, workspace_id, name) VALUES ('e2', 'ws', 'dev');
            INSERT INTO variables (id, environment_id, key, value, secret) VALUES ('v1', 'e2', 'host', 'https://a.example', 0);"#);
        let input = json!({ "method": "POST", "url": "http://127.0.0.1:9/x", "params": [], "headers": [], "bodyType": "none", "body": "" });
        let (st, r) = call(&app, "/api/requests/r1/execute", json!({ "executedBy": "me", "environmentId": "e1", "input": input })).await;
        assert_eq!(st, StatusCode::FORBIDDEN);
        assert_eq!(r["error"], "읽기 전용 환경에서 쓰기 요청이 차단되었습니다.");
        let (st, r) = call(&app, "/api/requests/r1/execute", json!({})).await;
        assert_eq!((st, r["error"].as_str()), (StatusCode::BAD_REQUEST, Some("input required")));
        let (st, r) = call(&app, "/api/requests/r1/execute", json!({ "executedBy": "me", "input": { "method": "GET" } })).await;
        assert_eq!((st, r["error"].as_str()), (StatusCode::BAD_REQUEST, Some(BAD_INPUT)));
        let (st, _) = call(&app, "/api/requests/r1/execute", json!({ "executedBy": "me", "input": input, "overrides": { "headers": {} } })).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        // overrides.vars 로 호스트를 바꾸면 거부
        let input = json!({ "method": "GET", "url": "{{host}}/x", "params": [], "headers": [], "bodyType": "none", "body": "" });
        let (st, r) = call(&app, "/api/requests/r1/execute", json!({ "executedBy": "me", "environmentId": "e2", "input": input, "overrides": { "vars": { "host": "https://evil.example" } } })).await;
        assert_eq!(st, StatusCode::FORBIDDEN);
        assert_eq!(r["error"], "실행 입력으로 URL 호스트·프로토콜·포트·자격증명을 변경할 수 없습니다. 저장된 환경을 선택하세요.");
        // 깨진 JSON 은 500
        let req = Request::post("/api/requests/r1/execute").body(Body::from("{bad")).unwrap();
        assert_eq!(app.clone().oneshot(req).await.unwrap().status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn 쿠키_jar_는_set_cookie_를_저장하고_다음_실행에_싣는다() {
        let (app, db) = app();
        let m = echo().await;
        seed(&db, "INSERT INTO folders (id, workspace_id, name) VALUES ('f1', 'ws', 'f'); INSERT INTO requests (id, folder_id, name, method, url, updated_at) VALUES ('r1', 'f1', 'r', 'GET', 'x', 0);");
        let mk = |p: &str| json!({ "executedBy": "me", "input": { "method": "GET", "url": format!("{}{p}", m.base), "params": [], "headers": [], "bodyType": "none", "body": "" } });
        call(&app, "/api/requests/r1/execute", mk("/cookie")).await;
        let (_, r) = call(&app, "/api/requests/r1/execute", mk("/echo")).await;
        let body: Value = serde_json::from_str(r["responseBody"].as_str().unwrap()).unwrap();
        assert!(body["head"].as_str().unwrap().contains("cookie: sid=s1"));
    }

    #[tokio::test]
    async fn 미리보기는_보내지_않고_마스킹() {
        let (app, db) = app();
        seed(&db, r#"INSERT INTO folders (id, workspace_id, name, shared_auth) VALUES ('f1', 'default', 'f', '{"type":"bearer","token":"FOLDER-TOKEN"}');
            INSERT INTO requests (id, folder_id, name, method, url, auth, updated_at) VALUES ('r1', 'f1', 'r', 'GET', 'x', '{"type":"inherit"}', 0);"#);
        let input = json!({ "method": "GET", "url": "https://x/{{nope}}", "params": [], "headers": [{ "key": "Cookie", "value": "a=1" }], "bodyType": "none", "body": "" });
        let (st, r) = call(&app, "/api/requests/r1/preview", json!({ "input": input })).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(r["missing"], json!(["nope"]));
        assert_eq!(r["authError"], Value::Null);
        let h = &r["preview"]["headers"];
        assert_eq!(h[0]["value"], "***");
        // 폴더에서 상속한 인증 — redacted 의 "Bearer ***" 도 리터럴 자격증명 헤더라 통째로 ***
        assert_eq!(h[1], json!({ "key": "Authorization", "value": "***", "enabled": true }));
        let (st, r) = call(&app, "/api/requests/r1/preview", json!({})).await;
        assert_eq!((st, r["error"].as_str()), (StatusCode::BAD_REQUEST, Some("input required")));
    }

    #[tokio::test]
    async fn adhoc_실행과_인증_오류_모양() {
        let (app, _db) = app();
        let m = echo().await;
        let input = json!({ "method": "GET", "url": format!("{}/a", m.base) });
        let (st, r) = call(&app, "/api/execute", json!({ "input": input, "preSteps": [{ "name": "v", "op": "setValue", "value": "{{gone}}" }] })).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(r["responseStatus"], 200);
        assert_eq!(r["missingVariables"], json!(["gone"]));
        assert_eq!(r["responseHeaders"]["content-type"], "application/json");
        let (_, r) = call(&app, "/api/execute", json!({ "input": input, "auth": { "type": "oauth2cc" } })).await;
        assert_eq!(r, json!({ "responseStatus": null, "responseHeaders": null, "responseBody": null, "durationMs": 0, "error": "OAuth2: 토큰 URL 과 Client ID 가 필요합니다", "missingVariables": [], "extracted": [], "extractMissing": [] }));
        let (st, _) = call(&app, "/api/execute", json!({ "input": input, "environmentId": "nope" })).await;
        assert_eq!(st, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn graphql_스키마_조회() {
        let (app, _db) = app();
        let m = echo().await;
        let (st, r) = call(&app, "/api/graphql/introspect", json!({ "url": format!("{}/gql", m.base), "headers": [{ "key": "X-A", "value": "1", "enabled": true }] })).await;
        assert_eq!(st, StatusCode::OK, "{r}");
        assert_eq!(r["schema"]["queryType"], "Query");
        let sent = m.seen.lock().unwrap()[0].clone();
        assert!(sent.contains("IntrospectionQuery"));
        assert!(split(&sent).0.contains("x-a: 1"));
        let (st, r) = call(&app, "/api/graphql/introspect", json!({ "url": "{{base}}/g" })).await;
        assert_eq!((st, r["error"].as_str()), (StatusCode::BAD_REQUEST, Some("미해석 변수: base")));
        let (st, _) = call(&app, "/api/graphql/introspect", json!({ "url": format!("{}/echo", m.base) })).await;
        assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY);
        let (st, _) = call(&app, "/api/graphql/introspect", json!({})).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        let (st, _) = call(&app, "/api/graphql/introspect", json!({ "url": "http://169.254.169.254/" })).await;
        assert_eq!(st, StatusCode::BAD_GATEWAY);
    }
}
