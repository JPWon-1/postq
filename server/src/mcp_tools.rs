//! MCP 도구 본체.
//!
//! 공개 API
//! - [`run`] (도구 이름, 검사를 통과한 인자) → CallToolResult JSON. Err 는 도구 본체가 던진 오류(메시지)다.
//!
//! 다른 라우트 핸들러를 그대로 부른다 — 서버 자신의 Router 를 oneshot 으로. 목록·실행·이력
//! 로직이 두 벌이 되지 않는다.
//!
//! 실행 출처: execute_request 는 요청 extensions 에 [`ExecutionSource::Mcp`] 를 실어 부른다. 그래서 AI 실행 허용·환경 정책·파라미터 타입 검사가 MCP 기준으로 걸린다.
//!
//! run_scenario 는 시나리오 실행([`crate::routes::flow_run::run_flow`])을 출처 Mcp 로 직접 부른다 — HTTP 로 넘기면
//! 출처가 'flow' 로 바뀌어 MCP 에만 걸리는 AI 실행 허용 검사가 빠진다.

use axum::body::Body;
use axum::http::{Method, Request};
use serde_json::{json, Map, Value};
use tower::ServiceExt;

use crate::execution_policy::ExecutionSource;
use crate::execution_overrides::describe_request;
use crate::http_explain::{explain_status, explain_transport_error};
use crate::resolve::{Kv, RequestInput};
use crate::{js, AppState};

/// 라우트 하나를 서버 안에서 부른다 → (상태 코드, 본문 바이트).
async fn call(s: &AppState, method: Method, uri: &str, body: Option<&Value>, source: Option<ExecutionSource>) -> Result<(u16, Vec<u8>), String> {
    let mut req = Request::builder().method(method).uri(uri);
    if body.is_some() {
        req = req.header("content-type", "application/json");
    }
    let mut req = req.body(body.map_or_else(Body::empty, |b| Body::from(js::stringify(b)))).map_err(|e| e.to_string())?;
    if let Some(src) = source {
        req.extensions_mut().insert(src);
    }
    let app = crate::routes::router().fallback(crate::static_files::api_not_found).with_state(s.clone());
    let res = app.oneshot(req).await.map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.map_err(|e| e.to_string())?;
    Ok((status, bytes.to_vec()))
}

/// `await res.json()` — 깨진 JSON 이면 던진다(도구 실패).
fn json_of(bytes: &[u8]) -> Result<Value, String> {
    js::parse_body(bytes).ok_or_else(|| if bytes.is_empty() { "Unexpected end of JSON input".into() } else { "Unexpected token in JSON".into() })
}

async fn get_json(s: &AppState, uri: &str) -> Result<Value, String> {
    let (_, b) = call(s, Method::GET, uri, None, None).await?;
    json_of(&b)
}

fn enc(s: &str) -> String {
    js::encode_uri_component(s)
}

/// `{ content: [{ type: 'text', text }] }` — 성공. 문자열이 아니면 JSON.stringify(v, null, 2).
fn ok(value: &Value) -> Value {
    let text = match value {
        Value::String(s) => s.clone(),
        v => js::stringify_pretty(v, 2),
    };
    json!({ "content": [{ "type": "text", "text": text }] })
}

/// 실패는 isError 로 — 없으면 LLM 이 '못 찾았다' 를 결과로 받아들이고 다음 단계로 넘어간다.
fn fail(text: impl Into<Value>) -> Value {
    json!({ "content": [{ "type": "text", "text": text.into() }], "isError": true })
}

fn as_array(v: Value, what: &str) -> Result<Vec<Value>, String> {
    match v {
        Value::Array(a) => Ok(a),
        _ => Err(format!("{what}.map is not a function")),
    }
}

/// `${v}` — 템플릿 문자열 안의 값.
fn tpl(v: Option<&Value>) -> String {
    v.map_or_else(|| "undefined".into(), js::to_string)
}

fn s<'a>(args: &'a Value, k: &str) -> &'a str {
    args.get(k).and_then(Value::as_str).unwrap_or_default()
}

