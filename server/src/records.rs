//! DB 행 → 화면으로 내보내는 JSON — schema.ts 의 열 목록과 요청·실행 행 매퍼.
//!
//! 열 목록은 schema.ts 에 적힌 순서다. drizzle 의 `select()` 가 그 순서로 객체를 만들고, 라우트는 그 객체를
//! 펼쳐(`{ ...row, params: .. }`) 내려보낸다 — 있던 키는 제자리, 없던 키는 뒤에 붙는다. 응답과
//! 저장본(request_versions.snapshot)의 모양이 바뀌지 않으려면 이 순서를 지켜야 한다.
//!
//! 요청·실행 라우트와 내보내기·실행 이력 라우트가 따로 옮겨지며 같은 열 목록·매퍼가 두 벌(request_row·records)
//! 생겼었다. 열 하나를 더할 때 한쪽만 고치면 경로마다 응답 모양이 갈리므로 여기 하나로 모은다.
//! 행 → 객체 변환의 바탕(drizzle 의 boolean 규칙 등)은 [`crate::rows`] 가 맡는다.

use rusqlite::{Connection, OptionalExtension, Row};
use serde_json::{Map, Value};

use crate::api_contract::parse_contract;
use crate::auth_config::{auth_for_client, sanitize_request_auth};
use crate::json_cols::{safe_json, to_kv_array, to_object, to_object_array, to_string_array};
use crate::rows::{self, Col};
use crate::{js, secretbox};

/// (JSON 필드명, DB 열 이름, 읽는 방식)
pub type Cols = [(&'static str, &'static str, Col)];

pub const EXECUTION_COLS: &Cols = &[
    ("executionSource", "execution_source", Col::Plain),
    ("denialReason", "denial_reason", Col::Plain),
    ("id", "id", Col::Plain),
    ("requestId", "request_id", Col::Plain),
    ("executedBy", "executed_by", Col::Plain),
    ("executedAt", "executed_at", Col::Plain),
    ("environmentId", "environment_id", Col::Plain),
    ("resolved", "resolved", Col::Plain),
    ("responseStatus", "response_status", Col::Plain),
    ("responseHeaders", "response_headers", Col::Plain),
    ("responseBody", "response_body", Col::Plain),
    ("durationMs", "duration_ms", Col::Plain),
    ("error", "error", Col::Plain),
    ("checkPassed", "check_passed", Col::Bool),
    ("assertionResults", "assertion_results", Col::Plain),
    ("missingVariables", "missing_variables", Col::Plain),
    ("pinned", "pinned", Col::Bool),
];

pub const REQUEST_COLS: &Cols = &[
    ("aiExecutionAllowed", "ai_execution_allowed", Col::Bool),
    ("id", "id", Col::Plain),
    ("folderId", "folder_id", Col::Plain),
    ("name", "name", Col::Plain),
    ("method", "method", Col::Plain),
    ("url", "url", Col::Plain),
    ("params", "params", Col::Plain),
    ("headers", "headers", Col::Plain),
    ("bodyType", "body_type", Col::Plain),
    ("body", "body", Col::Plain),
    ("description", "description", Col::Plain),
    ("sortOrder", "sort_order", Col::Plain),
    ("origin", "origin", Col::Plain),
    ("specState", "spec_state", Col::Plain),
    ("specOperationKey", "spec_operation_key", Col::Plain),
    ("specFingerprint", "spec_fingerprint", Col::Plain),
    ("specContract", "spec_contract", Col::Plain),
    ("owner", "owner", Col::Plain),
    ("updatedAt", "updated_at", Col::Plain),
    ("updatedBy", "updated_by", Col::Plain),
    ("assertions", "assertions", Col::Plain),
    ("preSteps", "pre_steps", Col::Plain),
    ("postSteps", "post_steps", Col::Plain),
    ("auth", "auth", Col::Plain),
    ("tags", "tags", Col::Plain),
    ("settings", "settings", Col::Plain),
    ("vars", "vars", Col::Plain),
];

