//! `/api/mock/[[...path]]` — 목 서버. ★핀 예시응답을 method+경로 매칭으로 되돌려준다(백엔드 없이 프론트 병렬 개발).
//!
//! 알려진 한계: 프로젝트 구분이 없다. 서로 다른 프로젝트에 같은 경로를 핀해 두면 먼저 찾힌 쪽이 나간다.

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::on;
use axum::routing::MethodFilter;
use axum::Router;
use rusqlite::OptionalExtension;
use serde_json::{json, Value};

use crate::error::ApiResult;
use crate::jsval::reply;
use crate::{js, AppState};

pub fn router() -> Router<AppState> {
    let methods = MethodFilter::GET.or(MethodFilter::POST).or(MethodFilter::PUT).or(MethodFilter::PATCH).or(MethodFilter::DELETE);
    Router::new().route("/api/mock", on(methods, root)).route("/api/mock/{*path}", on(methods, nested))
}

async fn root(State(s): State<AppState>, method: Method) -> ApiResult<Response> {
    serve(s, method, "/".into()).await
}

async fn nested(State(s): State<AppState>, method: Method, Path(path): Path<String>) -> ApiResult<Response> {
    serve(s, method, format!("/{path}")).await
}

/// OpenAPI 스타일 경로 템플릿 매칭 — /orders/{id} 는 /orders/123 에 맞는다.
fn match_path(template: &str, actual: &str) -> bool {
    if template == actual {
        return true;
    }
    let (t, a): (Vec<&str>, Vec<&str>) = (template.split('/').collect(), actual.split('/').collect());
    t.len() == a.len() && t.iter().zip(&a).all(|(seg, x)| (seg.starts_with('{') && seg.ends_with('}')) || seg == x)
}

/// 핀 실행의 resolved(JSON) → (method, 경로). 손상된 값은 None(그 핀만 건너뛴다).
fn pinned_target(resolved: &str) -> Option<(String, String)> {
    let r = js::parse_json(resolved).filter(|v| v.is_object() || v.is_array())?;
    let rurl = r.get("url").and_then(Value::as_str).unwrap_or("").to_string();
    let rmethod = r.get("method").and_then(Value::as_str).unwrap_or("GET").to_string();
    // {{var}} 가 안 풀린 주소면 URL 이 아니다 — 그때는 글자 그대로 비교한다.
    let p = url::Url::parse(&rurl).ok().and_then(|u| js::decode_uri_component(u.path()).ok()).unwrap_or(rurl);
    Some((rmethod.to_uppercase(), p))
}

struct Hit {
    body: Option<String>,
    headers: Option<String>,
    status: Option<f64>,
}