/// JSON.stringify 는 undefined 키를 뺀다 — 값이 있을 때만 넣는다.
fn put(o: &mut Map<String, Value>, k: &str, v: Option<&Value>) {
    if let Some(v) = v {
        o.insert(k.into(), v.clone());
    }
}

/// `arr.slice(0, n)` — n 은 JS 숫자(음수면 뒤에서, 소수는 버림).
fn slice_to(len: usize, n: f64) -> usize {
    if n.is_nan() {
        return 0;
    }
    let n = n.trunc();
    if n < 0.0 {
        (len as f64 + n).max(0.0) as usize
    } else {
        n.min(len as f64) as usize
    }
}

const KST_OFFSET_MS: f64 = 9.0 * 3_600_000.0;

/// kstFull — 'YYYY-MM-DD HH:MM:SS'(KST). Date 가 못 담는 값이면 '—'.
fn kst_full(ts: Option<&Value>) -> String {
    let t = match ts {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::Null) => 0.0, // null + 9h — 1970-01-01 09:00:00
        _ => f64::NAN,
    } + KST_OFFSET_MS;
    if !t.is_finite() || t.abs() > 8.64e15 {
        return "—".into();
    }
    let iso = js::iso_string(t.trunc() as i64);
    iso.get(0..19).unwrap_or(&iso).replacen('T', " ", 1)
}

/// truncate(s, 4000) — 길이는 UTF-16 단위.
fn truncate(s: &str) -> String {
    const N: usize = 4000;
    let len = js::len16(s);
    if len > N {
        format!("{}\n…(생략 {}자)", js::slice16(s, N), len - N)
    } else {
        s.to_string()
    }
}

fn is_failed_execution(e: &Value) -> bool {
    let nullish = |k: &str| e.get(k).map_or(true, Value::is_null);
    if !nullish("error") {
        return true;
    }
    match e.get("checkPassed") {
        Some(Value::Bool(false)) => true,
        None | Some(Value::Null) => e.get("responseStatus").and_then(Value::as_f64).map_or(false, |st| st >= 400.0),
        _ => false,
    }
}

/// summarizeExecution — 이력·목록·시나리오와 같은 실패 판정(isFailedExecution)으로 AI 에게 알린다.
fn summarize_execution(exec: &Value, out: &mut Map<String, Value>) {
    let status = exec.get("responseStatus");
    put(out, "status", status);
    let meaning = match status {
        Some(v) if !v.is_null() => json!(explain_status(v.as_f64().unwrap_or(0.0) as u16).0),
        _ => Value::Null,
    };
    out.insert("statusMeaning".into(), meaning);
    put(out, "durationMs", exec.get("durationMs"));
    put(out, "error", exec.get("error"));
    let explained = if js::truthy(exec.get("error")) {
        explain_transport_error(&js::to_string(&exec["error"])).map_or(Value::Null, |x| x.to_json())
    } else {
        Value::Null
    };
    out.insert("errorExplained".into(), explained);
    put(out, "missingVariables", exec.get("missingVariables"));
    out.insert("checkPassed".into(), exec.get("checkPassed").cloned().unwrap_or(Value::Null));
    out.insert("failed".into(), Value::Bool(is_failed_execution(exec)));
    let body = if js::truthy(exec.get("responseBody")) { json!(truncate(&js::to_string(&exec["responseBody"]))) } else { Value::Null };
    out.insert("responseBody".into(), body);
}

/// 프로젝트의 (폴더, 요청) 전부.
async fn requests_of(st: &AppState, workspace_id: &str) -> Result<Vec<(Value, Value)>, String> {
    let folders = as_array(get_json(st, &format!("/api/folders?workspaceId={}", enc(workspace_id))).await?, "folders")?;
    let mut all = vec![];
    for folder in folders {
        let fid = tpl(folder.get("id"));
        let rs = as_array(get_json(st, &format!("/api/requests?folderId={}", enc(&fid))).await?, "rs")?;
        all.extend(rs.into_iter().map(|r| (folder.clone(), r)));
    }
    Ok(all)
}

