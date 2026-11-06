//! API 구조 계약(ApiContract)의 읽기·비교.
//!
//! 스펙 동기화가 저장된 계약과 새 계약을 비교해 무엇이 바뀌었는지 남기는 데 이 둘이 필요하다.
//! 계약을 스펙에서 뽑는 operationContract 도 여기 있다 —
//! 저장된 계약과 새로 뽑은 계약을 같은 규칙으로 만들어야 '바뀌지 않은 것' 이 바뀐 것으로 뜨지 않는다.

use serde_json::{json, Map, Value};

use crate::js;

/// 문자열이면 JSON 으로 읽고, 모양(fields 객체 + incomplete 배열, 각 필드의 type 문자열·required 불리언)이
/// 맞을 때만 { fields, incomplete(문자열만) } 를 돌려준다.
pub fn parse_contract(value: Option<&Value>) -> Option<Value> {
    let parsed;
    let value = match value {
        Some(Value::String(s)) => {
            parsed = serde_json::from_str::<Value>(s).ok()?;
            &parsed
        }
        Some(v) => v,
        None => return None,
    };
    let v = value.as_object()?;
    let fields = v.get("fields")?.as_object()?;
    let incomplete = v.get("incomplete")?.as_array()?;
    let bad = fields.values().any(|f| {
        !js::truthy(Some(f)) || !f.get("type").map_or(false, Value::is_string) || !f.get("required").map_or(false, Value::is_boolean)
    });
    if bad {
        return None;
    }
    Some(json!({
        "fields": fields,
        "incomplete": incomplete.iter().filter(|x| x.is_string()).cloned().collect::<Vec<_>>(),
    }))
}

/// Array.prototype.includes 의 SameValueZero — 객체·배열 요소는 서로 다른 것(동일성 비교라 다시 읽은 값끼리는 같지 않다).
fn includes(arr: &[Value], x: &Value) -> bool {
    arr.iter().any(|a| match (a, x) {
        (Value::Number(p), Value::Number(q)) => p.as_f64() == q.as_f64(),
        (Value::Array(_) | Value::Object(_), _) | (_, Value::Array(_) | Value::Object(_)) => false,
        _ => a == x,
    })
}

fn description(f: Option<&Value>) -> String {
    let Some(f) = f else { return "(없음)".into() };
    let mut s = format!(
        "{} · {}",
        f.get("type").map_or("undefined".into(), js::to_string),
        if js::truthy(f.get("required")) { "필수" } else { "선택" }
    );
    if let Some(e) = f.get("enum").filter(|e| js::truthy(Some(e))) {
        s.push_str(&format!(" · 허용값 {}", js::stringify(e)));
    }
    if let Some(c) = f.get("constraints").filter(|c| js::truthy(Some(c))) {
        s.push_str(&format!(" · {}", js::stringify(c)));
    }
    s
}

fn fields_of(c: &Value) -> Map<String, Value> {
    c.get("fields").and_then(Value::as_object).cloned().unwrap_or_default()
}

fn incomplete_of(c: &Value) -> Vec<Value> {
    c.get("incomplete").and_then(Value::as_array).cloned().unwrap_or_default()
}

/// 두 계약의 차이. 한쪽이라도 없으면 [] — 처음 잡은 계약은 기준선이지 변경이 아니다.
pub fn diff_contract(before: Option<&Value>, after: Option<&Value>) -> Vec<Value> {
    let (Some(before), Some(after)) = (before.filter(|v| js::truthy(Some(v))), after.filter(|v| js::truthy(Some(v)))) else {
        return vec![];
    };
    let (bf, af) = (fields_of(before), fields_of(after));
    // new Set([...Object.keys(before.fields), ...Object.keys(after.fields)]) — JS 객체 키 순서.
    let mut keys: Vec<&String> = js::object_keys(&bf);
    for k in js::object_keys(&af) {
        if !keys.contains(&k) {
            keys.push(k);
        }
    }
    let mut changes = vec![];
    for key in keys {
        let (a, b) = (bf.get(key), af.get(key));
        if a.map(js::stringify) == b.map(js::stringify) {
            continue;
        }
        let input = key.starts_with("요청 ");
        let req = |f: &Value| js::truthy(f.get("required"));
        let severity = match (a, b) {
            (None, Some(b)) => {
                if input && req(b) {
                    "breaking"
                } else {
                    "info"
                }
            }
            (_, None) => "breaking",
            (Some(a), Some(b)) => {
                let type_or_required = a.get("type") != b.get("type") || if input { !req(a) && req(b) } else { req(a) && !req(b) };
                let narrowed = match (a.get("enum"), b.get("enum")) {
                    (Some(ae), Some(be)) if js::truthy(Some(ae)) && js::truthy(Some(be)) => {
                        let (ae, be) = (ae.as_array().cloned().unwrap_or_default(), be.as_array().cloned().unwrap_or_default());
                        if input {
                            ae.iter().any(|v| !includes(&be, v))
                        } else {
                            be.iter().any(|v| !includes(&ae, v))
                        }
                    }
                    _ => false,
                };
                if type_or_required || narrowed {
                    "breaking"
                } else {
                    "review"
                }
            }
        };
        let label = match severity {
            "breaking" => "호환성 주의",
            "review" => "검토 필요",
            _ => "스키마 변경",
        };
        changes.push(json!({ "label": format!("{label} · {key}"), "from": description(a), "to": description(b), "severity": severity }));
    }
    let (bi, ai) = (incomplete_of(before), incomplete_of(after));
    if !ai.is_empty() && js::stringify(&Value::Array(bi.clone())) != js::stringify(&Value::Array(ai.clone())) {
        let join = |v: &[Value]| v.iter().map(js::to_string).collect::<Vec<_>>().join(", ");
        let from = join(&bi);
        changes.push(json!({
            "label": "분석 범위 확인",
            "from": if from.is_empty() { "없음".to_string() } else { from },
            "to": join(&ai),
            "severity": "review",
        }));
    }
    changes
}

