//! 실행 정책.
//!
//! 공개 API
//! - [`ExecutionSource`]·[`EXECUTION_POLICIES`]·[`is_execution_policy`]·[`is_write_method`]
//! - [`decide_execution`] → [`Decision`] — 순수 판정. 모든 실행 진입점과 화면이 같이 쓴다.
//! - [`parameter_type_error`] — MCP 실행 때 OpenAPI 스칼라 query/header 타입 검사.
//! - [`execution_target_error`] — 실행 입력(vars·params)이 저장된 요청의 호스트·스킴·포트·자격증명을 바꾸지 못하게.
//! - [`guard_execution`] → 거부면 감사 이력 행을 남기고 그 행(JSON)을 돌려준다(라우트는 403 으로 그대로 응답).
//!
//! 순서가 중요하다: 정책 검사는 자격증명·네트워크·pre-step 보다 먼저, 파라미터 검사는 해석 뒤.
//! 거부 행에는 요청 내용(헤더·바디)을 싣지 않는다 — 거부된 요청의 secret 이 이력에 남으면 안 된다.
//!
//! 실행 출처(source)는 서버만 정한다. Node 는 AsyncLocalStorage 로 MCP·스케줄·플로우를 표시했고, HTTP 로 들어온
//! 요청은 항상 'ui' 다 — JSON 필드나 헤더로 출처를 사칭할 수 없게 Rust 라우트도 호출부가 직접 넘긴다.

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Map, Value};

use crate::js;
use crate::records::parse_execution;
use crate::resolve::RequestInput;

pub const EXECUTION_POLICIES: [&str; 3] = ["open", "confirm-writes", "read-only"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExecutionSource {
    Ui,
    Mcp,
    Schedule,
    Flow,
}

impl ExecutionSource {
    pub fn as_str(self) -> &'static str {
        match self {
            ExecutionSource::Ui => "ui",
            ExecutionSource::Mcp => "mcp",
            ExecutionSource::Schedule => "schedule",
            ExecutionSource::Flow => "flow",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            ExecutionSource::Ui => "사람 화면",
            ExecutionSource::Mcp => "MCP",
            ExecutionSource::Schedule => "스케줄",
            ExecutionSource::Flow => "플로우",
        }
    }
}

pub fn is_execution_policy(v: &Value) -> bool {
    v.as_str().map_or(false, |s| EXECUTION_POLICIES.contains(&s))
}

pub fn is_write_method(method: &str) -> bool {
    !matches!(js::trim(method).to_uppercase().as_str(), "GET" | "HEAD" | "OPTIONS")
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    Allowed,
    Denied { reason: String, confirmation_required: bool },
}

impl Decision {
    fn deny(reason: &str) -> Self {
        Decision::Denied { reason: reason.into(), confirmation_required: false }
    }
    pub fn allowed(&self) -> bool {
        matches!(self, Decision::Allowed)
    }
}

pub struct DecideInput<'a> {
    pub policy: Option<&'a str>,
    pub method: &'a str,
    pub source: ExecutionSource,
    pub ai_execution_allowed: bool,
    pub confirmed: bool,
}

pub fn decide_execution(i: &DecideInput<'_>) -> Decision {
    if !is_write_method(i.method) {
        return Decision::Allowed;
    }
    if i.policy == Some("read-only") {
        return Decision::deny("읽기 전용 환경에서 쓰기 요청이 차단되었습니다.");
    }
    if i.policy == Some("confirm-writes") && i.source != ExecutionSource::Ui {
        return Decision::deny(if i.source == ExecutionSource::Flow {
            "쓰기 확인이 필요한 환경이라 시나리오에서는 실행되지 않음 — 요청 화면에서 확인 후 실행"
        } else {
            "쓰기 확인이 필요한 환경입니다. 사람이 요청 화면에서 확인 후 실행해야 합니다."
        });
    }
    if i.source == ExecutionSource::Mcp && !i.ai_execution_allowed {
        return Decision::deny("AI 실행 허용이 꺼진 요청입니다. 사람이 요청 설정에서 허용해야 실행할 수 있습니다.");
    }
    if i.policy == Some("confirm-writes") && !i.confirmed {
        return Decision::Denied { reason: "쓰기 요청이 아직 확인되지 않아 실행되지 않았습니다.".into(), confirmation_required: true };
    }
    Decision::Allowed
}