/// envByName — 이름이 없거나(빈 문자열 포함) 못 찾으면 None.
async fn env_by_name(st: &AppState, workspace_id: &str, name: Option<&str>) -> Result<Option<Value>, String> {
    let Some(name) = name.filter(|n| !n.is_empty()) else { return Ok(None) };
    let envs = as_array(get_json(st, &format!("/api/environments?workspaceId={}", enc(workspace_id))).await?, "envs")?;
    Ok(envs.into_iter().find(|e| e.get("name").and_then(Value::as_str) == Some(name)))
}

/// 저장된 요청 행 → describeRequest 의 입력.
fn request_input(r: &Value) -> RequestInput {
    let kvs = |k: &str| r.get(k).and_then(Value::as_array).map(|a| a.iter().map(Kv::from_json).collect()).unwrap_or_default();
    RequestInput {
        method: js::to_string(r.get("method").unwrap_or(&Value::Null)),
        url: r.get("url").and_then(Value::as_str).unwrap_or_default().to_string(),
        params: kvs("params"),
        headers: kvs("headers"),
        body_type: r.get("bodyType").and_then(Value::as_str).unwrap_or_default().to_string(),
        body: r.get("body").and_then(Value::as_str).unwrap_or_default().to_string(),
    }
}

pub async fn run(st: &AppState, name: &str, a: Value) -> Result<Value, String> {
    match name {
        "search_requests" => {
            let all = requests_of(st, s(&a, "workspaceId")).await?;
            let q = s(&a, "query").to_lowercase();
            let hits: Vec<Value> = all
                .iter()
                .filter(|(folder, r)| {
                    q.is_empty()
                        || format!("{} {} {} {}", tpl(r.get("method")), tpl(r.get("name")), tpl(r.get("url")), tpl(folder.get("name")))
                            .to_lowercase()
                            .contains(&q)
                })
                .take(30)
                .map(|(folder, r)| {
                    let mut o = Map::new();
                    put(&mut o, "requestId", r.get("id"));
                    put(&mut o, "name", r.get("name"));
                    put(&mut o, "method", r.get("method"));
                    put(&mut o, "url", r.get("url"));
                    put(&mut o, "folder", folder.get("name"));
                    Value::Object(o)
                })
                .collect();
            Ok(ok(&json!({ "total": hits.len(), "requests": hits })))
        }
        "get_request" => {
            let id = s(&a, "requestId");
            let all = requests_of(st, s(&a, "workspaceId")).await?;
            let Some((_, r)) = all.iter().find(|(_, r)| r.get("id").and_then(Value::as_str) == Some(id)) else {
                return Ok(fail("요청을 찾을 수 없습니다"));
            };
            let mut o = Map::new();
            o.insert("requestId".into(), json!(id));
            if let Value::Object(d) = describe_request(&request_input(r)) {
                o.extend(d);
            }
            o.insert("aiExecutionAllowed".into(), r.get("aiExecutionAllowed").filter(|v| !v.is_null()).cloned().unwrap_or(json!(false)));
            Ok(ok(&Value::Object(o)))
        }
        "execute_request" => execute_request(st, &a).await,
        "get_history" => {
            let rows = get_json(st, &format!("/api/requests/{}/executions", enc(s(&a, "requestId")))).await?;
            let rows = if let Value::Array(r) = rows { r } else { vec![] };
            let n = slice_to(rows.len(), a["limit"].as_f64().unwrap_or(f64::NAN));
            let mut items = vec![];
            for e in &rows[..n] {
                let resolved = match e.get("resolved") {
                    None => return Err("Cannot read properties of undefined (reading 'method')".into()),
                    Some(Value::Null) => return Err("Cannot read properties of null (reading 'method')".into()),
                    Some(r) => r,
                };
                let mut o = Map::new();
                put(&mut o, "executedBy", e.get("executedBy"));
                o.insert("executedAtKST".into(), json!(kst_full(e.get("executedAt"))));
                put(&mut o, "status", e.get("responseStatus"));
                put(&mut o, "durationMs", e.get("durationMs"));
                put(&mut o, "error", e.get("error"));
                o.insert("sent".into(), json!(format!("{} {}", tpl(resolved.get("method")), tpl(resolved.get("url")))));
                items.push(Value::Object(o));
            }
            Ok(ok(&Value::Array(items)))
        }
        "run_scenario" => run_scenario(st, &a).await,
        "create_scenario" => create_scenario(st, &a).await,
        "get_workspace_info" => {
            let ws = as_array(get_json(st, "/api/workspaces").await?, "ws")?;
            let mut detail = vec![];
            for w in ws {
                let wid = tpl(w.get("id"));
                let envs = as_array(get_json(st, &format!("/api/environments?workspaceId={}", enc(&wid))).await?, "envs")?;
                let mut o = Map::new();
                put(&mut o, "workspaceId", w.get("id"));
                put(&mut o, "name", w.get("name"));
                o.insert("environments".into(), Value::Array(envs.iter().map(|e| e.get("name").cloned().unwrap_or(Value::Null)).collect()));
                let folders = as_array(get_json(st, &format!("/api/folders?workspaceId={}", enc(&wid))).await?, "folders")?;
                // Workspace discovery only needs metadata, not inherited header values.
                o.insert("folders".into(), Value::Array(folders.iter().map(|f| json!({
                    "id": f["id"], "name": f["name"], "description": f["description"]
                })).collect()));
                detail.push(Value::Object(o));
            }
            Ok(ok(&Value::Array(detail)))
        }
        _ => Err(format!("Tool {name} not found")),
    }
}