/// JS 의 기본 sort() — 값을 문자열로 바꿔 UTF-16 단위로 비교한다(안정 정렬).
pub fn js_default_sort(v: &mut [Value]) {
    v.sort_by(|a, b| js::to_string(a).encode_utf16().cmp(js::to_string(b).encode_utf16()));
}

/// `object(v)` — 배열이 아닌 객체만 그대로, 나머지는 {}.
fn obj(v: Option<&Value>) -> Map<String, Value> {
    v.and_then(Value::as_object).cloned().unwrap_or_default()
}

/// `$ref` 의 '#/a/b' 경로를 스펙 안에서 따라간다(~1 → /, ~0 → ~).
fn pointer<'a>(spec: &'a Value, path: &str) -> Option<&'a Value> {
    let mut cur = spec;
    for k in path.split('/') {
        let k = k.replace("~1", "/").replace("~0", "~");
        cur = match cur {
            Value::Object(o) => o.get(&k)?,
            Value::Array(a) => a.get(k.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(cur)
}

struct Walker<'a> {
    spec: &'a Value,
    fields: Map<String, Value>,
    incomplete: Vec<String>,
}

impl Walker<'_> {
    /// resolve — $ref 를 끝까지 따라간 객체. 따라갈 수 없으면(외부 참조·순환·없는 대상) None(null).
    fn resolve(&self, raw: Option<&Value>, seen: &mut Vec<String>) -> Option<Map<String, Value>> {
        let s = obj(raw);
        if !js::truthy(s.get("$ref")) {
            return Some(s);
        }
        let r = s.get("$ref").and_then(Value::as_str)?;
        if !r.starts_with("#/") || seen.iter().any(|x| x == r) {
            return None;
        }
        let found = pointer(self.spec, &r[2..]).filter(|v| js::truthy(Some(v)))?.clone();
        seen.push(r.to_string());
        self.resolve(Some(&found), seen)
    }

    fn walk(&mut self, raw: Option<&Value>, path: String, required: bool, depth: usize, refs: &[Value]) {
        let ref_v = obj(raw).get("$ref").cloned();
        let has_ref = ref_v.as_ref().map_or(false, |r| js::truthy(Some(r)));
        // Set.has 는 원시값만 값으로 같다 — 객체 $ref 는 늘 다른 것.
        let seen_ref = has_ref && refs.iter().any(|x| Some(x) == ref_v.as_ref() && !x.is_object() && !x.is_array());
        if depth > 12 || seen_ref {
            self.incomplete.push(path);
            return;
        }
        let s = match self.resolve(raw, &mut vec![]) {
            Some(s) if !s.is_empty() => s,
            _ => {
                self.incomplete.push(path);
                return;
            }
        };
        let mut next_refs = refs.to_vec();
        if has_ref {
            next_refs.push(ref_v.clone().unwrap_or(Value::Null));
        }
        let mut constraints = Map::new();
        for k in ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "pattern", "minItems", "maxItems", "additionalProperties", "format", "nullable"] {
            if let Some(v) = s.get(k) {
                constraints.insert(k.into(), v.clone());
            }
        }
        let ty = match s.get("type") {
            Some(Value::Array(a)) => {
                let mut a = a.clone();
                js_default_sort(&mut a);
                Value::String(a.iter().map(|x| if x.is_null() { String::new() } else { js::to_string(x) }).collect::<Vec<_>>().join("|"))
            }
            Some(v) if !v.is_null() => v.clone(),
            _ => Value::String(
                if js::truthy(s.get("properties")) {
                    "object"
                } else if js::truthy(s.get("items")) {
                    "array"
                } else {
                    "unknown"
                }
                .into(),
            ),
        };
        let mut f = Map::new();
        f.insert("type".into(), ty);
        f.insert("required".into(), Value::Bool(required));
        if let Some(Value::Array(e)) = s.get("enum") {
            let mut e = e.clone();
            js_default_sort(&mut e);
            f.insert("enum".into(), Value::Array(e));
        }
        if !constraints.is_empty() {
            f.insert("constraints".into(), Value::Object(constraints));
        }
        self.fields.insert(path.clone(), Value::Object(f));
        if ["oneOf", "anyOf", "allOf", "not"].iter().any(|k| js::truthy(s.get(*k))) {
            self.incomplete.push(format!("{path} (조합 스키마)"));
        }
        let props = obj(s.get("properties"));
        let req_list = s.get("required").and_then(Value::as_array).cloned();
        for name in js::object_keys(&props) {
            let req = req_list.as_ref().map_or(false, |r| r.iter().any(|x| x.as_str() == Some(name.as_str())));
            self.walk(props.get(name), format!("{path}.{name}"), req, depth + 1, &next_refs);
        }
        if js::truthy(s.get("items")) {
            self.walk(s.get("items"), format!("{path}[]"), false, depth + 1, &next_refs);
        }
    }
}

