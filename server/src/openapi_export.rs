//! postq 폴더(요청 집합) → OpenAPI 3.0 문서.
//!
//! 코드생성·게이트웨이 등이 다시 쓰는 표준 계약이다. 인증·자격증명 헤더는
//! 파라미터에서 빠지고 값은 내보내지 않는다.

use serde_json::{json, Map, Value};

use crate::js;
use crate::scrub::is_credential_header;

/// 내보내기에 필요한 요청 필드만 — parseRequestRow 를 거친 모양(params/headers 는 KV 정규화, tags 는 문자열만).
pub struct ReqLike {
    pub name: Value,
    pub method: String,
    pub url: String,
    pub description: String,
    pub params: Vec<Value>,
    pub headers: Vec<Value>,
    pub body_type: String,
    pub body: String,
    pub tags: Vec<Value>,
}

/// URL 에서 경로만 — `{{baseUrl}}/x?q=1` → `/x`, `https://api/x` → `/x`.
pub fn to_path(raw_url: &str) -> String {
    let no_query = raw_url.split('?').next().unwrap_or("");
    // new URL 이 읽으면 그 pathname. pathname 은 {id} 를 %7B..%7D 로 바꿔 두므로 풀어서 경로 템플릿을 살린다.
    // url 크레이트는 브라우저·Node 와 같은 WHATWG 규칙이라 'localhost:8080/x' 같은 것도 같은 자리에서 갈린다.
    if let Ok(u) = url::Url::parse(no_query) {
        if let Ok(p) = js::decode_uri_component(u.path()) {
            return if p.is_empty() { "/".into() } else { p };
        }
    }
    // {{var}} 등으로 못 읽는 주소 — 앞의 스킴과 맨 앞의 {{변수}} 하나를 떼고 첫 '/' 부터.
    let mut after = no_query;
    for scheme in ["http://", "https://"] {
        if let Some(rest) = after.strip_prefix(scheme) {
            after = rest;
            break;
        }
    }
    if let Some(rest) = after.strip_prefix("{{") {
        // /^\{\{[^}]+\}\}/ — 닫는 }} 앞까지 '}' 가 하나도 없어야 하고, 한 글자 이상.
        if let Some(end) = rest.find('}') {
            if end > 0 && rest[end..].starts_with("}}") {
                after = &rest[end + 2..];
            }
        }
    }
    match after.find('/') {
        Some(idx) => after[idx..].to_string(),
        None => format!("/{}", after.trim_start_matches('/')),
    }
}

/// 요청 바디 → requestBody. 바디가 없으면 None.
fn request_body(r: &ReqLike) -> Option<Value> {
    if r.body_type == "none" || r.body.is_empty() {
        return None;
    }
    if r.body_type == "binary" {
        let value: Value = serde_json::from_str(&r.body).unwrap_or(Value::Null);
        let ct = value.get("contentType").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("application/octet-stream");
        return Some(json!({ "content": { ct: { "schema": { "type": "string", "format": "binary" } } } }));
    }
    let ct = match r.body_type.as_str() {
        "json" | "graphql" => "application/json",
        "form" => "application/x-www-form-urlencoded",
        "multipart" => "multipart/form-data",
        _ => "text/plain",
    };
    let mut example = Value::String(r.body.clone());
    if ct == "application/json" {
        if let Ok(v) = serde_json::from_str::<Value>(&r.body) {
            example = v;
        }
    }
    let mut content = Map::new();
    content.insert(ct.into(), json!({ "example": example }));
    Some(json!({ "content": content }))
}

fn kv_str<'a>(kv: &'a Value, k: &str) -> &'a str {
    kv.get(k).and_then(Value::as_str).unwrap_or("")
}

fn param(kv: &Value, place: &str) -> Value {
    let mut p = Map::new();
    p.insert("name".into(), json!(kv_str(kv, "key")));
    p.insert("in".into(), json!(place));
    p.insert("required".into(), json!(false));
    p.insert("schema".into(), json!({ "type": "string" }));
    p.insert("example".into(), json!(kv_str(kv, "value")));
    if let Some(d) = kv.get("description").and_then(Value::as_str).filter(|d| !d.is_empty()) {
        p.insert("description".into(), json!(d));
    }
    Value::Object(p)
}

fn enabled(kv: &Value) -> bool {
    kv.get("enabled") == Some(&Value::Bool(true)) && !kv_str(kv, "key").is_empty()
}

pub fn folder_to_openapi(folder_name: &Value, requests: &[ReqLike]) -> Value {
    let mut paths = Map::new();
    for r in requests {
        let path = to_path(&r.url);
        // (r.method || 'GET').toLowerCase()
        let method = if r.method.is_empty() { "get".to_string() } else { r.method.to_lowercase() };
        let mut parameters: Vec<Value> = r.params.iter().filter(|p| enabled(p)).map(|p| param(p, "query")).collect();
        parameters.extend(r.headers.iter().filter(|h| enabled(h) && !is_credential_header(kv_str(h, "key"))).map(|h| param(h, "header")));
        let mut op = Map::new();
        op.insert("summary".into(), r.name.clone());
        if !r.description.is_empty() {
            op.insert("description".into(), json!(r.description));
        }
        if !r.tags.is_empty() {
            op.insert("tags".into(), json!(r.tags));
        }
        if !parameters.is_empty() {
            op.insert("parameters".into(), Value::Array(parameters));
        }
        if let Some(b) = request_body(r) {
            op.insert("requestBody".into(), b);
        }
        op.insert("responses".into(), json!({ "200": { "description": "OK" } }));
        // 같은 경로·메서드가 또 나오면 뒤의 것이 덮는다(자리는 처음 그대로) — JS 객체 대입과 같다.
        let slot = paths.entry(path).or_insert_with(|| Value::Object(Map::new()));
        if let Some(m) = slot.as_object_mut() {
            m.insert(method, Value::Object(op));
        }
    }
    json!({
        "openapi": "3.0.0",
        "info": { "title": folder_name, "version": "1.0.0", "description": "postq 에서 내보낸 OpenAPI (자격증명 값 미포함)" },
        "paths": paths,
    })
}

