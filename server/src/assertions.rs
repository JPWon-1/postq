//! 응답 assertion.
//!
//! 규칙(assertion)은 저장 열·클라이언트 JSON 그대로(serde_json::Value) 받는다. 손편집으로 null·비객체가 섞이거나
//! path 가 숫자여도 그 항목만 이상하게 나올 뿐 실행 전체가 500 이 나면 안 된다.
//!
//! 공개 API
//! - [`AssertContext`]·[`evaluate_assertions`] → 결과 JSON 배열(`{ assertion, pass, actual, message }`).
//! - [`describe_assertion`]
//! - [`check_response`] → (checkPassed, assertionResults) — 명시적 status 규칙이 있어야 4xx/5xx 를 '기대한 실패' 로 본다.
//!
//! 'matches' 는 JS RegExp 대신 regex 크레이트로 돈다 — 앞뒤 살피기·역참조 같은 JS 전용 문법은 '정규식이 올바르지 않습니다' 로 나온다.

use serde_json::{json, Value};

use crate::executor::ExecResult;
use crate::js;
use crate::json_leaves::get_by_path;

pub struct AssertContext<'a> {
    pub status: Option<u16>,
    pub duration_ms: Option<i64>,
    pub body: Option<&'a str>,
    pub headers: Option<&'a [(String, String)]>,
}

/// `${x}` 템플릿 — undefined 는 "undefined".
fn tmpl(v: Option<&Value>) -> String {
    v.map_or_else(|| "undefined".into(), js::to_string)
}

fn actual_value(a: &Value, ctx: &AssertContext<'_>) -> Option<String> {
    let path = a.get("path");
    match a.get("target").and_then(Value::as_str) {
        Some("status") => ctx.status.map(|s| s.to_string()),
        Some("responseTime") => ctx.duration_ms.map(|d| d.to_string()),
        Some("body") => ctx.body.map(str::to_string),
        Some("header") => {
            let h = ctx.headers?;
            if !js::truthy(path) {
                return None;
            }
            let want = tmpl(path).to_lowercase();
            h.iter().find(|(k, _)| k.to_lowercase() == want).map(|(_, v)| v.clone())
        }
        Some("jsonPath") => {
            let body = ctx.body?;
            if !js::truthy(path) {
                return None;
            }
            // 비문자열 path 는 getByPath 안에서 던져 catch 로 undefined.
            let p = path?.as_str()?;
            get_by_path(&js::parse_json(body)?, p)
        }
        _ => None,
    }
}

/// 숫자로 읽는다. Number('') 와 Number(' ') 는 0 이라 빈 필드에 `< 100` 이 거짓 통과했다 — 그래서 빈 값은 숫자가 아니다.
fn as_number(v: Option<&str>) -> Option<f64> {
    let v = v?;
    if js::trim(v).is_empty() {
        return None;
    }
    let n = js::number(v);
    n.is_finite().then_some(n)
}

/// 비교 결과와, 비교 자체를 못 한 이유(있으면). 이유는 실패 메시지에 실린다.
fn apply_op(op: Option<&str>, actual: Option<&str>, expected: Option<&Value>) -> (bool, Option<String>) {
    let exp_s = expected.map(js::to_string);
    match op {
        Some("exists") => (actual.is_some(), None),
        Some("notExists") => (actual.is_none(), None),
        // === — 문자열끼리, 또는 둘 다 undefined 일 때만 같다.
        Some("eq") => (strict_eq(actual, expected), None),
        Some("ne") => (!strict_eq(actual, expected), None),
        Some("contains") => (matches!((actual, &exp_s), (Some(a), Some(e)) if a.contains(e.as_str())), None),
        Some("matches") => {
            let (Some(a), Some(e)) = (actual, exp_s) else { return (false, None) };
            // 패턴이 깨진 것과 데이터가 안 맞은 것은 고치는 방법이 다르다 — 이유를 보여 준다.
            match regex::Regex::new(&e) {
                Err(err) => (false, Some(format!("정규식이 올바르지 않습니다 — Invalid regular expression: /{e}/: {}", first_line(&err.to_string())))),
                Ok(re) => (re.is_match(a), None),
            }
        }
        Some(o @ ("lt" | "gt")) => {
            let a = as_number(actual);
            let b = as_number(exp_s.as_deref());
            match (a, b) {
                (Some(a), Some(b)) => (if o == "lt" { a < b } else { a > b }, None),
                (a, _) => {
                    let which = if a.is_none() { "실제값" } else { "기댓값" };
                    (false, Some(format!("{which}이 숫자가 아니라 크기를 비교할 수 없습니다")))
                }
            }
        }
        _ => (false, None),
    }
}

