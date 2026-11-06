//! `/api/cookies`, `/api/cookies/import`.
//!
//! 쿠키 jar 조회/삭제/붙여넣기, 그리고 브라우저 확장(postq Cookie Bridge)이 보낸 쿠키 저장.
//! 스코프: workspaceId + environmentId('' = 공용).

use axum::body::Bytes;
use axum::extract::rejection::BytesRejection;
use axum::extract::{RawQuery, State};
use axum::http::{HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use rusqlite::Connection;
use serde_json::{json, Value};

use crate::jsval::Js;
use crate::cookies::parse_cookie_string;
use crate::error::ApiResult;
use crate::routes::input::{bad_request, read_json, require_text};
use crate::rows::{self, Col};
use crate::secretbox::{self, Keys};
use crate::{js, AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/cookies", get(list).post(paste).delete(remove))
        // 핸들러 밖에서 끝나는 응답(본문 상한 초과 413 같은 추출기 거절)에도 CORS 를 단다 — 핸들러 안의
        // with_cors 만으로는 그 응답에 헤더가 안 붙어 확장이 '왜 안 되는지' 를 못 읽는다(codex 리뷰).
        .route("/api/cookies/import", post(import).options(preflight).layer(axum::middleware::map_response(cors_layer)))
}

async fn cors_layer(res: Response) -> Response {
    with_cors(res)
}

/// https://, 경로, 앞 점(.example.com)을 떼어 호스트만 남긴다 — 붙여넣기·확장 두 API 가 같은 규칙.
/// `raw.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^\./, '').toLowerCase()`
fn normalize_domain(raw: &str) -> String {
    let s = raw.strip_prefix("https://").or_else(|| raw.strip_prefix("http://")).unwrap_or(raw);
    // `/\/.*$/` — JS 의 `.` 는 줄바꿈을 못 건너고 `$` 는 끝에서만 맞는다. 그래서 '/' 뒤에 줄바꿈이 있으면
    // 그 '/' 에서는 안 맞고 다음 '/' 를 찾는다. 줄바꿈 없는 꼬리를 가진 첫 '/' 부터 지운다.
    let line_break = |c: char| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}');
    let cut = s.char_indices().filter(|&(_, c)| c == '/').map(|(i, _)| i).find(|&i| !s[i..].contains(line_break));
    let s = match cut {
        Some(i) => &s[..i],
        None => s,
    };
    let s = s.strip_prefix('.').unwrap_or(s);
    s.to_lowercase()
}

