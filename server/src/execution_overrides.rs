//! 실행 입력 덮어쓰기 — MCP·시나리오가 저장 요청을 값만 바꿔 실행할 때.
//!
//! 공개 API
//! - [`parse_overrides`] → [`ExecutionOverrides`] — zod 스키마(strict, vars/params 는 문자열 record, body·bodyMerge 배타)와 같은 검사.
//! - [`overlay_execution_vars`] — 값만 덮고 secret 분류는 원래 변수의 것을 지킨다(빈 문자열 덮어쓰기 포함).
//! - [`apply_execution_overrides`] — params 교체·body 교체·bodyMerge(얕은 병합). 실패는 Err.
//! - [`describe_request`] — 탐색용 요청 구조(리터럴 값·자격증명은 내보내지 않는다).
//!
//! 덮어쓰기는 헤더·자격증명에 닿지 않는다 — 라우트가 해석 뒤 헤더를 기준선 것으로 되돌린다.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{json, Map, Value};

use crate::js;
use crate::resolve::{extract_path_parameters, extract_variables, Kv, RequestInput};
use crate::scrub::VAR_NAME_CHARS;
use crate::variables::{Var, VarMap};

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ExecutionOverrides {
    /// (키, 값) — Object.entries 순서.
    pub vars: Option<Vec<(String, String)>>,
    pub params: Option<Vec<(String, String)>>,
    pub body: Option<String>,
    pub body_merge: Option<Map<String, Value>>,
}

/// `z.record(z.string(), z.string())` — 배열·null 은 거부, 값은 모두 문자열.
fn string_record(v: &Value) -> Option<Vec<(String, String)>> {
    let o = v.as_object()?;
    js::object_keys(o).into_iter().map(|k| Some((k.clone(), o[k.as_str()].as_str()?.to_string()))).collect()
}

/// `b.overrides ?? {}` 를 받아 검사한다. 실패는 None(라우트가 400).
pub fn parse_overrides(v: Option<&Value>) -> Option<ExecutionOverrides> {
    let v = match v {
        None | Some(Value::Null) => return Some(ExecutionOverrides::default()),
        Some(v) => v,
    };
    let o = v.as_object()?;
    if o.keys().any(|k| !matches!(k.as_str(), "vars" | "params" | "body" | "bodyMerge")) {
        return None; // .strict()
    }
    let mut out = ExecutionOverrides::default();
    if let Some(x) = o.get("vars") {
        out.vars = Some(string_record(x)?);
    }
    if let Some(x) = o.get("params") {
        out.params = Some(string_record(x)?);
    }
    if let Some(x) = o.get("body") {
        out.body = Some(x.as_str()?.to_string());
    }
    if let Some(x) = o.get("bodyMerge") {
        out.body_merge = Some(x.as_object()?.clone());
    }
    if out.body.is_some() && out.body_merge.is_some() {
        return None; // 'body 와 bodyMerge 는 함께 사용할 수 없습니다'
    }
    Some(out)
}

/// secret 분류는 원래 변수의 것 — 저장된 스코프는 건드리지 않는다.
pub fn overlay_execution_vars(base: &VarMap, values: Option<&[(String, String)]>) -> VarMap {
    let mut out = base.clone();
    for (k, v) in values.unwrap_or(&[]) {
        let secret = base.get(k).map_or(false, |b| b.secret);
        out.insert(k, Var { value: v.clone(), secret });
    }
    out
}

/// JSON 얕은 병합 — 최상위 키는 교체, 안쪽 객체·배열은 통째로 교체.
pub fn apply_execution_overrides(input: &RequestInput, o: &ExecutionOverrides) -> Result<RequestInput, String> {
    let mut out = input.clone();
    if let Some(body) = &o.body {
        js::parse_json(body).ok_or("body 는 JSON 문자열이어야 합니다")?;
        out.body = body.clone();
        out.body_type = "json".into();
    } else if let Some(merge) = &o.body_merge {
        let base = if js::trim(&input.body).is_empty() { Some(Value::Object(Map::new())) } else { js::parse_json(&input.body) };
        let Some(Value::Object(mut base)) = base else { return Err("bodyMerge 는 저장된 JSON 객체 본문에만 사용할 수 있습니다".into()) };
        for (k, v) in merge {
            base.insert(k.clone(), v.clone());
        }
        out.body = js::stringify(&Value::Object(base));
        out.body_type = "json".into();
    }
    if let Some(params) = &o.params {
        out.params.retain(|p| !params.iter().any(|(k, _)| k == &p.key));
        out.params.extend(params.iter().map(|(k, v)| Kv::new(k, v)));
    }
    Ok(out)
}

