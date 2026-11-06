//! 응답 ↔ OpenAPI 스키마 대조.
//!
//! 공개 API
//! - [`validate_against_schema`] — 응답 본문(JSON 문자열)을 스키마와 대조하는 경량 검증기(type/required/properties/
//!   items/$ref/enum/nullable 만. 완전한 JSON Schema 검증이 아니라 "백엔드가 스펙을 어긴 것"을 빠르게 드러내는 용도).
//! - [`response_schema`] — 실제 상태 코드 → 코드 범위(2XX) → default 순으로 응답 스키마를 고른다.
//! - [`schema_for`] — 요청의 스펙 연결(폴더의 스펙 URL)을 따라 스펙 번들을 받아 그 응답의 스키마를 찾는다.
//! - [`validate_request_response`] — 수동 검사(/api/requests/{id}/validate)와 시나리오·스케줄 스텝이 같이 쓰는 판정.
//!   계약이 없으면 통과, 계약이 있는데 응답이 비었거나 JSON 이 아니면 실패.
//!
//! 스펙 번들은 폴더 동기화와 같은 받기 규칙([`crate::spec_fetch::fetch_spec_bundle`])으로 받는다.

use rusqlite::OptionalExtension;
use serde_json::{json, Map, Value};

use crate::spec_fetch::fetch_spec_bundle;
use crate::{js, rows, AppState};

const MAX_DEPTH: usize = 8;
const REF_PREFIX: &str = "#/components/schemas/";

pub const UNLINKED: &str = "연결된 OpenAPI 정의가 없습니다";
pub const MISSING: &str = "요청을 찾을 수 없습니다";

fn issue(path: &str, message: impl Into<String>) -> Value {
    json!({ "path": path, "message": message.into() })
}

/// 원시 스키마에서 프로퍼티 읽기 — JS 에서 문자열·숫자의 프로퍼티는 undefined, null 은 던진다.
fn prop<'a>(s: &'a Value, k: &str) -> Result<Option<&'a Value>, String> {
    match s {
        Value::Null => Err(format!("Cannot read properties of null (reading '{k}')")),
        Value::Object(o) => Ok(o.get(k)),
        _ => Ok(None),
    }
}

fn resolve_ref<'a>(schema: &'a Value, schemas: &'a Value) -> Result<&'a Value, String> {
    let Some(Value::String(r)) = prop(schema, "$ref")? else { return Ok(schema) };
    let Some(name) = r.strip_prefix(REF_PREFIX) else { return Ok(schema) };
    // `components.schemas?.[name] ?? schema`
    Ok(schemas.as_object().and_then(|o| o.get(name)).filter(|t| !t.is_null()).unwrap_or(schema))
}

/// oneOf/anyOf/allOf 는 "가장 관대하게" — allOf 만 병합, one/any 는 통과(오탐 방지).
fn effective_type(s: &Value) -> Option<String> {
    let o = s.as_object()?;
    if let Some(Value::String(t)) = o.get("type") {
        return Some(t.clone());
    }
    if js::truthy(o.get("properties")) || js::truthy(o.get("additionalProperties")) {
        return Some("object".into());
    }
    if js::truthy(o.get("items")) {
        return Some("array".into());
    }
    None
}

fn type_matches(expected: &str, v: &Value) -> bool {
    match expected {
        "object" => v.is_object(),
        "array" => v.is_array(),
        "string" => v.is_string(),
        "integer" | "number" => v.is_number(),
        "boolean" => v.is_boolean(),
        _ => true,
    }
}

fn type_of(v: &Value) -> &'static str {
    match v {
        Value::Array(_) => "array",
        Value::Object(_) | Value::Null => "object",
        Value::String(_) => "string",
        Value::Number(_) => "number",
        Value::Bool(_) => "boolean",
    }
}

/// `Array.prototype.includes` — 원시값은 값으로(숫자는 수로), 객체·배열은 참조라 JSON 값끼리는 같을 수 없다.
fn same_value_zero(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::String(x), Value::String(y)) => x == y,
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::Null, Value::Null) => true,
        _ => false,
    }
}

fn join(path: &str, k: &str) -> String {
    if path.is_empty() {
        k.to_string()
    } else {
        format!("{path}.{k}")
    }
}