async fn list(State(s): State<AppState>, RawQuery(q): RawQuery) -> ApiResult<Js> {
    let ws = js::query_get(q.as_deref(), "workspaceId").unwrap_or_else(|| "default".into());
    let env = js::query_get(q.as_deref(), "environmentId").unwrap_or_default();
    let out = s
        .db
        .run(move |c| {
            let mut st = c.prepare_cached(
                r#"SELECT "id", "workspace_id", "environment_id", "domain", "name", "value", "path", "expires", "updated_at" FROM "cookies" WHERE ("cookies"."workspace_id" = ?1 AND "cookies"."environment_id" = ?2)"#,
            )?;
            let rows = st
                .query_map([&ws, &env], |r| {
                    let mut m = rows::object(
                        r,
                        &[
                            ("id", 0, Col::Plain),
                            ("workspaceId", 1, Col::Plain),
                            ("environmentId", 2, Col::Plain),
                            ("domain", 3, Col::Plain),
                            ("name", 4, Col::Plain),
                            ("value", 5, Col::Plain),
                            ("path", 6, Col::Plain),
                            ("expires", 7, Col::Plain),
                            ("updatedAt", 8, Col::Plain),
                        ],
                    )?;
                    // 쿠키 값은 로그인 세션 그 자체다 — 환경 secret·인증 토큰과 같은 정책으로 값은 내려보내지 않는다.
                    // 어느 쿠키인지는 도메인·이름으로 알아보고, 지우는 데도 값이 필요 없다.
                    m.insert("value".into(), json!(""));
                    Ok(Value::Object(m))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await?;
    Ok(Js(Value::Array(out)))
}

/// 저장할 쿠키 하나.
struct Incoming {
    name: String,
    value: String,
    path: String,
    /// ms. better-sqlite3 는 JS 숫자를 REAL 로 묶는다 — integer 열이라 정수 값이면 INTEGER 로 바뀌어 들어간다.
    expires: Option<f64>,
}

/// 한 트랜잭션에서 (scope, domain, name) 마다 지우고-넣기. 중간에 끊기면 로그인 세션이 반쯤 지워진 채 남아
/// 인증이 조용히 깨진다.
fn save_cookies(c: &Connection, ws: &str, env: &str, domain: &str, list: &[Incoming]) -> anyhow::Result<()> {
    let keys = Keys::from_env();
    let tx = c.unchecked_transaction()?;
    for ck in list {
        tx.prepare_cached(
            r#"DELETE FROM "cookies" WHERE ("cookies"."workspace_id" = ?1 AND "cookies"."environment_id" = ?2 AND "cookies"."domain" = ?3 AND "cookies"."name" = ?4)"#,
        )?
        .execute(rusqlite::params![ws, env, domain, ck.name])?;
        tx.prepare_cached(
            r#"INSERT INTO "cookies" ("id", "workspace_id", "environment_id", "domain", "name", "value", "path", "expires", "updated_at") VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"#,
        )?
        .execute(rusqlite::params![
            uuid::Uuid::new_v4().to_string(),
            ws,
            env,
            domain,
            ck.name,
            secretbox::encrypt_with(&keys, &ck.value),
            ck.path,
            ck.expires,
            js::now_ms()
        ])?;
    }
    tx.commit()?;
    Ok(())
}

/// 쿠키 수동 추가/붙여넣기 — 브라우저에서 복사한 Cookie 문자열을 도메인에 저장.
/// 이미 로그인된 사이트의 세션을 postq 로 가져와 그대로 재사용하는 용도(Postman 쿠키 관리자 대응).
async fn paste(State(s): State<AppState>, body: Bytes) -> ApiResult<Response> {
    let Some(b) = read_json(&body).filter(|b| js::truthy(Some(b))) else {
        return Err(bad_request("본문이 올바른 JSON 이 아닙니다"));
    };
    // ?.trim() 은 문자열 검증이 아니다 — 숫자가 오면 'trim is not a function' 으로 500 이 났다
    let raw_domain = require_text(b.get("domain"), 253); // 253 = 호스트명 최대 길이
    let cookie_string = require_text(b.get("cookieString"), 8192);
    let (Some(raw_domain), Some(cookie_string)) = (raw_domain, cookie_string) else {
        return Err(bad_request("domain, cookieString 은 비어 있지 않은 문자열이어야 합니다"));
    };
    let domain = normalize_domain(&raw_domain);
    let ws = require_text(b.get("workspaceId"), 200).unwrap_or_else(|| "default".into());
    let env = require_text(b.get("environmentId"), 64).unwrap_or_default();
    let parsed = parse_cookie_string(&cookie_string);
    // 한 쌍도 못 읽었으면 그렇게 말한다. `{ok:true, added:0}` 으로 넘기면 붙여넣기가 왜 안 먹었는지 알 방법이 없다.
    if parsed.is_empty() {
        return Err(bad_request("쿠키를 하나도 읽지 못했습니다 — 'name=value; name2=value2' 모양인지 확인하세요"));
    }
    let added = parsed.len();
    let list: Vec<Incoming> = parsed.into_iter().map(|(name, value)| Incoming { name, value, path: "/".into(), expires: None }).collect();
    s.db.run(move |c| save_cookies(c, &ws, &env, &domain, &list)).await?;
    Ok((StatusCode::CREATED, Js(json!({ "ok": true, "added": added }))).into_response())
}

async fn remove(State(s): State<AppState>, RawQuery(q): RawQuery) -> ApiResult<Js> {
    let id = js::query_get(q.as_deref(), "id");
    let ws = js::query_get(q.as_deref(), "workspaceId").unwrap_or_else(|| "default".into());
    let env = js::query_get(q.as_deref(), "environmentId").unwrap_or_default();
    let deleted = s
        .db
        .run(move |c| {
            // id 로 지울 때도 스코프를 함께 본다. 예전엔 id 만 보고 지워서, 다른 프로젝트를 보고 있던
            // 낡은 화면이 이 프로젝트의 쿠키를 지울 수 있었다. 빈 id(?id=)는 JS 에서 거짓 — 스코프 전체.
            Ok(match id.filter(|i| !i.is_empty()) {
                Some(id) => c
                    .prepare_cached(r#"DELETE FROM "cookies" WHERE ("cookies"."id" = ?1 AND ("cookies"."workspace_id" = ?2 AND "cookies"."environment_id" = ?3))"#)?
                    .execute([&id, &ws, &env])?,
                None => c
                    .prepare_cached(r#"DELETE FROM "cookies" WHERE ("cookies"."workspace_id" = ?1 AND "cookies"."environment_id" = ?2)"#)?
                    .execute([&ws, &env])?,
            })
        })
        .await?;
    Ok(Js(json!({ "ok": true, "deleted": deleted })))
}

// ── 브라우저 확장 ─────────────────────────────────────────────────────────
// Postman Interceptor 와 같은 방식이다 — OS 키체인을 뚫는 게 아니라, 브라우저가 확장에게 정식으로 허용한
// chrome.cookies 권한으로 그 도메인 쿠키를 읽어 여기로 보낸다. 확장은 다른 origin(chrome-extension://…)
// 에서 부르므로 CORS 를 연다. 로컬 앱 전용 서버라 origin 을 * 로 둔다.

fn with_cors(mut res: Response) -> Response {
    let h = res.headers_mut();
    for (k, v) in [("access-control-allow-origin", "*"), ("access-control-allow-methods", "POST, OPTIONS"), ("access-control-allow-headers", "Content-Type")] {
        h.insert(HeaderName::from_static(k), HeaderValue::from_static(v));
    }
    res
}

/// 프리플라이트 — 확장이 POST 전에 OPTIONS 로 물어본다.
async fn preflight() -> Response {
    with_cors(StatusCode::NO_CONTENT.into_response())
}

/// 400 도 CORS 를 달아 보낸다 — 안 그러면 확장이 에러 본문을 못 읽어 '왜 안 되는지' 를 못 보여준다.
fn bad(reason: &str) -> Response {
    with_cors((StatusCode::BAD_REQUEST, Js(json!({ "error": reason }))).into_response())
}

/// `typeof c.expires === 'number' && c.expires > 0 ? Math.round(c.expires * 1000) : null` — 초 → ms.
/// Math.round 는 .5 를 +∞ 쪽으로 올린다(Rust 의 round 는 0 에서 멀어지는 쪽이라 음수에서 다르지만, 여기는 양수만 온다).
fn expires_ms(v: Option<&Value>) -> Option<f64> {
    let n = v?.as_f64()?;
    (n > 0.0).then(|| (n * 1000.0 + 0.5).floor())
}

async fn import(State(s): State<AppState>, body: Result<Bytes, BytesRejection>) -> ApiResult<Response> {
    // 본문 상한(64MB)을 넘으면 추출기가 핸들러 전에 413 을 낸다 — 그 응답에도 CORS 를 달아야 확장이 이유를 읽는다(codex 리뷰).
    let body = match body {
        Ok(b) => b,
        Err(rej) => return Ok(with_cors((rej.status(), Js(json!({ "error": rej.body_text() }))).into_response())),
    };
    let Some(b) = read_json(&body).filter(|b| js::truthy(Some(b))) else {
        return Ok(bad("본문이 올바른 JSON 이 아닙니다"));
    };
    let Some(raw_domain) = require_text(b.get("domain"), 253) else {
        return Ok(bad("domain 은 비어 있지 않은 문자열이어야 합니다"));
    };
    let domain = normalize_domain(&raw_domain);
    let Some(Value::Array(items)) = b.get("cookies") else {
        return Ok(bad("cookies 는 배열이어야 합니다"));
    };
    // 이름·값이 문자열인 것만 취한다. 하나라도 이상하면 통째로 버리지 않고 멀쩡한 것만 저장한다 —
    // 세션 쿠키 하나라도 살리는 게 낫다.
    let mut list = Vec::new();
    for c in items {
        // Node 는 null 원소에서 `c.name` 으로 TypeError(500)를 던졌다 — 같은 500 으로 둔다.
        if c.is_null() {
            return Ok((StatusCode::INTERNAL_SERVER_ERROR, Js(json!({ "error": "Cannot read properties of null (reading 'name')" }))).into_response());
        }
        let name = c.get("name").and_then(Value::as_str).unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        list.push(Incoming {
            name,
            value: c.get("value").and_then(Value::as_str).unwrap_or("").to_string(),
            path: c.get("path").and_then(Value::as_str).filter(|p| !p.is_empty()).unwrap_or("/").to_string(),
            // 세션 쿠키는 없음/음수 → null.
            expires: expires_ms(c.get("expires")),
        });
    }
    if list.is_empty() {
        return Ok(bad("저장할 쿠키가 없습니다 — 그 도메인에 로그인돼 있는지 확인하세요"));
    }
    let ws = require_text(b.get("workspaceId"), 200).unwrap_or_else(|| "default".into());
    let env = require_text(b.get("environmentId"), 64).unwrap_or_default();
    let added = list.len();
    let d = domain.clone();
    s.db.run(move |c| save_cookies(c, &ws, &env, &d, &list)).await?;
    Ok(with_cors((StatusCode::CREATED, Js(json!({ "ok": true, "added": added, "domain": domain }))).into_response()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::variables::tests::test_db;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    fn state() -> AppState {
        let config = crate::Config { host: "127.0.0.1".into(), port: 0, db_path: ":memory:".into(), migrations_dir: Default::default(), static_dir: None };
        AppState { db: test_db(), config }
    }

    async fn call(s: &AppState, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, axum::http::HeaderMap, Value) {
        let req = Request::builder().method(method).uri(uri).body(body.map_or(Body::empty(), |b| Body::from(b.to_string()))).unwrap();
        let res = router().with_state(s.clone()).oneshot(req).await.unwrap();
        let (status, headers) = (res.status(), res.headers().clone());
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
        (status, headers, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    #[test]
    fn 도메인_정규화는_js_정규식과_같다() {
        assert_eq!(normalize_domain("http://127.0.0.1:3000/path"), "127.0.0.1:3000");
        assert_eq!(normalize_domain("https://.Example.COM/a/b"), "example.com");
        assert_eq!(normalize_domain("HTTPS://x.com"), "https:");
        assert_eq!(normalize_domain(".a.com"), "a.com");
        // 줄바꿈이 낀 꼬리는 `.*$` 에 안 맞는다 — 그 '/' 는 남는다
        assert_eq!(normalize_domain("a/b\nc"), "a/b\nc");
        assert_eq!(normalize_domain("a/b\nc/d"), "a/b\nc");
    }

    #[test]
    fn expires_는_초를_ms_로_반올림() {
        assert_eq!(expires_ms(Some(&json!(1.0005))), Some(1001.0));
        assert_eq!(expires_ms(Some(&json!(-1))), None);
        assert_eq!(expires_ms(Some(&json!("5"))), None);
        assert_eq!(expires_ms(None), None);
    }

    // cookieJar.test.ts 의 붙여넣기·삭제 부분.
    #[tokio::test]
    async fn 붙여넣기_목록_마스킹_삭제() {
        let s = state();
        let (st, _, b) = call(&s, "POST", "/api/cookies", Some(json!({ "domain": "http://Host:1/path", "cookieString": "PASTED=xyz; extra=1" }))).await;
        assert_eq!((st, b.clone()), (StatusCode::CREATED, json!({ "ok": true, "added": 2 })));
        let (_, _, jar) = call(&s, "GET", "/api/cookies?workspaceId=default", None).await;
        let jar = jar.as_array().unwrap();
        assert_eq!(jar.len(), 2);
        assert_eq!(jar[0].as_object().unwrap().keys().cloned().collect::<Vec<_>>(), ["id", "workspaceId", "environmentId", "domain", "name", "value", "path", "expires", "updatedAt"]);
        assert_eq!((jar[0]["domain"].as_str().unwrap(), jar[0]["value"].as_str().unwrap(), &jar[0]["expires"]), ("host:1", "", &Value::Null));
        // 다른 스코프의 id 로는 못 지운다
        let id = jar[0]["id"].as_str().unwrap();
        let (_, _, d) = call(&s, "DELETE", &format!("/api/cookies?id={id}&workspaceId=other"), None).await;
        assert_eq!(d["deleted"], 0);
        let (_, _, d) = call(&s, "DELETE", &format!("/api/cookies?id={id}"), None).await;
        assert_eq!(d["deleted"], 1);
        let (_, _, d) = call(&s, "DELETE", "/api/cookies?workspaceId=default", None).await;
        assert_eq!(d, json!({ "ok": true, "deleted": 1 }));
        let (st, _, b) = call(&s, "POST", "/api/cookies", Some(json!({ "domain": "x.com", "cookieString": "novalue" }))).await;
        assert_eq!((st, b["error"].as_str().unwrap()), (StatusCode::BAD_REQUEST, "쿠키를 하나도 읽지 못했습니다 — 'name=value; name2=value2' 모양인지 확인하세요"));
        let (st, _, _) = call(&s, "POST", "/api/cookies", Some(json!({ "domain": 5, "cookieString": "a=1" }))).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn 확장_가져오기는_cors_를_단다() {
        let s = state();
        let (st, h, _) = call(&s, "OPTIONS", "/api/cookies/import", None).await;
        assert_eq!(st, StatusCode::NO_CONTENT);
        assert_eq!(h["access-control-allow-origin"], "*");
        let (st, h, b) = call(&s, "POST", "/api/cookies/import", Some(json!({ "domain": "x.com", "cookies": [] }))).await;
        assert_eq!((st, b["error"].as_str().unwrap()), (StatusCode::BAD_REQUEST, "저장할 쿠키가 없습니다 — 그 도메인에 로그인돼 있는지 확인하세요"));
        assert_eq!(h["access-control-allow-methods"], "POST, OPTIONS");
        let (st, h, b) = call(
            &s,
            "POST",
            "/api/cookies/import",
            Some(json!({ "domain": ".X.com", "environmentId": "e1", "cookies": [{ "name": "sid", "value": "v", "expires": 2.5 }, { "name": 3 }, { "value": "x" }, { "name": "p", "path": "/a" }] })),
        )
        .await;
        assert_eq!((st, b), (StatusCode::CREATED, json!({ "ok": true, "added": 2, "domain": "x.com" })));
        assert_eq!(h["access-control-allow-headers"], "Content-Type");
        let (_, _, jar) = call(&s, "GET", "/api/cookies?environmentId=e1", None).await;
        assert_eq!(jar[0]["expires"], 2500);
        assert_eq!(jar[1]["path"], "/a");
    }
}
