//! 시나리오 실행·폴더 일괄 실행.
//!
//! 실행 자체(해석·인증·송신·이력)는 단건 실행과 같은 라이브러리(executor·resolve·steps·exec_helpers·execution_policy)를 쓴다.
//! 여기서 하는 일은 스텝 사이로 값을 넘기는 것(추출·prevBody·secret 이름 누적)과 결과를 묶는 것뿐이다.
//!
//! - [`run_flow`] — 스케줄러(crate::scheduler)도 이걸 직접 부른다. Node 는 run 라우트를 내부 호출했고 실행 출처를
//!   AsyncLocalStorage 로 'schedule' 로 바꿨다 — 여기서는 출처를 인자로 받는다. HTTP 로는 출처를 바꿀 수 없다.
//! - 시나리오 스텝은 쿠키 jar 를 쓰지 않는다. 폴더 실행은 이력을 남기지 않는다(정책 거부만 감사 행).
//! - 스텝 응답의 OpenAPI 스키마 검사는 수동 검사와 같은 [`crate::schema_validate::validate_request_response`].


use axum::body::{Body, Bytes};
use axum::extract::{Path, RawQuery, State};
use axum::http::{header, StatusCode};
use axum::response::Response;
use axum::routing::post;
use axum::Router;
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Map, Value};

use super::execute::load_saved;
use crate::assertions::check_response;
use crate::auth_config::sanitize_folder_auth;
use crate::collection_run::{collect_run_inputs, plan_run_rows, to_junit_xml, InputSource, PlanSource, RunRow};
use crate::exec_helpers::{apply_authorization, build_stored_execution, merge_folder_headers};
use crate::execution_overrides::overlay_execution_vars;
use crate::execution_policy::{execution_target_error, guard_execution, insert_execution, is_write_method, parameter_type_error, ExecutionSource, GuardInput};
use crate::executor::{execute_request, ExecResult};
use crate::flow_chain::{apply_extracts, auto_step_vars, overlay_vars, runtime_from_json, runtime_to_json, spread, Runtime};
use crate::json_cols::{safe_json, safe_json_str, to_kv_array, to_object_array};
use crate::jsval::reply;
use crate::records::{parse_execution, parse_request_row, read, select_list, REQUEST_COLS};
use crate::request_auth::resolve_effective_auth;
use crate::resolve::{dynamic_vars, merge_query_params, overlay_kv_vars, resolve_request, Kv, RequestInput, RequestSettings};
use crate::routes::input::{json_error, read_json};
use crate::schema_validate::validate_request_response;
use crate::scrub::{scrub_json, secret_values_of};
use crate::server_log::{self, Level};
use crate::steps::{apply_post_steps, apply_pre_steps, build_exec_vars};
use crate::variables::{load_team_vars, Var, VarMap};
use crate::{js, secretbox, AppState};

pub fn router() -> Router<AppState> {
    Router::new().route("/api/flows/{id}/run", post(flow_run)).route("/api/folders/{id}/run", post(folder_run))
}

fn out(code: StatusCode, v: Value) -> Response {
    reply(code, &v)
}

fn err(code: StatusCode, msg: impl Into<String>) -> Response {
    out(code, json!({ "error": msg.into() }))
}

/// 배열이면 그 원소, 아니면 빈 목록 — 손편집·손상된 값 하나로 실행이 500 나지 않게(`Array.isArray(x) ? x : []`).
fn arr(v: Option<&Value>) -> Vec<Value> {
    v.and_then(Value::as_array).cloned().unwrap_or_default()
}

fn kvs(v: Option<&Value>) -> Vec<Kv> {
    arr(v).iter().map(Kv::from_json).collect()
}

/// 스텝 오버라이드의 KV — 정규화를 안 거친 클라이언트 값이라 enabled 는 JS 처럼 참 같은 값일 때만 켠다.
fn raw_kvs(v: &[Value]) -> Vec<Kv> {
    v.iter()
        .filter_map(|x| {
            let mut kv = Kv::from_raw(x)?;
            kv.description = x.get("description").and_then(Value::as_str).map(str::to_string);
            Some(kv)
        })
        .collect()
}

/// `b.x ?? null` 을 문자열로 — 환경 id.
fn opt_string(v: Option<&Value>) -> Option<String> {
    match v {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(o) => Some(js::to_string(o)),
    }
}

fn header_value<'a>(h: Option<&'a [(String, String)]>, name: &str) -> Option<&'a str> {
    h?.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
}

// ── 시나리오 실행 ─────────────────────────────────────────────────────────

/// 스텝 하나에 같이 넘기는 실행 문맥.
struct FlowCtx<'a> {
    s: &'a AppState,
    env_vars: &'a VarMap,
    baseline_env_vars: &'a VarMap,
    /// `baselineEnvVars === envVars` — 실행 입력 vars 가 없으면 기준선 해석을 따로 하지 않는다.
    same_baseline: bool,
    executed_by: &'a str,
    environment_id: Option<&'a str>,
    source: ExecutionSource,
}

struct StepOutcome {
    result: Value,
    runtime: Runtime,
    /// secret 으로 추출된 런타임 변수 이름 — 다음 스텝의 redacted 마스킹을 위해 누적한다.
    secret_names: Vec<String>,
    failed: bool,
}

fn push_unique(v: &mut Vec<String>, name: &str) {
    if !v.iter().any(|x| x == name) {
        v.push(name.to_string());
    }
}

/// 이전 스텝에서 secret 으로 추출된 이름은 secret:true 로 복원 — redacted 이력에 평문이 안 남게.
fn restore_secrets(mut vars: VarMap, secret_names: &[String]) -> VarMap {
    for n in secret_names {
        if let Some(v) = vars.get(n).cloned() {
            vars.insert(n, Var { value: v.value, secret: true });
        }
    }
    vars
}

fn denied_result(row_id: &str, name: &Value, denied: Value) -> Value {
    let mut m = Map::new();
    m.insert("requestId".into(), json!(row_id));
    m.insert("name".into(), name.clone());
    let error = denied.get("error").cloned().filter(|e| !e.is_null());
    m.insert("execution".into(), denied);
    if let Some(e) = error {
        m.insert("error".into(), e);
    }
    Value::Object(m)
}

