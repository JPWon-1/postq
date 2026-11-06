//! OpenAPI 스펙 → 요청 템플릿 초안(TemplateDraft).
//!
//! 초안은 JSON 값(serde_json::Value)으로 다룬다. TS 쪽이 스펙을 any 로 읽어 '있는 대로' 옮겼고,
//! 그 결과가 그대로 DB 의 JSON 열(params·headers)과 fingerprint 문자열이 된다. 타입으로 좁히면
//! 숫자 이름·없는 설명 같은 모양이 바뀌어, 이미 저장된 요청 전부가 '스펙 바뀜' 으로 뜬다.
//! undefined 인 필드는 키를 아예 넣지 않는다 — JSON.stringify 가 지우는 것과 같은 결과다.

use serde_json::{json, Map, Value};

use crate::api_contract::operation_contract;
use crate::js;

pub const METHODS: [&str; 5] = ["get", "post", "put", "patch", "delete"];

fn get<'a>(v: Option<&'a Value>, k: &str) -> Option<&'a Value> {
    v?.as_object()?.get(k)
}

fn truthy(v: Option<&Value>) -> bool {
    js::truthy(v)
}

/// `String(ref).split('/').pop()`
fn ref_name(r: &Value) -> String {
    js::to_string(r).rsplit('/').next().unwrap_or("").to_string()
}

fn schema_of<'a>(components: Option<&'a Value>, name: &str) -> Option<&'a Value> {
    get(get(components, "schemas"), name)
}

/// `Object.entries(v)` — 객체만. JS 객체 키 순서(정수 모양 키 먼저).
fn entries(v: Option<&Value>) -> Vec<(String, Value)> {
    match v.and_then(Value::as_object) {
        Some(o) => js::object_keys(o).into_iter().map(|k| (k.clone(), o[k].clone())).collect(),
        None => vec![],
    }
}

fn trimmed_str(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).map(|s| js::trim(s).to_string())
}

/// 예시 JSON — 스키마를 따라 기본값으로 채운다. 깊이 5 를 넘거나 순환하면 null 로 끊는다.
fn example_from_schema(schema: Option<&Value>, components: Option<&Value>, depth: usize) -> Value {
    if !truthy(schema) || depth > 5 {
        return Value::Null;
    }
    if let Some(r) = get(schema, "$ref").filter(|r| truthy(Some(r))) {
        return example_from_schema(schema_of(components, &ref_name(r)), components, depth + 1);
    }
    if let Some(ex) = get(schema, "example") {
        return ex.clone();
    }
    match get(schema, "type").and_then(Value::as_str) {
        Some("object") => {
            let mut obj = Map::new();
            for (k, v) in entries(get(schema, "properties")) {
                obj.insert(k, example_from_schema(Some(&v), components, depth + 1));
            }
            Value::Object(obj)
        }
        Some("array") => Value::Array(vec![example_from_schema(get(schema, "items"), components, depth + 1)]),
        Some("integer") | Some("number") => json!(0),
        Some("boolean") => json!(false),
        // schema.enum?.[0] ?? ''
        Some("string") => match get(schema, "enum").and_then(Value::as_array).and_then(|a| a.first()) {
            Some(v) if !v.is_null() => v.clone(),
            _ => json!(""),
        },
        _ => Value::Null,
    }
}

/// 'integer(int64)' · 'string' · 'array<Item>' 처럼 한 줄로. enum 은 options 로 따로 나가므로 넣지 않는다.
fn schema_type_text(schema: Option<&Value>) -> Option<String> {
    if !truthy(schema) {
        return None;
    }
    if let Some(r) = get(schema, "$ref").filter(|r| truthy(Some(r))) {
        return Some(short_schema_name(&ref_name(r)));
    }
    let ty = get(schema, "type");
    if ty.and_then(Value::as_str) == Some("array") {
        return Some(match schema_type_text(get(schema, "items")) {
            Some(inner) if !inner.is_empty() => format!("array<{inner}>"),
            _ => "array".into(),
        });
    }
    let ty = ty?.as_str()?;
    match get(schema, "format").filter(|f| truthy(Some(f))) {
        Some(f) => Some(format!("{ty}({})", js::to_string(f))),
        None => Some(ty.to_string()),
    }
}

