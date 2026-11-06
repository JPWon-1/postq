//! 실행 경로 공유 헬퍼 — 헤더 병합, 쿠키 jar 주입·저장 등.
//!
//! 단건 실행·ad-hoc·시나리오·일괄 실행이 각자 복제하던 보안 로직(인증 주입·이력 스크럽)을 한 곳에 둔다 —
//! 한쪽만 마스킹을 빠뜨리면 secret·실토큰이 팀 이력·MCP 로 평문 유출된다.
//!
//! 공개 API
//! - [`apply_authorization`] — 유효 인증을 real 에 주입(redacted 에는 마스킹 값). 오류 문장을 돌려준다.
//! - [`build_stored_execution`] → [`StoredExecution`] — 이력 저장분(자격증명 헤더 마스킹 + echo 된 secret 스크럽).
//! - [`merge_folder_headers`] — 폴더 공통 헤더 병합(요청의 활성 키가 이긴다).
//! - [`inject_jar_cookies`]·[`save_set_cookies`] — (workspaceId, cookieEnv) 스코프 쿠키 jar.

use rusqlite::Connection;
use serde_json::Value;

use crate::cookies::{build_cookie_header, is_expired, parse_set_cookie, JarCookie};
use crate::executor::{headers_to_json, ExecResult};
use crate::request_auth::{build_authorization, field, mask_authorization, type_of};
use crate::resolve::{resolve_text, Kv, RequestInput};
use crate::scrub::{mask_credential_headers, scrub_headers, scrub_secrets};
use crate::variables::VarMap;
use crate::{js, secretbox};

/// `${url}${url.includes('?') ? '&' : '?'}${encodeURIComponent(key)}=${encodeURIComponent(value)}`
fn append_query(url: &str, key: &str, value: &str) -> String {
    format!("{url}{}{}={}", if url.contains('?') { '&' } else { '?' }, js::encode_uri_component(key), js::encode_uri_component(value))
}

/// 유효 인증으로 자격증명을 real 에 주입한다.
/// - bearer/basic/oauth2cc: Authorization 헤더 계산·주입(요청에 이미 활성 Authorization 이 있으면 존중).
/// - apikey: 지정한 이름의 커스텀 헤더 또는 쿼리 파라미터.
///
/// redacted 를 주면 마스킹된 값을 함께 넣는다(팀 공유 이력용). 실패하면 오류 문장.
pub async fn apply_authorization(auth: &Value, vars: &VarMap, real: &mut RequestInput, redacted: Option<&mut RequestInput>) -> Option<String> {
    let ty = type_of(auth);
    if matches!(ty, Some("none") | Some("inherit")) {
        return None;
    }
    if ty == Some("apikey") {
        let name = js::trim(&resolve_text(&field(auth, "key"), vars, None)).to_string();
        if name.is_empty() {
            return None;
        }
        let value = resolve_text(&field(auth, "value"), vars, None);
        if auth.get("in").and_then(Value::as_str) == Some("query") {
            real.url = append_query(&real.url, &name, &value);
            if let Some(r) = redacted {
                r.url = append_query(&r.url, &name, "***");
            }
        } else {
            real.headers.push(Kv::new(&name, &value));
            if let Some(r) = redacted {
                r.headers.push(Kv::new(&name, "***"));
            }
        }
        return None;
    }
    if real.headers.iter().any(|h| h.enabled && h.key.to_lowercase() == "authorization") {
        return None;
    }
    let ar = build_authorization(Some(auth), vars).await;
    if ar.error.is_some() {
        return ar.error;
    }
    if let Some(a) = ar.authorization.filter(|a| !a.is_empty()) {
        if let Some(r) = redacted {
            r.headers.push(Kv::new("Authorization", &mask_authorization(&a)));
        }
        real.headers.push(Kv::new("Authorization", &a));
    }
    None
}

/// 이력 저장분 — 각 값은 그대로 executions 열에 들어간다.
#[derive(Clone, Debug, PartialEq)]
pub struct StoredExecution {
    pub resolved: String,
    pub response_headers: Option<String>,
    pub response_body: Option<String>,
}

/// resolved 는 리터럴 자격증명 헤더 마스킹, 응답 바디·헤더는 요청이 보낸 secret 이 echo 된 경우 값 기반 스크럽.
pub fn build_stored_execution(redacted: &RequestInput, result: &ExecResult, secret_vals: &[String]) -> StoredExecution {
    let mut resolved = redacted.to_json();
    let masked = mask_credential_headers(resolved["headers"].as_array().map(Vec::as_slice).unwrap_or(&[]));
    resolved["headers"] = Value::Array(masked);
    let headers = scrub_headers(result.headers.as_deref(), secret_vals);
    StoredExecution {
        resolved: js::stringify(&resolved),
        response_headers: headers.map(|h| js::stringify(&headers_to_json(&h))),
        response_body: scrub_secrets(result.body.as_deref(), secret_vals),
    }
}