/// 단일 스텝 실행 — 실행/이력/추출/자동변수/로그수집을 한 번에. 자동·단계 실행이 공유한다.
async fn run_one_step(ctx: &FlowCtx<'_>, step: Option<&Value>, step_no: &str, runtime: Runtime, secret_names: Vec<String>) -> anyhow::Result<StepOutcome> {
    let fail = |result: Value, runtime: Runtime, secret_names: Vec<String>| Ok(StepOutcome { result, runtime, secret_names, failed: true });
    // 손상 스텝(요청 ID 누락/비문자열)이 DB 바인딩 오류로 실행을 500 내지 않게.
    let Some(step) = step.filter(|s| s.is_object()) else {
        return fail(json!({ "requestId": "", "error": "유효하지 않은 스텝(요청 ID 없음)" }), runtime, secret_names);
    };
    let Some(request_id) = step.get("requestId").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string) else {
        return fail(json!({ "requestId": "", "error": "유효하지 않은 스텝(요청 ID 없음)" }), runtime, secret_names);
    };
    let (saved, denied) = {
        let (id, env, by, source) = (request_id.clone(), ctx.environment_id.map(str::to_string), ctx.executed_by.to_string(), ctx.source);
        ctx.s
            .db
            .run(move |c| {
                let saved = load_saved(c, &id)?;
                let Some(row) = saved.parsed_row.as_ref() else { return Ok((saved, None)) };
                let method = js::to_string(&row["method"]);
                let denied = guard_execution(
                    c,
                    &GuardInput {
                        request_id: Some(&id),
                        method: &method,
                        environment_id: env.as_deref(),
                        workspace_id: &saved.workspace_id,
                        validation_error: None,
                        executed_by: &by,
                        source,
                        ai_execution_allowed: saved.ai_allowed,
                        confirmed: false,
                    },
                )?;
                Ok((saved, denied))
            })
            .await?
    };
    let Some(parsed) = saved.parsed_row.as_ref() else {
        return fail(json!({ "requestId": request_id, "error": "요청이 삭제되었습니다" }), runtime, secret_names);
    };
    let row_id = js::to_string(&parsed["id"]);
    let row_name = parsed.get("name").cloned().unwrap_or(Value::Null);
    if let Some(d) = denied {
        return fail(denied_result(&row_id, &row_name, d), runtime, secret_names);
    }

    // 바디 소스: template(기본)=저장 바디, prev=직전 응답 통짜({{prevBody}}), custom=직접 작성(변수 참조 가능).
    // prev/custom 인데 템플릿 bodyType 이 none 이면 json 으로(체인 바디는 대개 JSON) — 아니면 안 실린다.
    let mut body = js::to_string(parsed.get("body").unwrap_or(&Value::String(String::new())));
    let mut body_type = parsed.get("bodyType").and_then(Value::as_str).unwrap_or("none").to_string();
    match step.get("bodySource").and_then(Value::as_str) {
        Some("prev") => {
            // 직전 응답이 없으면(첫 스텝 등) 리터럴 '{{prevBody}}' 를 보내지 않고 빈 바디로.
            let has_prev = runtime.get("prevBody").and_then(Value::as_str).map_or(false, |s| !s.is_empty());
            body = if has_prev { "{{prevBody}}".into() } else { String::new() };
            if has_prev && body_type == "none" {
                body_type = "json".into();
            }
        }
        Some("custom") => {
            body = step.get("bodyOverride").and_then(Value::as_str).unwrap_or("").to_string();
            if !body.is_empty() && body_type == "none" {
                body_type = "json".into();
            }
        }
        _ => {}
    }
    // 스텝 오버라이드(params/headers/url)가 있으면 템플릿 대신 그것을 쓴다 — 단계마다 다른 값으로 보내기 위함.
    let params = match step.get("params").and_then(Value::as_array) {
        Some(p) => raw_kvs(p),
        None => kvs(parsed.get("params")),
    };
    let headers = match step.get("headers").and_then(Value::as_array) {
        Some(h) => raw_kvs(h),
        None => kvs(parsed.get("headers")),
    };
    let url = match step.get("url").and_then(Value::as_str) {
        Some(u) if !js::trim(u).is_empty() => u.to_string(),
        _ => js::to_string(parsed.get("url").unwrap_or(&Value::String(String::new()))),
    };
    let input = RequestInput {
        method: js::to_string(&parsed["method"]),
        url,
        params,
        headers: merge_folder_headers(&headers, &saved.shared_headers),
        body_type,
        body,
    };

    // 스코프: envVars(전역+환경+공유) < 요청별 변수 < 런타임(추출/prevBody) < 스텝 전용 입력 < 동적 < pre-step.
    // 스텝 전용 입력값은 이 단계에서만 최우선 — 다음 단계로 전파하지 않는다(nextRuntime 미포함).
    let req_vars = arr(parsed.get("vars"));
    let step_vars = arr(step.get("vars"));
    let pre_steps = arr(parsed.get("preSteps"));
    let dynamic = dynamic_vars();
    let scope = |env: &VarMap| {
        let overlay = restore_secrets(overlay_vars(&overlay_kv_vars(env, &req_vars), &runtime), &secret_names);
        let mut v = overlay_kv_vars(&overlay, &step_vars);
        v.spread(&dynamic);
        apply_pre_steps(&v, &pre_steps, None)
    };
    let vars = scope(ctx.env_vars);
    let baseline_vars = if ctx.same_baseline { vars.clone() } else { scope(ctx.baseline_env_vars) };
    let baseline = resolve_request(&input, &baseline_vars);
    let resolved = resolve_request(&input, &vars);
    let (mut real, mut redacted, missing) = (resolved.real, resolved.redacted, resolved.missing);
    // 실행 입력 vars 는 헤더·자격증명에 닿지 않는다 — 헤더는 기준선 해석의 것으로 되돌린다.
    real.headers = baseline.real.headers.clone();
    redacted.headers = baseline.redacted.headers.clone();
    let validation_error = execution_target_error(&baseline.real.url, &real.url)
        .or_else(|| if ctx.source == ExecutionSource::Mcp { parameter_type_error(parsed.get("specContract").filter(|v| !v.is_null()), &real) } else { None });
    if let Some(validation_error) = validation_error {
        let (id, env, by, source, ws, method) =
            (row_id.clone(), ctx.environment_id.map(str::to_string), ctx.executed_by.to_string(), ctx.source, saved.workspace_id.clone(), real.method.clone());
        let denied = ctx
            .s
            .db
            .run(move |c| {
                Ok(guard_execution(
                    c,
                    &GuardInput {
                        request_id: Some(&id),
                        method: &method,
                        environment_id: env.as_deref(),
                        workspace_id: &ws,
                        validation_error: Some(validation_error),
                        executed_by: &by,
                        source,
                        ai_execution_allowed: false,
                        confirmed: false,
                    },
                )?)
            })
            .await?
            .unwrap_or(Value::Null);
        return fail(denied_result(&row_id, &row_name, denied), runtime, secret_names);
    }

    // 인증 — 요청 auth(inherit 이면 폴더 sharedAuth)로 Authorization 주입. 단건 실행과 같은 규칙.
    let auth = resolve_effective_auth(parsed.get("auth"), Some(&saved.folder_auth));
    let auth_error = apply_authorization(&auth, &baseline_vars, &mut real, Some(&mut redacted)).await;

    let started_at = js::now_ms();
    let mut result = match auth_error {
        Some(e) => ExecResult { duration_ms: 0, error: Some(e), ..Default::default() },
        None => execute_request(&real, &RequestSettings::from_json(parsed.get("settings"))).await,
    };
    // 계약 불일치는 기존 실패·이력·알림 경로를 그대로 탄다.
    let content_type = header_value(result.headers.as_deref(), "content-type");
    match validate_request_response(ctx.s, &row_id, result.error.as_deref(), result.status, result.body.as_deref(), content_type).await {
        Ok(spec) if !spec.ok => {
            let list: Vec<String> = spec
                .issues
                .iter()
                .map(|i| {
                    let path = i.get("path").map(js::to_string).filter(|p| !p.is_empty() && p != "null").unwrap_or_else(|| "$".into());
                    format!("{path}: {}", i.get("message").map(js::to_string).unwrap_or_default())
                })
                .collect();
            result.error = Some(format!("스펙 불일치 — {}. 응답과 OpenAPI 정의를 확인하세요.", list.join("; ")));
        }
        Ok(_) => {}
        Err(e) => result.error = Some(format!("스펙 검사 실패 — {}. 스펙 연결을 확인하고 다시 실행하세요.", e.message())),
    }
    let mut secret_vals = secret_values_of(&baseline_vars);
    secret_vals.extend(secret_values_of(&vars));
    let stored = build_stored_execution(&redacted, &result, &secret_vals);
    let (check_passed, assertion_results) = check_response(&arr(parsed.get("assertions")), &result);
    let row_json = json!({
        "id": uuid::Uuid::new_v4().to_string(), "requestId": row_id, "executedBy": ctx.executed_by,
        "executedAt": started_at, "environmentId": ctx.environment_id,
        "executionSource": ctx.source.as_str(), "denialReason": null,
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
        let r = exec_row.clone();
        ctx.s.db.run(move |c| Ok(insert_execution(c, &r)?)).await?;
    }

    let extract_rules = arr(step.get("extracts"));
    let ex = apply_extracts(result.body.as_deref(), &extract_rules);
    // 요청 템플릿의 post-step 추출(헤더/JSON)도 다음 스텝 변수로 — 시나리오 추출 규칙과 공존.
    let post = apply_post_steps(result.body.as_deref(), result.headers.as_deref(), &arr(parsed.get("postSteps")));
    let mut next_runtime = runtime;
    spread(&mut next_runtime, &auto_step_vars(step_no, result.body.as_deref(), result.status));
    spread(&mut next_runtime, &ex.extracted);
    let mut next_secret = secret_names;
    for v in &post.extracted {
        let name = js::to_string(&v["name"]);
        next_runtime.insert(name.clone(), Value::String(js::to_string(&v["value"])));
        if js::truthy(v.get("secret")) {
            push_unique(&mut next_secret, &name);
        }
    }
    // 시나리오 추출 규칙에도 같은 규칙 — 다음 스텝에서 secret 으로 복원되면 값 기준 스크럽이 URL·바디까지 덮는다.
    for r in &extract_rules {
        if js::truthy(r.get("secret")) && js::truthy(r.get("variable")) {
            let name = js::to_string(&r["variable"]);
            if ex.extracted.contains_key(&name) {
                push_unique(&mut next_secret, &name);
            }
        }
    }

    let failed = !check_passed;
    exec_row.insert("pinned".into(), Value::Bool(false));
    let mut m = Map::new();
    m.insert("requestId".into(), json!(row_id));
    m.insert("name".into(), row_name);
    m.insert("execution".into(), parse_execution(exec_row));
    if failed {
        let e = result.error.clone().unwrap_or_else(|| {
            if assertion_results.iter().any(|a| a.get("pass") != Some(&Value::Bool(true))) {
                "응답 확인 조건 불일치".into()
            } else {
                format!("HTTP {}", result.status.map_or("응답 없음".to_string(), |s| s.to_string()))
            }
        });
        m.insert("error".into(), json!(e));
    }
    m.insert("extracted".into(), Value::Object(ex.extracted));
    m.insert("extractMissing".into(), json!(ex.missing));
    Ok(StepOutcome { result: Value::Object(m), runtime: next_runtime, secret_names: next_secret, failed })
}

