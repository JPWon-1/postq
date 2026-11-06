//! MCP(JSON-RPC) 프로토콜 층 — `@modelcontextprotocol/sdk` 의 McpServer 와 같은 응답을 낸다. 전송(streamable HTTP·SSE)은 [`crate::routes`] 의 mcp 라우트,
//! 도구 본체는 [`crate::mcp_tools`] 에 있다.
//!
//! 공개 API
//! - [`classify`] → [`Message`] — JSONRPCMessageSchema 판정(요청/알림/응답, 아니면 None).
//! - [`is_initialize_request`] — 초기화 요청(params 까지 올바른 것)인지.
//! - [`handle_request`] — 요청 하나를 처리해 JSON-RPC 응답 객체를 돌려준다.
//! - [`validate_args`] — 도구 inputSchema(JSON Schema)로 인자를 zod 와 같은 규칙·같은 오류 문장으로 검사.
//! - [`tools`] — tools/list 결과(mcp_tools.json 을 그대로 싣는다).
//! - [`SUPPORTED_PROTOCOL_VERSIONS`]·[`LATEST_PROTOCOL_VERSION`]
//!
//! 도구 스키마를 Rust 로 다시 적지 않고 tools/list 결과를 JSON 파일 그대로 싣는다 — MCP 클라이언트(LLM)는
//! 설명 문장과 스키마를 보고 도구를 고른다. 한 글자라도 달라지면 같은 질문에 다른 도구를 부를 수 있다.
//! 인자 검사도 그 스키마 하나로 한다(두 벌이면 스키마는 허용하는데 검사는 막는 틈이 생긴다).

use std::sync::LazyLock;

use serde_json::{json, Map, Value};

use crate::{js, AppState};

pub const LATEST_PROTOCOL_VERSION: &str = "2025-11-25";
pub const SUPPORTED_PROTOCOL_VERSIONS: [&str; 5] = [LATEST_PROTOCOL_VERSION, "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];

/// initialize 응답의 serverInfo — MCP 클라이언트가 이 이름으로 서버를 보여 준다.
const SERVER_NAME: &str = "postq";
const SERVER_VERSION: &str = "0.1.1";

static TOOLS: LazyLock<Vec<Value>> =
    LazyLock::new(|| serde_json::from_str(include_str!("mcp_tools.json")).expect("mcp_tools.json 은 올바른 JSON 이어야 한다"));

pub fn tools() -> &'static [Value] {
    &TOOLS
}

fn tool(name: &str) -> Option<&'static Value> {
    TOOLS.iter().find(|t| t["name"] == name)
}

// ── JSON-RPC 메시지 판정 ───────────────────────────────────────────────

pub enum Message {
    Request { id: Value, method: String, params: Option<Value> },
    Notification,
    Response,
}

/// RequestIdSchema — 문자열 또는 정수.
fn is_request_id(v: &Value) -> bool {
    match v {
        Value::String(_) => true,
        Value::Number(n) => n.is_i64() || n.is_u64() || n.as_f64().map_or(false, |f| f.fract() == 0.0),
        _ => false,
    }
}

fn only_keys(o: &Map<String, Value>, allowed: &[&str]) -> bool {
    o.keys().all(|k| allowed.contains(&k.as_str()))
}