/// Content-Disposition 파일 이름 — `name.replace(/[^\w.-]+/g, '_')`. \w 는 u 플래그가 없어 ASCII 영숫자·_ 만.
pub fn file_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut in_run = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') {
            out.push(c);
            in_run = false;
        } else if !in_run {
            out.push('_');
            in_run = true;
        }
    }
    format!("{out}-openapi.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_schema_does_not_export_file_data() {
        let mut r = req("file", "POST", "/file");
        r.body_type = "binary".into();
        r.body = json!({"filename":"a.bin", "contentType":"image/png", "dataBase64":"AAH/"}).to_string();
        assert_eq!(request_body(&r), Some(json!({"content":{"image/png":{"schema":{"type":"string","format":"binary"}}}})));
    }

    fn req(name: &str, method: &str, url: &str) -> ReqLike {
        ReqLike {
            name: json!(name),
            method: method.into(),
            url: url.into(),
            description: String::new(),
            params: vec![],
            headers: vec![],
            body_type: "none".into(),
            body: String::new(),
            tags: vec![],
        }
    }

    #[test]
    fn 요청을_paths_operations_로_경로_추출() {
        let mut a = req("생성", "POST", "{{base}}/orders?dry=1");
        a.body_type = "json".into();
        a.body = r#"{"a":1}"#.into();
        a.params = vec![json!({ "key": "dry", "value": "1", "enabled": true })];
        let doc = folder_to_openapi(&json!("주문"), &[a, req("조회", "GET", "https://api.example.com/orders/{id}")]);
        assert_eq!(doc["openapi"], "3.0.0");
        assert_eq!(doc["info"]["title"], "주문");
        assert_eq!(doc["paths"]["/orders"]["post"]["summary"], "생성");
        assert_eq!(doc["paths"]["/orders"]["post"]["parameters"][0]["name"], "dry");
        assert_eq!(doc["paths"]["/orders"]["post"]["parameters"][0]["in"], "query");
        assert_eq!(doc["paths"]["/orders"]["post"]["requestBody"]["content"]["application/json"]["example"], json!({ "a": 1 }));
        assert_eq!(doc["paths"]["/orders/{id}"]["get"]["summary"], "조회");
    }

    #[test]
    fn 인증_헤더는_파라미터에서_제외() {
        let mut r = req("r", "GET", "/x");
        r.headers = vec![json!({ "key": "Authorization", "value": "Bearer t", "enabled": true }), json!({ "key": "X-Trace", "value": "1", "enabled": true })];
        let doc = folder_to_openapi(&json!("f"), &[r]);
        let params = doc["paths"]["/x"]["get"]["parameters"].as_array().unwrap();
        assert!(!params.iter().any(|p| p["name"] == "Authorization"));
        assert!(params.iter().any(|p| p["name"] == "X-Trace"));
    }

    #[test]
    fn 경로_추출은_new_url_과_같은_자리에서_갈린다() {
        assert_eq!(to_path("{{baseUrl}}/a/b?x=1"), "/a/b");
        assert_eq!(to_path("https://h/a%20b/{id}"), "/a b/{id}");
        assert_eq!(to_path("https://h"), "/");
        assert_eq!(to_path("http://{{host}}/v1/x"), "/v1/x");
        assert_eq!(to_path("{{baseUrl}}"), "/");
        assert_eq!(to_path("abc"), "/abc");
        assert_eq!(to_path("/x"), "/x");
        // 스킴처럼 읽히는 주소 — JS 의 new URL 도 'localhost' 를 스킴으로 본다.
        assert_eq!(to_path("localhost:8080/x"), "8080/x");
        // 깨진 % 는 decodeURIComponent 가 던져 아래 갈래로 간다.
        assert_eq!(to_path("https://h/a%E0%A4%A"), "/a%E0%A4%A");
    }

    #[test]
    fn 바디_종류별_content_type() {
        let mut r = req("r", "POST", "/x");
        r.body_type = "raw".into();
        r.body = "hi".into();
        assert_eq!(request_body(&r), Some(json!({ "content": { "text/plain": { "example": "hi" } } })));
        r.body_type = "json".into();
        r.body = "{깨짐".into();
        assert_eq!(request_body(&r), Some(json!({ "content": { "application/json": { "example": "{깨짐" } } })));
        r.body = String::new();
        assert_eq!(request_body(&r), None);
    }

    #[test]
    fn 파일_이름() {
        assert_eq!(file_name("주문 API v1.2"), "_API_v1.2-openapi.json");
        assert_eq!(file_name("a/b"), "a_b-openapi.json");
    }
}