struct FlowRow {
    workspace_id: String,
    name: String,
    steps: Option<String>,
    shared_vars: Option<String>,
}

/// `executionVarsSchema.safeParse(b.vars ?? {})` — 문자열 값만 든 객체(배열·null 은 아님).
fn parse_exec_vars(v: Option<&Value>) -> Option<Vec<(String, String)>> {
    match v {
        None | Some(Value::Null) => Some(vec![]),
        Some(Value::Object(o)) => js::object_keys(o).into_iter().map(|k| Some((k.clone(), o[k.as_str()].as_str()?.to_string()))).collect(),
        _ => None,
    }
}

/// 시나리오 공유 변수 — 환경 위에 오버레이(공유 입력이 환경 기본값을 이긴다). 빈 값은 무시한다:
/// '+ 변수'로 만든 빈 행이 동명 환경변수(secret 포함)를 빈 문자열로 덮어써 전 스텝이 조용히 깨지는 것을 막는다.
/// secret 은 DB 에 암호문으로 있으므로 실행 직전에만 푼다(이력·cURL 에서는 {{이름}} 으로 가려진다).
fn shared_var_map(raw: Option<&str>) -> VarMap {
    let mut out = VarMap::new();
    for sv in to_object_array(safe_json_str(raw).as_ref()) {
        let value = match sv.get("value") {
            Some(Value::String(s)) => s.clone(),
            None | Some(Value::Null) => String::new(),
            Some(o) => js::to_string(o),
        };
        let secret = js::truthy(sv.get("secret"));
        let val = if secret { secretbox::decrypt_secret(&value) } else { value };
        if let Some(key) = sv.get("key").and_then(Value::as_str).filter(|k| !k.is_empty()) {
            if !val.is_empty() {
                out.insert(key, Var { value: val, secret });
            }
        }
    }
    out
}

fn str_at<'a>(v: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut cur = v;
    for p in path {
        cur = cur.get(*p)?;
    }
    Some(cur).filter(|x| !x.is_null())
}