fn whole_var_ref() -> &'static Regex {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"^\{{\{{{VAR_NAME_CHARS}+\}}\}}$")).expect("변수 참조"));
    &RE
}

/// 값 자리는 타입 이름(`<string>`)만, `{{변수}}` 하나뿐인 문자열은 그대로.
fn example(v: &Value) -> Value {
    match v {
        Value::Array(a) => Value::Array(a.iter().map(example).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), example(v))).collect()),
        Value::String(s) if whole_var_ref().is_match(s) => v.clone(),
        Value::Null => Value::Null,
        Value::String(_) => json!("<string>"),
        Value::Number(_) => json!("<number>"),
        Value::Bool(_) => json!("<boolean>"),
    }
}

/// 탐색용 — 구조와 변수 이름만, 리터럴 값·자격증명은 절대 내보내지 않는다.
pub fn describe_request(input: &RequestInput) -> Value {
    let body_example = js::parse_json(&input.body).map_or(Value::Null, |b| example(&b));
    json!({
        "method": input.method,
        "requiredVariables": extract_variables(input),
        "pathParameters": extract_path_parameters(&input.url),
        "queryParameters": input.params.iter().map(|p| p.key.clone()).collect::<Vec<_>>(),
        "bodyType": input.body_type,
        "bodyExample": body_example,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(body: &str) -> RequestInput {
        RequestInput { method: "POST".into(), url: "https://a/x".into(), params: vec![Kv::new("a", "1"), Kv::new("b", "2")], headers: vec![], body_type: "raw".into(), body: body.into() }
    }

    #[test]
    fn 스키마_검사() {
        assert_eq!(parse_overrides(None), Some(ExecutionOverrides::default()));
        assert!(parse_overrides(Some(&json!({ "headers": {} }))).is_none());
        assert!(parse_overrides(Some(&json!({ "vars": { "a": 1 } }))).is_none());
        assert!(parse_overrides(Some(&json!({ "vars": [] }))).is_none());
        assert!(parse_overrides(Some(&json!({ "body": "{}", "bodyMerge": {} }))).is_none());
        assert!(parse_overrides(Some(&json!("x"))).is_none());
        let o = parse_overrides(Some(&json!({ "vars": { "t": "v" }, "params": { "b": "9", "c": "3" } }))).unwrap();
        assert_eq!(o.vars, Some(vec![("t".into(), "v".into())]));
    }

    #[test]
    fn 덮어쓰기_적용() {
        let o = parse_overrides(Some(&json!({ "params": { "b": "9", "c": "3" }, "bodyMerge": { "y": [1], "x": 2 } }))).unwrap();
        let out = apply_execution_overrides(&input(r#"{"x":1,"z":true}"#), &o).unwrap();
        assert_eq!(out.params, vec![Kv::new("a", "1"), Kv::new("b", "9"), Kv::new("c", "3")]);
        assert_eq!(out.body, r#"{"x":2,"z":true,"y":[1]}"#);
        assert_eq!(out.body_type, "json");
        assert!(apply_execution_overrides(&input("[1]"), &o).is_err());
        assert_eq!(apply_execution_overrides(&input(" "), &o).unwrap().body, r#"{"y":[1],"x":2}"#);
        let o = parse_overrides(Some(&json!({ "body": "not json" }))).unwrap();
        assert!(apply_execution_overrides(&input(""), &o).is_err());
    }

    #[test]
    fn secret_분류는_원래_것() {
        let mut base = VarMap::new();
        base.insert("tok", Var { value: "S".into(), secret: true });
        let out = overlay_execution_vars(&base, Some(&[("tok".into(), "".into()), ("n".into(), "1".into())]));
        assert_eq!(out.get("tok").unwrap(), &Var { value: "".into(), secret: true });
        assert_eq!(out.get("n").unwrap().secret, false);
        assert_eq!(base.get("tok").unwrap().value, "S");
    }

    #[test]
    fn 요청_구조는_값을_숨긴다() {
        let mut i = input(r#"{"id":"{{id}}","name":"LITERAL","n":3,"a":[true,null]}"#);
        i.url = "{{base}}/x/{pid}".into();
        let d = describe_request(&i);
        assert_eq!(d["bodyExample"], json!({ "id": "{{id}}", "name": "<string>", "n": "<number>", "a": ["<boolean>", null] }));
        assert_eq!(d["requiredVariables"], json!(["base", "id"]));
        assert_eq!(d["pathParameters"], json!(["pid"]));
        assert_eq!(d["queryParameters"], json!(["a", "b"]));
        assert_eq!(describe_request(&input("plain"))["bodyExample"], Value::Null);
    }
}