/// JSONRPCMessageSchema — SDK 의 스키마는 `.strict()` 라 모르는 키가 하나라도 있으면 메시지가 아니다.
pub fn classify(v: &Value) -> Option<Message> {
    let o = v.as_object()?;
    if o.get("jsonrpc") != Some(&json!("2.0")) {
        return None;
    }
    let params_ok = |o: &Map<String, Value>| o.get("params").map_or(true, Value::is_object);
    let method = o.get("method").and_then(Value::as_str);
    if let (Some(id), Some(m)) = (o.get("id"), method) {
        if is_request_id(id) && params_ok(o) && only_keys(o, &["jsonrpc", "id", "method", "params"]) {
            return Some(Message::Request { id: id.clone(), method: m.to_string(), params: o.get("params").cloned() });
        }
    }
    if method.is_some() && !o.contains_key("id") && params_ok(o) && only_keys(o, &["jsonrpc", "method", "params"]) {
        return Some(Message::Notification);
    }
    if o.get("id").map_or(false, is_request_id) && o.get("result").map_or(false, Value::is_object) && only_keys(o, &["jsonrpc", "id", "result"]) {
        return Some(Message::Response);
    }
    let err_ok = o.get("error").and_then(Value::as_object).map_or(false, |e| {
        e.get("code").map_or(false, |c| c.as_f64().map_or(false, |f| f.fract() == 0.0)) && e.get("message").map_or(false, Value::is_string)
    });
    if err_ok && o.get("id").map_or(true, is_request_id) && only_keys(o, &["jsonrpc", "id", "error"]) {
        return Some(Message::Response);
    }
    None
}

/// isInitializeRequest — method 만이 아니라 params 까지 InitializeRequestSchema 에 맞아야 초기화 요청이다.
pub fn is_initialize_request(v: &Value) -> bool {
    matches!(classify(v), Some(Message::Request { ref method, ref params, .. }) if method == "initialize" && initialize_issues(params.as_ref()).is_empty())
}

// ── zod 와 같은 오류 문장 ──────────────────────────────────────────────

/// zod v4 의 parsedType 이름.
fn received(v: Option<&Value>) -> &'static str {
    match v {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

fn invalid_type(expected: &str, v: Option<&Value>, path: &[Value]) -> Value {
    json!({
        "expected": expected, "code": "invalid_type", "path": path,
        "message": format!("Invalid input: expected {expected}, received {}", received(v)),
    })
}

fn num(f: f64) -> Value {
    serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number)
}

