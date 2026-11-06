//! `/api/global-vars`.
//!
//! 환경에 속하지 않는 변수 — 모든 환경이 상속한다(충돌 시 환경 값이 우선). 저장은 variables 테이블에
//! environment_id='global:<ws>' 로(실제 environment 아님).
//!   workspaceId=<프로젝트>  → 그 프로젝트 공통 변수
//!   workspaceId=*           → 모든 프로젝트가 함께 쓰는 전역 변수 (ALL_PROJECTS)

use axum::body::Bytes;
use axum::extract::{RawQuery, State};
use axum::routing::get;
use axum::{Json, Router};
use rusqlite::types::Value as Sql;
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::routes::input::read_json;
use crate::secretbox::{self, Keys};
use crate::variables::{global_scope_id, load_var_map_with};
use crate::{js, AppState};

pub fn router() -> Router<AppState> {
    Router::new().route("/api/global-vars", get(list).put(replace))
}

async fn list(State(s): State<AppState>, RawQuery(q): RawQuery) -> ApiResult<Json<Value>> {
    // searchParams.get(..) ?? 'default' — 빈 값(?workspaceId=)은 빈 문자열 그대로다.
    let ws = js::query_get(q.as_deref(), "workspaceId").unwrap_or_else(|| "default".into());
    let list = s
        .db
        .run(move |c| {
            let map = load_var_map_with(c, &global_scope_id(&ws), &Keys::from_env())?;
            // secret 은 값 숨김('')으로 내려보낸다(환경 변수 GET 과 같은 정책). hasValue 는 실제 값 기준.
            Ok(map
                .iter()
                .map(|(key, v)| {
                    json!({ "key": key, "value": if v.secret { "" } else { v.value.as_str() }, "secret": v.secret, "hasValue": !v.value.is_empty() })
                })
                .collect::<Vec<_>>())
        })
        .await?;
    Ok(Json(Value::Array(list)))
}

/// 저장할 값 — Node 가 drizzle·better-sqlite3 에 넘기던 그대로 바인딩한다.
/// 문자열은 text, 숫자는 언제나 REAL(그래서 text 열에 '5.0' 으로 들어간다 — better-sqlite3 가 그렇다),
/// 값이 없으면 열 기본값 '', null·true/false·객체는 Node 에서 바인딩 오류(500)였다.
/// 기본값('')과 NOT NULL 만 여기서 정하고, 나머지 바인딩 규칙은 [`crate::jsval::bind`] 하나를 쓴다.
fn bind_value(v: Option<&Value>) -> Result<Sql, String> {
    match v {
        None => Ok(Sql::Text(String::new())),
        Some(Value::Null) => Err("NOT NULL constraint failed: variables.value".into()),
        other => crate::jsval::bind(other),
    }
}

async fn replace(State(s): State<AppState>, body: Bytes) -> ApiResult<Json<Value>> {
    // `req.json().catch(() => null)` 뒤 `if (!b)` — 깨진 JSON 뿐 아니라 null·false·0·"" 도 400 이다.
    let b = read_json(&body).filter(|b| js::truthy(Some(b)));
    let Some(b) = b else { return Err(ApiError::bad_request("invalid json")) };
    // `b.workspaceId ?? 'default'` 를 템플릿 문자열에 넣는다 — 숫자·배열도 문자열이 되어 들어간다.
    let ws = match b.get("workspaceId") {
        None | Some(Value::Null) => "default".to_string(),
        Some(v) => js::to_string(v),
    };
    let scope = global_scope_id(&ws);
    // variables 가 배열일 때만 전체 교체 — 비배열/생략이면 아무것도 지우지 않는다
    // (지우고 나서 돌다가 터져 전역 변수(secret 포함)가 통째로 사라지던 일을 막는다).
    let Some(Value::Array(vars)) = b.get("variables").cloned() else {
        return Ok(Json(json!({ "ok": true })));
    };
    s.db
        .run(move |c| {
            let keys = Keys::from_env();
            let prev = load_var_map_with(c, &scope, &keys)?; // 복호화된 평문(빈 값=유지 판정용)
            // 지우고-넣기라 중간에 터지면 전역 변수가 통째로 사라진다 — 한 트랜잭션으로 묶는다.
            let tx = c.unchecked_transaction()?;
            tx.execute(r#"DELETE FROM "variables" WHERE "environment_id" = ?1"#, [&scope])?;
            for v in &vars {
                let Some(key) = v.get("key").and_then(Value::as_str).filter(|k| !k.is_empty()) else { continue };
                let secret = js::truthy(v.get("secret"));
                let value = v.get("value");
                let prev_var = prev.get(key);
                // secret 의 빈 값 재저장은 기존 값 유지(마스킹돼 내려간 값을 그대로 저장하는 정상 흐름)
                let keep_previous = value.and_then(Value::as_str) == Some("")
                    && (secret || prev_var.map_or(false, |p| p.secret))
                    && prev_var.map_or(false, |p| !p.value.is_empty());
                let stored = if keep_previous {
                    Sql::Text(secretbox::store_secret_with(&keys, &prev_var.unwrap().value, secret))
                } else {
                    match (value, secret) {
                        // 문자열 secret 만 암호화한다. 키가 있는데 문자열이 아니면 Node 는 TypeError(500)였다.
                        (Some(Value::String(s)), true) => Sql::Text(secretbox::store_secret_with(&keys, s, true)),
                        (other, true) if keys.current.is_some() => {
                            anyhow::bail!("The \"data\" argument must be of type string. Received {}", other.map_or("undefined".into(), |o| o.to_string()))
                        }
                        (other, _) => bind_value(other).map_err(anyhow::Error::msg)?,
                    }
                };
                tx.execute(
                    r#"INSERT INTO "variables" ("id", "environment_id", "key", "value", "secret") VALUES (?1, ?2, ?3, ?4, ?5)"#,
                    rusqlite::params![uuid::Uuid::new_v4().to_string(), scope, key, stored, secret as i64],
                )?;
            }
            tx.commit()?;
            Ok(())
        })
        .await?;
    Ok(Json(json!({ "ok": true })))
}