/// 폴더 공통 헤더를 요청 헤더에 병합한다(실행 시점, 변수 치환 전). 요청에 같은 키(대소문자 무시)가 **활성**으로 있으면
/// 요청 값이 이기고 폴더 헤더는 붙지 않는다. 순서: 요청 헤더 그대로 + 적용된 폴더 헤더.
pub fn merge_folder_headers(request_headers: &[Kv], folder_headers: &[Kv]) -> Vec<Kv> {
    let active: Vec<String> = request_headers.iter().filter(|h| h.enabled && !js::trim(&h.key).is_empty()).map(|h| h.key.to_lowercase()).collect();
    let mut out = request_headers.to_vec();
    out.extend(folder_headers.iter().filter(|h| h.enabled && !js::trim(&h.key).is_empty() && !active.contains(&h.key.to_lowercase())).cloned());
    out
}

/// `new URL(url).host` — 변수 미해석 URL 이면 None(쿠키를 건너뛴다).
pub fn url_host(url: &str) -> Option<String> {
    let u = url::Url::parse(url).ok()?;
    let host = u.host_str()?.to_string();
    Some(match u.port() {
        Some(p) => format!("{host}:{p}"),
        None => host,
    })
    .filter(|h| !h.is_empty())
}

/// 요청에 활성 Cookie 헤더가 없을 때만 jar 에서 도메인 매칭 쿠키를 붙인다. jar 값은 at-rest 암호문일 수 있어 복호화.
pub fn inject_jar_cookies(c: &Connection, workspace_id: &str, cookie_env: &str, host: &str, real: &mut RequestInput) -> rusqlite::Result<()> {
    if host.is_empty() || real.headers.iter().any(|h| h.enabled && h.key.to_lowercase() == "cookie") {
        return Ok(());
    }
    let mut st = c.prepare_cached(
        r#"SELECT "name", "value", "domain", "expires" FROM "cookies" WHERE ("cookies"."workspace_id" = ?1 AND "cookies"."environment_id" = ?2)"#,
    )?;
    let jar = st
        .query_map([workspace_id, cookie_env], |r| {
            Ok(JarCookie {
                name: crate::rows::text(r, 0)?,
                value: secretbox::decrypt_secret(&crate::rows::text(r, 1)?),
                domain: crate::rows::text(r, 2)?,
                expires: match r.get_ref(3)? {
                    rusqlite::types::ValueRef::Integer(i) => Some(i as f64),
                    rusqlite::types::ValueRef::Real(f) => Some(f),
                    _ => None,
                },
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let header = build_cookie_header(&jar, host);
    if !header.is_empty() {
        real.headers.push(Kv::new("Cookie", &header));
    }
    Ok(())
}

/// 응답 Set-Cookie → jar upsert(만료 지시는 삭제). 값은 암호화해 저장.
pub fn save_set_cookies(c: &Connection, workspace_id: &str, cookie_env: &str, host: &str, lines: &[String]) -> rusqlite::Result<()> {
    if host.is_empty() {
        return Ok(());
    }
    for line in lines {
        let Some(ck) = parse_set_cookie(line, host) else { continue };
        c.prepare_cached(
            r#"DELETE FROM "cookies" WHERE ("cookies"."workspace_id" = ?1 AND "cookies"."environment_id" = ?2 AND "cookies"."domain" = ?3 AND "cookies"."name" = ?4)"#,
        )?
        .execute([workspace_id, cookie_env, &ck.domain, &ck.name])?;
        if !is_expired(&ck) {
            let expires = ck.expires.map(|e| if e.fract() == 0.0 { rusqlite::types::Value::Integer(e as i64) } else { rusqlite::types::Value::Real(e) });
            c.prepare_cached(
                r#"INSERT INTO "cookies" ("id", "workspace_id", "environment_id", "domain", "name", "value", "path", "expires", "updated_at") VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"#,
            )?
            .execute(rusqlite::params![
                uuid::Uuid::new_v4().to_string(),
                workspace_id,
                cookie_env,
                ck.domain,
                ck.name,
                secretbox::encrypt_secret(&ck.value),
                ck.path,
                expires,
                js::now_ms()
            ])?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::variables::Var;
    use serde_json::json;

    fn input() -> RequestInput {
        RequestInput { method: "GET".into(), url: "https://x/y".into(), params: vec![], headers: vec![], body_type: "none".into(), body: String::new() }
    }

    #[test]
    fn 폴더_헤더_병합() {
        let req = vec![Kv::new("X-A", "req"), Kv { enabled: false, ..Kv::new("X-B", "off") }];
        let folder = vec![Kv::new("x-a", "folder"), Kv::new("X-B", "folder-b"), Kv::new(" ", "blank"), Kv { enabled: false, ..Kv::new("X-C", "c") }, Kv::new("X-D", "d")];
        let out = merge_folder_headers(&req, &folder);
        let keys: Vec<(&str, &str)> = out.iter().map(|h| (h.key.as_str(), h.value.as_str())).collect();
        assert_eq!(keys, [("X-A", "req"), ("X-B", "off"), ("X-B", "folder-b"), ("X-D", "d")]);
        assert!(merge_folder_headers(&[], &[]).is_empty());
    }

    #[tokio::test]
    async fn apikey_헤더_쿼리_와_bearer_마스킹() {
        let mut v = VarMap::new();
        v.insert("k", Var { value: "SECRET".into(), secret: true });
        let (mut real, mut red) = (input(), input());
        let auth = json!({ "type": "apikey", "key": " X-Key ", "value": "{{k}}", "in": "header" });
        assert_eq!(apply_authorization(&auth, &v, &mut real, Some(&mut red)).await, None);
        assert_eq!(real.headers, vec![Kv::new("X-Key", "SECRET")]);
        assert_eq!(red.headers, vec![Kv::new("X-Key", "***")]);

        let (mut real, mut red) = (input(), input());
        real.url = "https://x/y?a=1".into();
        let auth = json!({ "type": "apikey", "key": "api key", "value": "a&b", "in": "query" });
        apply_authorization(&auth, &v, &mut real, Some(&mut red)).await;
        assert_eq!(real.url, "https://x/y?a=1&api%20key=a%26b");
        assert_eq!(red.url, "https://x/y?api%20key=***");

        let (mut real, mut red) = (input(), input());
        apply_authorization(&json!({ "type": "bearer", "token": "{{k}}" }), &v, &mut real, Some(&mut red)).await;
        assert_eq!(real.headers, vec![Kv::new("Authorization", "Bearer SECRET")]);
        assert_eq!(red.headers, vec![Kv::new("Authorization", "Bearer ***")]);

        // 이미 Authorization 이 있으면 존중
        let mut real = input();
        real.headers = vec![Kv::new("authorization", "mine")];
        apply_authorization(&json!({ "type": "bearer", "token": "x" }), &v, &mut real, None).await;
        assert_eq!(real.headers.len(), 1);
        // 빈 키 apikey 는 무동작
        let mut real = input();
        apply_authorization(&json!({ "type": "apikey", "key": "  ", "value": "v" }), &v, &mut real, None).await;
        assert!(real.headers.is_empty());
        // oauth 오류는 문장으로
        let mut real = input();
        assert_eq!(apply_authorization(&json!({ "type": "oauth2cc" }), &v, &mut real, None).await.as_deref(), Some("OAuth2: 토큰 URL 과 Client ID 가 필요합니다"));
    }

    #[test]
    fn 저장분은_자격증명_헤더_마스킹과_echo_스크럽() {
        let mut red = input();
        red.headers = vec![Kv::new("Authorization", "Bearer LITERAL"), Kv::new("X-Api-Key", "{{key}}"), Kv::new("X-Trace", "t")];
        let result = ExecResult {
            status: Some(200),
            headers: Some(vec![("x-echo".into(), "SECRETVAL".into())]),
            body: Some(r#"{"echo":"SECRETVAL"}"#.into()),
            ..Default::default()
        };
        let s = build_stored_execution(&red, &result, &["SECRETVAL".to_string()]);
        let resolved: Value = serde_json::from_str(&s.resolved).unwrap();
        assert_eq!(resolved["headers"][0]["value"], "***");
        assert_eq!(resolved["headers"][1]["value"], "{{key}}");
        assert_eq!(resolved["headers"][2]["value"], "t");
        assert!(s.resolved.starts_with(r#"{"method":"GET","bodyType":"none","url":"#));
        assert_eq!(s.response_headers.as_deref(), Some(r#"{"x-echo":"***"}"#));
        assert_eq!(s.response_body.as_deref(), Some(r#"{"echo":"***"}"#));
        let none = build_stored_execution(&red, &ExecResult { error: Some("e".into()), ..Default::default() }, &[]);
        assert_eq!((none.response_headers, none.response_body), (None, None));
    }

    #[test]
    fn 쿠키_jar_주입과_저장() {
        let db = crate::variables::tests::test_db();
        db.with(|c| {
            save_set_cookies(c, "ws", "", "api.example.com", &["sid=abc; Path=/".into(), "gone=1; Max-Age=0".into()])?;
            assert_eq!(c.query_row("SELECT count(*) FROM cookies", [], |r| r.get::<_, i64>(0))?, 1);
            let mut real = input();
            inject_jar_cookies(c, "ws", "", "api.example.com", &mut real)?;
            assert_eq!(real.headers, vec![Kv::new("Cookie", "sid=abc")]);
            // 다른 스코프·이미 Cookie 가 있으면 안 붙인다
            let mut real = input();
            inject_jar_cookies(c, "ws", "env", "api.example.com", &mut real)?;
            assert!(real.headers.is_empty());
            let mut real = input();
            real.headers = vec![Kv::new("cookie", "mine=1")];
            inject_jar_cookies(c, "ws", "", "api.example.com", &mut real)?;
            assert_eq!(real.headers.len(), 1);
            // 만료 지시는 삭제
            save_set_cookies(c, "ws", "", "api.example.com", &["sid=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT".into()])?;
            assert_eq!(c.query_row("SELECT count(*) FROM cookies", [], |r| r.get::<_, i64>(0))?, 0);
            Ok(())
        })
        .unwrap();
        assert_eq!(url_host("http://h:8080/x").as_deref(), Some("h:8080"));
        assert_eq!(url_host("https://h/x").as_deref(), Some("h"));
        assert_eq!(url_host("{{base}}/x"), None);
    }
}