/// springdoc use-fqn 이면 스키마 이름이 패키지째 온다 — 보여줄 때만 끝부분으로 줄인다.
fn short_schema_name(name: &str) -> String {
    match name.rsplit('.').next() {
        Some(last) if !last.is_empty() => last.to_string(),
        _ => name.to_string(),
    }
}

fn options_of(v: Option<&Value>) -> Option<Value> {
    v.and_then(Value::as_array).map(|a| Value::Array(a.iter().map(|x| Value::String(js::to_string(x))).collect()))
}

/// 스펙 파라미터 한 항목 → 화면용 한 줄. path 파라미터도 싣는다(실행용 KV 에는 안 들어간다).
fn to_spec_param(p: &Value) -> Option<Value> {
    if !truthy(get(Some(p), "name")) || !truthy(get(Some(p), "in")) {
        return None;
    }
    let wh = get(Some(p), "in")?.as_str()?;
    if !["path", "query", "header", "cookie"].contains(&wh) {
        return None;
    }
    let d = trimmed_str(get(Some(p), "description")).unwrap_or_default();
    let mut m = Map::new();
    m.insert("name".into(), json!(js::to_string(&p["name"])));
    m.insert("in".into(), json!(wh));
    // path 는 스펙상 항상 필수다
    m.insert("required".into(), json!(get(Some(p), "required") == Some(&Value::Bool(true)) || wh == "path"));
    if let Some(t) = schema_type_text(get(Some(p), "schema")) {
        m.insert("type".into(), json!(t));
    }
    if !d.is_empty() {
        m.insert("description".into(), json!(d));
    }
    if let Some(o) = options_of(get(get(Some(p), "schema"), "enum")) {
        m.insert("options".into(), o);
    }
    Some(Value::Object(m))
}

/// 요청 바디 스키마 → 필드 목록(보여주기용). 깊이 3 까지만 편다 — 그 아래는 스키마 덤프가 된다.
fn flatten_body_fields(schema: Option<&Value>, components: Option<&Value>, prefix: &str, depth: usize, seen: &[String]) -> Vec<Value> {
    if !truthy(schema) || depth > 3 {
        return vec![];
    }
    if let Some(r) = get(schema, "$ref").filter(|r| truthy(Some(r))) {
        let name = ref_name(r);
        // 스스로를 품는 스키마(트리 구조)가 실제로 있다 — 안 막으면 무한히 돈다.
        if seen.contains(&name) {
            return vec![];
        }
        let mut next = seen.to_vec();
        next.push(name.clone());
        return flatten_body_fields(schema_of(components, &name), components, prefix, depth, &next);
    }
    if get(schema, "type").and_then(Value::as_str) == Some("array") {
        return flatten_body_fields(get(schema, "items"), components, &format!("{prefix}[]"), depth, seen);
    }
    let required: Vec<Value> = get(schema, "required").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut out = vec![];
    for (key, raw) in entries(get(schema, "properties")) {
        let raw_ref = get(Some(&raw), "$ref").filter(|r| truthy(Some(r)));
        let resolved: Option<Value> = match raw_ref {
            Some(r) => schema_of(components, &ref_name(r)).cloned(),
            None => Some(raw.clone()),
        };
        let path = if prefix.is_empty() { key.clone() } else { format!("{prefix}.{key}") };
        let mut f = Map::new();
        f.insert("path".into(), json!(path));
        if let Some(t) = schema_type_text(Some(&raw)) {
            f.insert("type".into(), json!(t));
        }
        f.insert("required".into(), json!(required.iter().any(|x| x.as_str() == Some(key.as_str()))));
        let desc = match get(resolved.as_ref(), "description").and_then(Value::as_str) {
            Some(d) => Some(js::trim(d).to_string()),
            None => trimmed_str(get(Some(&raw), "description")),
        };
        if let Some(d) = desc.filter(|d| !d.is_empty()) {
            f.insert("description".into(), json!(d));
        }
        if let Some(o) = options_of(get(resolved.as_ref(), "enum")) {
            f.insert("options".into(), o);
        }
        out.push(Value::Object(f));
        // 객체·배열이면 한 단계 더 편다.
        let is_array = get(resolved.as_ref(), "type").and_then(Value::as_str) == Some("array");
        let child: Option<Value> = if is_array { get(resolved.as_ref(), "items").cloned() } else { resolved.clone() };
        let child_ref = get(child.as_ref(), "$ref").filter(|r| truthy(Some(r))).map(ref_name);
        let child_resolved: Option<Value> = match &child_ref {
            Some(n) => schema_of(components, n).cloned(),
            None => child.clone(),
        };
        if truthy(get(child_resolved.as_ref(), "properties")) {
            let mut next = seen.to_vec();
            next.extend(child_ref);
            let p = if is_array { format!("{path}[]") } else { path.clone() };
            out.extend(flatten_body_fields(child_resolved.as_ref(), components, &p, depth + 1, &next));
        }
    }
    out
}