/// JSON Schema(zod 가 만든 것) 하나로 값 하나를 검사한다. 통과하면 zod 가 돌려주는 값(기본값 채움·모르는 키 제거)을.
fn check(schema: &Value, v: Option<&Value>, path: &mut Vec<Value>, issues: &mut Vec<Value>) -> Option<Value> {
    let v = match v {
        None => match schema.get("default") {
            Some(d) => return Some(d.clone()),
            None => None,
        },
        some => some,
    };
    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        if v.map_or(false, |x| values.contains(x)) {
            return v.cloned();
        }
        let opts: Vec<String> = values.iter().map(js::stringify).collect();
        issues.push(json!({
            "code": "invalid_value", "values": values, "path": path,
            "message": format!("Invalid option: expected one of {}", opts.join("|")),
        }));
        return None;
    }
    let ty = schema.get("type").and_then(Value::as_str).unwrap_or("");
    match ty {
        "string" | "boolean" => {
            let ok = if ty == "string" { matches!(v, Some(Value::String(_))) } else { matches!(v, Some(Value::Bool(_))) };
            if !ok {
                issues.push(invalid_type(ty, v, path));
                return None;
            }
            v.cloned()
        }
        "number" | "integer" => {
            let Some(f) = v.and_then(Value::as_f64) else {
                issues.push(invalid_type("number", v, path));
                return None;
            };
            if ty == "integer" && (f.fract() != 0.0 || f.abs() > 9_007_199_254_740_991.0) {
                issues.push(json!({
                    "expected": "int", "format": "safeint", "code": "invalid_type", "path": path,
                    "message": "Invalid input: expected int, received number",
                }));
                return None;
            }
            let before = issues.len();
            if let Some(min) = schema.get("minimum").and_then(Value::as_f64) {
                if f < min {
                    issues.push(json!({
                        "origin": "number", "code": "too_small", "minimum": num(min), "inclusive": true, "path": path,
                        "message": format!("Too small: expected number to be >={}", js::number_to_string(min)),
                    }));
                }
            }
            if let Some(max) = schema.get("maximum").and_then(Value::as_f64) {
                if f > max {
                    issues.push(json!({
                        "origin": "number", "code": "too_big", "maximum": num(max), "inclusive": true, "path": path,
                        "message": format!("Too big: expected number to be <={}", js::number_to_string(max)),
                    }));
                }
            }
            (issues.len() == before).then(|| v.cloned()).flatten()
        }
        "array" => {
            let Some(Value::Array(items)) = v else {
                issues.push(invalid_type("array", v, path));
                return None;
            };
            let before = issues.len();
            let item_schema = schema.get("items").cloned().unwrap_or(json!({}));
            let mut out = Vec::with_capacity(items.len());
            for (i, x) in items.iter().enumerate() {
                path.push(json!(i));
                if let Some(y) = check(&item_schema, Some(x), path, issues) {
                    out.push(y);
                }
                path.pop();
            }
            if let Some(min) = schema.get("minItems").and_then(Value::as_f64) {
                if (items.len() as f64) < min {
                    issues.push(json!({
                        "origin": "array", "code": "too_small", "minimum": num(min), "inclusive": true, "path": path,
                        "message": format!("Too small: expected array to have >={} items", js::number_to_string(min)),
                    }));
                }
            }
            (issues.len() == before).then_some(Value::Array(out))
        }
        "object" if schema.get("propertyNames").is_some() => {
            // z.record(z.string(), X)
            let Some(Value::Object(o)) = v else {
                issues.push(invalid_type("record", v, path));
                return None;
            };
            let value_schema = schema.get("additionalProperties").cloned().unwrap_or(json!({}));
            let before = issues.len();
            let mut out = Map::new();
            for k in js::object_keys(o) {
                path.push(json!(k));
                if let Some(y) = check(&value_schema, o.get(k.as_str()), path, issues) {
                    out.insert(k.clone(), y);
                }
                path.pop();
            }
            (issues.len() == before).then_some(Value::Object(out))
        }
        "object" => {
            let Some(Value::Object(o)) = v else {
                issues.push(invalid_type("object", v, path));
                return None;
            };
            let required: Vec<&str> =
                schema.get("required").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
            let before = issues.len();
            let mut out = Map::new();
            if let Some(props) = schema.get("properties").and_then(Value::as_object) {
                for (k, ps) in props {
                    let x = o.get(k);
                    // 선택 키가 없으면(기본값도 없으면) 결과에도 넣지 않는다 — zod 의 optional 과 같다.
                    if x.is_none() && !required.contains(&k.as_str()) && ps.get("default").is_none() {
                        continue;
                    }
                    path.push(json!(k));
                    if let Some(y) = check(ps, x, path, issues) {
                        out.insert(k.clone(), y);
                    }
                    path.pop();
                }
            }
            (issues.len() == before).then_some(Value::Object(out))
        }
        // {} — z.unknown()
        _ => v.cloned().or(Some(Value::Null)),
    }
}

/// 도구 인자 검사 — 실패면 zod 가 내던 issue 목록.
pub fn validate_args(input_schema: &Value, args: Option<&Value>) -> Result<Value, Vec<Value>> {
    let mut issues = vec![];
    let out = check(input_schema, args, &mut vec![], &mut issues);
    if issues.is_empty() {
        Ok(out.unwrap_or(Value::Null))
    } else {
        Err(issues)
    }
}

// ── 요청 처리 ──────────────────────────────────────────────────────────

fn ok_response(id: &Value, result: Value) -> Value {
    json!({ "result": result, "jsonrpc": "2.0", "id": id })
}