fn walk(value: &Value, schema: &Value, schemas: &Value, path: &str, depth: usize, issues: &mut Vec<Value>) -> Result<(), String> {
    if depth > MAX_DEPTH || issues.len() > 100 {
        return Ok(());
    }
    let s = resolve_ref(schema, schemas)?;
    // allOf 병합(얕게) — 하위 스키마 required/properties 를 합쳐서 검사.
    if let Some(Value::Array(all)) = prop(s, "allOf")? {
        for sub in all {
            walk(value, sub, schemas, path, depth + 1, issues)?;
        }
    }
    if matches!(prop(s, "oneOf")?, Some(Value::Array(_))) || matches!(prop(s, "anyOf")?, Some(Value::Array(_))) {
        return Ok(());
    }
    if value.is_null() {
        if prop(s, "nullable")? == Some(&Value::Bool(true)) {
            return Ok(());
        }
        if let Some(t) = effective_type(s).filter(|t| !t.is_empty() && t != "null") {
            issues.push(issue(path, format!("null 인데 스펙은 {t}")));
        }
        return Ok(());
    }
    let expected = effective_type(s).filter(|t| !t.is_empty());
    if let Some(e) = &expected {
        if !type_matches(e, value) {
            issues.push(issue(path, format!("타입 불일치 — 스펙 {e}, 실제 {}", type_of(value))));
            return Ok(());
        }
    }
    if let Some(Value::Array(allowed)) = prop(s, "enum")? {
        if !allowed.iter().any(|a| same_value_zero(a, value)) {
            issues.push(issue(path, format!("enum 벗어남 — 허용 {}, 실제 {}", js::stringify(&Value::Array(allowed.clone())), js::stringify(value))));
        }
    }
    if expected.as_deref() == Some("object") {
        if let Value::Object(obj) = value {
            let props = prop(s, "properties")?.and_then(Value::as_object);
            if let Some(Value::Array(req)) = prop(s, "required")? {
                for r in req {
                    let k = js::to_string(r);
                    if !obj.contains_key(&k) {
                        issues.push(issue(&join(path, &k), "필수 필드 누락"));
                    }
                }
            }
            for (k, v) in obj {
                if let Some(ps) = props.and_then(|p| p.get(k)).filter(|p| js::truthy(Some(p))) {
                    walk(v, ps, schemas, &join(path, k), depth + 1, issues)?;
                }
            }
        }
    }
    if expected.as_deref() == Some("array") {
        if let (Value::Array(items), Some(item_schema)) = (value, prop(s, "items")?.filter(|i| js::truthy(Some(i)))) {
            // 배열은 앞 20개만 검사(대형 응답 방어).
            for (i, item) in items.iter().take(20).enumerate() {
                walk(item, item_schema, schemas, &format!("{path}[{i}]"), depth + 1, issues)?;
            }
        }
    }
    Ok(())
}

pub struct Validation {
    pub ok: bool,
    pub issues: Vec<Value>,
    pub skipped: Option<String>,
}

impl Validation {
    fn skip(ok: bool, issues: Vec<Value>, reason: &str) -> Self {
        Validation { ok, issues, skipped: Some(reason.to_string()) }
    }

    /// `{ ok, issues, skipped? }` — 키 순서는 Node 의 객체 그대로.
    pub fn to_json(&self) -> Value {
        let mut o = Map::new();
        o.insert("ok".into(), json!(self.ok));
        o.insert("issues".into(), Value::Array(self.issues.clone()));
        if let Some(s) = &self.skipped {
            o.insert("skipped".into(), json!(s));
        }
        Value::Object(o)
    }
}

/// 응답 바디(JSON 문자열)를 스키마와 대조한다. 스키마·바디가 없거나 JSON 이 아니면 ok=true(검증 스킵).
/// `schemas` 는 components.schemas($ref 대상).
pub fn validate_against_schema(body: Option<&str>, schema: Option<&Value>, schemas: &Value) -> Result<Validation, String> {
    let Some(schema) = schema else { return Ok(Validation::skip(true, vec![], "스펙에 응답 스키마가 없음")) };
    let Some(body) = body.filter(|b| !js::trim(b).is_empty()) else { return Ok(Validation::skip(true, vec![], "응답 바디 없음")) };
    let Some(value) = js::parse_json(body) else { return Ok(Validation::skip(true, vec![], "JSON 응답 아님")) };
    let mut issues = vec![];
    walk(&value, schema, schemas, "", 0, &mut issues)?;
    Ok(Validation { ok: issues.is_empty(), issues, skipped: None })
}

fn nn(v: Option<&Value>) -> Option<&Value> {
    v.filter(|x| !x.is_null())
}

/// 실제 상태 코드 → 해당 코드 범위 → default 순서. 다른 상태 응답은 쓰지 않는다.
pub fn response_schema<'a>(operation: &'a Value, status: u16, content_type: &str) -> Option<&'a Value> {
    let responses = nn(operation.get("responses"));
    let pick = |k: &str| nn(responses.and_then(|r| r.get(k)));
    let response = pick(&status.to_string()).or_else(|| pick(&format!("{}XX", status / 100))).or_else(|| pick("default"));
    let media = js::trim(content_type.split(';').next().unwrap_or("")).to_lowercase();
    let content = nn(response.and_then(|r| r.get("content")));
    let schema_of = |k: &str| nn(nn(content.and_then(|c| c.get(k))).and_then(|m| m.get("schema")));
    let major = media.split('/').next().unwrap_or("").to_string();
    schema_of(&media).or_else(|| schema_of(&format!("{major}/*"))).or_else(|| schema_of("*/*"))
}