/// operationContract — 오퍼레이션 하나의 구조 계약(예시·사용자 값과 무관). params 는 경로·오퍼레이션 파라미터를 이은 것.
pub fn operation_contract(spec: &Value, op: &Value, params: &[Value]) -> Value {
    let mut w = Walker { spec, fields: Map::new(), incomplete: vec![] };
    for raw in params {
        let p = w.resolve(Some(raw), &mut vec![]);
        let Some(p) = p.filter(|p| js::truthy(p.get("name")) && js::truthy(p.get("in"))) else {
            w.incomplete.push("파라미터 참조".into());
            continue;
        };
        let (pin, pname) = (js::to_string(&p["in"]), js::to_string(&p["name"]));
        let required = p.get("in").and_then(Value::as_str) == Some("path") || p.get("required") == Some(&Value::Bool(true));
        w.walk(p.get("schema"), format!("요청 {pin}.{pname}"), required, 0, &[]);
    }
    let body = w.resolve(op.get("requestBody"), &mut vec![]);
    let body_required = body.as_ref().and_then(|b| b.get("required")) == Some(&Value::Bool(true));
    let content = obj(body.as_ref().and_then(|b| b.get("content")));
    for media in js::object_keys(&content) {
        let schema = obj(content.get(media)).get("schema").cloned();
        w.walk(schema.as_ref(), format!("요청 body[{media}]"), body_required, 0, &[]);
    }
    let responses = obj(op.get("responses"));
    if responses.is_empty() {
        w.incomplete.push("응답 정의 없음".into());
    }
    for code in js::object_keys(&responses) {
        let Some(response) = w.resolve(responses.get(code), &mut vec![]) else {
            w.incomplete.push(format!("응답 {code}"));
            continue;
        };
        w.fields.insert(format!("응답 {code}"), json!({ "type": "response", "required": false }));
        let content = obj(response.get("content"));
        if content.is_empty() && code != "204" && code != "304" {
            w.incomplete.push(format!("응답 {code} 스키마 없음"));
        }
        for media in js::object_keys(&content) {
            let schema = obj(content.get(media)).get("schema").cloned();
            w.walk(schema.as_ref(), format!("응답 {code}[{media}]"), false, 0, &[]);
        }
        let headers = obj(response.get("headers"));
        for name in js::object_keys(&headers) {
            let header = w.resolve(headers.get(name), &mut vec![]);
            let schema = header.as_ref().and_then(|h| h.get("schema")).cloned();
            let req = header.as_ref().and_then(|h| h.get("required")) == Some(&Value::Bool(true));
            w.walk(schema.as_ref(), format!("응답 {code} header.{}", name.to_lowercase()), req, 0, &[]);
        }
    }
    // Object.fromEntries(entries.sort(localeCompare)) — 정수 모양 키는 stringify 가 다시 앞으로 보낸다(JS 와 같다).
    let mut entries: Vec<(String, Value)> = w.fields.into_iter().collect();
    entries.sort_by(|a, b| crate::sort_order::locale_compare(&a.0, &b.0));
    let mut inc: Vec<String> = vec![];
    for i in w.incomplete {
        if !inc.contains(&i) {
            inc.push(i);
        }
    }
    inc.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    json!({ "fields": Value::Object(entries.into_iter().collect()), "incomplete": inc })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn contract(amount_type: &str, required: bool) -> Value {
        json!({ "fields": { "응답 200": { "type": "response", "required": false }, "응답 200[application/json].amount": { "type": amount_type, "required": required } }, "incomplete": [] })
    }

    // apiContract.test.ts·collectorRelease.test.ts 의 비교 규칙을 옮긴 것(계약은 손으로 만든다).
    #[test]
    fn 응답_필드_형식이_바뀌면_호환성_주의() {
        let changes = diff_contract(Some(&contract("number", false)), Some(&contract("string", false)));
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0]["severity"], "breaking");
        assert_eq!(changes[0]["label"], "호환성 주의 · 응답 200[application/json].amount");
        assert_eq!(changes[0]["from"], "number · 선택");
        assert_eq!(changes[0]["to"], "string · 선택");
    }

    #[test]
    fn 새_필수_요청_파라미터는_호환성_주의() {
        let before = json!({ "fields": {}, "incomplete": [] });
        let after = json!({ "fields": { "요청 query.channel": { "type": "string", "required": true, "enum": ["APP", "WEB"] } }, "incomplete": [] });
        let c = diff_contract(Some(&before), Some(&after));
        assert_eq!(c[0]["label"], "호환성 주의 · 요청 query.channel");
        assert_eq!(c[0]["to"], r#"string · 필수 · 허용값 ["APP","WEB"]"#);
    }

    #[test]
    fn 제약_변경은_검토_허용값_축소는_호환성_주의() {
        let a = json!({ "fields": { "요청 query.q": { "type": "string", "required": false, "constraints": { "maxLength": 20 } } }, "incomplete": [] });
        let b = json!({ "fields": { "요청 query.q": { "type": "string", "required": false, "constraints": { "maxLength": 10 } } }, "incomplete": [] });
        assert_eq!(diff_contract(Some(&a), Some(&b))[0]["severity"], "review");
        let e1 = json!({ "fields": { "요청 query.c": { "type": "string", "required": false, "enum": ["A", "B"] } }, "incomplete": [] });
        let e2 = json!({ "fields": { "요청 query.c": { "type": "string", "required": false, "enum": ["A"] } }, "incomplete": [] });
        assert_eq!(diff_contract(Some(&e1), Some(&e2))[0]["severity"], "breaking");
        assert_eq!(diff_contract(Some(&e2), Some(&e1))[0]["severity"], "review");
    }

    #[test]
    fn 기준선이_없으면_변경도_없다_분석_범위_변화는_알린다() {
        assert!(diff_contract(None, Some(&contract("number", false))).is_empty());
        let a = json!({ "fields": {}, "incomplete": [] });
        let b = json!({ "fields": {}, "incomplete": ["응답 200 스키마 없음"] });
        let c = diff_contract(Some(&a), Some(&b));
        assert_eq!(c[0], json!({ "label": "분석 범위 확인", "from": "없음", "to": "응답 200 스키마 없음", "severity": "review" }));
    }

    #[test]
    fn parse_contract_는_모양이_맞을_때만() {
        assert_eq!(parse_contract(Some(&json!("broken"))), None);
        assert_eq!(parse_contract(None), None);
        assert_eq!(parse_contract(Some(&json!({ "fields": [], "incomplete": [] }))), None);
        assert_eq!(parse_contract(Some(&json!({ "fields": { "a": { "type": 1, "required": true } }, "incomplete": [] }))), None);
        let ok = parse_contract(Some(&json!(r#"{"fields":{"a":{"type":"x","required":true}},"incomplete":["p",3]}"#))).unwrap();
        assert_eq!(ok, json!({ "fields": { "a": { "type": "x", "required": true } }, "incomplete": ["p"] }));
        assert_eq!(parse_contract(Some(&Value::Null)), None);
        assert_eq!(parse_contract(Some(&json!(r#"{"fields":{"x":null},"incomplete":[]}"#))), None);
        let ok = r#"{"fields":{"응답 200":{"type":"response","required":false}},"incomplete":["a",1]}"#;
        assert_eq!(parse_contract(Some(&json!(ok))), Some(json!({"fields": {"응답 200": {"type": "response", "required": false}}, "incomplete": ["a"]})));
        assert_eq!(parse_contract(Some(&Value::Null)), None);
        assert_eq!(parse_contract(Some(&json!(r#"{"fields":{"x":null},"incomplete":[]}"#))), None);
        let ok = r#"{"fields":{"응답 200":{"type":"response","required":false}},"incomplete":["a",1]}"#;
        assert_eq!(parse_contract(Some(&json!(ok))), Some(json!({"fields": {"응답 200": {"type": "response", "required": false}}, "incomplete": ["a"]})));
    }
}