/// `/^[+-]?\d+$/` (ASCII 숫자) + Number.isSafeInteger(Number(v)).
fn is_safe_integer_text(v: &str) -> bool {
    let digits = v.strip_prefix(['+', '-']).unwrap_or(v);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let n = js::number(v);
    n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0
}

/// OpenAPI 의 스칼라 query/header 타입만 본다. 모르는 타입·복합 스키마는 손대지 않는다.
pub fn parameter_type_error(contract: Option<&Value>, input: &RequestInput) -> Option<String> {
    let fields = contract?.get("fields")?.as_object()?;
    let url = url::Url::parse(&input.url).ok()?;
    let url_query: Vec<(String, String)> = url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    for path in js::object_keys(fields) {
        let field = &fields[path.as_str()];
        let Some(rest) = path.strip_prefix("요청 ") else { continue };
        let Some((location, name)) = rest.split_once('.') else { continue };
        if !matches!(location, "query" | "header") || name.is_empty() || name.contains(['.', '[', ']']) {
            continue;
        }
        let value = if location == "query" {
            // searchParams.set 을 params 순서대로 — 마지막 활성 값이 이기고, 없으면 URL 의 첫 값.
            input.params.iter().rev().find(|p| p.enabled && !p.key.is_empty() && p.key == name).map(|p| p.value.clone()).or_else(|| url_query.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone()))
        } else {
            let lower = name.to_lowercase();
            input.headers.iter().find(|h| h.enabled && h.key.to_lowercase() == lower).map(|h| h.value.clone())
        };
        let Some(value) = value else { continue };
        let ty = field.get("type").and_then(Value::as_str).unwrap_or("");
        let valid = match ty {
            "integer" => is_safe_integer_text(&value),
            "number" => !js::trim(&value).is_empty() && js::number(&value).is_finite(),
            "boolean" => value == "true" || value == "false",
            _ => true,
        };
        if !valid {
            return Some(format!("{location} 파라미터 '{name}'의 값이 {} 형식이 아니어서 실행되지 않았습니다.", field.get("type").map_or("undefined".into(), js::to_string)));
        }
    }
    None
}

/// 실행 데이터는 저장된 요청의 대상(프로토콜·호스트·포트·자격증명)을 바꿀 수 없다.
pub fn execution_target_error(before: &str, after: &str) -> Option<String> {
    if before == after {
        return None;
    }
    match (url::Url::parse(before), url::Url::parse(after)) {
        (Ok(a), Ok(b)) => {
            let host_has_brace = a.host_str().map_or(false, |h| h.contains(['{', '}']));
            if host_has_brace || a.origin().ascii_serialization() != b.origin().ascii_serialization() || a.username() != b.username() || a.password() != b.password() {
                Some("실행 입력으로 URL 호스트·프로토콜·포트·자격증명을 변경할 수 없습니다. 저장된 환경을 선택하세요.".into())
            } else {
                None
            }
        }
        _ => Some("저장된 URL 호스트를 확인할 수 없어 실행 입력의 URL 변경이 거부되었습니다.".into()),
    }
}

/// guardExecution 의 입력.
#[derive(Clone)]
pub struct GuardInput<'a> {
    pub request_id: Option<&'a str>,
    pub method: &'a str,
    pub environment_id: Option<&'a str>,
    pub workspace_id: &'a str,
    pub validation_error: Option<String>,
    pub executed_by: &'a str,
    pub source: ExecutionSource,
    pub ai_execution_allowed: bool,
    pub confirmed: bool,
}