/// schemaFor 가 던지는 오류 — 응답은 502.
pub enum SchemaError {
    Other(String),
}

impl SchemaError {
    pub fn message(&self) -> String {
        match self {
            SchemaError::Other(m) => m.clone(),
        }
    }
}

pub enum Found {
    Schema { schema: Value, schemas: Value },
    Reason(String),
}

/// `split(/\s+/)` — 앞에 공백이 있으면 첫 조각이 빈 문자열.
fn split_ws(s: &str) -> Vec<&str> {
    let mut out = vec![];
    let mut start = 0;
    let mut in_ws = false;
    for (i, c) in s.char_indices() {
        if c.is_whitespace() || c == '\u{feff}' {
            if !in_ws {
                out.push(&s[start..i]);
                in_ws = true;
            }
        } else if in_ws {
            start = i;
            in_ws = false;
        }
    }
    out.push(if in_ws { "" } else { &s[start..] });
    out
}

/// `Object.keys(schema).length === 0` 의 길이.
fn key_count(v: &Value) -> usize {
    match v {
        Value::Object(o) => o.len(),
        Value::Array(a) => a.len(),
        Value::String(s) => js::len16(s),
        _ => 0,
    }
}

pub async fn schema_for(s: &AppState, id: &str, status: u16, content_type: &str) -> Result<Found, SchemaError> {
    struct Linked {
        op_key: Value,
        folder: Option<(String, String, Value)>,
    }
    let id = id.to_string();
    let row = s
        .db
        .run(move |c| {
            let req = c
                .prepare_cached(r#"SELECT "folder_id", "spec_operation_key" FROM "requests" WHERE "requests"."id" = ?1"#)?
                .query_row([&id], |r| Ok((rows::text(r, 0)?, rows::raw(r.get_ref(1)?))))
                .optional()?;
            let Some((folder_id, op_key)) = req else { return Ok(None) };
            let folder = c
                .prepare_cached(r#"SELECT "name", "spec_source_type", "spec_source_url" FROM "folders" WHERE "folders"."id" = ?1"#)?
                .query_row([&folder_id], |r| Ok((rows::text(r, 0)?, rows::text(r, 1)?, rows::raw(r.get_ref(2)?))))
                .optional()?;
            Ok(Some(Linked { op_key, folder }))
        })
        .await
        .map_err(|e| SchemaError::Other(e.to_string()))?;
    let Some(row) = row else { return Err(SchemaError::Other(MISSING.into())) };
    let unlinked = || Ok(Found::Reason(UNLINKED.into()));
    let Some((name, ty, url)) = row.folder else { return unlinked() };
    if !js::truthy(Some(&row.op_key)) {
        return unlinked();
    }
    let bundle = if ty == "url" && js::truthy(Some(&url)) {
        fetch_spec_bundle(&name, &js::to_string(&url), 15_000).await
    } else {
        return unlinked();
    };
    if !js::truthy(bundle.get("reachable")) {
        return Ok(Found::Reason("OpenAPI 문서를 불러오지 못했습니다. 연결을 확인하세요".into()));
    }
    let key = js::to_string(&row.op_key);
    let parts = split_ws(&key);
    let (method, path) = (parts.first().copied(), parts.get(1).copied());
    let ep = bundle.get("endpoints").and_then(Value::as_array).into_iter().flatten().find(|e| {
        e.get("method").and_then(Value::as_str) == method && e.get("path").and_then(Value::as_str) == path
    });
    let Some(ep) = ep else { return Ok(Found::Reason("OpenAPI에서 이 요청을 찾지 못했습니다. 스펙 동기화를 확인하세요".into())) };
    let op = ep.get("operation").cloned().unwrap_or(Value::Null);
    let schema = response_schema(&op, status, content_type).filter(|v| key_count(v) > 0);
    let Some(schema) = schema else {
        return Ok(Found::Reason(format!("HTTP {status} 응답의 {} 스키마가 없습니다", content_type.split(';').next().unwrap_or(""))));
    };
    if !content_type.to_lowercase().contains("json") {
        return Ok(Found::Reason("JSON 응답의 기본 구조만 검사할 수 있습니다".into()));
    }
    Ok(Found::Schema { schema: schema.clone(), schemas: bundle.get("schemas").cloned().unwrap_or(Value::Null) })
}

/// 수동·예약·시나리오 실행이 같이 쓰는 스키마 선택과 검사. 계약이 없으면 통과(skipped).
/// `status` 가 None/0 이거나 전송 오류가 있으면 응답이 없는 것.
pub async fn validate_request_response(
    s: &AppState,
    id: &str,
    error: Option<&str>,
    status: Option<u16>,
    body: Option<&str>,
    content_type: Option<&str>,
) -> Result<Validation, SchemaError> {
    let Some(status) = status.filter(|st| *st != 0 && error.map_or(true, str::is_empty)) else {
        return Ok(Validation::skip(true, vec![], "응답 없음"));
    };
    let ct = content_type.filter(|c| !c.is_empty()).unwrap_or("application/json");
    match schema_for(s, id, status, ct).await? {
        Found::Reason(reason) => {
            let unlinked = reason == UNLINKED;
            let issues = if unlinked { vec![] } else { vec![issue("", reason.clone())] };
            Ok(Validation::skip(unlinked, issues, &reason))
        }
        Found::Schema { schema, schemas } => {
            let v = validate_against_schema(body, Some(&schema), &schemas).map_err(SchemaError::Other)?;
            // 계약이 있는데 응답이 비었거나 JSON 이 아니면 통과할 수 없다 — 수동 검사도 스케줄 스텝도 같게.
            Ok(match v.skipped {
                Some(reason) => Validation { ok: false, issues: vec![issue("", reason.clone())], skipped: Some(reason) },
                None => v,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(body: &str, schema: Value, schemas: Value) -> Value {
        validate_against_schema(Some(body), Some(&schema), &schemas).unwrap().to_json()
    }

    #[test]
    fn 스키마_대조() {
        let schemas = json!({ "Order": { "type": "object", "required": ["id", "kind"], "properties": {
            "id": { "type": "integer" }, "kind": { "enum": ["A", "B"] }, "tags": { "type": "array", "items": { "type": "string" } },
            "note": { "type": "string", "nullable": true } } } });
        let schema = json!({ "$ref": "#/components/schemas/Order" });
        assert_eq!(check(r#"{"id":1,"kind":"A","tags":["x"],"note":null}"#, schema.clone(), schemas.clone()), json!({ "ok": true, "issues": [] }));
        assert_eq!(
            check(r#"{"id":"1","kind":"C","tags":["x",2]}"#, schema.clone(), schemas.clone()),
            json!({ "ok": false, "issues": [
                { "path": "id", "message": "타입 불일치 — 스펙 integer, 실제 string" },
                { "path": "kind", "message": "enum 벗어남 — 허용 [\"A\",\"B\"], 실제 \"C\"" },
                { "path": "tags[1]", "message": "타입 불일치 — 스펙 string, 실제 number" },
            ] })
        );
        assert_eq!(check(r#"{"kind":"A"}"#, schema.clone(), schemas.clone())["issues"], json!([{ "path": "id", "message": "필수 필드 누락" }]));
        assert_eq!(check("null", schema.clone(), schemas.clone())["issues"], json!([{ "path": "", "message": "null 인데 스펙은 object" }]));
        assert_eq!(check("[1]", json!({ "oneOf": [] }), json!({})), json!({ "ok": true, "issues": [] }));
        assert_eq!(check("1.0", json!({ "enum": [1] }), json!({})), json!({ "ok": true, "issues": [] }));
        assert_eq!(check("x", schema.clone(), schemas.clone()), json!({ "ok": true, "issues": [], "skipped": "JSON 응답 아님" }));
        assert_eq!(check("  ", schema, schemas), json!({ "ok": true, "issues": [], "skipped": "응답 바디 없음" }));
    }

    #[test]
    fn 응답_스키마_고르기() {
        let op = json!({ "responses": {
            "200": { "content": { "application/json": { "schema": { "type": "object" } } } },
            "4XX": { "content": { "application/*": { "schema": { "type": "string" } } } },
            "default": { "content": { "*/*": { "schema": { "type": "array" } } } },
        } });
        assert_eq!(response_schema(&op, 200, "application/json; charset=utf-8"), Some(&json!({ "type": "object" })));
        assert_eq!(response_schema(&op, 404, "application/problem+json"), Some(&json!({ "type": "string" })));
        assert_eq!(response_schema(&op, 500, "text/plain"), Some(&json!({ "type": "array" })));
        assert_eq!(response_schema(&json!({}), 200, "application/json"), None);
        assert_eq!(split_ws("GET  /a b"), vec!["GET", "/a", "b"]);
        assert_eq!(split_ws(" GET"), vec!["", "GET"]);
    }
}
