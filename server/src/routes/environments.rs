//! `/api/environments`, `/api/environments/{id}`.

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use axum::Router;
use rusqlite::types::Value as Sql;
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Map, Value};

use crate::jsval::Js;
use crate::error::{ApiError, ApiResult};
use crate::routes::input::{bad_request, read_json, require_text};
use crate::rows::{self, Col};
use crate::secretbox::{self, Keys};
use crate::variables::load_var_map_with;
use crate::{js, AppState};

pub fn router() -> Router<AppState> {
    Router::new().route("/api/environments", get(list).post(create)).route("/api/environments/{id}", put(update).delete(remove))
}

/// 환경의 실행 정책 값(open·confirm-writes·read-only).
fn is_execution_policy(v: &Value) -> bool {
    matches!(v.as_str(), Some("open" | "confirm-writes" | "read-only"))
}

/// 한 환경의 변수 — secret 값은 절대 내려보내지 않는다. 대신 '지금 이 값을 쓸 수 있나'(keyState)만 알려준다.
/// 값이 안 보이는 화면에서는 살아 있는 secret 과 못 푸는 secret 이 똑같이 빈칸이라, 상해 있어도 아무도 모른다.
fn masked_variables(c: &Connection, environment_id: &str, keys: &Keys) -> rusqlite::Result<Vec<Value>> {
    let mut st = c.prepare_cached(
        r#"SELECT "id", "environment_id", "key", "value", "secret" FROM "variables" WHERE "variables"."environment_id" = ?1"#,
    )?;
    let mut rs = st.query([environment_id])?;
    let mut out = Vec::new();
    while let Some(r) = rs.next()? {
        let mut m = rows::object(r, &[("id", 0, Col::Plain), ("environmentId", 1, Col::Plain), ("key", 2, Col::Plain), ("value", 3, Col::Plain), ("secret", 4, Col::Bool)])?;
        if rows::boolean(r, 4)? == Some(true) {
            let raw = rows::text(r, 3)?;
            m.insert("value".into(), json!(""));
            m.insert("keyState".into(), json!(secretbox::key_state_with(keys, &raw).as_str()));
            m.insert("hasValue".into(), json!(!raw.is_empty()));
        }
        out.push(Value::Object(m));
    }
    Ok(out)
}