async fn execute_request(st: &AppState, a: &Value) -> Result<Value, String> {
    let request_id = s(a, "requestId");
    let workspace_id = s(a, "workspaceId");
    let all = requests_of(st, workspace_id).await?;
    let Some((_, r)) = all.into_iter().find(|(_, r)| r.get("id").and_then(Value::as_str) == Some(request_id)) else {
        return Ok(fail(format!("requestId {request_id} 를 찾을 수 없습니다 (search_requests 로 확인)")));
    };
    let env_name = a.get("environmentName").and_then(Value::as_str);
    let env = env_by_name(st, workspace_id, env_name).await?;
    if let (Some(n), None) = (env_name.filter(|n| !n.is_empty()), &env) {
        return Ok(fail(format!("환경 '{n}' 없음 — get_workspace_info 로 환경 목록 확인")));
    }
    let mut overrides = Map::new();
    for k in ["vars", "params", "body", "bodyMerge"] {
        put(&mut overrides, k, a.get(k));
    }
    let mut input = Map::new();
    for k in ["method", "url", "params", "headers", "bodyType", "body"] {
        put(&mut input, k, r.get(k));
    }
    let mut payload = Map::new();
    payload.insert("executedBy".into(), a["executedBy"].clone());
    put(&mut payload, "environmentId", env.as_ref().and_then(|e| e.get("id")));
    payload.insert("overrides".into(), Value::Object(overrides));
    payload.insert("input".into(), Value::Object(input));

    let uri = format!("/api/requests/{}/execute", enc(request_id));
    let (status, bytes) = call(st, Method::POST, &uri, Some(&Value::Object(payload)), Some(ExecutionSource::Mcp)).await?;
    let exec = json_of(&bytes)?;
    if !(200..300).contains(&status) {
        let err = exec.get("error").filter(|e| !e.is_null()).cloned().unwrap_or_else(|| json!("요청 실행이 거부되었습니다"));
        return Ok(fail(err));
    }
    // 실행 라우트는 실행한 본인에게 실 응답을 돌려준다(화면에서 진짜 응답을 봐야 하니까). 그런데 MCP 의 출력은
    // LLM 컨텍스트로 들어간다 — 대상 서버가 받은 토큰을 그대로 돌려주면(에코·디버그 엔드포인트) secret 이 모델
    // 제공자에게까지 흘러간다(Node 에서 실측). 그래서 저장된(스크럽된) 실행을 다시 읽어 그 응답 본문을 쓴다.
    // 다시 읽지 못하면 본문 없이 요약만 — 확실하지 않으면 안 보내는 쪽이 맞다.
    let mut scrubbed = exec.clone();
    if js::truthy(exec.get("id")) {
        let stored = match call(st, Method::GET, &format!("/api/executions/{}", enc(&js::to_string(&exec["id"]))), None, None).await {
            Ok((_, b)) => js::parse_body(&b),
            Err(_) => None,
        };
        let body = match stored.as_ref().and_then(|x| x.get("execution")).filter(|e| js::truthy(Some(e))) {
            Some(e) => e.get("responseBody").cloned(),
            None => Some(Value::Null),
        };
        if let Value::Object(o) = &mut scrubbed {
            match body {
                Some(b) => {
                    o.insert("responseBody".into(), b);
                }
                None => {
                    o.remove("responseBody");
                }
            }
        }
    }
    let mut summary = Map::new();
    summary.insert("request".into(), json!(format!("{} {}", tpl(r.get("method")), tpl(r.get("url")))));
    summarize_execution(&scrubbed, &mut summary);
    let failed = summary.get("failed") == Some(&Value::Bool(true));
    let summary = Value::Object(summary);
    // 4xx/5xx·전송 오류는 도구 실패로 — 본문만 보고 성공으로 넘어가지 않게.
    Ok(if failed { fail(js::stringify_pretty(&summary, 2)) } else { ok(&summary) })
}