fn error_response(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// 요청 params 스키마 검사 실패 — SDK 는 ZodError 를 그대로 던지고 Protocol 이 -32603 으로 감싼다(메시지는 issue JSON).
fn params_error(id: &Value, issues: &[Value]) -> Value {
    error_response(id, -32603, &js::stringify_pretty(&Value::Array(issues.to_vec()), 2))
}

fn field_issue(params: &Value, key: &str, expected: &str, path: &[&str], issues: &mut Vec<Value>) {
    let v = params.get(key);
    let ok = match expected {
        "string" => matches!(v, Some(Value::String(_))),
        _ => matches!(v, Some(Value::Object(_))),
    };
    if !ok {
        let p: Vec<Value> = path.iter().map(|s| json!(s)).collect();
        issues.push(invalid_type(expected, v, &p));
    }
}

fn initialize_issues(params: Option<&Value>) -> Vec<Value> {
    let mut issues = vec![];
    let Some(p) = params.filter(|p| p.is_object()) else {
        issues.push(invalid_type("object", params, &[json!("params")]));
        return issues;
    };
    field_issue(p, "protocolVersion", "string", &["params", "protocolVersion"], &mut issues);
    field_issue(p, "capabilities", "object", &["params", "capabilities"], &mut issues);
    match p.get("clientInfo") {
        Some(ci @ Value::Object(_)) => {
            field_issue(ci, "name", "string", &["params", "clientInfo", "name"], &mut issues);
            field_issue(ci, "version", "string", &["params", "clientInfo", "version"], &mut issues);
        }
        other => issues.push(invalid_type("object", other, &[json!("params"), json!("clientInfo")])),
    }
    issues
}

/// 도구 실패 결과 — McpServer.createToolError.
pub fn tool_error(text: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": true })
}

/// 요청 하나 → JSON-RPC 응답 객체.
pub async fn handle_request(state: &AppState, id: &Value, method: &str, params: Option<&Value>) -> Value {
    match method {
        "initialize" => {
            let issues = initialize_issues(params);
            if !issues.is_empty() {
                return params_error(id, &issues);
            }
            let asked = params.and_then(|p| p.get("protocolVersion")).and_then(Value::as_str).unwrap_or("");
            let version = if SUPPORTED_PROTOCOL_VERSIONS.contains(&asked) { asked } else { LATEST_PROTOCOL_VERSION };
            ok_response(
                id,
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": true } },
                    "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION },
                }),
            )
        }
        "ping" => ok_response(id, json!({})),
        "tools/list" => {
            if let Some(c) = params.and_then(|p| p.get("cursor")).filter(|c| !c.is_string()) {
                return params_error(id, &[invalid_type("string", Some(c), &[json!("params"), json!("cursor")])]);
            }
            ok_response(id, json!({ "tools": tools() }))
        }
        "tools/call" => {
            let mut issues = vec![];
            let Some(p) = params.filter(|p| p.is_object()) else {
                return params_error(id, &[invalid_type("object", params, &[json!("params")])]);
            };
            field_issue(p, "name", "string", &["params", "name"], &mut issues);
            if let Some(a) = p.get("arguments").filter(|a| !a.is_object()) {
                issues.push(invalid_type("record", Some(a), &[json!("params"), json!("arguments")]));
            }
            if !issues.is_empty() {
                return params_error(id, &issues);
            }
            let name = p["name"].as_str().unwrap_or_default();
            ok_response(id, call_tool(state, name, p.get("arguments")).await)
        }
        _ => error_response(id, -32601, "Method not found"),
    }
}

