//! pre/post 비주얼 스텝 실행기.
//!
//! 화이트리스트 연산만 수행한다(임의 코드 실행 없음). 스텝은 저장 열·클라이언트 JSON 을 그대로(serde_json::Value)
//! 받아 JS 의 느슨한 규칙(비문자열 인자는 String(), null 요소는 건너뜀)대로 읽는다 — 손편집 데이터 하나로
//! 실행 전체가 500 이 나면 안 된다.
//!
//! 공개 API
//! - [`apply_pre_steps`] — 순서대로 변수를 계산해 스코프에 누적(뒤 스텝이 앞 결과를 {{name}} 으로 참조).
//! - [`apply_post_steps`] → [`PostOutcome`] — 응답 바디(jsonPath)·헤더에서 값 추출.
//! - [`build_exec_vars`] — 팀 변수 + 개인 오버라이드 + 동적변수 + pre-step. 단건/ad-hoc/시나리오가 같이 쓴다.
//! - [`pre_step_secret`]·[`hmac_sha256_hex`]

use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::js;
use crate::json_leaves::get_by_path;
use crate::resolve::{apply_personal_vars, dynamic_vars, random_f64, references_secret, resolve_text, NameSet};
use crate::variables::{Var, VarMap};

/// hmac 결과 등 파생 민감값은 기본 secret — 명시 플래그(`s.secret ?? op === 'hmacSha256'`)가 있으면 그것.
pub fn pre_step_secret(s: &Value) -> bool {
    match s.get("secret") {
        None | Some(Value::Null) => s.get("op").and_then(Value::as_str) == Some("hmacSha256"),
        v => js::truthy(v),
    }
}