/// 파라미터 설명 — 필수 여부를 앞에 붙인다('필수 · 페이지 크기'). 비면 None.
fn describe(p: &Value) -> Option<String> {
    let d = trimmed_str(get(Some(p), "description")).unwrap_or_default();
    let req = if truthy(get(Some(p), "required")) { "필수" } else { "" };
    let text = [req, d.as_str()].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join(" · ");
    (!text.is_empty()).then_some(text)
}

fn kv(key: &Value, enabled: bool, description: Option<String>) -> Value {
    let mut m = Map::new();
    m.insert("key".into(), key.clone());
    m.insert("value".into(), json!(""));
    m.insert("enabled".into(), json!(enabled));
    if let Some(d) = description {
        m.insert("description".into(), json!(d));
    }
    Value::Object(m)
}

/// `p.description ?? ''`
fn desc_or_empty(p: &Value) -> Value {
    match p.get("description") {
        Some(v) if !v.is_null() => v.clone(),
        _ => json!(""),
    }
}

/// specToDrafts — 경로·메서드마다 초안 하나.
pub fn spec_to_drafts(spec: &Value) -> Vec<Value> {
    let components = get(Some(spec), "components");
    let mut drafts = vec![];
    for (path, item) in entries(get(Some(spec), "paths")) {
        // TS 는 item 이 null 이면 item.parameters 에서 TypeError 였다 — 그 경로 하나를 건너뛴다.
        if item.is_null() {
            continue;
        }
        let path_params: Vec<Value> = get(Some(&item), "parameters").and_then(Value::as_array).cloned().unwrap_or_default();
        for method in METHODS {
            let Some(op) = get(Some(&item), method).filter(|o| truthy(Some(o))) else { continue };
            let op_params: Vec<Value> = get(Some(op), "parameters").and_then(Value::as_array).cloned().unwrap_or_default();
            let all_raw: Vec<Value> = path_params.iter().chain(op_params.iter()).cloned().collect();
            // Map 에 `${in}:${name}` 으로 — 같은 키는 자리를 지킨 채 값만 뒤의 것(오퍼레이션 쪽)으로.
            let mut merged: Vec<(String, Value)> = vec![];
            for p in &all_raw {
                if truthy(get(Some(p), "name")) && truthy(get(Some(p), "in")) {
                    let k = format!("{}:{}", js::to_string(&p["in"]), js::to_string(&p["name"]));
                    match merged.iter_mut().find(|(mk, _)| *mk == k) {
                        Some(slot) => slot.1 = p.clone(),
                        None => merged.push((k, p.clone())),
                    }
                }
            }
            let all_params: Vec<Value> = merged.into_iter().map(|(_, p)| p).collect();
            let in_is = |p: &Value, w: &str| p.get("in").and_then(Value::as_str) == Some(w);
            // 값이 없는 쿼리 파라미터는 꺼둔 채로 — 빈 문자열을 보내면 서버가 '필터 있음' 으로 받아
            // 인덱스를 못 타는 쿼리를 만드는 경우가 있다(568ms → 16,962ms). 필수는 켜 둔다.
            let params: Vec<Value> = all_params.iter().filter(|p| in_is(p, "query")).map(|p| kv(&p["name"], truthy(p.get("required")), describe(p))).collect();
            let headers: Vec<Value> = all_params.iter().filter(|p| in_is(p, "header")).map(|p| kv(&p["name"], true, describe(p))).collect();
            let json_schema = get(get(get(get(Some(op), "requestBody"), "content"), "application/json"), "schema").filter(|s| truthy(Some(s)));
            let body_type = if json_schema.is_some() { "json" } else { "none" };
            let body = match json_schema {
                Some(s) => js::stringify_pretty(&example_from_schema(Some(s), components, 0), 2),
                None => String::new(),
            };
            let method_upper = method.to_uppercase();
            let operation_key = format!("{method_upper} {path}");
            let op_description = trimmed_str(get(Some(op), "description")).unwrap_or_default();

            let mut d = Map::new();
            let name = match get(Some(op), "summary").filter(|s| truthy(Some(s))) {
                Some(s) => s.clone(),
                None => json!(operation_key),
            };
            d.insert("name".into(), name);
            if !op_description.is_empty() {
                d.insert("description".into(), json!(op_description));
            }
            d.insert("method".into(), json!(method_upper));
            d.insert("url".into(), json!(format!("{{{{baseUrl}}}}{path}")));
            d.insert("params".into(), Value::Array(params.clone()));
            d.insert("headers".into(), Value::Array(headers.clone()));
            d.insert("bodyType".into(), json!(body_type));
            d.insert("body".into(), json!(body));
            if let Some(tags) = get(Some(op), "tags").and_then(Value::as_array) {
                d.insert("tags".into(), Value::Array(tags.iter().filter(|t| t.is_string()).cloned().collect()));
            }
            if get(Some(op), "deprecated") == Some(&Value::Bool(true)) {
                d.insert("deprecated".into(), json!(true));
            }
            d.insert("specParams".into(), Value::Array(all_params.iter().filter_map(to_spec_param).collect()));
            if let Some(s) = json_schema {
                d.insert("bodyFields".into(), Value::Array(flatten_body_fields(Some(s), components, "", 0, &[])));
            }
            let responses: Vec<Value> = entries(get(Some(op), "responses"))
                .into_iter()
                .map(|(code, r)| json!({ "code": code, "description": get(Some(&r), "description").and_then(Value::as_str).unwrap_or("") }))
                .collect();
            d.insert("responses".into(), Value::Array(responses));
            d.insert("operationKey".into(), json!(operation_key));
            d.insert("specContract".into(), operation_contract(spec, op, &all_raw));
            // fingerprint 에는 보여주기용 필드를 넣지 않는다 — 넣는 순간 저장된 요청 전부가 '스펙 바뀜' 으로 뜬다.
            let fp = json!([
                method_upper,
                path,
                params.iter().map(|p| json!([p["key"], desc_or_empty(p)])).collect::<Vec<_>>(),
                headers.iter().map(|h| json!([h["key"], desc_or_empty(h)])).collect::<Vec<_>>(),
                body,
                op_description,
            ]);
            d.insert("fingerprint".into(), json!(js::stringify(&fp)));
            drafts.push(Value::Object(d));
        }
    }
    drafts
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> Value {
        json!({
            "openapi": "3.0.1",
            "paths": {
                "/api/orders/{id}": {
                    "get": {
                        "summary": "주문 조회",
                        "parameters": [
                            { "name": "id", "in": "path", "required": true, "schema": { "type": "integer" } },
                            { "name": "detail", "in": "query", "schema": { "type": "boolean" } },
                            { "name": "X-Channel", "in": "header", "schema": { "type": "string" } },
                        ],
                    },
                    "post": { "requestBody": { "content": { "application/json": { "schema": { "$ref": "#/components/schemas/IssueReq" } } } } },
                },
            },
            "components": { "schemas": {
                "IssueReq": { "type": "object", "properties": {
                    "memberCode": { "type": "string" }, "count": { "type": "integer" }, "nested": { "$ref": "#/components/schemas/Nested" },
                } },
                "Nested": { "type": "object", "properties": { "flag": { "type": "boolean" }, "self": { "$ref": "#/components/schemas/Nested" } } },
            } },
        })
    }

    fn find<'a>(d: &'a [Value], k: &str, v: &str) -> &'a Value {
        d.iter().find(|x| x[k] == v).unwrap()
    }

    #[test]
    fn 경로_메서드별_드래프트() {
        let drafts = spec_to_drafts(&spec());
        assert_eq!(drafts.len(), 2);
        let g = find(&drafts, "method", "GET");
        assert_eq!(g["name"], "주문 조회");
        assert_eq!(g["url"], "{{baseUrl}}/api/orders/{id}");
        assert_eq!(g["operationKey"], "GET /api/orders/{id}");
        assert_eq!(g["params"], json!([{ "key": "detail", "value": "", "enabled": false }]));
        assert_eq!(g["headers"], json!([{ "key": "X-Channel", "value": "", "enabled": true }]));
        assert_eq!(g["bodyType"], "none");
    }

    #[test]
    fn 바디_스켈레톤_ref_해소_순환_가드() {
        let post = spec_to_drafts(&spec()).into_iter().find(|d| d["method"] == "POST").unwrap();
        assert_eq!(post["bodyType"], "json");
        let body: Value = serde_json::from_str(post["body"].as_str().unwrap()).unwrap();
        assert_eq!(body["memberCode"], "");
        assert_eq!(body["count"], 0);
        assert_eq!(body["nested"]["flag"], false);
    }

    #[test]
    fn fingerprint_는_스펙_변경에_반응하고_고정값과_같다() {
        let a = spec_to_drafts(&spec())[0]["fingerprint"].clone();
        let mut m = spec();
        m["paths"]["/api/orders/{id}"]["get"]["parameters"].as_array_mut().unwrap().push(json!({ "name": "extra", "in": "query" }));
        assert_ne!(a, spec_to_drafts(&m)[0]["fingerprint"]);
        assert_eq!(a, json!(r#"["GET","/api/orders/{id}",[["detail",""]],[["X-Channel",""]],"",""]"#));
    }

    #[test]
    fn 오퍼레이션_파라미터가_경로_파라미터를_덮는다() {
        let d = spec_to_drafts(&json!({ "paths": { "/items": {
            "parameters": [{ "name": "limit", "in": "query" }, { "name": "shared", "in": "query" }],
            "get": { "parameters": [{ "name": "limit", "in": "query", "schema": { "type": "string" } }] },
        } } }));
        assert_eq!(d.len(), 1);
        let keys: Vec<_> = d[0]["params"].as_array().unwrap().iter().map(|p| p["key"].clone()).collect();
        assert_eq!(keys, vec![json!("limit"), json!("shared")]);
    }

    #[test]
    fn 설명을_싣는다() {
        let d = &spec_to_drafts(&json!({ "paths": { "/orders": { "get": {
            "summary": "주문 조회", "description": "회원의 주문 목록을 조회합니다.",
            "parameters": [
                { "name": "size", "in": "query", "required": true, "description": "페이지 크기" },
                { "name": "X-Trace", "in": "header", "description": "추적 ID" },
                { "name": "nodesc", "in": "query" },
            ],
        } } } }))[0];
        assert_eq!(d["description"], "회원의 주문 목록을 조회합니다.");
        assert_eq!(d["params"][0], json!({ "key": "size", "value": "", "enabled": true, "description": "필수 · 페이지 크기" }));
        assert_eq!(d["params"][1], json!({ "key": "nodesc", "value": "", "enabled": false }));
        assert_eq!(d["headers"][0]["description"], "추적 ID");
    }

    #[test]
    fn 보여주기용_스펙_정보() {
        let d = &spec_to_drafts(&json!({ "paths": { "/jobs/{jobId}/cancel": { "post": {
            "summary": "중단", "tags": ["Admin"], "deprecated": true,
            "parameters": [
                { "name": "jobId", "in": "path", "required": true, "schema": { "type": "integer", "format": "int64" } },
                { "name": "force", "in": "query", "description": "강제 중단", "schema": { "type": "boolean" } },
                { "name": "sort", "in": "query", "schema": { "type": "array", "items": { "type": "string" } } },
                { "name": "status", "in": "query", "schema": { "type": "string", "enum": ["A", "B"] } },
            ],
            "responses": { "404": { "description": "Job 없음" }, "200": { "description": "OK" } },
        } } } }))[0];
        assert_eq!(d["tags"], json!(["Admin"]));
        assert_eq!(d["deprecated"], true);
        // 응답 코드는 정수 모양 키라 JS 처럼 숫자 순으로 온다.
        assert_eq!(d["responses"], json!([{ "code": "200", "description": "OK" }, { "code": "404", "description": "Job 없음" }]));
        assert_eq!(d["specParams"], json!([
            { "name": "jobId", "in": "path", "required": true, "type": "integer(int64)" },
            { "name": "force", "in": "query", "required": false, "type": "boolean", "description": "강제 중단" },
            { "name": "sort", "in": "query", "required": false, "type": "array<string>" },
            { "name": "status", "in": "query", "required": false, "type": "string", "options": ["A", "B"] },
        ]));
    }

    #[test]
    fn 바디_필드() {
        let d = &spec_to_drafts(&json!({
            "paths": { "/jobs": { "post": { "requestBody": { "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Req" } } } } } } },
            "components": { "schemas": {
                "com.example.deep.Item": { "type": "object", "required": ["code"], "properties": { "code": { "type": "string", "description": "상품 코드" } } },
                "Req": { "type": "object", "required": ["name", "status"], "properties": {
                    "name": { "type": "string", "description": "이름" },
                    "status": { "type": "string", "enum": ["ACTIVE", "PAUSED"], "description": "상태" },
                    "items": { "type": "array", "items": { "$ref": "#/components/schemas/com.example.deep.Item" } },
                } },
            } },
        }))[0];
        assert_eq!(d["bodyFields"], json!([
            { "path": "name", "type": "string", "required": true, "description": "이름" },
            { "path": "status", "type": "string", "required": true, "description": "상태", "options": ["ACTIVE", "PAUSED"] },
            { "path": "items", "type": "array<Item>", "required": false },
            { "path": "items[].code", "type": "string", "required": true, "description": "상품 코드" },
        ]));
    }

    #[test]
    fn 스스로를_품는_스키마여도_멈춘다() {
        let d = &spec_to_drafts(&json!({
            "paths": { "/t": { "post": { "requestBody": { "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Node" } } } } } } },
            "components": { "schemas": { "Node": { "type": "object", "properties": { "name": { "type": "string" }, "child": { "$ref": "#/components/schemas/Node" } } } } },
        }))[0];
        let n = d["bodyFields"].as_array().unwrap().len();
        assert!(n > 0 && n < 20);
    }

    // apiContract.test.ts 의 계약 규칙.
    fn doc(ty: &str, required: bool) -> Value {
        json!({ "openapi": "3.0.0", "paths": { "/orders/{id}": { "get": {
            "parameters": [{ "name": "id", "in": "path", "required": true, "schema": { "type": "string" } }, { "name": "channel", "in": "query", "required": required, "schema": { "type": "string", "enum": ["APP", "WEB"] } }],
            "responses": { "200": { "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Order" } } } } },
        } } }, "components": { "schemas": { "Order": { "type": "object", "required": ["discount"], "properties": { "discount": { "type": ty } } } } } })
    }

    #[test]
    fn 응답_스키마가_바뀌면_fingerprint_가_같아도_변경() {
        use crate::api_contract::diff_contract;
        let (b, a) = (&spec_to_drafts(&doc("number", false))[0], &spec_to_drafts(&doc("string", false))[0]);
        assert_eq!(b["fingerprint"], a["fingerprint"]);
        let c = diff_contract(Some(&b["specContract"]), Some(&a["specContract"]));
        assert!(c.iter().any(|x| x["label"].as_str().unwrap().contains("discount") && x["severity"] == "breaking"));
        let n = &spec_to_drafts(&doc("number", true))[0];
        let c = diff_contract(Some(&b["specContract"]), Some(&n["specContract"]));
        assert!(c.iter().any(|x| x["label"] == "호환성 주의 · 요청 query.channel" && x["severity"] == "breaking"));
    }

    #[test]
    fn 계약은_불완전한_곳을_밝히고_파라미터_순서와_무관하다() {
        let sp = json!({ "components": { "schemas": { "Node": { "type": "object", "properties": { "child": { "$ref": "#/components/schemas/Node" } } } } } });
        let op = json!({ "responses": { "200": { "description": "x" }, "201": { "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Node" } } } }, "202": { "content": { "application/json": { "schema": { "oneOf": [{ "type": "string" }] } } } } } });
        let c = operation_contract(&sp, &op, &[]);
        let inc: Vec<String> = c["incomplete"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
        assert!(inc.iter().any(|p| p.contains("200")));
        assert!(inc.iter().any(|p| p.contains("child")));
        assert!(inc.iter().any(|p| p.contains("조합")));
        let p = vec![json!({ "name": "q", "in": "query", "schema": { "type": "string", "maxLength": 20 } }), json!({ "name": "n", "in": "query", "schema": { "type": "number" } })];
        let rev: Vec<Value> = p.iter().rev().cloned().collect();
        assert_eq!(js::stringify(&operation_contract(&json!({}), &json!({}), &p)), js::stringify(&operation_contract(&json!({}), &json!({}), &rev)));
    }
}