/// tools/call — 도구를 못 찾거나 인자가 틀리면 McpError(-32602) 를 도구 실패 결과로 감싼다(SDK 동작).
async fn call_tool(state: &AppState, name: &str, args: Option<&Value>) -> Value {
    let Some(t) = tool(name) else {
        return tool_error(&format!("MCP error -32602: Tool {name} not found"));
    };
    let args = match validate_args(&t["inputSchema"], args) {
        Ok(a) => a,
        Err(issues) => {
            return tool_error(&format!(
                "MCP error -32602: Input validation error: Invalid arguments for tool {name}: {}",
                js::stringify_pretty(&Value::Array(issues), 2)
            ))
        }
    };
    match crate::mcp_tools::run(state, name, args).await {
        Ok(v) => v,
        // 도구 본체가 던진 오류 — createToolError(error.message)
        Err(msg) => tool_error(&msg),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema(name: &str) -> &'static Value {
        &tool(name).unwrap()["inputSchema"]
    }

    fn msg(name: &str, args: Option<Value>) -> String {
        js::stringify_pretty(&Value::Array(validate_args(schema(name), args.as_ref()).unwrap_err()), 2)
    }

    /// 지금 도구 목록에는 enum·정수·최댓값을 쓰는 스키마가 없다 — 검사기 갈래를 그대로 확인하려고 zod 가 내보내는 모양을 직접 둔다.
    fn enum_int_schema() -> Value {
        json!({
            "type": "object",
            "properties": {
                "q": { "type": "string" },
                "env": { "default": "stage", "type": "string", "enum": ["stage", "production"] },
                "size": { "default": 10, "type": "integer", "minimum": 1, "maximum": 100 },
                "allFields": { "default": false, "type": "boolean" }
            },
            "required": ["q"]
        })
    }

    fn inline_msg(schema: &Value, args: Value) -> String {
        js::stringify_pretty(&Value::Array(validate_args(schema, Some(&args)).unwrap_err()), 2)
    }

    #[test]
    fn 도구_목록은_node_가_내보낸_그대로() {
        let names: Vec<&str> = tools().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(
            names,
            [
                "search_requests", "get_request", "execute_request", "get_history", "run_scenario", "create_scenario",
                "get_workspace_info",
            ]
        );
        assert!(tools().iter().all(|t| t["execution"] == json!({ "taskSupport": "forbidden" })));
    }

    // 아래 기대 문장은 Node(mcp-handler + zod 4.4) 에 같은 인자를 넣어 받은 응답에서 옮겼다.
    #[test]
    fn 인자_오류_문장은_zod_와_같다() {
        assert_eq!(
            msg("get_request", Some(json!({}))),
            "[\n  {\n    \"expected\": \"string\",\n    \"code\": \"invalid_type\",\n    \"path\": [\n      \"requestId\"\n    ],\n    \"message\": \"Invalid input: expected string, received undefined\"\n  }\n]"
        );
        assert_eq!(
            inline_msg(&enum_int_schema(), json!({ "q": "x", "env": "bad", "size": 1000 })),
            "[\n  {\n    \"code\": \"invalid_value\",\n    \"values\": [\n      \"stage\",\n      \"production\"\n    ],\n    \"path\": [\n      \"env\"\n    ],\n    \"message\": \"Invalid option: expected one of \\\"stage\\\"|\\\"production\\\"\"\n  },\n  {\n    \"origin\": \"number\",\n    \"code\": \"too_big\",\n    \"maximum\": 100,\n    \"inclusive\": true,\n    \"path\": [\n      \"size\"\n    ],\n    \"message\": \"Too big: expected number to be <=100\"\n  }\n]"
        );
        assert_eq!(
            inline_msg(&enum_int_schema(), json!({ "q": "x", "size": 1.5 })),
            "[\n  {\n    \"expected\": \"int\",\n    \"format\": \"safeint\",\n    \"code\": \"invalid_type\",\n    \"path\": [\n      \"size\"\n    ],\n    \"message\": \"Invalid input: expected int, received number\"\n  }\n]"
        );
        assert_eq!(
            msg("create_scenario", Some(json!({ "name": "x", "requestNames": [], "sharedVars": [{ "key": 1 }] }))),
            "[\n  {\n    \"origin\": \"array\",\n    \"code\": \"too_small\",\n    \"minimum\": 1,\n    \"inclusive\": true,\n    \"path\": [\n      \"requestNames\"\n    ],\n    \"message\": \"Too small: expected array to have >=1 items\"\n  },\n  {\n    \"expected\": \"string\",\n    \"code\": \"invalid_type\",\n    \"path\": [\n      \"sharedVars\",\n      0,\n      \"key\"\n    ],\n    \"message\": \"Invalid input: expected string, received number\"\n  },\n  {\n    \"expected\": \"string\",\n    \"code\": \"invalid_type\",\n    \"path\": [\n      \"sharedVars\",\n      0,\n      \"value\"\n    ],\n    \"message\": \"Invalid input: expected string, received undefined\"\n  }\n]"
        );
        assert!(msg("execute_request", Some(json!({ "requestId": "x", "vars": { "a": 1 } }))).contains("\"vars\",\n      \"a\"\n"));
        assert!(msg("execute_request", Some(json!({ "requestId": "x", "vars": 5 }))).contains("expected record, received number"));
        // 인자를 아예 안 주면 빈 스키마 도구도 실패한다.
        assert!(msg("get_workspace_info", None).contains("\"path\": [],\n    \"message\": \"Invalid input: expected object, received undefined\""));
    }

    #[test]
    fn 기본값을_채우고_모르는_키는_버린다() {
        let out = validate_args(&enum_int_schema(), Some(&json!({ "q": "a", "zzz": 1 }))).unwrap();
        assert_eq!(js::stringify(&out), r#"{"q":"a","env":"stage","size":10,"allFields":false}"#);
        let out = validate_args(schema("get_history"), Some(&json!({ "requestId": "a", "zzz": 1 }))).unwrap();
        assert_eq!(js::stringify(&out), r#"{"requestId":"a","limit":5}"#);
        let out = validate_args(schema("create_scenario"), Some(&json!({ "name": "n", "requestNames": ["a"], "sharedVars": [{ "value": "v", "key": "k", "x": 1 }] })))
            .unwrap();
        assert_eq!(js::stringify(&out), r#"{"name":"n","requestNames":["a"],"sharedVars":[{"key":"k","value":"v"}],"workspaceId":"default"}"#);
        assert_eq!(js::stringify(&validate_args(schema("get_workspace_info"), Some(&json!({}))).unwrap()), "{}");
    }

    #[test]
    fn 메시지_판정() {
        assert!(matches!(classify(&json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" })), Some(Message::Request { .. })));
        assert!(matches!(classify(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })), Some(Message::Notification)));
        assert!(matches!(classify(&json!({ "jsonrpc": "2.0", "id": 1, "result": {} })), Some(Message::Response)));
        assert!(classify(&json!({ "foo": 1 })).is_none());
        assert!(classify(&json!({ "jsonrpc": "2.0", "id": 1.5, "method": "ping" })).is_none());
        assert!(classify(&json!({ "jsonrpc": "2.0", "id": 1, "method": "ping", "extra": 1 })).is_none());
        assert!(classify(&json!({ "jsonrpc": "2.0", "id": 1, "method": "ping", "params": null })).is_none());
        let init = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "x", "version": "1" } } });
        assert!(is_initialize_request(&init));
        assert!(!is_initialize_request(&json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize" })));
    }

    #[tokio::test]
    async fn 프로토콜_응답() {
        let st = crate::mcp_tools::tests::state();
        let id = json!(1);
        let r = handle_request(&st, &id, "initialize", Some(&json!({ "protocolVersion": "1999-01-01", "capabilities": {}, "clientInfo": { "name": "x", "version": "1" } }))).await;
        assert_eq!(
            js::stringify(&r),
            r#"{"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"postq","version":"0.1.1"}},"jsonrpc":"2.0","id":1}"#
        );
        assert_eq!(js::stringify(&handle_request(&st, &json!("a"), "nope", None).await), r#"{"jsonrpc":"2.0","id":"a","error":{"code":-32601,"message":"Method not found"}}"#);
        assert_eq!(
            js::stringify(&handle_request(&st, &id, "tools/call", Some(&json!({ "name": "nope", "arguments": {} }))).await),
            r#"{"result":{"content":[{"type":"text","text":"MCP error -32602: Tool nope not found"}],"isError":true},"jsonrpc":"2.0","id":1}"#
        );
        let r = handle_request(&st, &id, "tools/call", Some(&json!({ "name": "get_request", "arguments": null }))).await;
        assert_eq!(r["error"]["code"], -32603);
        assert!(r["error"]["message"].as_str().unwrap().contains("expected record, received null"));
        let r = handle_request(&st, &id, "tools/call", None).await;
        assert!(r["error"]["message"].as_str().unwrap().contains("\"params\"\n    ],\n    \"message\": \"Invalid input: expected object, received undefined\""));
    }
}