/// HMAC-SHA256(hex) — node:crypto createHmac('sha256', key).update(msg).digest('hex').
/// hmac 크레이트 없이 RFC 2104 그대로(블록 64바이트, 긴 키는 먼저 해시).
pub fn hmac_sha256_hex(key: &[u8], msg: &[u8]) -> String {
    let mut k = [0u8; 64];
    if key.len() > 64 {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(k.iter().map(|b| b ^ 0x36).collect::<Vec<_>>());
    inner.update(msg);
    let mut outer = Sha256::new();
    outer.update(k.iter().map(|b| b ^ 0x5c).collect::<Vec<_>>());
    outer.update(inner.finalize());
    hex::encode(outer.finalize())
}

/// `String(t ?? '')`
fn arg(s: &Value, k: &str) -> String {
    match s.get(k) {
        None | Some(Value::Null) => String::new(),
        Some(v) => js::to_string(v),
    }
}

/// Pre-request 스텝을 순서대로 적용해 변수 스코프에 누적한다. 각 인자는 지금까지 누적된 vars 로 먼저 치환한다.
/// missing 을 주면 인자에서 못 채운 변수 이름을 담는다.
pub fn apply_pre_steps(base: &VarMap, steps: &[Value], mut missing: Option<&mut NameSet>) -> VarMap {
    let mut vars = base.clone();
    for s in steps {
        // 이름 없는/null 스텝은 건너뜀(`!s?.name`).
        let name = match s.get("name") {
            Some(n) if js::truthy(Some(n)) => js::to_string(n),
            _ => continue,
        };
        let op = s.get("op").and_then(Value::as_str).unwrap_or("");
        // secret 오염 전파: 인자가 secret 변수를 참조하면 결과도 secret(setValue=동일값, base64=가역).
        // 안 하면 {{apiSecret}} 를 setValue/base64 로 담은 값이 평문으로 이력·cURL 에 샌다.
        let mut tainted = false;
        let value = match op {
            "setValue" => {
                let t = arg(s, "value");
                tainted = references_secret(&t, &vars);
                resolve_text(&t, &vars, missing.as_deref_mut())
            }
            "timestamp" => js::now_ms().to_string(),
            "uuid" => uuid::Uuid::new_v4().to_string(),
            "randomInt" => {
                // Math.trunc(Number(x) || 0) — NaN 은 0.
                let n = |t: String| {
                    let v = js::number(&t);
                    if v.is_nan() { 0.0 } else { v.trunc() }
                };
                let mn = n(resolve_text(&arg(s, "min"), &vars, missing.as_deref_mut()));
                let mx = n(resolve_text(&arg(s, "max"), &vars, missing.as_deref_mut()));
                let (lo, hi) = (mn.min(mx), mn.max(mx));
                js::number_to_string(lo + (random_f64() * (hi - lo + 1.0)).floor())
            }
            "base64" => {
                let t = arg(s, "input");
                let out = base64::engine::general_purpose::STANDARD.encode(resolve_text(&t, &vars, missing.as_deref_mut()));
                tainted = references_secret(&t, &vars);
                out
            }
            "hmacSha256" => {
                // 결과는 단방향 해시라 기본 secret(pre_step_secret). 입력 secret 유무와 무관하게 마스킹.
                let key = resolve_text(&arg(s, "key"), &vars, missing.as_deref_mut());
                let msg = resolve_text(&arg(s, "input"), &vars, missing.as_deref_mut());
                hmac_sha256_hex(key.as_bytes(), msg.as_bytes())
            }
            _ => continue,
        };
        vars.insert(&name, Var { value, secret: pre_step_secret(s) || tainted });
    }
    vars
}

/// post-step 추출 결과. extracted 각 항목은 `{ name, value, secret }` 그대로 응답에 실린다.
#[derive(Clone, Debug, Default)]
pub struct PostOutcome {
    pub extracted: Vec<Value>,
    pub missing: Vec<String>,
}

/// Post-response 스텝 — jsonPath(바디 dot 경로) 또는 header(대소문자 무시)로 값을 꺼낸다. 검증(assertions)은 따로.
pub fn apply_post_steps(body: Option<&str>, headers: Option<&[(String, String)]>, steps: &[Value]) -> PostOutcome {
    let mut out = PostOutcome::default();
    if steps.is_empty() {
        return out;
    }
    let parsed = body.filter(|b| !b.is_empty()).and_then(js::parse_json).filter(|v| !v.is_null());
    for s in steps {
        let (Some(name), Some(path)) = (s.get("name").filter(|v| js::truthy(Some(v))), s.get("path").filter(|v| js::truthy(Some(v)))) else {
            continue;
        };
        // 비문자열 name/path(손편집/레거시)도 String() 으로.
        let (name, path) = (js::to_string(name), js::to_string(path));
        let v = if s.get("source").and_then(Value::as_str) == Some("header") {
            let want = path.to_lowercase();
            headers.and_then(|h| h.iter().find(|(k, _)| k.to_lowercase() == want)).map(|(_, v)| v.clone())
        } else {
            parsed.as_ref().and_then(|p| get_by_path(p, &path))
        };
        match v {
            None => out.missing.push(path),
            Some(value) => {
                let secret = match s.get("secret") {
                    None | Some(Value::Null) => Value::Bool(false),
                    Some(x) => x.clone(),
                };
                out.extracted.push(json!({ "name": name, "value": value, "secret": secret }));
            }
        }
    }
    out
}

/// 실행용 변수 스코프: 팀 환경 + 개인 오버라이드 + 동적변수 + pre-step 누적.
/// 3개 실행 라우트(단건/ad-hoc/flow)가 공유해 pre-step 처리 누락을 막는다.
pub fn build_exec_vars(team: &VarMap, personal: Option<&Value>, pre_steps: &[Value], missing: Option<&mut NameSet>) -> VarMap {
    let mut base = apply_personal_vars(team, personal);
    base.spread(&dynamic_vars());
    apply_pre_steps(&base, pre_steps, missing)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> VarMap {
        let mut m = VarMap::new();
        m.insert("secretKey", Var { value: "topsecret".into(), secret: true });
        m.insert("bodyText", Var { value: "payload".into(), secret: false });
        m
    }
    fn pre(steps: Value) -> VarMap {
        apply_pre_steps(&base(), steps.as_array().unwrap(), None)
    }

    #[test]
    fn set_value_와_체이닝() {
        let out = pre(json!([{ "name": "msg", "op": "setValue", "value": "hi-{{bodyText}}" }]));
        assert_eq!(out.get("msg").unwrap(), &Var { value: "hi-payload".into(), secret: false });
        let out = pre(json!([{ "name": "a", "op": "setValue", "value": "X" }, { "name": "b", "op": "setValue", "value": "{{a}}-Y" }]));
        assert_eq!(out.get("b").unwrap().value, "X-Y");
        assert_eq!(pre(json!([{ "name": "x", "op": "setValue", "value": 123 }])).get("x").unwrap().value, "123");
    }

    #[test]
    fn 연산들() {
        assert!(pre(json!([{ "name": "t", "op": "timestamp" }])).get("t").unwrap().value.bytes().all(|b| b.is_ascii_digit()));
        assert_eq!(pre(json!([{ "name": "u", "op": "uuid" }])).get("u").unwrap().value.len(), 36);
        assert_eq!(pre(json!([{ "name": "r", "op": "randomInt", "min": "5", "max": "5" }])).get("r").unwrap().value, "5");
        for _ in 0..50 {
            let v: f64 = pre(json!([{ "name": "r", "op": "randomInt", "min": "1", "max": "3" }])).get("r").unwrap().value.parse().unwrap();
            assert!((1.0..=3.0).contains(&v));
        }
        assert_eq!(pre(json!([{ "name": "b", "op": "base64", "input": "hello" }])).get("b").unwrap().value, "aGVsbG8=");
        // node -e "console.log(require('crypto').createHmac('sha256','topsecret').update('payload').digest('hex'))"
        let sig = pre(json!([{ "name": "sig", "op": "hmacSha256", "key": "{{secretKey}}", "input": "{{bodyText}}" }]));
        assert_eq!(sig.get("sig").unwrap().value, hmac_sha256_hex(b"topsecret", b"payload"));
        assert!(sig.get("sig").unwrap().secret);
        // RFC 4231 테스트 케이스 2
        assert_eq!(hmac_sha256_hex(b"Jefe", b"what do ya want for nothing?"), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
        // 64바이트보다 긴 키(RFC 4231 케이스 6)
        assert_eq!(
            hmac_sha256_hex(&[0xaa; 131], b"Test Using Larger Than Block-Size Key - Hash Key First"),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[test]
    fn secret_플래그와_오염_전파() {
        assert!(pre(json!([{ "name": "b", "op": "base64", "input": "x", "secret": true }])).get("b").unwrap().secret);
        assert!(!pre(json!([{ "name": "b", "op": "base64", "input": "x" }])).get("b").unwrap().secret);
        let out = pre(json!([
            { "name": "leak", "op": "setValue", "value": "Bearer {{secretKey}}" },
            { "name": "b64", "op": "base64", "input": "u:{{secretKey}}" },
            { "name": "plain", "op": "setValue", "value": "{{bodyText}}" },
        ]));
        assert!(out.get("leak").unwrap().secret);
        assert!(out.get("b64").unwrap().secret);
        assert!(!out.get("plain").unwrap().secret);
        // 이름 없는·null 스텝은 건너뜀
        assert_eq!(pre(json!([{ "name": "", "op": "uuid" }, null])).len(), 2);
    }

    #[test]
    fn pre_step_인자의_미해석_변수() {
        let mut m = NameSet::new();
        let out = apply_pre_steps(&VarMap::new(), json!([{ "name": "sig", "op": "setValue", "value": "v1-{{missingVar}}" }]).as_array().unwrap(), Some(&mut m));
        assert_eq!(out.get("sig").unwrap().value, "v1-{{missingVar}}");
        assert_eq!(m.items(), ["missingVar"]);
        let mut m = NameSet::new();
        apply_pre_steps(
            &VarMap::new(),
            json!([
                { "name": "r", "op": "randomInt", "min": "{{noMin}}", "max": "10" },
                { "name": "b", "op": "base64", "input": "{{noInput}}" },
                { "name": "h", "op": "hmacSha256", "key": "{{noKey}}", "input": "x" },
                { "name": "a", "op": "setValue", "value": "hello" },
                { "name": "c", "op": "setValue", "value": "{{a}}-world" },
            ])
            .as_array()
            .unwrap(),
            Some(&mut m),
        );
        assert_eq!(m.sorted(), ["noInput", "noKey", "noMin"]);
    }

    #[test]
    fn post_step_추출() {
        let o = apply_post_steps(Some(r#"{"data":{"token":"abc"}}"#), None, &[json!({ "name": "tok", "source": "jsonPath", "path": "data.token" })]);
        assert_eq!(o.extracted, vec![json!({ "name": "tok", "value": "abc", "secret": false })]);
        let h = vec![("X-Request-Id".to_string(), "r-9".to_string())];
        let o = apply_post_steps(None, Some(&h), &[json!({ "name": "rid", "source": "header", "path": "x-request-id" })]);
        assert_eq!(o.extracted[0], json!({ "name": "rid", "value": "r-9", "secret": false }));
        let o = apply_post_steps(Some(r#"{"a":1}"#), None, &[json!({ "name": "x", "source": "jsonPath", "path": "nope.deep" })]);
        assert!(o.extracted.is_empty());
        assert_eq!(o.missing, ["nope.deep"]);
        let o = apply_post_steps(Some(r#"{"t":"x"}"#), None, &[json!({ "name": "t", "source": "jsonPath", "path": "t", "secret": true })]);
        assert_eq!(o.extracted[0]["secret"], true);
        let o = apply_post_steps(Some("not-json"), None, &[json!({ "name": "t", "source": "jsonPath", "path": "t" })]);
        assert_eq!(o.missing, ["t"]);
        // 비문자열 path·null 요소
        let o = apply_post_steps(Some(r#"{"a":"hi"}"#), Some(&h), &[Value::Null, json!({ "name": "x", "source": "header", "path": 123 }), json!({ "name": "ok", "source": "jsonPath", "path": "a" })]);
        assert_eq!(o.extracted, vec![json!({ "name": "ok", "value": "hi", "secret": false })]);
    }

    #[test]
    fn 실행_변수_조립() {
        let mut team = VarMap::new();
        team.insert("host", Var { value: "h".into(), secret: false });
        let out = build_exec_vars(&team, Some(&json!({ "mytoken": "T" })), json!([{ "name": "sig", "op": "setValue", "value": "{{mytoken}}!" }]).as_array().unwrap(), None);
        assert_eq!(out.get("host").unwrap().value, "h");
        assert_eq!(out.get("mytoken").unwrap(), &Var { value: "T".into(), secret: true });
        assert_eq!(out.get("$uuid").unwrap().value.len(), 36);
        assert_eq!(out.get("sig").unwrap().value, "T!");
    }
}
