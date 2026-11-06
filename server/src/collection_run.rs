//! 폴더 일괄 실행의 순수 로직.
//!
//! 공개 API
//! - [`RunRow`] — 행 하나의 결과. JSON 키 순서는 Node 의 `{ ...base, ...덮어쓴 것 }` 결과와 같다.
//! - [`plan_run_rows`] — 정책 거부·쓰기 제외를 미리 판정한다(정책 거부가 먼저).
//! - [`collect_run_inputs`] — 실행 전에 물어볼 입력값(생성되는 값·요청 기본값은 묻지 않는다, secret 값은 비운다).
//! - [`to_junit_xml`] — CI(Jenkins/GitLab/GitHub Actions)가 그대로 소비하는 리포트.

use serde_json::{json, Map, Value};

use crate::execution_policy::{decide_execution, is_write_method, DecideInput, Decision, ExecutionSource};
use crate::resolve::{extract_path_parameters, extract_variables, RequestInput};
use crate::variables::VarMap;

#[derive(Clone, Debug, PartialEq)]
pub struct RunRow {
    pub request_id: String,
    pub name: String,
    pub method: String,
    /// waiting | running | passed | failed | skipped
    pub state: String,
    pub error: Option<String>,
    /// undefined 면 JSON 에서 빠진다.
    pub denial_reason: Option<String>,
    pub status: Option<u16>,
    pub duration_ms: Option<i64>,
    pub missing_variables: Vec<String>,
    pub passed: usize,
    pub total: usize,
    /// 실행한 행에만 있다(계획 단계에는 없음).
    pub results: Option<Vec<Value>>,
    pub ok: bool,
    pub url: Option<String>,
    pub response_body: Option<String>,
}

impl RunRow {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("requestId".into(), json!(self.request_id));
        m.insert("name".into(), json!(self.name));
        m.insert("method".into(), json!(self.method));
        m.insert("state".into(), json!(self.state));
        m.insert("error".into(), json!(self.error));
        if let Some(d) = &self.denial_reason {
            m.insert("denialReason".into(), json!(d));
        }
        m.insert("status".into(), json!(self.status));
        m.insert("durationMs".into(), json!(self.duration_ms));
        m.insert("missingVariables".into(), json!(self.missing_variables));
        let mut a = Map::new();
        a.insert("passed".into(), json!(self.passed));
        a.insert("total".into(), json!(self.total));
        if let Some(r) = &self.results {
            a.insert("results".into(), Value::Array(r.clone()));
        }
        m.insert("assertions".into(), Value::Object(a));
        m.insert("ok".into(), json!(self.ok));
        if let Some(u) = &self.url {
            m.insert("url".into(), json!(u));
        }
        if let Some(b) = &self.response_body {
            m.insert("responseBody".into(), json!(b));
        }
        Value::Object(m)
    }
}

pub struct PlanSource<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub method: &'a str,
    pub ai_execution_allowed: bool,
}

pub fn plan_run_rows(rows: &[PlanSource<'_>], policy: Option<&str>, include_writes: bool, source: ExecutionSource) -> Vec<RunRow> {
    rows.iter()
        .map(|row| {
            let decision = decide_execution(&DecideInput { policy, method: row.method, source, ai_execution_allowed: row.ai_execution_allowed, confirmed: false });
            let denial_reason = match decision {
                Decision::Allowed => None,
                Decision::Denied { reason, .. } => Some(reason),
            };
            let error = match &denial_reason {
                Some(r) => Some(format!("정책으로 건너뜀 — {r}")),
                None if !include_writes && is_write_method(row.method) => Some("쓰기 요청 제외 — 실행하려면 쓰기 포함을 선택하세요.".to_string()),
                None => None,
            };
            RunRow {
                request_id: row.id.into(),
                name: row.name.into(),
                method: row.method.into(),
                state: if error.is_some() { "skipped" } else { "waiting" }.into(),
                error,
                denial_reason,
                status: None,
                duration_ms: None,
                missing_variables: vec![],
                passed: 0,
                total: 0,
                results: None,
                ok: false,
                url: None,
                response_body: None,
            }
        })
        .collect()
}

pub struct InputSource<'a> {
    pub input: &'a RequestInput,
    pub vars: &'a VarMap,
    pub generated: &'a [String],
}