/// 시나리오 실행.
/// - 자동 모드(기본): 스텝을 순서대로 전부 실행, 실패(전송 에러/검증 실패) 시 중단.
/// - 단계 모드: body 에 { stepIndex, runtime } 을 주면 그 스텝 하나만 실행하고 갱신된 runtime 을 돌려준다(서버 무상태).
///
pub(crate) async fn run_flow(s: &AppState, id: &str, b: &Value, source: ExecutionSource) -> anyhow::Result<(StatusCode, Value)> {
    let Some(exec_vars) = parse_exec_vars(b.get("vars")) else {
        return Ok((StatusCode::BAD_REQUEST, json!({ "error": "vars 는 문자열 값의 객체여야 합니다" })));
    };
    let env_id = opt_string(b.get("environmentId"));
    let flow = {
        let id = id.to_string();
        s.db
            .run(move |c| {
                Ok(c.prepare_cached(r#"select "workspace_id", "name", "steps", "shared_vars" from "flows" where "flows"."id" = ?"#)?
                    .query_row([&id], |r| {
                        Ok(FlowRow { workspace_id: crate::rows::text(r, 0)?, name: crate::rows::text(r, 1)?, steps: r.get(2)?, shared_vars: r.get(3)? })
                    })
                    .optional()?)
            })
            .await?
    };
    let Some(flow) = flow else { return Ok((StatusCode::NOT_FOUND, json!({ "error": "flow not found" }))) };
    // 손상 steps 컬럼(수동 DB편집/PUT null)이 실행을 500 내지 않게 방어 파싱.
    let steps = to_object_array(safe_json_str(flow.steps.as_deref()).as_ref());
    if steps.is_empty() {
        return Ok((StatusCode::BAD_REQUEST, json!({ "error": "스텝이 없습니다" })));
    }
    let shared = shared_var_map(flow.shared_vars.as_deref());
    let mut baseline_env = {
        let (ws, env) = (flow.workspace_id.clone(), env_id.clone());
        s.db.run(move |c| load_team_vars(c, &ws, env.as_deref())).await?
    };
    baseline_env.spread(&shared);
    let same_baseline = exec_vars.is_empty();
    let env_vars = if same_baseline { baseline_env.clone() } else { overlay_execution_vars(&baseline_env, Some(&exec_vars)) };
    // 외부 API 호출자가 전달한 실행자 메타데이터는 호환을 위해 보존한다.
    let executed_by = b
        .get("executedBy")
        .filter(|v| js::truthy(Some(v)))
        .map(js::to_string)
        .unwrap_or_default();
    let ctx = FlowCtx {
        s,
        env_vars: &env_vars,
        baseline_env_vars: &baseline_env,
        same_baseline,
        executed_by: &executed_by,
        environment_id: env_id.as_deref(),
        source,
    };

    // 단계 실행 모드 — 요청된 스텝 하나만. stepIndex 는 클라이언트 값이라 JS 의 비교·인덱싱 규칙을 따른다.
    if let Some(si) = b.get("stepIndex") {
        let n = match si {
            Value::Number(x) => x.as_f64().unwrap_or(f64::NAN),
            Value::String(t) => js::number(t),
            Value::Bool(t) => f64::from(u8::from(*t)),
            Value::Null => 0.0,
            _ => f64::NAN,
        };
        if n < 0.0 || n >= steps.len() as f64 {
            return Ok((StatusCode::BAD_REQUEST, json!({ "error": format!("stepIndex 범위 밖 (0~{})", steps.len() - 1) })));
        }
        // steps[b.stepIndex] — 정수(또는 정수 모양 문자열)만 칸을 찾는다. 그 밖은 undefined → 유효하지 않은 스텝.
        let index = match si {
            Value::Number(_) if n.fract() == 0.0 => Some(n as usize),
            Value::String(t) if js::is_index_key(t) => Some(n as usize),
            _ => None,
        };
        let has_next = match si {
            Value::String(t) => js::number(&format!("{t}1")) < steps.len() as f64,
            _ => n + 1.0 < steps.len() as f64,
        };
        let secret_names: Vec<String> = arr(b.get("secretNames")).iter().map(js::to_string).fold(Vec::new(), |mut acc, n| {
            push_unique(&mut acc, &n);
            acc
        });
        // `${b.stepIndex + 1}` — 문자열이면 이어 붙이고("0"+1 = "01"), 숫자·불리언·null 은 더한다.
        let step_no = match si {
            Value::String(t) => format!("{t}1"),
            Value::Number(_) | Value::Bool(_) | Value::Null => js::number_to_string(n + 1.0),
            other => format!("{}1", js::to_string(other)),
        };
        let out = run_one_step(&ctx, index.and_then(|i| steps.get(i)), &step_no, runtime_from_json(b.get("runtime")), secret_names).await?;
        return Ok((
            StatusCode::OK,
            json!({
                "flowId": id, "name": flow.name,
                "step": out.result, "stepIndex": si,
                "failed": out.failed,
                "hasNext": has_next,
                "runtimeVariables": runtime_to_json(&out.runtime),
                "secretNames": out.secret_names,
            }),
        ));
    }

    // 자동 모드 — 전부 순차 실행
    let started_at = js::now_ms();
    let mut runtime = Runtime::new();
    let mut secret_names: Vec<String> = Vec::new();
    let mut results: Vec<Value> = Vec::new();
    let mut stopped: Option<usize> = None;
    for (i, step) in steps.iter().enumerate() {
        let out = run_one_step(&ctx, Some(step), &(i + 1).to_string(), runtime, secret_names).await?;
        results.push(out.result);
        runtime = out.runtime;
        secret_names = out.secret_names;
        if out.failed {
            stopped = Some(i);
            break;
        }
    }

    // 실행 묶음을 한 행으로 — 나중에 "언제 어느 스텝에서 멈췄나"를 바로 볼 수 있게. 기록 실패가 결과 반환을 막지 않는다.
    let summary: Vec<Value> = results
        .iter()
        .map(|r| {
            let ex = r.get("execution");
            json!({
                "name": r.get("name").cloned().filter(|v| !v.is_null()),
                "method": ex.and_then(|e| str_at(e, &["resolved", "method"])).cloned(),
                "url": ex.and_then(|e| str_at(e, &["resolved", "url"])).cloned(),
                "status": ex.and_then(|e| str_at(e, &["responseStatus"])).cloned(),
                "ms": ex.and_then(|e| str_at(e, &["durationMs"])).cloned(),
                "error": r.get("error").filter(|v| !v.is_null()).or_else(|| ex.and_then(|e| str_at(e, &["error"]))).cloned(),
                // 없으면 화면이 HTTP 코드로만 판정해 '404 를 기대한' 통과 스텝을 빨갛게 그렸다
                "checkPassed": ex.and_then(|e| str_at(e, &["checkPassed"])).cloned(),
                "executionId": ex.and_then(|e| str_at(e, &["id"])).cloned(),
            })
        })
        .collect();
    {
        let (fid, ws, env, by, steps_json) = (id.to_string(), flow.workspace_id.clone(), env_id.clone(), executed_by.clone(), js::stringify(&Value::Array(summary)));
        let duration = js::now_ms() - started_at;
        let stopped_at = stopped.map(|x| x as i64);
        let saved = s
            .db
            .run(move |c| {
                c.prepare_cached(
                    r#"insert into "flow_runs" ("id", "flow_id", "workspace_id", "environment_id", "executed_by", "started_at", "duration_ms", "stopped_at", "steps") values (?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
                )?
                .execute(rusqlite::params![uuid::Uuid::new_v4().to_string(), fid, ws, env, by, started_at, duration, stopped_at, steps_json])?;
                Ok(())
            })
            .await;
        if let Err(e) = saved {
            eprintln!("[flowRuns] 실행 기록 저장 실패 — {e}");
            server_log::log(Level::Warn, "시나리오 실행 기록", "기록 저장 실패(실행 자체는 완료)", Some(&e.to_string()), None);
        }
    }
    let lines: Vec<String> = results
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let ex = r.get("execution");
            let field = |p: &[&str]| ex.and_then(|e| str_at(e, p)).map(js::to_string).unwrap_or_default();
            let outcome = r
                .get("error")
                .filter(|v| !v.is_null())
                .or_else(|| ex.and_then(|e| str_at(e, &["responseStatus"])))
                .map_or_else(|| "?".to_string(), js::to_string);
            let ms = ex.and_then(|e| str_at(e, &["durationMs"])).map_or(String::new(), |m| format!(" ({}ms)", js::to_string(m)));
            let body = ex
                .and_then(|e| e.get("responseBody"))
                .and_then(Value::as_str)
                .filter(|b| !b.is_empty())
                .map_or(String::new(), |b| format!("\n   응답: {}", js::slice16(b, 300)));
            let name = r.get("name").filter(|v| !v.is_null()).map(js::to_string).unwrap_or_default();
            format!("{}. {name} {} {}\n   → {outcome}{ms}{body}", i + 1, field(&["resolved", "method"]), field(&["resolved", "url"]))
        })
        .collect();
    let message = match stopped {
        None => format!("{}스텝 전부 성공 ({}ms)", results.len(), js::now_ms() - started_at),
        Some(at) => {
            let r = &results[at];
            let why = r
                .get("error")
                .filter(|v| !v.is_null())
                .or_else(|| r.get("execution").and_then(|e| str_at(e, &["error"])))
                .map_or_else(|| "응답 오류".to_string(), js::to_string);
            format!("{}번째 스텝에서 중단 — {why}", at + 1)
        }
    };
    server_log::log(
        if stopped.is_none() { Level::Info } else { Level::Error },
        &format!("시나리오 실행 · {}", flow.name),
        &message,
        Some(&lines.join("\n")),
        Some(&format!("?flow={id}")),
    );

    Ok((
        StatusCode::OK,
        json!({
            "flowId": id, "name": flow.name,
            "steps": results,
            "stoppedAt": stopped,
            "runtimeVariables": runtime_to_json(&runtime),
            "secretNames": secret_names,
        }),
    ))
}