async fn create_scenario(st: &AppState, a: &Value) -> Result<Value, String> {
    let name = s(a, "name");
    let workspace_id = s(a, "workspaceId");
    // 이름 → 요청 id. 하나라도 못 찾으면 만들지 않고 후보를 알려준다 — 절반만 이어진 시나리오는 원인을 찾기 어렵다.
    let all: Vec<Value> = requests_of(st, workspace_id).await?.into_iter().map(|(_, r)| r).collect();
    let mut picked: Vec<(Value, String)> = vec![];
    let mut missing: Vec<String> = vec![];
    for want in a["requestNames"].as_array().into_iter().flatten() {
        let want = want.as_str().unwrap_or_default();
        match all.iter().find(|r| r.get("name").and_then(Value::as_str).map_or(false, |n| n.contains(want))) {
            Some(hit) => picked.push((hit.get("id").cloned().unwrap_or(Value::Null), tpl(hit.get("name")))),
            None => missing.push(want.to_string()),
        }
    }
    if !missing.is_empty() {
        let examples: Vec<String> = all.iter().take(15).map(|r| tpl(r.get("name"))).collect();
        return Ok(fail(format!(
            "요청을 찾지 못했습니다: {}\n이 프로젝트의 요청 {}개 중 예시: {}",
            missing.join(", "),
            all.len(),
            examples.join(", ")
        )));
    }

    let (_, b) = call(st, Method::POST, "/api/flows", Some(&json!({ "name": name, "workspaceId": workspace_id })), None).await?;
    let created = json_of(&b)?;
    let flow_id = created.get("id");
    let steps: Vec<Value> = picked.iter().map(|(id, _)| json!({ "requestId": id, "extracts": [] })).collect();
    let shared = a.get("sharedVars").cloned().unwrap_or(json!([]));
    call(st, Method::PUT, &format!("/api/flows/{}", enc(&tpl(flow_id))), Some(&json!({ "name": name, "steps": steps, "sharedVars": shared })), None).await?;

    let mut o = Map::new();
    o.insert("created".into(), json!(name));
    put(&mut o, "flowId", flow_id);
    o.insert("steps".into(), Value::Array(picked.iter().enumerate().map(|(i, (_, n))| json!({ "step": i + 1, "name": n })).collect()));
    o.insert(
        "다음".into(),
        json!(format!("run_scenario 로 '{name}' 을 실행하거나, 앱에서 ?flow={} 로 열어 추출 규칙을 붙이세요.", tpl(flow_id))),
    );
    Ok(ok(&Value::Object(o)))
}