fn strict_eq(actual: Option<&str>, expected: Option<&Value>) -> bool {
    match (actual, expected) {
        (None, None) => true,
        (Some(a), Some(Value::String(e))) => a == e,
        _ => false,
    }
}

fn first_line(s: &str) -> String {
    s.lines().rev().find(|l| !js::trim(l).is_empty()).map(|l| js::trim(l).to_string()).unwrap_or_default()
}

fn target_label(t: Option<&str>) -> &'static str {
    match t {
        Some("status") => "상태 코드",
        Some("responseTime") => "응답 시간(ms)",
        Some("body") => "응답 바디",
        Some("jsonPath") => "JSON",
        Some("header") => "헤더",
        _ => "undefined",
    }
}

fn op_label(o: Option<&str>) -> &'static str {
    match o {
        Some("eq") => "=",
        Some("ne") => "≠",
        Some("contains") => "포함",
        Some("exists") => "존재",
        Some("notExists") => "없음",
        Some("lt") => "<",
        Some("gt") => ">",
        Some("matches") => "정규식",
        _ => "undefined",
    }
}

/// `a ?? ''` 를 템플릿에 — null·undefined 는 빈 문자열.
fn or_empty(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(v) => js::to_string(v),
    }
}

pub fn describe_assertion(a: &Value) -> String {
    let target = a.get("target").and_then(Value::as_str);
    let op = a.get("op").and_then(Value::as_str);
    let t = if matches!(target, Some("jsonPath") | Some("header")) {
        format!("{} {}", target_label(target), or_empty(a.get("path")))
    } else {
        target_label(target).to_string()
    };
    let rhs = if matches!(op, Some("exists") | Some("notExists")) { String::new() } else { format!(" {}", or_empty(a.get("expected"))) };
    js::trim(&format!("{t} {}{rhs}", op_label(op))).to_string()
}

/// 값을 따옴표로 — 앞뒤 공백이 눈에 보여야 '같아 보이는데 왜 실패하지' 가 풀린다.
fn quote(v: Option<String>) -> String {
    v.map_or_else(|| "없음".into(), |v| format!("\"{v}\""))
}

/// 응답에 assertion 목록을 평가한다. null·비객체 원소는 건너뛴다(배열은 JS 에서 객체라 통과).
pub fn evaluate_assertions(assertions: &[Value], ctx: &AssertContext<'_>) -> Vec<Value> {
    assertions
        .iter()
        .filter(|a| a.is_object() || a.is_array())
        .map(|a| {
            let actual = actual_value(a, ctx);
            let op = a.get("op").and_then(Value::as_str);
            let expected = a.get("expected");
            let (pass, problem) = apply_op(op, actual.as_deref(), expected);
            let detail = problem.unwrap_or_else(|| {
                if matches!(op, Some("exists") | Some("notExists")) {
                    format!("실제: {}", quote(actual.clone()))
                } else {
                    format!("기대: {} · 실제: {}", quote(expected.map(js::to_string)), quote(actual.clone()))
                }
            });
            let message = format!("{} — {}", describe_assertion(a), if pass { "통과".to_string() } else { format!("실패 ({detail})") });
            json!({ "assertion": a, "pass": pass, "actual": actual.unwrap_or_else(|| "(없음)".into()), "message": message })
        })
        .collect()
}