async fn flow_run(State(s): State<AppState>, Path(id): Path<String>, body: Bytes) -> Response {
    // `await req.json().catch(() => ({}))` — 깨진 본문은 빈 객체. 원시값은 프로퍼티가 없다.
    let parsed = read_json(&body);
    // 본문이 JSON `null` 이면 Node 는 `b.vars` 를 읽다 TypeError(500)로 멈췄다 — 실행하지 않는다.
    // 예전엔 빈 객체로 바꿔 실제로 실행해 버렸다(대상 API 호출·이력 기록, codex 최종 대조).
    if parsed == Some(Value::Null) {
        return json_error("시나리오 실행 중 서버 오류", "Cannot read properties of null (reading 'vars')");
    }
    let b = parsed.filter(Value::is_object).unwrap_or_else(|| json!({}));
    match run_flow(&s, &id, &b, ExecutionSource::Flow).await {
        Ok((code, v)) => out(code, v),
        Err(e) => json_error("시나리오 실행 중 서버 오류", &e.to_string()),
    }
}

// ── 폴더 일괄 실행 ────────────────────────────────────────────────────────

struct Prepared {
    parsed: Map<String, Value>,
    input: RequestInput,
    vars: VarMap,
}

struct FolderRun {
    s: AppState,
    folder_name: String,
    workspace_id: String,
    environment_id: Option<String>,
    personal_vars: Option<Value>,
    folder_auth: Value,
    prepared: Vec<Prepared>,
    initial: Vec<RunRow>,
    plan: Map<String, Value>,
}

fn bad_input() -> Response {
    err(StatusCode::BAD_REQUEST, "실행 입력 형식이 올바르지 않습니다. 환경과 공통 입력값을 확인하세요.")
}