/// 실행 이력 한 행을 넣는다 — m 의 키는 [`crate::records::EXECUTION_COLS`] 의 JSON 이름. 없는 열은 DB 기본값.
pub fn insert_execution(c: &Connection, m: &Map<String, Value>) -> rusqlite::Result<()> {
    let mut cols = Vec::new();
    let mut vals = Vec::new();
    for (name, col, _) in crate::records::EXECUTION_COLS {
        let Some(v) = m.get(*name) else { continue };
        cols.push(format!("\"{col}\""));
        vals.push(match v {
            Value::Null => rusqlite::types::Value::Null,
            Value::Bool(b) => rusqlite::types::Value::Integer(i64::from(*b)),
            Value::Number(n) => n.as_i64().map_or_else(|| rusqlite::types::Value::Real(n.as_f64().unwrap_or(0.0)), rusqlite::types::Value::Integer),
            Value::String(s) => rusqlite::types::Value::Text(s.clone()),
            other => rusqlite::types::Value::Text(js::stringify(other)),
        });
    }
    let ph: Vec<String> = (1..=cols.len()).map(|i| format!("?{i}")).collect();
    let sql = format!(r#"INSERT INTO "executions" ({}) VALUES ({})"#, cols.join(", "), ph.join(", "));
    c.execute(&sql, rusqlite::params_from_iter(vals))?;
    Ok(())
}

/// 허용이면 None. 거부면 감사 행을 남기고 `{ ...parseExecution(row), confirmationRequired }` 를 돌려준다.
pub fn guard_execution(c: &Connection, i: &GuardInput<'_>) -> rusqlite::Result<Option<Value>> {
    // `input.environmentId ? select : undefined` — 빈 문자열은 환경 없음.
    let env_id = i.environment_id.filter(|e| !e.is_empty());
    let env: Option<(String, String)> = match env_id {
        Some(id) => c
            .prepare_cached(r#"SELECT "execution_policy", "workspace_id" FROM "environments" WHERE "environments"."id" = ?1"#)?
            .query_row([id], |r| Ok((crate::rows::text(r, 0)?, crate::rows::text(r, 1)?)))
            .optional()?,
        None => None,
    };
    let decision = if let Some(v) = &i.validation_error {
        Decision::deny(v)
    } else if env_id.is_some() && env.as_ref().map_or(true, |(_, ws)| ws != i.workspace_id) {
        Decision::deny("선택한 환경이 없거나 다른 프로젝트의 환경이어서 실행되지 않았습니다.")
    } else {
        decide_execution(&DecideInput {
            policy: env.as_ref().map(|(p, _)| p.as_str()),
            method: i.method,
            source: i.source,
            ai_execution_allowed: i.ai_execution_allowed,
            confirmed: i.confirmed,
        })
    };
    let Decision::Denied { reason, confirmation_required } = decision else { return Ok(None) };
    let request_id = i.request_id.map_or_else(|| format!("__adhoc__:{}", i.workspace_id), str::to_string);
    let row = json!({
        "id": uuid::Uuid::new_v4().to_string(), "requestId": request_id, "executedBy": i.executed_by,
        "executionSource": i.source.as_str(), "denialReason": reason,
        "executedAt": js::now_ms(), "environmentId": i.environment_id,
        "resolved": js::stringify(&json!({ "method": i.method, "url": "", "params": [], "headers": [], "bodyType": "none", "body": "" })),
        "responseStatus": null, "responseHeaders": null, "responseBody": null, "durationMs": 0,
        "error": reason, "checkPassed": false, "assertionResults": "[]", "missingVariables": "[]", "pinned": false,
    });
    let Value::Object(row) = row else { unreachable!() };
    insert_execution(c, &row)?;
    let mut out = parse_execution(row);
    out["confirmationRequired"] = Value::Bool(confirmation_required);
    Ok(Some(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resolve::Kv;

    // 모든 조합.
    #[test]
    fn 판정_조합() {
        let sources = [ExecutionSource::Ui, ExecutionSource::Mcp, ExecutionSource::Schedule, ExecutionSource::Flow];
        for policy in EXECUTION_POLICIES {
            for method in ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "CUSTOM", "get"] {
                for source in sources {
                    for ai in [false, true] {
                        for confirmed in [false, true] {
                            let read = ["GET", "HEAD", "OPTIONS"].contains(&method.to_uppercase().as_str());
                            let expected = read
                                || (policy != "read-only"
                                    && (policy != "confirm-writes" || (source == ExecutionSource::Ui && confirmed))
                                    && (source != ExecutionSource::Mcp || ai));
                            let d = decide_execution(&DecideInput { policy: Some(policy), method, source, ai_execution_allowed: ai, confirmed });
                            assert_eq!(d.allowed(), expected, "{policy} {method} {source:?} {ai} {confirmed}");
                        }
                    }
                }
            }
        }
        let d = |source| decide_execution(&DecideInput { policy: None, method: "POST", source, ai_execution_allowed: false, confirmed: false });
        assert!(d(ExecutionSource::Ui).allowed());
        assert!(!d(ExecutionSource::Mcp).allowed());
    }

    #[test]
    fn 스칼라_query_검사() {
        for (ty, value, rejected) in [("integer", "12", false), ("integer", "1.2", true), ("number", "1.2", false), ("number", "NaN", true), ("boolean", "true", false), ("boolean", "1", true), ("string", "anything", false)] {
            let contract = json!({ "fields": { "요청 query.limit": { "type": ty, "required": false } }, "incomplete": [] });
            let input = RequestInput { method: "GET".into(), url: "https://example.com".into(), headers: vec![], params: vec![Kv::new("limit", value)], body_type: "none".into(), body: String::new() };
            assert_eq!(parameter_type_error(Some(&contract), &input).is_some(), rejected, "{ty} {value}");
        }
        let contract = json!({ "fields": { "요청 header.X-Page": { "type": "integer", "required": false } }, "incomplete": [] });
        let input = RequestInput { method: "GET".into(), url: "https://e.com".into(), headers: vec![Kv::new("x-page", "a")], params: vec![], body_type: "none".into(), body: String::new() };
        assert_eq!(parameter_type_error(Some(&contract), &input).as_deref(), Some("header 파라미터 'X-Page'의 값이 integer 형식이 아니어서 실행되지 않았습니다."));
    }

    #[test]
    fn 대상_변경_거부() {
        assert_eq!(execution_target_error("https://a/x", "https://a/x"), None);
        assert_eq!(execution_target_error("https://a/x", "https://a/y?z=1"), None);
        assert!(execution_target_error("https://a/x", "https://b/x").is_some());
        assert!(execution_target_error("https://a/x", "http://a/x").is_some());
        assert!(execution_target_error("https://a/x", "https://a:444/x").is_some());
        assert!(execution_target_error("https://a/x", "https://u@a/x").is_some());
        assert_eq!(execution_target_error("{{base}}/x", "https://a/x").as_deref(), Some("저장된 URL 호스트를 확인할 수 없어 실행 입력의 URL 변경이 거부되었습니다."));
    }

    #[test]
    fn 가드는_거부_행을_남긴다() {
        let db = crate::variables::tests::test_db();
        db.with(|c| {
            c.execute(r#"INSERT INTO environments (execution_policy, id, workspace_id, name) VALUES ('read-only', 'e1', 'ws', 'prod')"#, [])?;
            let base = GuardInput { request_id: Some("r1"), method: "POST", environment_id: Some("e1"), workspace_id: "ws", validation_error: None, executed_by: "me", source: ExecutionSource::Ui, ai_execution_allowed: false, confirmed: false };
            let d = guard_execution(c, &base)?.unwrap();
            assert_eq!(d["error"], "읽기 전용 환경에서 쓰기 요청이 차단되었습니다.");
            assert_eq!(d["confirmationRequired"], false);
            assert_eq!(d["resolved"], json!({ "method": "POST", "url": "", "params": [], "headers": [], "bodyType": "none", "body": "" }));
            assert_eq!(d["checkPassed"], false);
            assert!(guard_execution(c, &GuardInput { method: "GET", ..base.clone() })?.is_none());
            // 다른 프로젝트의 환경
            let d = guard_execution(c, &GuardInput { workspace_id: "other", method: "GET", ..base.clone() })?.unwrap();
            assert_eq!(d["denialReason"], "선택한 환경이 없거나 다른 프로젝트의 환경이어서 실행되지 않았습니다.");
            let d = guard_execution(c, &GuardInput { request_id: None, environment_id: None, validation_error: Some("v".into()), ..base.clone() })?.unwrap();
            assert_eq!(d["requestId"], "__adhoc__:ws");
            c.execute(r#"INSERT INTO environments (execution_policy, id, workspace_id, name) VALUES ('confirm-writes', 'e2', 'ws', 'stg')"#, [])?;
            let d = guard_execution(c, &GuardInput { environment_id: Some("e2"), ..base.clone() })?.unwrap();
            assert_eq!(d["confirmationRequired"], true);
            assert!(guard_execution(c, &GuardInput { environment_id: Some("e2"), confirmed: true, ..base.clone() })?.is_none());
            let n: i64 = c.query_row("SELECT count(*) FROM executions WHERE denial_reason IS NOT NULL", [], |r| r.get(0))?;
            assert_eq!(n, 4);
            Ok(())
        })
        .unwrap();
    }
}