async fn serve(s: AppState, method: Method, req_path: String) -> ApiResult<Response> {
    let method = method.as_str().to_uppercase();
    let (m2, p2) = (method.clone(), req_path.clone());
    let hit = s
        .db
        .run(move |c| {
            // 매칭에 필요한 두 열만 먼저 읽는다 — responseBody(행당 최대 1MB)를 핀마다 끌어오지 않게.
            let pinned: Vec<(String, String)> = c
                .prepare_cached(r#"select "id", "resolved" from "executions" where "executions"."pinned" = 1"#)?
                .query_map([], |r| Ok((crate::rows::text(r, 0)?, crate::rows::text(r, 1)?)))?
                .collect::<Result<_, _>>()?;
            for (id, resolved) in pinned {
                let Some((rm, p)) = pinned_target(&resolved) else { continue };
                if rm == m2 && match_path(&p, &p2) {
                    let hit = c
                        .prepare_cached(r#"select "response_body", "response_headers", "response_status" from "executions" where "executions"."id" = ?"#)?
                        .query_row([&id], |r| {
                            Ok(Hit {
                                body: r.get::<_, Option<String>>(0)?,
                                headers: r.get::<_, Option<String>>(1)?,
                                status: r.get::<_, Option<f64>>(2)?,
                            })
                        })
                        .optional()?;
                    // 매칭 직후 지워진 경우 — 다음 핀을 계속 본다.
                    if let Some(h) = hit {
                        return Ok(Some(h));
                    }
                }
            }
            Ok(None)
        })
        .await?;
    let Some(hit) = hit else {
        return Ok(reply(
            StatusCode::NOT_FOUND,
            &json!({ "error": "no pinned example matches", "method": method, "path": req_path, "hint": "해당 method·경로의 실행을 이력에서 ★예시로 고정하세요" }),
        ));
    };
    // 손상 헤더여도 목 서빙이 500 나지 않게 — 빈 헤더로.
    let headers = hit.headers.filter(|h| !h.is_empty()).and_then(|h| js::parse_json(&h)).filter(Value::is_object);
    let ct = headers
        .as_ref()
        .and_then(|h| h.as_object()?.iter().find(|(k, _)| k.to_lowercase() == "content-type").map(|(_, v)| v.clone()))
        .filter(|v| !v.is_null())
        .map_or_else(|| "application/json".to_string(), |v| js::to_string(&v));
    let status = hit.status.unwrap_or(200.0);
    let body = hit.body.unwrap_or_default();
    // new Response 가 던지던 경우(범위 밖 상태, 본문을 못 싣는 상태에 본문) — Next 는 500 을 냈다.
    let code = (status.fract() == 0.0 && (200.0..=599.0).contains(&status)).then(|| StatusCode::from_u16(status as u16).ok()).flatten();
    let Some(code) = code.filter(|c| body.is_empty() || !matches!(c.as_u16(), 204 | 205 | 304)) else {
        return Ok((StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response());
    };
    let Ok(ct) = HeaderValue::from_str(&ct) else { return Ok((StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response()) };
    Ok((code, [(header::CONTENT_TYPE, ct), (header::HeaderName::from_static("x-postq-mock"), HeaderValue::from_static("pinned-example"))], Body::from(body)).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::variables::tests::test_db;
    use axum::http::Request;
    use tower::ServiceExt;

    #[test]
    fn 경로_템플릿() {
        assert!(match_path("/orders/{id}", "/orders/123"));
        assert!(!match_path("/orders/{id}", "/orders/123/x"));
        assert!(match_path("/a", "/a"));
        assert_eq!(pinned_target(r#"{"method":"post","url":"https://x.test/c%20d/{id}"}"#), Some(("POST".into(), "/c d/{id}".into())));
        assert_eq!(pinned_target("null"), None);
        assert_eq!(pinned_target(r#"{"url":"{{base}}/x"}"#), Some(("GET".into(), "{{base}}/x".into())));
    }

    #[tokio::test]
    async fn 핀된_예시를_돌려준다() {
        let db = test_db();
        db.with(|c| {
            c.execute_batch(
                r#"INSERT INTO folders (id, workspace_id, name) VALUES ('f', 'default', 'F');
                   INSERT INTO requests (id, folder_id, name, method, url, updated_at) VALUES ('r', 'f', 'R', 'GET', 'x', 0);
                   INSERT INTO executions (id, request_id, executed_by, executed_at, resolved, response_status, response_headers, response_body, missing_variables, pinned)
                   VALUES ('e', 'r', 'u', 1, '{"method":"GET","url":"https://api.test/orders/{id}"}', 201, '{"Content-Type":"text/plain"}', 'hello', '[]', 1);"#,
            )?;
            Ok(())
        })
        .unwrap();
        let config = crate::Config { host: "127.0.0.1".into(), port: 0, db_path: ":memory:".into(), migrations_dir: Default::default(), static_dir: None };
        let st = AppState { db, config };
        let res = router().with_state(st.clone()).oneshot(Request::get("/api/mock/orders/9").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), StatusCode::CREATED);
        assert_eq!(res.headers()["content-type"], "text/plain");
        assert_eq!(res.headers()["x-postq-mock"], "pinned-example");
        let res = router().with_state(st).oneshot(Request::post("/api/mock/orders/9").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }
}