/// run_scenario — 시나리오 실행을 서버 안에서 직접, 출처 'mcp' 로(Node 의 withExecutionSource('mcp')).
/// 출처가 Mcp 라 스텝마다 AI 실행 허용·파라미터 타입 검사가 MCP 기준으로 걸린다.
async fn run_scenario(st: &AppState, a: &Value) -> Result<Value, String> {
    let flow_name = s(a, "flowName");
    let workspace_id = s(a, "workspaceId");
    let flows = as_array(get_json(st, &format!("/api/flows?workspaceId={}", enc(workspace_id))).await?, "flowsList")?;
    let Some(flow) = flows.iter().find(|f| f.get("name").and_then(Value::as_str).map_or(false, |n| n.contains(flow_name))) else {
        let names: Vec<String> = flows.iter().map(|f| tpl(f.get("name"))).collect();
        let shown = if names.is_empty() { "(없음)".to_string() } else { names.join(", ") };
        return Ok(fail(format!("시나리오 '{flow_name}' 없음. 존재: {shown}")));
    };
    let env_name = a.get("environmentName").and_then(Value::as_str);
    let env = env_by_name(st, workspace_id, env_name).await?;
    if let (Some(n), None) = (env_name.filter(|n| !n.is_empty()), &env) {
        return Ok(fail(format!("환경 '{n}' 없음 — 실행되지 않았습니다")));
    }
    let mut body = Map::new();
    body.insert("executedBy".into(), json!("Claude(MCP)"));
    put(&mut body, "environmentId", env.as_ref().and_then(|e| e.get("id")));
    put(&mut body, "vars", a.get("vars"));
    let flow_id = tpl(flow.get("id"));
    let (_, run) = crate::routes::flow_run::run_flow(st, &flow_id, &Value::Object(body), ExecutionSource::Mcp)
        .await
        .map_err(|e| e.to_string())?;
    let steps: Vec<Value> = run
        .get("steps")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .enumerate()
        .map(|(i, step)| {
            let mut o = Map::new();
            o.insert("step".into(), json!(i + 1));
            put(&mut o, "name", step.get("name"));
            if let Some(exec) = step.get("execution").filter(|e| js::truthy(Some(e))) {
                summarize_execution(exec, &mut o);
            }
            // 시나리오를 멈춘 이유(응답 확인 조건 불일치 등)는 스텝에 붙는다 — 빠뜨리면 멈춘 스텝이 failed:false 로 나온다.
            if let Some(e) = step.get("error").filter(|e| js::truthy(Some(e))) {
                o.insert("failed".into(), json!(true));
                o.insert("stepError".into(), e.clone());
            }
            put(&mut o, "extracted", step.get("extracted"));
            Value::Object(o)
        })
        .collect();
    let mut summary = Map::new();
    put(&mut summary, "flow", flow.get("name"));
    put(&mut summary, "stoppedAt", run.get("stoppedAt"));
    summary.insert("steps".into(), Value::Array(steps));
    // `run.stoppedAt !== null` — 오류 응답(stoppedAt 없음)도 실패.
    let stopped = run.get("stoppedAt") != Some(&Value::Null);
    let summary = Value::Object(summary);
    Ok(if stopped { fail(js::stringify_pretty(&summary, 2)) } else { ok(&summary) })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn state() -> AppState {
        let db = crate::variables::tests::test_db();
        let config = crate::Config {
            host: "127.0.0.1".into(),
            port: 0,
            db_path: ":memory:".into(),
            migrations_dir: std::path::PathBuf::new(),
            static_dir: None,
        };
        AppState { db, config }
    }

    fn text(v: &Value) -> String {
        v["content"][0]["text"].as_str().unwrap().to_string()
    }

    #[test]
    fn 작은_js_의미() {
        assert_eq!(slice_to(10, 5.0), 5);
        assert_eq!(slice_to(10, -3.0), 7);
        assert_eq!(slice_to(2, 5.0), 2);
        assert_eq!(slice_to(10, 2.7), 2);
        assert_eq!(kst_full(Some(&json!(0))), "1970-01-01 09:00:00");
        assert_eq!(kst_full(Some(&json!(1_793_534_096_789i64))), "2026-11-01 20:54:56");
        assert_eq!(kst_full(None), "—");
        assert_eq!(truncate("abc"), "abc");
        let long = "가".repeat(4005);
        assert_eq!(truncate(&long), format!("{}\n…(생략 5자)", "가".repeat(4000)));
        assert!(is_failed_execution(&json!({ "error": "x" })));
        assert!(!is_failed_execution(&json!({ "error": null, "checkPassed": true, "responseStatus": 404 })));
        assert!(is_failed_execution(&json!({ "responseStatus": 500 })));
    }

    #[tokio::test]
    async fn 빈_프로젝트의_도구_응답은_node_와_같다() {
        let st = state();
        let r = run(&st, "search_requests", json!({ "query": "", "workspaceId": "default" })).await.unwrap();
        assert_eq!(text(&r), "{\n  \"total\": 0,\n  \"requests\": []\n}");
        let r = run(&st, "get_request", json!({ "requestId": "zz", "workspaceId": "default" })).await.unwrap();
        assert_eq!(js::stringify(&r), r#"{"content":[{"type":"text","text":"요청을 찾을 수 없습니다"}],"isError":true}"#);
        let r = run(&st, "get_history", json!({ "requestId": "zz", "limit": 5 })).await.unwrap();
        assert_eq!(text(&r), "[]");
        let r = run(&st, "execute_request", json!({ "requestId": "zz", "workspaceId": "default", "executedBy": "Claude(MCP)" })).await.unwrap();
        assert_eq!(text(&r), "requestId zz 를 찾을 수 없습니다 (search_requests 로 확인)");
        let r = run(&st, "create_scenario", json!({ "name": "n", "requestNames": ["zz"], "workspaceId": "default" })).await.unwrap();
        assert_eq!(text(&r), "요청을 찾지 못했습니다: zz\n이 프로젝트의 요청 0개 중 예시: ");
    }

    fn seed(st: &AppState, sql: &'static str) {
        st.db.with(move |c| Ok(c.execute_batch(sql)?)).unwrap();
    }

    #[tokio::test]
    async fn workspace_info_includes_folder_descriptions() {
        let st = state();
        seed(&st, "INSERT INTO workspaces (id, name) VALUES ('notes-ws', 'Notes'); INSERT INTO folders (id, workspace_id, name, description) VALUES ('notes-f', 'notes-ws', 'Folder', 'Shared notes');");
        let result = run(&st, "get_workspace_info", json!({})).await.unwrap();
        let value: Value = serde_json::from_str(&text(&result)).unwrap();
        let workspace = value.as_array().unwrap().iter().find(|w| w["workspaceId"] == "notes-ws").unwrap();
        assert_eq!(workspace["folders"][0], json!({"id": "notes-f", "name": "Folder", "description": "Shared notes"}));
    }

    #[tokio::test]
    async fn 요청_검색과_구조_확인() {
        let st = state();
        seed(
            &st,
            r#"INSERT INTO folders (id, workspace_id, name, sort_order) VALUES ('f1', 'default', '주문', 0);
               INSERT INTO requests (id, folder_id, name, method, url, params, headers, body_type, body, sort_order, ai_execution_allowed, updated_at)
               VALUES ('r1', 'f1', '주문 생성', 'POST', '{{base}}/orders/{cid}', '[{"key":"page","value":"1"}]', '[]', 'json', '{"code":"SECRET","n":1}', 0, 1, 0);"#,
        );
        let r = run(&st, "search_requests", json!({ "query": "주문", "workspaceId": "default" })).await.unwrap();
        let v: Value = serde_json::from_str(&text(&r)).unwrap();
        assert_eq!(v["requests"][0], json!({ "requestId": "r1", "name": "주문 생성", "method": "POST", "url": "{{base}}/orders/{cid}", "folder": "주문" }));
        let r = run(&st, "get_request", json!({ "requestId": "r1", "workspaceId": "default" })).await.unwrap();
        let t = text(&r);
        assert!(!t.contains("SECRET"), "{t}");
        let v: Value = serde_json::from_str(&t).unwrap();
        assert_eq!(v["pathParameters"], json!(["cid"]));
        assert_eq!(v["queryParameters"], json!(["page"]));
        assert_eq!(v["aiExecutionAllowed"], json!(true));
        assert_eq!(js::object_keys(v.as_object().unwrap())[0], "requestId");
    }

    #[tokio::test]
    async fn 실행은_mcp_출처로_ai_허용을_따른다() {
        let st = state();
        seed(
            &st,
            r#"INSERT INTO folders (id, workspace_id, name, sort_order) VALUES ('f1', 'default', 'F', 0);
               INSERT INTO requests (id, folder_id, name, method, url, params, headers, body_type, body, sort_order, ai_execution_allowed, updated_at)
               VALUES ('r1', 'f1', '쓰기', 'POST', 'http://127.0.0.1:9/x', '[]', '[]', 'none', '', 0, 0, 0);"#,
        );
        let r = run(&st, "execute_request", json!({ "requestId": "r1", "workspaceId": "default", "executedBy": "Claude(MCP)" })).await.unwrap();
        assert_eq!(r["isError"], json!(true));
        let src: String = st
            .db
            .with(|c| Ok(c.query_row("SELECT execution_source FROM executions WHERE request_id = 'r1'", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(src, "mcp");
    }

    #[tokio::test]
    async fn 시나리오_만들기() {
        let st = state();
        seed(
            &st,
            r#"INSERT INTO folders (id, workspace_id, name, sort_order) VALUES ('f1', 'default', 'F', 0);
               INSERT INTO requests (id, folder_id, name, method, url, params, headers, body_type, body, sort_order, updated_at)
               VALUES ('r1', 'f1', '로그인', 'POST', 'http://a/login', '[]', '[]', 'none', '', 0, 0),
                      ('r2', 'f1', '주문 조회', 'GET', 'http://a/orders', '[]', '[]', 'none', '', 1, 0);"#,
        );
        let r = run(&st, "create_scenario", json!({ "name": "S", "requestNames": ["로그인", "주문"], "workspaceId": "default" })).await.unwrap();
        let v: Value = serde_json::from_str(&text(&r)).unwrap();
        assert_eq!(v["steps"], json!([{ "step": 1, "name": "로그인" }, { "step": 2, "name": "주문 조회" }]));
        let steps: String = st.db.with(|c| Ok(c.query_row("SELECT steps FROM flows WHERE name = 'S'", [], |r| r.get(0))?)).unwrap();
        assert!(steps.contains("r1") && steps.contains("r2"), "{steps}");
    }

    #[tokio::test]
    async fn 시나리오_실행은_node_없이_mcp_출처로_돈다() {
        let st = state();
        let r = run(&st, "run_scenario", json!({ "flowName": "x", "workspaceId": "default" })).await.unwrap();
        assert_eq!(text(&r), "시나리오 'x' 없음. 존재: (없음)");
        seed(
            &st,
            r#"INSERT INTO folders (id, workspace_id, name, sort_order) VALUES ('f1', 'default', 'F', 0);
               INSERT INTO requests (id, folder_id, name, method, url, params, headers, body_type, body, sort_order, ai_execution_allowed, updated_at)
               VALUES ('r1', 'f1', '조회', 'GET', 'http://127.0.0.1:9/x', '[]', '[]', 'none', '', 0, 0, 0);
               INSERT INTO flows (id, workspace_id, name, steps, shared_vars, updated_at)
               VALUES ('fl1', 'default', '내 시나리오', '[{"requestId":"r1","extracts":[]}]', '[]', 0);"#,
        );
        let r = run(&st, "run_scenario", json!({ "flowName": "시나리오", "workspaceId": "default", "environmentName": "없는환경" })).await.unwrap();
        assert_eq!(text(&r), "환경 '없는환경' 없음 — 실행되지 않았습니다");
        // AI 실행이 허용되지 않은 요청 — MCP 출처라 막히고, 그 기록이 mcp 로 남는다.
        let r = run(&st, "run_scenario", json!({ "flowName": "시나리오", "workspaceId": "default" })).await.unwrap();
        assert_eq!(r["isError"], json!(true), "{r}");
        let v: Value = serde_json::from_str(&text(&r)).unwrap();
        assert_eq!(v["flow"], json!("내 시나리오"));
        assert_eq!(v["stoppedAt"], json!(0));
        assert_eq!(v["steps"][0]["failed"], json!(true));
        let src: String = st
            .db
            .with(|c| Ok(c.query_row("SELECT execution_source FROM executions WHERE request_id = 'r1'", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(src, "mcp");
    }
}
