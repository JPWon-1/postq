//! 시나리오(플로우) 체인의 순수 로직.
//!
//! 공개 API
//! - [`Runtime`] — 스텝 사이로 넘기는 런타임 변수(추출값·prevBody 등). JS 객체처럼 넣은 순서를 지킨다.
//! - [`apply_extracts`] — 응답 바디에서 추출 규칙대로 값을 뽑는다(없는 경로는 missing).
//! - [`overlay_vars`] — 환경 변수 위에 런타임 값을 겹친다(런타임이 이긴다, secret 은 false).
//! - [`auto_step_vars`] — 스텝 뒤 자동 등록 변수(prevBody·prevStatus·stepNBody).

use serde_json::{Map, Value};

use crate::js;
use crate::json_leaves::get_by_path;
use crate::variables::{Var, VarMap};

/// 런타임 변수 — Node 에선 `Record<string, string>` 이었다. 응답(runtimeVariables)에 그대로 나가므로
/// 키 순서를 JS 객체처럼 둔다(같은 키를 다시 넣으면 자리는 처음 그대로).
pub type Runtime = Map<String, Value>;

/// `{ ...a, ...b }` 를 런타임에 — 값은 문자열로.
pub fn spread(into: &mut Runtime, from: &Runtime) {
    for (k, v) in from {
        into.insert(k.clone(), v.clone());
    }
}

/// 클라이언트가 돌려준 runtime(`b.runtime ?? {}`) — 객체가 아니면 빈 것. 값이 문자열이 아니면 String().
pub fn runtime_from_json(v: Option<&Value>) -> Runtime {
    let mut out = Runtime::new();
    if let Some(Value::Object(o)) = v {
        for k in js::object_keys(o) {
            let s = match &o[k.as_str()] {
                Value::String(s) => s.clone(),
                other => js::to_string(other),
            };
            out.insert(k.clone(), Value::String(s));
        }
    }
    out
}

/// 응답으로 내보낼 때 — JS 가 정수 모양 키를 앞에 두는 순서까지.
pub fn runtime_to_json(r: &Runtime) -> Value {
    let mut out = Map::new();
    for k in js::object_keys(r) {
        out.insert(k.clone(), r[k.as_str()].clone());
    }
    Value::Object(out)
}

pub struct Extracted {
    /// 변수 이름 → 값(넣은 순서).
    pub extracted: Runtime,
    pub missing: Vec<String>,
}

/// 추출값은 환경에 저장하지 않는다 — 이 실행 안에서만 유효한 런타임 값.
pub fn apply_extracts(response_body: Option<&str>, rules: &[Value]) -> Extracted {
    let mut out = Extracted { extracted: Runtime::new(), missing: Vec::new() };
    if rules.is_empty() {
        return out;
    }
    // JSON 아니면 null. `"null"` 바디도 null 로 — 둘 다 전부 missing.
    let parsed = response_body.filter(|b| !b.is_empty()).and_then(js::parse_json).filter(|v| !v.is_null());
    for r in rules {
        // `if (!r.path || !r.variable) continue` — 손편집 규칙(비문자열)도 크래시 없이.
        if !js::truthy(r.get("path")) || !js::truthy(r.get("variable")) {
            continue;
        }
        let path = js::to_string(&r["path"]);
        let variable = js::to_string(&r["variable"]);
        match parsed.as_ref().and_then(|p| get_by_path(p, &path)) {
            None => out.missing.push(path),
            Some(v) => {
                out.extracted.insert(variable, Value::String(v));
            }
        }
    }
    out
}

/// 환경 변수 위에 런타임 추출값을 겹친다 (추출값이 우선, secret:false — 호출부가 secretNames 로 복원한다).
pub fn overlay_vars(base: &VarMap, overlay: &Runtime) -> VarMap {
    let mut out = base.clone();
    for k in js::object_keys(overlay) {
        let v = match &overlay[k.as_str()] {
            Value::String(s) => s.clone(),
            other => js::to_string(other),
        };
        out.insert(k, Var { value: v, secret: false });
    }
    out
}

/// 추출 규칙 없이도 통짜 응답을 다음 스텝에 실을 수 있게 — {{prevBody}}·{{prevStatus}}·{{stepNBody}}(1-base, 계속 유지).
/// `step_no` 는 JS 의 `${stepIndex + 1}` 그대로다 — 단계 모드에서 stepIndex 가 문자열 "0" 이면 "0"+1 = "01" 이라
/// 변수 이름이 step01Body 가 된다. 보통 실행은 정수라 "1"·"2"….
pub fn auto_step_vars(step_no: &str, response_body: Option<&str>, status: Option<u16>) -> Runtime {
    let body = response_body.unwrap_or("").to_string();
    let mut m = Runtime::new();
    m.insert("prevBody".into(), Value::String(body.clone()));
    m.insert("prevStatus".into(), Value::String(status.map(|s| s.to_string()).unwrap_or_default()));
    m.insert(format!("step{step_no}Body"), Value::String(body));
    m
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn 응답_json_에서_규칙대로_추출() {
        let r = apply_extracts(
            Some(r#"{"data":{"accessToken":"abc","user":{"id":42}}}"#),
            &[json!({ "path": "data.accessToken", "variable": "token" }), json!({ "path": "data.user.id", "variable": "userId" })],
        );
        assert_eq!(Value::Object(r.extracted), json!({ "token": "abc", "userId": "42" }));
        assert!(r.missing.is_empty());
        let r = apply_extracts(Some(r#"{"a":1}"#), &[json!({ "path": "a", "variable": "a" }), json!({ "path": "nope.x", "variable": "x" })]);
        assert_eq!(Value::Object(r.extracted), json!({ "a": "1" }));
        assert_eq!(r.missing, vec!["nope.x"]);
        assert_eq!(apply_extracts(Some("not-json"), &[json!({ "path": "a", "variable": "a" })]).missing, vec!["a"]);
        assert_eq!(apply_extracts(None, &[json!({ "path": "a", "variable": "a" })]).missing, vec!["a"]);
    }

    #[test]
    fn 추출값이_환경_변수를_덮는다() {
        let mut base = VarMap::new();
        base.insert("token", Var { value: "env-token".into(), secret: true });
        let mut rt = Runtime::new();
        rt.insert("token".into(), json!("runtime-token"));
        rt.insert("extra".into(), json!("x"));
        let out = overlay_vars(&base, &rt);
        assert_eq!(out.get("token"), Some(&Var { value: "runtime-token".into(), secret: false }));
        assert_eq!(out.get("extra").unwrap().value, "x");
        assert_eq!(base.get("token").unwrap().value, "env-token");
    }

    #[test]
    fn 자동_변수() {
        let v = auto_step_vars("2", Some("{}"), Some(201));
        assert_eq!(Value::Object(v), json!({ "prevBody": "{}", "prevStatus": "201", "step2Body": "{}" }));
        let v = auto_step_vars("1", None, None);
        assert_eq!(v["prevStatus"], "");
    }
}