async fn list(State(s): State<AppState>, RawQuery(q): RawQuery) -> ApiResult<Js> {
    let ws = js::query_get(q.as_deref(), "workspaceId").unwrap_or_else(|| "default".into());
    let out = s
        .db
        .run(move |c| {
            let keys = Keys::from_env();
            let mut st = c.prepare_cached(
                r#"SELECT "execution_policy", "id", "workspace_id", "name", "updated_at" FROM "environments" WHERE "environments"."workspace_id" = ?1"#,
            )?;
            let envs = st
                .query_map([&ws], |r| {
                    rows::object(r, &[("executionPolicy", 0, Col::Plain), ("id", 1, Col::Plain), ("workspaceId", 2, Col::Plain), ("name", 3, Col::Plain), ("updatedAt", 4, Col::Plain)])
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let mut out = Vec::with_capacity(envs.len());
            for mut e in envs {
                let id = e.get("id").map(js::to_string).unwrap_or_default();
                e.insert("variables".into(), Value::Array(masked_variables(c, &id, &keys)?));
                out.push(Value::Object(e));
            }
            Ok(out)
        })
        .await?;
    Ok(Js(Value::Array(out)))
}

/// 문자열이 아닌 workspaceId — Node 는 drizzle 에 그대로 넘겼다(숫자는 REAL 로 들어가 '5.0' 이 된다,
/// true/false·객체는 바인딩 오류로 500). 같은 값이 저장되도록 그대로 따른다.
/// 바인딩 규칙은 [`crate::jsval::bind`] 하나 — 여기 오는 값은 이미 nullish 가 'default' 로 바뀐 뒤다.
fn bind_loose(v: &Value) -> Result<Sql, String> {
    crate::jsval::bind(Some(v))
}

async fn create(State(s): State<AppState>, body: Bytes) -> ApiResult<(StatusCode, Js)> {
    // `if (!b)` — 깨진 JSON 뿐 아니라 null·false·0·"" 도 같은 400 이다.
    let Some(b) = read_json(&body).filter(|b| js::truthy(Some(b))) else {
        return Err(bad_request("본문이 올바른 JSON 이 아닙니다"));
    };
    // truthy 검사만 하면 숫자·객체가 이름으로 들어간다(flows 에서 '123.0' 이 실제로 생겼다).
    let Some(name) = require_text(b.get("name"), 200) else {
        return Err(bad_request("name 은 비어 있지 않은 문자열이어야 합니다"));
    };
    let policy = b.get("executionPolicy");
    if policy.map_or(false, |p| !is_execution_policy(p)) {
        return Err(bad_request("실행 정책이 올바르지 않아 저장되지 않았습니다"));
    }
    let policy = policy.cloned().unwrap_or_else(|| json!("open"));
    let ws = match b.get("workspaceId") {
        None | Some(Value::Null) => json!("default"),
        Some(v) => v.clone(),
    };
    let id = uuid::Uuid::new_v4().to_string();
    let ws_bind = bind_loose(&ws).map_err(|e| ApiError::from(anyhow::anyhow!(e)))?;
    let (id2, name2, policy2) = (id.clone(), name.clone(), policy.as_str().unwrap_or("open").to_string());
    s.db
        .run(move |c| {
            // drizzle 은 빠진 열을 기본값으로 채워 넣는다(updated_at=0).
            c.prepare_cached(
                r#"INSERT INTO "environments" ("execution_policy", "id", "workspace_id", "name", "updated_at") VALUES (?1, ?2, ?3, ?4, 0)"#,
            )?
            .execute(rusqlite::params![policy2, id2, ws_bind, name2])?;
            Ok(())
        })
        .await?;
    let mut row = Map::new();
    row.insert("executionPolicy".into(), policy);
    row.insert("id".into(), json!(id));
    row.insert("workspaceId".into(), ws);
    row.insert("name".into(), json!(name));
    Ok((StatusCode::CREATED, Js(Value::Object(row))))
}

enum PutOutcome {
    Ok(Value),
    Status(StatusCode, Value),
}

fn err_body(status: StatusCode, msg: impl Into<String>) -> PutOutcome {
    PutOutcome::Status(status, json!({ "error": msg.into() }))
}

/// 낙관적 잠금 비교 — `cur.updatedAt !== body.ifUpdatedAt`. 숫자끼리만 같을 수 있다(문자열 "1" 은 다르다).
fn same_updated_at(cur: &Value, given: &Value) -> bool {
    match (cur, given) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::String(a), Value::String(b)) => a == b,
        _ => false,
    }
}