/// 입력 검사 → 폴더·환경·요청을 읽고 실행 계획까지. 미리보기면 계획만 돌려준다.
fn prepare_folder(c: &Connection, id: &str, b: &Value) -> anyhow::Result<Result<(FolderRunData, Map<String, Value>), Response>> {
    let folder = c
        .prepare_cached(r#"select "workspace_id", "name", "shared_headers", "shared_auth" from "folders" where "folders"."id" = ?"#)?
        .query_row([id], |r| Ok((crate::rows::text(r, 0)?, crate::rows::text(r, 1)?, r.get::<_, Option<String>>(2)?, r.get::<_, Option<String>>(3)?)))
        .optional()?;
    let Some((ws, folder_name, sh, sa)) = folder else { return Ok(Err(err(StatusCode::NOT_FOUND, "folder not found"))) };
    let env_id = b.get("environmentId").and_then(Value::as_str).map(str::to_string);
    let env: Option<(String, String)> = match env_id.as_deref().filter(|e| !e.is_empty()) {
        Some(e) => c
            .prepare_cached(r#"select "workspace_id", "execution_policy" from "environments" where "environments"."id" = ?"#)?
            .query_row([e], |r| Ok((crate::rows::text(r, 0)?, crate::rows::text(r, 1)?)))
            .optional()?,
        None => None,
    };
    if env_id.as_deref().map_or(false, |e| !e.is_empty()) && env.as_ref().map_or(true, |(w, _)| w != &ws) {
        return Ok(Err(err(StatusCode::BAD_REQUEST, "환경이 없거나 다른 프로젝트의 환경입니다. 환경을 다시 선택하세요.")));
    }
    let sql = format!(r#"SELECT {} FROM "requests" WHERE "requests"."folder_id" = ?1"#, select_list("requests", REQUEST_COLS));
    let mut rows: Vec<Map<String, Value>> = c.prepare_cached(&sql)?.query_map([id], |r| read(r, REQUEST_COLS, 0))?.collect::<Result<_, _>>()?;
    let so = |r: &Map<String, Value>| r.get("sortOrder").and_then(Value::as_f64).unwrap_or(0.0);
    rows.sort_by(|a, b| {
        so(a).partial_cmp(&so(b)).unwrap_or(std::cmp::Ordering::Equal).then_with(|| js::to_string(&a["id"]).cmp(&js::to_string(&b["id"])))
    });
    let team = load_team_vars(c, &ws, env_id.as_deref())?;
    let shared_headers: Vec<Kv> = to_kv_array(safe_json_str(sh.as_deref()).as_ref()).iter().map(Kv::from_json).collect();
    let folder_auth = secretbox::decrypt_auth_config(&sanitize_folder_auth(safe_json(sa.map(Value::String).as_ref()).as_ref()));
    let prepared: Vec<Prepared> = rows
        .iter()
        .map(|row| {
            let parsed = parse_request_row(row);
            let input = RequestInput {
                method: js::to_string(&parsed["method"]),
                url: js::to_string(&parsed["url"]),
                params: kvs(parsed.get("params")),
                headers: merge_folder_headers(&kvs(parsed.get("headers")), &shared_headers),
                body_type: parsed.get("bodyType").and_then(Value::as_str).unwrap_or("none").to_string(),
                body: parsed.get("body").and_then(Value::as_str).unwrap_or("").to_string(),
            };
            let vars = overlay_kv_vars(&team, &arr(parsed.get("vars")));
            Prepared { parsed, input, vars }
        })
        .collect();
    let sources: Vec<(String, String, String, bool)> = rows
        .iter()
        .map(|r| (js::to_string(&r["id"]), js::to_string(&r["name"]), js::to_string(&r["method"]), js::truthy(r.get("aiExecutionAllowed"))))
        .collect();
    let plan_src: Vec<PlanSource> = sources.iter().map(|(id, name, method, ai)| PlanSource { id, name, method, ai_execution_allowed: *ai }).collect();
    let initial = plan_run_rows(&plan_src, env.as_ref().map(|(_, p)| p.as_str()), b.get("includeWrites") == Some(&Value::Bool(true)), ExecutionSource::Flow);
    let write_count = sources.iter().filter(|(_, _, m, _)| is_write_method(m)).count();
    // 입력 수집은 인증 설정·pre-step 안의 {{참조}} 까지 본다 — 바디 뒤에 붙여 한 번에 훑는다.
    let scan_inputs: Vec<(RequestInput, Vec<String>)> = prepared
        .iter()
        .map(|p| {
            let auth = resolve_effective_auth(p.parsed.get("auth"), Some(&folder_auth));
            let pre = Value::Array(arr(p.parsed.get("preSteps")));
            let mut input = p.input.clone();
            input.body = format!("{}\n{}\n{}", input.body, js::stringify(&auth), js::stringify(&pre));
            let generated = arr(p.parsed.get("preSteps")).iter().map(|s| s.get("name").map(js::to_string).unwrap_or_else(|| "undefined".into())).collect();
            (input, generated)
        })
        .collect();
    let items: Vec<InputSource> = scan_inputs.iter().zip(&prepared).map(|((input, generated), p)| InputSource { input, vars: &p.vars, generated }).collect();
    let inputs = collect_run_inputs(&items, &team);
    let mut plan = Map::new();
    plan.insert("rows".into(), Value::Array(initial.iter().map(RunRow::to_json).collect()));
    plan.insert("writeCount".into(), json!(write_count));
    plan.insert("inputs".into(), Value::Array(inputs));
    Ok(Ok((FolderRunData { folder_name, workspace_id: ws, folder_auth, prepared, initial }, plan)))
}

struct FolderRunData {
    folder_name: String,
    workspace_id: String,
    folder_auth: Value,
    prepared: Vec<Prepared>,
    initial: Vec<RunRow>,
}

impl FolderRun {
    /// 행을 순서대로 실행한다. emit 이 false 를 돌려주면(스트림을 받던 쪽이 끊겼다) 남은 행은 실행하지 않는다.
    async fn perform(self, mut emit: impl FnMut(Value) -> bool) -> anyhow::Result<(Value, String)> {
        let mut results: Vec<RunRow> = Vec::new();
        let mut start = Map::new();
        start.insert("type".into(), json!("start"));
        for (k, v) in &self.plan {
            start.insert(k.clone(), v.clone());
        }
        let mut alive = emit(Value::Object(start));
        for (p, base) in self.prepared.iter().zip(&self.initial) {
            if !alive {
                break;
            }
            let guard = |row_id: String, method: String, ai: bool| {
                let (env, ws) = (self.environment_id.clone(), self.workspace_id.clone());
                self.s.db.run(move |c| {
                    Ok(guard_execution(
                        c,
                        &GuardInput {
                            request_id: Some(&row_id),
                            method: &method,
                            environment_id: env.as_deref(),
                            workspace_id: &ws,
                            validation_error: None,
                            executed_by: "폴더 실행",
                            source: ExecutionSource::Flow,
                            ai_execution_allowed: ai,
                            confirmed: false,
                        },
                    )?)
                })
            };
            let row_id = js::to_string(&p.parsed["id"]);
            let row_method = js::to_string(&p.parsed["method"]);
            let ai = js::truthy(p.parsed.get("aiExecutionAllowed"));
            if base.state == "skipped" {
                // 정책 거부만 감사 행을 남긴다 — 쓰기 제외는 응답에만.
                if base.denial_reason.is_some() {
                    guard(row_id, row_method, ai).await?;
                }
                results.push(base.clone());
                alive = emit(json!({ "type": "result", "row": base.to_json() }));
                continue;
            }
            alive = emit(json!({ "type": "running", "requestId": row_id }));
            let denied = guard(row_id, row_method, ai).await?;
            let outcome = if let Some(d) = denied {
                let e = d.get("error").and_then(Value::as_str).map(str::to_string);
                RunRow { state: "skipped".into(), error: e.clone(), denial_reason: e, ..base.clone() }
            } else {
                let vars = build_exec_vars(&p.vars, self.personal_vars.as_ref(), &arr(p.parsed.get("preSteps")), None);
                let resolved = resolve_request(&p.input, &vars);
                let mut real = resolved.real;
                let auth = resolve_effective_auth(p.parsed.get("auth"), Some(&self.folder_auth));
                let auth_error = apply_authorization(&auth, &vars, &mut real, None).await;
                let result = match auth_error {
                    Some(e) => ExecResult { duration_ms: 0, error: Some(e), ..Default::default() },
                    None => execute_request(&real, &RequestSettings::from_json(p.parsed.get("settings"))).await,
                };
                let (check_passed, assertion_results) = check_response(&arr(p.parsed.get("assertions")), &result);
                let url = match url::Url::parse(&real.url) {
                    Ok(mut u) => {
                        merge_query_params(&mut u, &real.params);
                        u.to_string()
                    }
                    Err(_) => real.url.clone(),
                };
                let passed = assertion_results.iter().filter(|a| a.get("pass") == Some(&Value::Bool(true))).count();
                let error = result.error.clone().or_else(|| {
                    if check_passed {
                        None
                    } else if passed < assertion_results.len() {
                        Some("검증 조건 불일치 — 아래 검증 결과와 기대값을 확인하세요.".into())
                    } else {
                        Some(format!("HTTP {} — 응답 본문과 요청 입력을 확인하세요.", result.status.map_or("undefined".to_string(), |s| s.to_string())))
                    }
                });
                RunRow {
                    state: if check_passed { "passed" } else { "failed" }.into(),
                    status: result.status,
                    duration_ms: Some(result.duration_ms),
                    error,
                    url: Some(url),
                    response_body: result.body.as_deref().map(|b| js::slice16(b, 8000)),
                    missing_variables: resolved.missing,
                    passed,
                    total: assertion_results.len(),
                    results: Some(assertion_results),
                    ok: check_passed,
                    ..base.clone()
                }
            };
            alive = emit(json!({ "type": "result", "row": outcome.to_json() })) && alive;
            results.push(outcome);
        }
        let summary = json!({
            "total": results.len(),
            "passed": results.iter().filter(|r| r.ok).count(),
            "failed": results.iter().filter(|r| r.state == "failed" || r.denial_reason.as_deref().map_or(false, |d| !d.is_empty())).count(),
            "skipped": results.iter().filter(|r| r.state == "skipped").count(),
        });
        let junit = to_junit_xml(&self.folder_name, &results);
        let result = json!({ "folderName": self.folder_name, "summary": summary, "results": results.iter().map(RunRow::to_json).collect::<Vec<_>>(), "junit": junit });
        let mut done = Map::new();
        done.insert("type".into(), json!("done"));
        for (k, v) in result.as_object().unwrap() {
            done.insert(k.clone(), v.clone());
        }
        emit(Value::Object(done));
        Ok((result, junit))
    }
}

/// personalVars 는 문자열 값만 든 객체여야 한다.
fn valid_body(b: &Value) -> bool {
    if !b.is_object() && !b.is_array() {
        return false;
    }
    let env_ok = b.get("environmentId").map_or(true, Value::is_string);
    let writes_ok = b.get("includeWrites").map_or(true, Value::is_boolean);
    let personal_ok = match b.get("personalVars") {
        None => true,
        Some(Value::Object(o)) => o.values().all(Value::is_string),
        Some(_) => false,
    };
    env_ok && writes_ok && personal_ok
}

async fn folder_run(State(s): State<AppState>, Path(id): Path<String>, RawQuery(q): RawQuery, body: Bytes) -> Response {
    let Some(b) = read_json(&body).filter(valid_body) else { return bad_input() };
    let prepared = {
        let (id, b) = (id.clone(), b.clone());
        s.db.run(move |c| prepare_folder(c, &id, &b)).await
    };
    let (data, plan) = match prepared {
        Ok(Ok(x)) => x,
        Ok(Err(resp)) => return resp,
        Err(e) => return json_error("폴더 실행 중 서버 오류", &e.to_string()),
    };
    if b.get("preview") == Some(&Value::Bool(true)) {
        return out(StatusCode::OK, Value::Object(plan));
    }
    let run = FolderRun {
        s: s.clone(),
        folder_name: data.folder_name,
        workspace_id: data.workspace_id,
        environment_id: b.get("environmentId").and_then(Value::as_str).map(str::to_string),
        personal_vars: b.get("personalVars").cloned(),
        folder_auth: data.folder_auth,
        prepared: data.prepared,
        initial: data.initial,
        plan,
    };
    if js::query_get(q.as_deref(), "stream").as_deref() == Some("1") {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Bytes>();
        tokio::spawn(async move {
            let line = |v: &Value| Bytes::from(format!("{}\n", js::stringify(v)));
            let emit_tx = tx.clone();
            let emit = move |v: Value| emit_tx.send(line(&v)).is_ok();
            if run.perform(emit).await.is_err() {
                let _ = tx.send(line(&json!({ "type": "error", "error": "실행 연결이 끊겼습니다. 완료된 행을 확인하고 다시 실행하세요." })));
            }
        });
        let stream = futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|b| (Ok::<_, std::convert::Infallible>(b), rx)) });
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/x-ndjson")
            .header(header::CACHE_CONTROL, "no-store")
            .header("x-accel-buffering", "no")
            .body(Body::from_stream(stream))
            .unwrap_or_else(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "응답을 만들지 못했습니다"));
    }
    let (result, junit) = match run.perform(|_| true).await {
        Ok(x) => x,
        Err(e) => return json_error("폴더 실행 중 서버 오류", &e.to_string()),
    };
    if js::query_get(q.as_deref(), "format").as_deref() == Some("junit") {
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/xml")
            .body(Body::from(junit))
            .unwrap_or_else(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "응답을 만들지 못했습니다"));
    }
    out(StatusCode::OK, result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::executor::tests::{mock, resp, split};
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

    async fn call_raw(app: &Router, uri: &str, body: Value) -> (StatusCode, axum::http::HeaderMap, String) {
        let req = Request::post(uri).header("content-type", "application/json").body(Body::from(body.to_string())).unwrap();
        let res = app.clone().oneshot(req).await.unwrap();
        let (st, h) = (res.status(), res.headers().clone());
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
        (st, h, String::from_utf8_lossy(&bytes).into_owned())
    }

    async fn call(app: &Router, uri: &str, body: Value) -> (StatusCode, Value) {
        let (st, _, text) = call_raw(app, uri, body).await;
        (st, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    fn seed(db: &crate::Db, sql: String) {
        db.with(move |c| Ok(c.execute_batch(&sql)?)).unwrap();
    }

    async fn server() -> crate::executor::tests::Mock {
        mock(|path, req, _| {
            let (h, _) = split(req);
            if path.starts_with("/login") {
                resp("200 OK", &[("content-type", "application/json")], br#"{"token":"TOKEN-123"}"#)
            } else if path.starts_with("/fail") {
                resp("500 Internal Server Error", &[], b"boom")
            } else {
                resp("200 OK", &[("content-type", "application/json")], json!({ "path": path, "auth": h.contains("authorization: bearer token-123") }).to_string().as_bytes())
            }
        })
        .await
    }

    #[tokio::test]
    async fn 시나리오는_추출값을_다음_스텝에_넘기고_secret_은_이력에서_가린다() {
        let (app, db) = app();
        let m = server().await;
        seed(
            &db,
            format!(
                r#"INSERT INTO folders (id, workspace_id, name) VALUES ('f1', 'ws', 'f');
                INSERT INTO requests (id, folder_id, name, method, url, updated_at) VALUES ('r1', 'f1', 'login', 'POST', '{b}/login', 0);
                INSERT INTO requests (id, folder_id, name, method, url, updated_at, headers) VALUES ('r2', 'f1', 'me', 'GET', '{b}/me?t={{{{token}}}}', 0, '[{{"key":"Authorization","value":"Bearer {{{{token}}}}","enabled":true}}]');
                INSERT INTO flows (id, workspace_id, name, steps, updated_at) VALUES ('fl', 'ws', '스모크', '[{{"requestId":"r1","extracts":[{{"path":"token","variable":"token","secret":true}}]}},{{"requestId":"r2","extracts":[]}}]', 1);"#,
                b = m.base
            ),
        );
        let (st, r) = call(&app, "/api/flows/fl/run", json!({ "executedBy": "me" })).await;
        assert_eq!(st, StatusCode::OK, "{r}");
        assert_eq!(r["stoppedAt"], Value::Null, "{r}");
        assert_eq!(r["steps"].as_array().unwrap().len(), 2);
        assert_eq!(r["steps"][0]["extracted"], json!({ "token": "TOKEN-123" }));
        assert_eq!(r["secretNames"], json!(["token"]));
        assert_eq!(r["runtimeVariables"]["prevStatus"], "200");
        assert!(r["runtimeVariables"]["step1Body"].as_str().unwrap().contains("TOKEN-123"));
        // 다음 스텝은 실값으로 나갔다
        let body2: Value = serde_json::from_str(r["runtimeVariables"]["step2Body"].as_str().unwrap()).unwrap();
        assert_eq!(body2["auth"], true);
        assert_eq!(body2["path"], "/me?t=TOKEN-123");
        // 이력에는 가려져 있다
        let stored = r["steps"][1]["execution"]["resolved"]["url"].as_str().unwrap().to_string();
        assert!(!stored.contains("TOKEN-123"), "{stored}");
        assert_eq!(r["steps"][1]["execution"]["executionSource"], "flow");
        let (runs, execs): (i64, i64) = db
            .with(|c| Ok((c.query_row("SELECT count(*) FROM flow_runs", [], |r| r.get(0))?, c.query_row("SELECT count(*) FROM executions", [], |r| r.get(0))?)))
            .unwrap();
        assert_eq!((runs, execs), (1, 2));

        // 단계 모드
        let (st, r) = call(&app, "/api/flows/fl/run", json!({ "stepIndex": 0 })).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(r["hasNext"], true);
        assert_eq!(r["step"]["name"], "login");
        assert_eq!(r["secretNames"], json!(["token"]));
        // F4 — 자동 변수 이름은 `${stepIndex + 1}`: 숫자 0 → step1Body, 문자열 "0" → "0"+1 = step01Body.
        assert!(r["runtimeVariables"]["step1Body"].as_str().unwrap().contains("TOKEN-123"), "{r}");
        let (st, r) = call(&app, "/api/flows/fl/run", json!({ "stepIndex": "1", "runtime": { "token": "TOKEN-123" } })).await;
        assert_eq!(st, StatusCode::OK, "{r}");
        assert_eq!(r["step"]["name"], "me");
        assert!(r["runtimeVariables"]["step11Body"].as_str().unwrap().contains("/me?t=TOKEN-123"), "{r}");
        assert!(r["runtimeVariables"].get("step2Body").is_none(), "{r}");
        let (st, r) = call(&app, "/api/flows/fl/run", json!({ "stepIndex": 5 })).await;
        assert_eq!((st, r["error"].as_str()), (StatusCode::BAD_REQUEST, Some("stepIndex 범위 밖 (0~1)")));
        let (st, _) = call(&app, "/api/flows/fl/run", json!({ "vars": { "a": 1 } })).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        let (st, _) = call(&app, "/api/flows/none/run", json!({})).await;
        assert_eq!(st, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn 시나리오는_실패한_스텝에서_멈춘다() {
        let (app, db) = app();
        let m = server().await;
        seed(
            &db,
            format!(
                r#"INSERT INTO folders (id, workspace_id, name) VALUES ('f1', 'ws', 'f');
                INSERT INTO requests (id, folder_id, name, method, url, updated_at) VALUES ('r1', 'f1', 'bad', 'GET', '{b}/fail', 0);
                INSERT INTO flows (id, workspace_id, name, steps, updated_at) VALUES ('fl', 'ws', 'x', '[{{"requestId":"r1"}},{{"requestId":"r1"}},{{"requestId":""}}]', 1);"#,
                b = m.base
            ),
        );
        let (st, r) = call(&app, "/api/flows/fl/run", json!({})).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(r["stoppedAt"], 0);
        assert_eq!(r["steps"][0]["error"], "HTTP 500");
        let steps: String = db.with(|c| Ok(c.query_row("SELECT steps FROM flow_runs", [], |r| r.get(0))?)).unwrap();
        let steps: Value = serde_json::from_str(&steps).unwrap();
        assert_eq!(steps[0]["status"], 500);
        assert_eq!(steps[0]["checkPassed"], false);
        let (_, r) = call(&app, "/api/flows/fl/run", json!({ "stepIndex": 2 })).await;
        assert_eq!(r["step"], json!({ "requestId": "", "error": "유효하지 않은 스텝(요청 ID 없음)" }));
        assert_eq!(r["hasNext"], false);
    }

    #[tokio::test]
    async fn 폴더_실행은_쓰기를_빼고_결과와_junit_을_준다() {
        let (app, db) = app();
        let m = server().await;
        seed(
            &db,
            format!(
                r#"INSERT INTO folders (id, workspace_id, name) VALUES ('f1', 'ws', '주문');
                INSERT INTO requests (id, folder_id, name, method, url, updated_at, sort_order) VALUES ('a', 'f1', 'me', 'GET', '{b}/me/{{id}}', 0, 1);
                INSERT INTO requests (id, folder_id, name, method, url, updated_at, sort_order) VALUES ('b', 'f1', 'bad', 'GET', '{b}/fail', 0, 2);
                INSERT INTO requests (id, folder_id, name, method, url, updated_at, sort_order) VALUES ('c', 'f1', 'write', 'POST', '{b}/w', 0, 3);
                INSERT INTO environments (id, workspace_id, name) VALUES ('other', 'ws2', 'x');"#,
                b = m.base
            ),
        );
        let (st, plan) = call(&app, "/api/folders/f1/run", json!({ "preview": true })).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(plan["writeCount"], 1);
        assert_eq!(plan["inputs"], json!([{ "name": "id", "value": "", "secret": false, "supplied": false }]));
        assert_eq!(plan["rows"][2]["state"], "skipped");

        let (st, r) = call(&app, "/api/folders/f1/run", json!({ "personalVars": { "id": "7" } })).await;
        assert_eq!(st, StatusCode::OK, "{r}");
        assert_eq!(r["folderName"], "주문");
        assert_eq!(r["summary"], json!({ "total": 3, "passed": 1, "failed": 1, "skipped": 1 }), "{r}");
        assert_eq!(r["results"][1]["error"], "HTTP 500 — 응답 본문과 요청 입력을 확인하세요.");
        assert!(r["junit"].as_str().unwrap().contains(r#"<testsuite name="주문" tests="3" failures="1">"#));
        // 폴더 실행은 이력을 남기지 않는다
        let n: i64 = db.with(|c| Ok(c.query_row("SELECT count(*) FROM executions", [], |r| r.get(0))?)).unwrap();
        assert_eq!(n, 0);

        let (st, h, xml) = call_raw(&app, "/api/folders/f1/run?format=junit", json!({})).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(h["content-type"], "application/xml");
        assert!(xml.starts_with("<?xml"));

        let (st, h, nd) = call_raw(&app, "/api/folders/f1/run?stream=1", json!({})).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(h["content-type"], "application/x-ndjson");
        let types: Vec<String> = nd.lines().map(|l| serde_json::from_str::<Value>(l).unwrap()["type"].as_str().unwrap().to_string()).collect();
        assert_eq!(types, vec!["start", "running", "result", "running", "result", "result", "done"]);

        let (st, _) = call(&app, "/api/folders/f1/run", json!({ "environmentId": "other" })).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        let (st, _) = call(&app, "/api/folders/f1/run", json!({ "personalVars": { "id": 1 } })).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        let (st, _) = call(&app, "/api/folders/none/run", json!({})).await;
        assert_eq!(st, StatusCode::NOT_FOUND);
    }
}