/// 실행 전에 참조를 모은다 — 생성되는 값(pre-step)·요청 기본값이 있는 것은 묻지 않는다. 팀 값이 있으면 기본값으로 채운다.
pub fn collect_run_inputs(items: &[InputSource<'_>], team: &VarMap) -> Vec<Value> {
    let mut names: Vec<String> = Vec::new();
    for it in items {
        let mut refs = extract_variables(it.input);
        refs.extend(extract_path_parameters(&it.input.url));
        for name in refs {
            let has_default = it.vars.get(&name).map_or(false, |v| !v.value.is_empty());
            if !it.generated.contains(&name) && (!has_default || team.get(&name).is_some()) && !names.contains(&name) {
                names.push(name);
            }
        }
    }
    names
        .into_iter()
        .map(|name| {
            let t = team.get(&name);
            let secret = t.map_or(false, |v| v.secret);
            json!({
                "name": name,
                "value": if secret { String::new() } else { t.map(|v| v.value.clone()).unwrap_or_default() },
                "secret": secret,
                "supplied": t.map_or(false, |v| !v.value.is_empty()),
            })
        })
        .collect()
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// 실패 수에는 '쓰기 제외로 건너뛴 것' 을 넣지 않는다 — 정책 거부는 실패다.
pub fn to_junit_xml(suite_name: &str, results: &[RunRow]) -> String {
    let plain_skip = |r: &RunRow| r.state == "skipped" && r.denial_reason.as_deref().map_or(true, str::is_empty);
    let failures = results.iter().filter(|r| !r.ok && !plain_skip(r)).count();
    let cases: Vec<String> = results
        .iter()
        .map(|r| {
            let time = format!("{:.3}", r.duration_ms.unwrap_or(0) as f64 / 1000.0);
            let open = format!(r#"  <testcase name="{}" classname="{}" time="{time}">"#, esc(&r.name), esc(suite_name));
            if plain_skip(r) {
                return format!(r#"{open}<skipped message="{}"/></testcase>"#, esc(r.error.as_deref().unwrap_or("건너뜀")));
            }
            if r.ok {
                return format!("{open}</testcase>");
            }
            let reason = match (&r.error, r.status) {
                (Some(e), _) if !e.is_empty() => format!("요청 오류: {e}"),
                (_, Some(s)) if s >= 400 => format!("HTTP {s}"),
                _ => format!("검증 실패 {}/{}", r.passed, r.total),
            };
            let status = r.status.map_or("ERR".to_string(), |s| s.to_string());
            format!(
                "{open}\n    <failure message=\"{}\">status={status} assertions={}/{}</failure>\n  </testcase>",
                esc(&reason),
                r.passed,
                r.total
            )
        })
        .collect();
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<testsuite name=\"{}\" tests=\"{}\" failures=\"{failures}\">\n{}\n</testsuite>\n",
        esc(suite_name),
        results.len(),
        cases.join("\n")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::variables::Var;

    fn input() -> RequestInput {
        RequestInput {
            method: "GET".into(),
            url: "https://test/{customerNumber}/{{orderCode}}/{{generated}}".into(),
            params: vec![],
            headers: vec![],
            body_type: "none".into(),
            body: String::new(),
        }
    }

    #[test]
    fn 입력값_수집() {
        let mut team = VarMap::new();
        team.insert("orderCode", Var { value: "env-order".into(), secret: false });
        team.insert("customerNumber", Var { value: "private-value".into(), secret: true });
        let i = input();
        let generated = vec!["generated".to_string()];
        let items = [InputSource { input: &i, vars: &team, generated: &generated }, InputSource { input: &i, vars: &team, generated: &generated }];
        assert_eq!(
            collect_run_inputs(&items, &team),
            vec![
                json!({ "name": "orderCode", "value": "env-order", "secret": false, "supplied": true }),
                json!({ "name": "customerNumber", "value": "", "secret": true, "supplied": true }),
            ]
        );
        let mut req_vars = VarMap::new();
        req_vars.insert("orderCode", Var { value: "request-default".into(), secret: false });
        let missing = collect_run_inputs(&[InputSource { input: &i, vars: &req_vars, generated: &generated }], &VarMap::new());
        assert_eq!(missing.iter().map(|v| v["name"].as_str().unwrap()).collect::<Vec<_>>(), vec!["customerNumber"]);
    }

    #[test]
    fn 쓰기는_기본_제외_정책_거부가_우선() {
        let methods = ["GET", "HEAD", "POST", "DELETE"];
        let ids: Vec<String> = (0..4).map(|i| i.to_string()).collect();
        let rows: Vec<PlanSource> = methods.iter().zip(&ids).map(|(m, id)| PlanSource { id, name: m, method: m, ai_execution_allowed: false }).collect();
        let st = |rs: Vec<RunRow>| rs.into_iter().map(|r| r.state).collect::<Vec<_>>();
        assert_eq!(st(plan_run_rows(&rows, None, false, ExecutionSource::Flow)), vec!["waiting", "waiting", "skipped", "skipped"]);
        assert!(plan_run_rows(&rows, Some("open"), true, ExecutionSource::Flow).iter().all(|r| r.state == "waiting"));
        assert!(plan_run_rows(&rows, Some("read-only"), true, ExecutionSource::Flow)[2].denial_reason.as_deref().unwrap().contains("읽기 전용"));
        let j = plan_run_rows(&rows, None, false, ExecutionSource::Flow)[0].to_json();
        assert_eq!(
            js_keys(&j),
            vec!["requestId", "name", "method", "state", "error", "status", "durationMs", "missingVariables", "assertions", "ok"]
        );
    }

    fn js_keys(v: &Value) -> Vec<&str> {
        v.as_object().unwrap().keys().map(String::as_str).collect()
    }

    fn case(name: &str, ok: bool, status: Option<u16>, error: Option<&str>, passed: usize, total: usize) -> RunRow {
        RunRow {
            request_id: "r".into(),
            name: name.into(),
            method: "GET".into(),
            state: if ok { "passed" } else { "failed" }.into(),
            error: error.map(str::to_string),
            denial_reason: None,
            status,
            duration_ms: Some(5),
            missing_variables: vec![],
            passed,
            total,
            results: None,
            ok,
            url: None,
            response_body: None,
        }
    }

    #[test]
    fn junit_xml() {
        let xml = to_junit_xml("주문", &[case("ok", true, Some(200), None, 0, 0), case("bad", false, Some(500), None, 0, 0), case("assert", false, Some(200), None, 1, 2)]);
        assert!(xml.contains(r#"<testsuite name="주문" tests="3" failures="2">"#));
        assert!(xml.contains(r#"<testcase name="ok""#));
        assert!(xml.contains("HTTP 500"));
        assert!(xml.contains("검증 실패 1/2"));
        assert!(xml.contains(r#"time="0.005""#));
        assert_eq!(xml.matches("<failure").count(), 2);
        let xml = to_junit_xml("a&b", &[case("<x>", false, Some(200), Some(r#"a & "b""#), 0, 0)]);
        assert!(xml.contains(r#"name="a&amp;b""#));
        assert!(xml.contains("&lt;x&gt;"));
        assert!(xml.contains("a &amp; &quot;b&quot;"));
    }
}