/// 명시적 status 기대가 있어야 음수 테스트(4xx 기대)를 허용한다. 필드 규칙만으로는 HTTP 오류를 봐주지 않는다.
pub fn check_response(rules: &[Value], result: &ExecResult) -> (bool, Vec<Value>) {
    let ctx = AssertContext { status: result.status, duration_ms: Some(result.duration_ms), body: result.body.as_deref(), headers: result.headers.as_deref() };
    let results = evaluate_assertions(rules, &ctx);
    let status_allowed = result.status.map_or(false, |s| rules.iter().any(|r| r.get("target").and_then(Value::as_str) == Some("status")) || (200..400).contains(&s));
    let passed = result.error.is_none() && result.truncated != Some(true) && status_allowed && results.iter().all(|r| r["pass"] == true);
    (passed, results)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx<'a>(body: Option<&'a str>, headers: Option<&'a [(String, String)]>) -> AssertContext<'a> {
        AssertContext { status: Some(200), duration_ms: Some(120), body, headers }
    }
    fn one(a: Value, c: &AssertContext<'_>) -> Value {
        evaluate_assertions(&[a], c).remove(0)
    }

    #[test]
    fn 상태_시간_바디_경로_헤더() {
        let h = vec![("content-type".to_string(), "application/json".to_string())];
        let c = ctx(Some(r#"{"data":{"id":7,"name":"주문"},"list":[{"x":"a"}]}"#), Some(&h));
        assert_eq!(one(json!({ "target": "status", "op": "eq", "expected": "200" }), &c)["pass"], true);
        assert_eq!(one(json!({ "target": "responseTime", "op": "lt", "expected": "500" }), &c)["pass"], true);
        assert_eq!(one(json!({ "target": "body", "op": "contains", "expected": "주문" }), &c)["pass"], true);
        assert_eq!(one(json!({ "target": "jsonPath", "path": "data.id", "op": "eq", "expected": "7" }), &c)["pass"], true);
        assert_eq!(one(json!({ "target": "jsonPath", "path": "list[0].x", "op": "eq", "expected": "a" }), &c)["pass"], true);
        assert_eq!(one(json!({ "target": "jsonPath", "path": "data.nope", "op": "notExists" }), &c)["pass"], true);
        assert_eq!(one(json!({ "target": "header", "path": "Content-Type", "op": "contains", "expected": "json" }), &c)["pass"], true);
        assert_eq!(one(json!({ "target": "jsonPath", "path": "data.name", "op": "matches", "expected": "^주" }), &c)["pass"], true);
        assert_eq!(one(json!({ "target": "status", "op": "ne", "expected": "500" }), &c)["pass"], true);
        assert_eq!(one(json!({ "target": "status", "op": "gt", "expected": "100" }), &c)["pass"], true);
    }

    #[test]
    fn 실패_메시지에는_기대와_실제() {
        let c = ctx(Some("{}"), None);
        let r = one(json!({ "target": "status", "op": "eq", "expected": "201 " }), &c);
        assert_eq!(r["message"], "상태 코드 = 201 — 실패 (기대: \"201 \" · 실제: \"200\")");
        let r = one(json!({ "target": "jsonPath", "path": "a", "op": "exists" }), &c);
        assert_eq!(r["message"], "JSON a 존재 — 실패 (실제: 없음)");
        assert_eq!(r["actual"], "(없음)");
        let r = one(json!({ "target": "status", "op": "eq", "expected": "200" }), &c);
        assert_eq!(r["message"], "상태 코드 = 200 — 통과");
    }

    #[test]
    fn 빈_값과_숫자_아닌_값은_크기_비교_거짓_통과가_없다() {
        let c = ctx(Some(r#"{"v":"","w":"abc"}"#), None);
        let r = one(json!({ "target": "jsonPath", "path": "v", "op": "lt", "expected": "100" }), &c);
        assert_eq!(r["pass"], false);
        assert!(r["message"].as_str().unwrap().contains("실제값이 숫자가 아니라 크기를 비교할 수 없습니다"));
        let r = one(json!({ "target": "status", "op": "lt", "expected": "abc" }), &c);
        assert!(r["message"].as_str().unwrap().contains("기댓값이 숫자가 아니라"));
    }

    #[test]
    fn 깨진_정규식은_이유를_싣는다() {
        let r = one(json!({ "target": "body", "op": "matches", "expected": "(" }), &ctx(Some("x"), None));
        assert_eq!(r["pass"], false);
        assert!(r["message"].as_str().unwrap().contains("정규식이 올바르지 않습니다"));
    }

    #[test]
    fn 손상_원소는_건너뛰고_비문자열_path_는_안전() {
        let h = vec![("x-n".to_string(), "1".to_string())];
        let out = evaluate_assertions(&[Value::Null, json!(3), json!({ "target": "header", "path": 123, "op": "exists" })], &ctx(Some("{}"), Some(&h)));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["pass"], false);
        assert_eq!(out[0]["message"], "헤더 123 존재 — 실패 (실제: 없음)");
    }

    #[test]
    fn 상태_규칙이_있어야_4xx_를_허용() {
        let r = ExecResult { status: Some(404), body: Some("{}".into()), headers: Some(vec![]), ..Default::default() };
        assert!(!check_response(&[], &r).0);
        assert!(!check_response(&[json!({ "target": "body", "op": "exists" })], &r).0);
        assert!(check_response(&[json!({ "target": "status", "op": "eq", "expected": "404" })], &r).0);
        let ok = ExecResult { status: Some(200), body: Some("{}".into()), truncated: Some(false), ..Default::default() };
        assert!(check_response(&[], &ok).0);
        assert!(!check_response(&[], &ExecResult { truncated: Some(true), ..ok.clone() }).0);
        assert!(!check_response(&[], &ExecResult { error: Some("x".into()), status: None, ..Default::default() }).0);
    }
}