pub const FOLDER_COLS: &Cols = &[
    ("id", "id", Col::Plain),
    ("workspaceId", "workspace_id", Col::Plain),
    ("name", "name", Col::Plain),
    ("specSourceType", "spec_source_type", Col::Plain),
    ("specSourceUrl", "spec_source_url", Col::Plain),
    ("sortOrder", "sort_order", Col::Plain),
    ("sharedHeaders", "shared_headers", Col::Plain),
    ("sharedAuth", "shared_auth", Col::Plain),
    ("description", "description", Col::Plain),
];

/// `"t"."a", "t"."b", ...` — drizzle 이 만드는 select 목록과 같은 모양. 조인할 때 열 이름이 겹치지 않게 테이블 이름을 붙인다.
pub fn select_list(table: &str, cols: &Cols) -> String {
    cols.iter().map(|(_, c, _)| format!(r#""{table}"."{c}""#)).collect::<Vec<_>>().join(", ")
}

/// 행의 start 번째 열부터 cols 순서대로 객체로 읽는다.
pub fn read(row: &Row<'_>, cols: &Cols, start: usize) -> rusqlite::Result<Map<String, Value>> {
    let spec: Vec<(&str, usize, Col)> = cols.iter().enumerate().map(|(i, (name, _, kind))| (*name, start + i, *kind)).collect();
    rows::object(row, &spec)
}

/// `db.select().from(requests).where(eq(requests.id, id))` — drizzle 이 돌려주던 행 그대로.
pub fn select_request(c: &Connection, id: &str) -> rusqlite::Result<Option<Map<String, Value>>> {
    let sql = format!(r#"SELECT {} FROM "requests" WHERE "requests"."id" = ?1"#, select_list("requests", REQUEST_COLS));
    c.prepare_cached(&sql)?.query_row([id], |r| read(r, REQUEST_COLS, 0)).optional()
}

/// `{ ...obj, [k]: v }` — 있던 키는 제자리, 없던 키는 맨 뒤.
fn put(m: &mut Map<String, Value>, k: &str, v: Value) {
    m.insert(k.to_string(), v);
}

/// parseRequestRow — 실행·미리보기가 읽어 쓰는 형태(인증 비밀값은 복호화된 평문).
pub fn parse_request_row(row: &Map<String, Value>) -> Map<String, Value> {
    let mut out = row.clone();
    let col = |k: &str| safe_json(row.get(k));
    put(&mut out, "owner", match row.get("owner") {
        None | Some(Value::Null) => Value::String(String::new()),
        Some(v) => v.clone(),
    });
    put(&mut out, "specContract", parse_contract(row.get("specContract")).unwrap_or(Value::Null));
    put(&mut out, "params", Value::Array(to_kv_array(col("params").as_ref())));
    put(&mut out, "headers", Value::Array(to_kv_array(col("headers").as_ref())));
    put(&mut out, "assertions", Value::Array(to_object_array(col("assertions").as_ref())));
    put(&mut out, "preSteps", Value::Array(to_object_array(col("preSteps").as_ref())));
    put(&mut out, "postSteps", Value::Array(to_object_array(col("postSteps").as_ref())));
    // auth: 타입·내부 필드를 유효한 모양으로 강제한 뒤 복호화(비밀 필드는 저장형 암호문 '문자열' 이라 sanitize 가 보존한다).
    put(&mut out, "auth", secretbox::decrypt_auth_config(&sanitize_request_auth(col("auth").as_ref())));
    put(&mut out, "tags", Value::Array(to_string_array(col("tags").as_ref())));
    put(&mut out, "settings", to_object(col("settings").as_ref()));
    put(&mut out, "vars", Value::Array(to_kv_array(col("vars").as_ref())));
    out
}

/// toClientRequest — 화면으로 내보내는 형태. 저장된 인증 비밀값을 지운다({{var}} 참조는 둔다).
/// parseRequestRow 자체에서 지우면 안 된다 — 실행 경로가 그걸로 인증을 실어 보낸다.
pub fn to_client_request(row: &Map<String, Value>) -> Value {
    let mut parsed = parse_request_row(row);
    let masked = auth_for_client(parsed.get("auth").unwrap_or(&Value::Null));
    put(&mut parsed, "auth", masked);
    Value::Object(parsed)
}

/// `safeJson(x) ?? fallback` — 파싱 결과가 null 이어도 fallback.
fn parse_or(v: Option<&Value>, fallback: Value) -> Value {
    safe_json(v).filter(|x| !x.is_null()).unwrap_or(fallback)
}

/// parseExecution — 손상된 실행 행 하나가 목록 조회 전체를 500 내지 않게, 그 행의 JSON 열만 기본값으로.
pub fn parse_execution(mut row: Map<String, Value>) -> Value {
    let assertion = match row.get("assertionResults") {
        None | Some(Value::Null) => parse_or(Some(&Value::String("[]".into())), Value::Array(vec![])),
        v => parse_or(v, Value::Array(vec![])),
    };
    let resolved = parse_or(row.get("resolved"), Value::Object(Map::new()));
    let headers = if js::truthy(row.get("responseHeaders")) { parse_or(row.get("responseHeaders"), Value::Null) } else { Value::Null };
    let missing = parse_or(row.get("missingVariables"), Value::Array(vec![]));
    put(&mut row, "assertionResults", assertion);
    put(&mut row, "resolved", resolved);
    put(&mut row, "responseHeaders", headers);
    put(&mut row, "missingVariables", missing);
    Value::Object(row)
}

/// 숫자 열을 f64 로 — sort_order·updated_at 처럼 integer 열이지만 SQLite 는 형식을 강제하지 않는다.
pub fn num(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn base() -> Map<String, Value> {
        json!({
            "id": "r1", "folderId": "f1", "name": "x", "method": "GET", "url": "/x",
            "params": "[]", "headers": "[]", "bodyType": "none", "body": "", "description": "",
            "origin": "manual", "specState": null, "specOperationKey": null, "specFingerprint": null,
            "auth": r#"{"type":"none"}"#, "tags": "[]", "settings": "{}",
            "assertions": "[]", "preSteps": "[]", "postSteps": "[]", "updatedAt": 0,
        })
        .as_object()
        .unwrap()
        .clone()
    }
    fn with(k: &str, v: &str) -> Map<String, Value> {
        let mut m = base();
        m.insert(k.into(), json!(v));
        m
    }
    fn p(m: Map<String, Value>) -> Map<String, Value> {
        parse_request_row(&m)
    }

    #[test]
    fn auth_가_null_배열_원시값_깨진값이면_none() {
        for a in ["null", "[1,2]", "42", "{bad"] {
            assert_eq!(p(with("auth", a))["auth"], json!({"type": "none"}), "{a}");
        }
    }

    #[test]
    fn 비배열_열은_빈_배열로() {
        let mut m = base();
        for (k, v) in [("params", "{}"), ("headers", "null"), ("assertions", "42"), ("preSteps", "\"x\""), ("postSteps", "5")] {
            m.insert(k.into(), json!(v));
        }
        let o = p(m);
        for k in ["params", "headers", "assertions", "preSteps", "postSteps"] {
            assert_eq!(o[k], json!([]), "{k}");
        }
    }

    #[test]
    fn settings_가_배열_원시값이면_빈_객체() {
        for s in ["[1,2]", "null", "99"] {
            assert_eq!(p(with("settings", s))["settings"], json!({}));
        }
    }

    #[test]
    fn 잘못된_배열_요소를_걸러낸다() {
        let mut m = base();
        m.insert("params".into(), json!(json!([null, 42, {"key": "q"}, {"key": "k", "value": 123}, {"key": "ok", "value": "v", "enabled": false}]).to_string()));
        m.insert("headers".into(), json!(json!([null, "x", {"key": "H", "value": "V"}]).to_string()));
        m.insert("assertions".into(), json!(json!([null, {"target": "status"}, 5]).to_string()));
        let o = p(m);
        assert_eq!(
            o["params"],
            json!([{"key": "q", "value": "", "enabled": true}, {"key": "k", "value": "123", "enabled": true}, {"key": "ok", "value": "v", "enabled": false}])
        );
        assert_eq!(o["headers"], json!([{"key": "H", "value": "V", "enabled": true}]));
        assert_eq!(o["assertions"], json!([{"target": "status"}]));
    }

    #[test]
    fn auth_내부_필드가_비문자열이어도_안전() {
        assert_eq!(p(with("auth", r#"{"type":"bearer","token":{"x":1}}"#))["auth"], json!({"type": "bearer", "token": ""}));
        assert_eq!(p(with("auth", r#"{"type":"bearer","token":123}"#))["auth"], json!({"type": "bearer", "token": ""}));
        assert_eq!(p(with("auth", r#"{"type":"basic","username":5,"password":{}}"#))["auth"], json!({"type": "basic", "username": "", "password": ""}));
    }

    #[test]
    fn 정상_값은_그대로() {
        let mut m = base();
        m.insert("params".into(), json!(r#"[{"key":"a","value":"1","enabled":true}]"#));
        m.insert("tags".into(), json!(r#"["smoke"]"#));
        m.insert("settings".into(), json!(r#"{"timeoutMs":5000}"#));
        m.insert("auth".into(), json!(r#"{"type":"bearer","token":"raw-token"}"#));
        let o = p(m.clone());
        assert_eq!(o["params"], json!([{"key": "a", "value": "1", "enabled": true}]));
        assert_eq!(o["tags"], json!(["smoke"]));
        assert_eq!(o["settings"], json!({"timeoutMs": 5000}));
        assert_eq!(o["auth"]["token"], json!("raw-token"));
        // 화면으로 내보낼 때만 지운다
        assert_eq!(to_client_request(&m)["auth"], json!({"type": "bearer", "token": "", "hasStoredSecret": true}));
    }

    #[test]
    fn 키_순서는_펼치기와_같다() {
        // 없던 owner·specContract·vars 는 뒤에 붙고, 있던 키는 제자리.
        let o = p(base());
        let keys: Vec<&str> = o.keys().map(String::as_str).collect();
        assert_eq!(&keys[..3], &["id", "folderId", "name"]);
        assert_eq!(&keys[keys.len() - 3..], &["owner", "specContract", "vars"]);
    }

    #[test]
    fn 실행_행_방어_파싱() {
        let m = json!({"id": "e", "assertionResults": null, "resolved": "{bad", "responseHeaders": "", "missingVariables": "null"});
        let o = parse_execution(m.as_object().unwrap().clone());
        assert_eq!(o, json!({"id": "e", "assertionResults": [], "resolved": {}, "responseHeaders": null, "missingVariables": []}));
    }

    #[test]
    fn 손상된_실행_행은_기본값으로() {
        let row = json!({ "id": "e", "resolved": "{oops", "responseHeaders": "", "assertionResults": null, "missingVariables": "null", "pinned": false });
        let out = parse_execution(row.as_object().unwrap().clone());
        assert_eq!(out, json!({ "id": "e", "resolved": {}, "responseHeaders": null, "assertionResults": [], "missingVariables": [], "pinned": false }));
        let ok = parse_execution(json!({ "resolved": "{\"method\":\"GET\"}", "responseHeaders": "{\"a\":\"b\"}" }).as_object().unwrap().clone());
        assert_eq!(ok["resolved"]["method"], "GET");
        assert_eq!(ok["responseHeaders"], json!({ "a": "b" }));
    }

    #[test]
    fn 화면용_요청은_비밀값을_지우고_열을_정규화한다() {
        let row = json!({ "id": "r", "params": "{}", "headers": "[null,{\"key\":\"a\",\"value\":1}]", "specContract": null, "owner": "",
            "assertions": "oops", "preSteps": "[]", "postSteps": "[]", "auth": "{\"type\":\"bearer\",\"token\":\"LIT\"}",
            "tags": "[\"a\",1]", "settings": "[]", "vars": "[]" });
        let out = to_client_request(row.as_object().unwrap());
        assert_eq!(out["auth"], json!({ "type": "bearer", "token": "", "hasStoredSecret": true }));
        assert_eq!(out["headers"], json!([{ "key": "a", "value": "1", "enabled": true }]));
        assert_eq!(out["params"], json!([]));
        assert_eq!(out["tags"], json!(["a"]));
        assert_eq!(out["settings"], json!({}));
        assert_eq!(out["specContract"], Value::Null);
    }
}