async fn update(State(s): State<AppState>, Path(id): Path<String>, body: Bytes) -> ApiResult<Response> {
    // `req.json().catch(() => null)` 뒤 `if (!body)` — 거짓 값 전부 400.
    let Some(body) = js::parse_body(&body).filter(|b| js::truthy(Some(b))) else {
        return Ok((StatusCode::BAD_REQUEST, Js(json!({ "error": "invalid json" }))).into_response());
    };
    let outcome = s
        .db
        .run(move |c| {
            // 없는 환경에도 200 을 돌려주고 있었다 — 다른 사람이 지운 환경에 변수를 저장하고 '저장됨' 을 본다.
            let cur: Option<Value> = c
                .prepare_cached(r#"SELECT "updated_at" FROM "environments" WHERE "environments"."id" = ?1"#)?
                .query_row([&id], |r| Ok(rows::raw(r.get_ref(0)?)))
                .optional()?;
            let Some(cur) = cur else {
                return Ok(err_body(StatusCode::NOT_FOUND, "환경이 없습니다 — 다른 사람이 지웠을 수 있습니다"));
            };
            // 낙관적 잠금 — 환경 저장은 변수 표 전체를 지우고 다시 넣는다. 둘이 같은 환경을 열어 두면
            // 나중에 저장한 쪽이 앞사람이 넣은 변수(토큰)를 지운다. ifUpdatedAt 미제공은 기존대로 저장한다.
            if let Some(given) = body.get("ifUpdatedAt") {
                if !same_updated_at(&cur, given) {
                    return Ok(PutOutcome::Status(
                        StatusCode::CONFLICT,
                        json!({ "error": "다른 사람이 이 환경을 먼저 저장했습니다 — 덮어쓰지 않았습니다", "updatedAt": cur }),
                    ));
                }
            }
            let policy = body.get("executionPolicy");
            if policy.map_or(false, |p| !is_execution_policy(p)) {
                return Ok(err_body(StatusCode::BAD_REQUEST, "실행 정책이 올바르지 않아 저장되지 않았습니다"));
            }
            let now = js::now_ms();

            // 문자열이 아니면 조용히 무시하고 200 을 주고 있었다 — 조용한 실패라 거절한다.
            // 이름은 여기서 바로 저장한다 — 아래 variables 검증이 400 이어도 이름은 바뀐 채 남는다.
            if let Some(n) = body.get("name") {
                let Some(name) = require_text(Some(n), 200) else {
                    return Ok(err_body(StatusCode::BAD_REQUEST, "name 은 비어 있지 않은 문자열이어야 합니다"));
                };
                c.prepare_cached(r#"UPDATE "environments" SET "name" = ?1, "updated_at" = ?2 WHERE "environments"."id" = ?3"#)?
                    .execute(rusqlite::params![name, now, id])?;
            }

            // variables 는 '배열로 제공될 때만' 전체 교체한다 — 이름만 바꾸는 부분 PUT 에서 모든 변수가 지워지던 일을 막는다.
            if let Some(Value::Array(vars)) = body.get("variables") {
                // 저장 전에 전부 검증한다 — 아래는 delete-후-insert 라, 도중에 하나가 터지면 나머지가 통째로 사라진다.
                for v in vars {
                    let Some(key) = v.get("key").and_then(Value::as_str) else {
                        return Ok(err_body(StatusCode::BAD_REQUEST, "variables[].key 는 문자열이어야 합니다"));
                    };
                    if v.get("value").map_or(false, |x| !x.is_string()) {
                        return Ok(err_body(StatusCode::BAD_REQUEST, format!("'{key}' 의 value 가 문자열이 아닙니다 — 저장을 중단했습니다(기존 값 유지)")));
                    }
                }
                let keys = Keys::from_env();
                let prev = load_var_map_with(c, &id, &keys)?;
                // 이전 값을 '행 id' 로도 찾는다 — 이름으로만 찾으면 secret 변수의 이름 변경이 값을 조용히 지운다.
                // 복호화해 담는다 — 암호문을 그대로 넣으면 재저장 시 이중 암호화된다.
                let mut prev_by_id: HashMap<String, (String, bool)> = HashMap::new();
                {
                    let mut st = c.prepare_cached(r#"SELECT "id", "value", "secret" FROM "variables" WHERE "variables"."environment_id" = ?1"#)?;
                    let mut rs = st.query([&id])?;
                    while let Some(r) = rs.next()? {
                        let secret = rows::boolean(r, 2)?.unwrap_or(false);
                        let value = rows::text(r, 1)?;
                        let value = if secret { secretbox::decrypt_with(&keys, &value) } else { value };
                        prev_by_id.insert(rows::text(r, 0)?, (value, secret));
                    }
                }
                // 트랜잭션 — 중간 실패 시 삭제까지 롤백되어 '일부만 남는' 상태가 생기지 않는다.
                let tx = c.unchecked_transaction()?;
                tx.prepare_cached(r#"DELETE FROM "variables" WHERE "variables"."environment_id" = ?1"#)?.execute([&id])?;
                for v in vars {
                    let key = v.get("key").and_then(Value::as_str).unwrap_or("");
                    if key.is_empty() {
                        continue;
                    }
                    let value = v.get("value").and_then(Value::as_str).unwrap_or("");
                    let secret = js::truthy(v.get("secret"));
                    // "빈 값 = 기존 값 유지"는 secret 에만 적용한다 — 비-secret 빈 값은 사용자가 지운 것이다.
                    // 같은 행(id)이 있으면 이름이 바뀌었어도 그 행의 값을 잇는다. id 는 문자열일 때만 맞는다(Map.get).
                    let by_id = v.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()).and_then(|i| prev_by_id.get(i)).map(|(v, s)| (v.as_str(), *s));
                    let source = by_id.or_else(|| prev.get(key).map(|p| (p.value.as_str(), p.secret)));
                    let keep_previous = value.is_empty() && (secret || source.map_or(false, |s| s.1)) && source.map_or(false, |s| !s.0.is_empty());
                    let raw_value = if keep_previous { source.unwrap().0 } else { value };
                    tx.prepare_cached(r#"INSERT INTO "variables" ("id", "environment_id", "key", "value", "secret") VALUES (?1, ?2, ?3, ?4, ?5)"#)?.execute(
                        rusqlite::params![uuid::Uuid::new_v4().to_string(), id, key, secretbox::store_secret_with(&keys, raw_value, secret), secret as i64],
                    )?;
                }
                tx.commit()?;
            }
            match policy {
                Some(p) => c
                    .prepare_cached(r#"UPDATE "environments" SET "updated_at" = ?1, "execution_policy" = ?2 WHERE "environments"."id" = ?3"#)?
                    .execute(rusqlite::params![now, p.as_str().unwrap_or("open"), id])?,
                None => c.prepare_cached(r#"UPDATE "environments" SET "updated_at" = ?1 WHERE "environments"."id" = ?2"#)?.execute(rusqlite::params![now, id])?,
            };
            // 새 시각을 돌려준다 — 클라이언트가 다음 저장의 ifUpdatedAt 으로 쓴다.
            let vars = masked_variables(c, &id, &Keys::from_env())?;
            Ok(PutOutcome::Ok(json!({ "ok": true, "updatedAt": now, "variables": vars })))
        })
        .await?;
    Ok(match outcome {
        PutOutcome::Ok(v) => Js(v).into_response(),
        PutOutcome::Status(st, v) => (st, Js(v)).into_response(),
    })
}

async fn remove(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<Js> {
    s.db
        .run(move |c| {
            c.prepare_cached(r#"DELETE FROM "variables" WHERE "variables"."environment_id" = ?1"#)?.execute([&id])?;
            c.prepare_cached(r#"DELETE FROM "environments" WHERE "environments"."id" = ?1"#)?.execute([&id])?;
            Ok(())
        })
        .await?;
    Ok(Js(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::variables::tests::test_db;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    fn state() -> AppState {
        let db = test_db();
        let config = crate::Config {
            host: "127.0.0.1".into(),
            port: 0,
            db_path: ":memory:".into(),
            migrations_dir: std::path::PathBuf::new(),
            static_dir: None,
        };
        AppState { db, config }
    }

    async fn call(s: &AppState, method: &str, uri: &str, body: Value) -> (StatusCode, Value) {
        let req = Request::builder().method(method).uri(uri).body(Body::from(body.to_string())).unwrap();
        let res = router().with_state(s.clone()).oneshot(req).await.unwrap();
        let status = res.status();
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    fn var_map(s: &AppState, id: &str) -> crate::variables::VarMap {
        let id = id.to_string();
        s.db.with(move |c| load_var_map_with(c, &id, &Keys::from_env())).unwrap()
    }

    async fn new_env(s: &AppState, name: &str) -> String {
        let (st, env) = call(s, "POST", "/api/environments", json!({ "name": name })).await;
        assert_eq!(st, StatusCode::CREATED);
        assert_eq!(env.as_object().unwrap().keys().cloned().collect::<Vec<_>>(), ["executionPolicy", "id", "workspaceId", "name"]);
        env["id"].as_str().unwrap().to_string()
    }

    // (SECRET_ENCRYPTION_KEY 를 건드리는 at-rest 시험은 secretbox 쪽 테스트가 맡는다 —
    // 환경 변수는 프로세스 전역이라 병렬 테스트끼리 서로 덮는다).
    #[tokio::test]
    async fn 환경_생성_변수_저장_목록_마스킹() {
        let s = state();
        let id = new_env(&s, "스테이지").await;
        let (st, _) = call(&s, "PUT", &format!("/api/environments/{id}"), json!({ "name": "스테이지", "variables": [
            { "key": "baseUrl", "value": "https://stage", "secret": false },
            { "key": "token", "value": "REAL", "secret": true },
        ] }))
        .await;
        assert_eq!(st, StatusCode::OK);
        let (_, list) = call(&s, "GET", "/api/environments", Value::Null).await;
        let vars = list[0]["variables"].as_array().unwrap();
        let token = vars.iter().find(|v| v["key"] == "token").unwrap();
        assert_eq!(token["value"], "");
        assert_eq!(token.as_object().unwrap().keys().cloned().collect::<Vec<_>>(), ["id", "environmentId", "key", "value", "secret", "keyState", "hasValue"]);
        assert_eq!(token["hasValue"], true);
        assert_eq!(vars.iter().find(|v| v["key"] == "baseUrl").unwrap()["value"], "https://stage");
        assert_eq!(var_map(&s, &id).get("token").unwrap().value, "REAL");
    }

    #[tokio::test]
    async fn secret_빈값_재저장과_secret_해제_시_기존_값_유지() {
        let s = state();
        let id = new_env(&s, "e2").await;
        let uri = format!("/api/environments/{id}");
        call(&s, "PUT", &uri, json!({ "variables": [{ "key": "token", "value": "REAL", "secret": true }] })).await;
        call(&s, "PUT", &uri, json!({ "variables": [{ "key": "token", "value": "", "secret": true }] })).await;
        assert_eq!(var_map(&s, &id).get("token").unwrap().value, "REAL");
        call(&s, "PUT", &uri, json!({ "variables": [{ "key": "token", "value": "", "secret": false }] })).await;
        assert_eq!(var_map(&s, &id).get("token").unwrap().value, "REAL");
    }

    #[tokio::test]
    async fn secret_이름을_바꿔도_id_로_값을_잇는다() {
        let s = state();
        let id = new_env(&s, "rename-env").await;
        let uri = format!("/api/environments/{id}");
        let (_, first) = call(&s, "PUT", &uri, json!({ "variables": [{ "key": "token", "value": "PRIVATE", "secret": true }] })).await;
        assert!(!first.to_string().contains("PRIVATE"));
        assert_eq!(first["variables"][0]["value"], "");
        let mut renamed = first["variables"][0].clone();
        renamed["key"] = json!("renamed");
        let (st, saved) = call(&s, "PUT", &uri, json!({ "ifUpdatedAt": first["updatedAt"], "variables": [renamed] })).await;
        assert_eq!(st, StatusCode::OK);
        assert_ne!(saved["variables"][0]["id"], first["variables"][0]["id"]);
        let m = var_map(&s, &id);
        assert!(m.get("token").is_none());
        assert_eq!(m.get("renamed").unwrap().value, "PRIVATE");
        assert!(!saved.to_string().contains("PRIVATE"));
    }

    #[tokio::test]
    async fn 잘못된_value_는_400_이고_기존_변수를_지우지_않는다() {
        let s = state();
        let id = new_env(&s, "guard-env").await;
        let uri = format!("/api/environments/{id}");
        call(&s, "PUT", &uri, json!({ "variables": [
            { "key": "baseUrl", "value": "https://stage" }, { "key": "api-key", "value": "REAL", "secret": true }, { "key": "siteId", "value": "1" },
        ] }))
        .await;
        let (st, body) = call(&s, "PUT", &uri, json!({ "variables": [{ "key": "baseUrl", "value": "x" }, { "key": "api-key", "value": null, "secret": true }] })).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "'api-key' 의 value 가 문자열이 아닙니다 — 저장을 중단했습니다(기존 값 유지)");
        let m = var_map(&s, &id);
        assert_eq!(m.len(), 3);
        assert_eq!(m.get("api-key").unwrap().value, "REAL");
        let (st, body) = call(&s, "PUT", &uri, json!({ "variables": [{ "value": "x" }] })).await;
        assert_eq!((st, body["error"].as_str().unwrap()), (StatusCode::BAD_REQUEST, "variables[].key 는 문자열이어야 합니다"));
    }

    // optimisticLock.test.ts 의 환경 부분.
    #[tokio::test]
    async fn 낡은_if_updated_at_은_409_없는_환경은_404() {
        let s = state();
        let id = new_env(&s, "lock").await;
        let uri = format!("/api/environments/{id}");
        let (_, a) = call(&s, "PUT", &uri, json!({ "ifUpdatedAt": 0, "name": "A" })).await;
        let (st, b) = call(&s, "PUT", &uri, json!({ "ifUpdatedAt": 0, "name": "B" })).await;
        assert_eq!(st, StatusCode::CONFLICT);
        assert_eq!(b["updatedAt"], a["updatedAt"]);
        let (st, _) = call(&s, "PUT", &uri, json!({ "ifUpdatedAt": a["updatedAt"], "name": "B" })).await;
        assert_eq!(st, StatusCode::OK);
        let (st, b) = call(&s, "PUT", "/api/environments/nope", json!({ "name": "x" })).await;
        assert_eq!((st, b["error"].as_str().unwrap()), (StatusCode::NOT_FOUND, "환경이 없습니다 — 다른 사람이 지웠을 수 있습니다"));
        let (st, b) = call(&s, "PUT", &uri, Value::Null).await;
        assert_eq!((st, b["error"].as_str().unwrap()), (StatusCode::BAD_REQUEST, "invalid json"));
    }

    #[tokio::test]
    async fn 생성_입력_검증과_실행_정책() {
        let s = state();
        let (st, b) = call(&s, "POST", "/api/environments", json!({ "name": 123 })).await;
        assert_eq!((st, b["error"].as_str().unwrap()), (StatusCode::BAD_REQUEST, "name 은 비어 있지 않은 문자열이어야 합니다"));
        let (st, _) = call(&s, "POST", "/api/environments", json!({ "name": "x", "executionPolicy": "nope" })).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        let (st, b) = call(&s, "POST", "/api/environments", json!({ "name": " ro ", "executionPolicy": "read-only", "workspaceId": "w1" })).await;
        assert_eq!(st, StatusCode::CREATED);
        assert_eq!((b["name"].as_str().unwrap(), b["executionPolicy"].as_str().unwrap()), ("ro", "read-only"));
        let (_, list) = call(&s, "GET", "/api/environments?workspaceId=w1", Value::Null).await;
        assert_eq!(list[0]["updatedAt"], 0);
        assert_eq!(list[0]["variables"], json!([]));
        let (st, _) = call(&s, "DELETE", &format!("/api/environments/{}", b["id"].as_str().unwrap()), Value::Null).await;
        assert_eq!(st, StatusCode::OK);
        let (_, list) = call(&s, "GET", "/api/environments?workspaceId=w1", Value::Null).await;
        assert_eq!(list, json!([]));
    }
}
