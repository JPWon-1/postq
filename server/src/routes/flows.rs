//! `/api/flows`, `/api/flows/{id}`, `/api/flows/{id}/runs`.
//!
//! 시나리오 실행(`/api/flows/{id}/run`)은 [`super::flow_run`] 이 맡는다.
//!
//! 저장 규칙은 Node 와 똑같이 맞춘다. steps 는 화면이 보낸 배열을 JSON.stringify 해서 그대로 넣고
//! (JS 의 키 순서·숫자 표기까지 — [`crate::js::stringify`]), sharedVars 의 secret 은 저장할 때 암호화하고
//! 내려보낼 때 값을 비운다.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::{get, put};
use axum::Router;
use rusqlite::types::Value as Sql;
use rusqlite::Connection;
use serde_json::{json, Map, Value};

use crate::error::ApiResult;
use crate::json_cols::{safe_json, to_object_array};
use crate::jsval::{self, ok};
use crate::routes::input::{fail, read_json, require_text, respond, Out};
use crate::rows::{self, Col};
use crate::secretbox::{self, Keys};
use crate::{js, AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/flows", get(list).post(create))
        .route("/api/flows/{id}", put(update).delete(remove))
        .route("/api/flows/{id}/runs", get(runs))
}

/// text 열에 JSON 값 하나를 넣을 때 Node(drizzle → better-sqlite3)가 하던 그대로.
/// 문자열은 text, 숫자는 REAL(text 열에선 '5.0' 이 된다), null 은 NOT NULL 위반, 나머지는 바인딩 오류(500).
/// 바인딩 규칙은 [`jsval::bind`] 하나 — 여기는 NOT NULL 열이라 null 만 먼저 막는다.
pub(crate) fn bind_text(v: &Value, column: &str) -> anyhow::Result<Sql> {
    if v.is_null() {
        anyhow::bail!("NOT NULL constraint failed: {column}");
    }
    jsval::bind(Some(v)).map_err(anyhow::Error::msg)
}

/// sharedVars 를 내려보낼 모양으로 — secret 은 값을 비운다(환경 변수 GET 과 같은 규약).
/// 화면은 '(저장된 값 유지)' 로 표시하고, 빈 값으로 저장하면 서버가 기존 값을 지킨다.
fn masked_shared_vars(raw: &Value) -> Value {
    let list = to_object_array(safe_json(Some(raw)).as_ref());
    Value::Array(
        list.into_iter()
            .map(|mut v| {
                if js::truthy(v.get("secret")) {
                    // 스프레드처럼 — 있던 키는 제자리, 없던 value 는 끝에 붙는다.
                    if let Some(o) = v.as_object_mut() {
                        o.insert("value".into(), Value::String(String::new()));
                    }
                }
                v
            })
            .collect(),
    )
}

fn steps_of(raw: &Value) -> Value {
    Value::Array(to_object_array(safe_json(Some(raw)).as_ref()))
}

const FLOW_COLS: &[(&str, usize, Col)] = &[
    ("id", 0, Col::Plain),
    ("workspaceId", 1, Col::Plain),
    ("name", 2, Col::Plain),
    ("steps", 3, Col::Plain),
    ("sharedVars", 4, Col::Plain),
    ("updatedAt", 5, Col::Plain),
];

pub(crate) fn list_flows(c: &Connection, ws: &str) -> anyhow::Result<Vec<Value>> {
    let mut st = c.prepare_cached(
        r#"select "id", "workspace_id", "name", "steps", "shared_vars", "updated_at" from "flows" where "flows"."workspace_id" = ?"#,
    )?;
    let rows = st.query_map([ws], |r| rows::object(r, FLOW_COLS))?.collect::<Result<Vec<_>, _>>()?;
    // steps/sharedVars 열이 손상돼도 목록(사이드바) 전체가 500 나지 않도록 방어 파싱 + 무효 요소 제거.
    Ok(rows
        .into_iter()
        .map(|mut f| {
            let steps = steps_of(&f["steps"]);
            let shared = masked_shared_vars(&f["sharedVars"]);
            f.insert("steps".into(), steps);
            f.insert("sharedVars".into(), shared);
            Value::Object(f)
        })
        .collect())
}

async fn list(State(s): State<AppState>, RawQuery(q): RawQuery) -> ApiResult<Response> {
    let ws = js::query_get(q.as_deref(), "workspaceId").unwrap_or_else(|| "default".into());
    let list = s.db.run(move |c| list_flows(c, &ws)).await?;
    Ok(ok(&Value::Array(list)))
}

pub(crate) fn create_flow(c: &Connection, keys: &Keys, body: &[u8]) -> anyhow::Result<Out> {
    // readJson 뒤 `if (!b)` — 깨진 JSON 뿐 아니라 null·false·0·"" 도 400 이다.
    let Some(b) = read_json(body).filter(|b| js::truthy(Some(b))) else {
        return Ok(fail(StatusCode::BAD_REQUEST, "본문이 올바른 JSON 이 아닙니다"));
    };
    // truthy 검사만 하면 숫자 123 이 통과해 이름이 숫자인 행이 생긴다('123.0' 시나리오가 실제로 생겼다).
    let Some(name) = require_text(b.get("name"), 200) else {
        return Ok(fail(StatusCode::BAD_REQUEST, "name 은 비어 있지 않은 문자열이어야 합니다"));
    };
    let shared: Vec<(String, String, bool)> = to_object_array(b.get("sharedVars"))
        .into_iter()
        .map(|v| {
            let secret = js::truthy(v.get("secret"));
            let key = v.get("key").and_then(Value::as_str).unwrap_or("").to_string();
            let value = secretbox::store_secret_with(keys, v.get("value").and_then(Value::as_str).unwrap_or(""), secret);
            (key, value, secret)
        })
        .collect();
    let shared_json = |mask: bool| {
        Value::Array(
            shared
                .iter()
                .map(|(k, v, s)| json!({ "key": k, "value": if mask && *s { "" } else { v.as_str() }, "secret": s }))
                .collect(),
        )
    };
    // `b.workspaceId ?? 'default'` — 문자열이 아니어도 그대로 넣고 그대로 돌려준다.
    let ws = match b.get("workspaceId") {
        None | Some(Value::Null) => Value::String("default".into()),
        Some(v) => v.clone(),
    };
    let steps = match b.get("steps") {
        Some(a @ Value::Array(_)) => a.clone(),
        _ => Value::Array(Vec::new()),
    };
    let id = uuid::Uuid::new_v4().to_string();
    let now = js::now_ms();
    c.prepare_cached(r#"insert into "flows" ("id", "workspace_id", "name", "steps", "shared_vars", "updated_at") values (?, ?, ?, ?, ?, ?)"#)?
        .execute(rusqlite::params![id, bind_text(&ws, "flows.workspace_id")?, name, js::stringify(&steps), js::stringify(&shared_json(false)), now])?;
    Ok((
        StatusCode::CREATED,
        json!({ "id": id, "workspaceId": ws, "name": name, "steps": steps, "sharedVars": shared_json(true), "updatedAt": now }),
    ))
}

async fn create(State(s): State<AppState>, body: Bytes) -> ApiResult<Response> {
    Ok(respond(s.db.run(move |c| create_flow(c, &Keys::from_env(), &body)).await?))
}

/// `a !== b` 의 반대 — DB 값과 바디 값이 JS 에서 엄격히 같은지(숫자는 값으로, 문자열은 글자로).
fn strict_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::String(x), Value::String(y)) => x == y,
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::Null, Value::Null) => true,
        _ => false,
    }
}

pub(crate) fn update_flow(c: &Connection, keys: &Keys, id: &str, body: &[u8]) -> anyhow::Result<Out> {
    // `req.json().catch(() => null)` 뒤 `if (!b)`
    let Some(b) = read_json(body).filter(|b| js::truthy(Some(b))) else {
        return Ok(fail(StatusCode::BAD_REQUEST, "invalid json"));
    };
    let now = js::now_ms();
    /*
     * 낙관적 잠금 — 클라이언트가 알고 있던 updatedAt 과 다르면 그 사이 다른 사람이 저장한 것.
     * 시나리오는 팀이 같이 만지는 물건이고 저장은 steps 전체를 통째로 덮어쓴다 — 둘이 같은 시나리오를
     * 열어 두면 나중에 저장한 쪽이 앞사람의 스텝을 조용히 지운다. ifUpdatedAt 이 없으면 무조건 저장한다.
     */
    if let Some(if_updated) = b.get("ifUpdatedAt") {
        let cur: Option<Value> = c
            .prepare_cached(r#"select "updated_at" from "flows" where "flows"."id" = ?"#)?
            .query_map([id], |r| Ok(rows::raw(r.get_ref(0)?)))?
            .next()
            .transpose()?;
        if let Some(cur) = cur {
            if !strict_eq(&cur, if_updated) {
                return Ok((
                    StatusCode::CONFLICT,
                    json!({ "error": "다른 사람이 이 시나리오를 먼저 저장했습니다 — 덮어쓰지 않았습니다", "updatedAt": cur }),
                ));
            }
        }
    }
    // 없는 시나리오에 200 을 주면 다른 사람이 지운 시나리오를 편집하던 사람은 저장이 성공한 줄 안다.
    let prev_shared: Option<Value> = c
        .prepare_cached(r#"select "shared_vars" from "flows" where "flows"."id" = ?"#)?
        .query_map([id], |r| Ok(rows::raw(r.get_ref(0)?)))?
        .next()
        .transpose()?;
    let Some(prev_shared) = prev_shared else {
        return Ok(fail(StatusCode::NOT_FOUND, "시나리오가 없습니다 — 다른 사람이 지웠을 수 있습니다"));
    };

    // drizzle 의 update ... set 처럼 준 열만 바꾼다.
    let mut sets: Vec<(&str, Sql)> = Vec::new();
    if let Some(name) = b.get("name") {
        sets.push(("name", bind_text(name, "flows.name")?));
    }
    if let Some(steps) = b.get("steps") {
        let arr = if steps.is_array() { steps.clone() } else { Value::Array(Vec::new()) };
        sets.push(("steps", Sql::Text(js::stringify(&arr))));
    }
    if let Some(next) = b.get("sharedVars") {
        let next: &[Value] = next.as_array().map_or(&[], |a| a.as_slice());
        // 화면은 secret 값을 못 받으므로(GET 이 '' 로 내려준다) 빈 값으로 되돌아온다.
        // 그걸 그대로 저장하면 저장돼 있던 시크릿이 조용히 지워진다 → 키가 같은 기존 값을 지킨다.
        // 손상된 행(배열이 아님·깨진 JSON)은 무시 — 아래에서 새 값으로 덮인다.
        let mut prev: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        if let Some(Value::Array(items)) = safe_json(Some(&prev_shared)) {
            for v in items {
                if let Some(k) = v.get("key").and_then(Value::as_str) {
                    let value = match v.get("value") {
                        None | Some(Value::Null) => String::new(),
                        Some(x) => js::to_string(x),
                    };
                    prev.insert(k.to_string(), value);
                }
            }
        }
        let out: Vec<Value> = next
            .iter()
            .map(|v| {
                let key = v.get("key").and_then(Value::as_str).unwrap_or("").to_string();
                let secret = js::truthy(v.get("secret"));
                let incoming = v.get("value").and_then(Value::as_str).unwrap_or("");
                // 빈 값 + secret + 기존 값 있음 → 기존 암호문 유지
                if let Some(before) = prev.get(&key).filter(|p| secret && incoming.is_empty() && !p.is_empty()) {
                    return json!({ "key": key, "value": before, "secret": true });
                }
                json!({ "key": key, "value": secretbox::store_secret_with(keys, incoming, secret), "secret": secret })
            })
            .collect();
        sets.push(("shared_vars", Sql::Text(js::stringify(&Value::Array(out)))));
    }
    sets.push(("updated_at", Sql::Integer(now)));
    let sql = format!(
        r#"update "flows" set {} where "flows"."id" = ?"#,
        sets.iter().map(|(col, _)| format!(r#""{col}" = ?"#)).collect::<Vec<_>>().join(", ")
    );
    let mut params: Vec<Sql> = sets.into_iter().map(|(_, v)| v).collect();
    params.push(Sql::Text(id.to_string()));
    c.prepare_cached(&sql)?.execute(rusqlite::params_from_iter(params))?;
    // 새 updatedAt 을 돌려준다 — 클라이언트가 다음 저장의 ifUpdatedAt 으로 쓴다.
    Ok((StatusCode::OK, json!({ "ok": true, "updatedAt": now })))
}

async fn update(State(s): State<AppState>, Path(id): Path<String>, body: Bytes) -> ApiResult<Response> {
    Ok(respond(s.db.run(move |c| update_flow(c, &Keys::from_env(), &id, &body)).await?))
}

pub(crate) fn delete_flow(c: &Connection, id: &str) -> anyhow::Result<()> {
    // 시나리오가 사라진 스케줄은 매 tick 'flow-missing' 을 남기며 영영 돈다 — 같이 지운다.
    let tx = c.unchecked_transaction()?;
    tx.prepare_cached(r#"delete from "schedules" where "schedules"."flow_id" = ?"#)?.execute([id])?;
    tx.prepare_cached(r#"delete from "flows" where "flows"."id" = ?"#)?.execute([id])?;
    tx.commit()?;
    Ok(())
}

async fn remove(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<Response> {
    s.db.run(move |c| delete_flow(c, &id)).await?;
    Ok(ok(&json!({ "ok": true })))
}

const RUN_COLS: &[(&str, usize, Col)] = &[
    ("id", 0, Col::Plain),
    ("flowId", 1, Col::Plain),
    ("workspaceId", 2, Col::Plain),
    ("environmentId", 3, Col::Plain),
    ("executedBy", 4, Col::Plain),
    ("startedAt", 5, Col::Plain),
    ("durationMs", 6, Col::Plain),
    ("stoppedAt", 7, Col::Plain),
    ("steps", 8, Col::Plain),
];

/// 이 시나리오의 지난 실행 — 최근순 30건. 스텝 요약(JSON 열)은 파싱해서 내려준다.
pub(crate) fn list_runs(c: &Connection, flow_id: &str) -> anyhow::Result<Vec<Value>> {
    let mut st = c.prepare_cached(
        r#"select "id", "flow_id", "workspace_id", "environment_id", "executed_by", "started_at", "duration_ms", "stopped_at", "steps" from "flow_runs" where "flow_runs"."flow_id" = ? order by "flow_runs"."started_at" desc limit ?"#,
    )?;
    let rows = st.query_map(rusqlite::params![flow_id, 30], |r| rows::object(r, RUN_COLS))?.collect::<Result<Vec<Map<String, Value>>, _>>()?;
    Ok(rows
        .into_iter()
        .map(|mut r| {
            // 손상된 행이 목록 전체를 500 내지 않도록 — 배열이 아니면 빈 배열(요소는 거르지 않는다, Node 와 같게).
            let steps = match safe_json(r.get("steps")) {
                Some(a @ Value::Array(_)) => a,
                _ => Value::Array(Vec::new()),
            };
            r.insert("steps".into(), steps);
            Value::Object(r)
        })
        .collect())
}

async fn runs(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<Response> {
    Ok(ok(&Value::Array(s.db.run(move |c| list_runs(c, &id)).await?)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::variables::tests::test_db;

    const KEY: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn make(c: &Connection, keys: &Keys, body: Value) -> Value {
        let (st, v) = create_flow(c, keys, body.to_string().as_bytes()).unwrap();
        assert_eq!(st, StatusCode::CREATED);
        v
    }

    fn stored(c: &Connection, id: &str) -> Vec<Value> {
        let s: String = c.query_row("SELECT shared_vars FROM flows WHERE id = ?1", [id], |r| r.get(0)).unwrap();
        serde_json::from_str::<Vec<Value>>(&s).unwrap()
    }

    fn save(c: &Connection, keys: &Keys, id: &str, shared: Value) {
        let (st, _) = update_flow(c, keys, id, json!({ "sharedVars": shared }).to_string().as_bytes()).unwrap();
        assert_eq!(st, StatusCode::OK);
    }

    // 시나리오 공통 입력값 secret 이 환경 변수 secret 과 같은 보증을 갖는지.
    #[test]
    fn secret_은_암호문으로_저장되고_목록엔_값이_없고_빈_값_재저장에도_지켜진다() {
        let db = test_db();
        let keys = Keys::new(Some(KEY), &[]);
        db.with(|c| {
            let id = make(c, &keys, json!({ "name": "secret-저장" }))["id"].as_str().unwrap().to_string();
            save(c, &keys, &id, json!([{ "key": "token", "value": "SUPER-SECRET", "secret": true }, { "key": "customerNumber", "value": "test01" }]));
            let rows = stored(c, &id);
            let tok = rows[0]["value"].as_str().unwrap().to_string();
            assert!(secretbox::is_encrypted(&tok));
            assert!(!tok.contains("SUPER-SECRET"));
            assert_eq!(rows[1]["value"], "test01");

            // 목록 API 는 secret 값을 내려주지 않는다
            let listed = list_flows(c, "default")?;
            let f = listed.iter().find(|f| f["id"] == id.as_str()).unwrap();
            assert_eq!(f["sharedVars"][0]["value"], "");
            assert_eq!(f["sharedVars"][0]["secret"], true);

            // 빈 값으로 다시 저장해도 기존 secret 이 지워지지 않는다
            save(c, &keys, &id, json!([{ "key": "token", "value": "", "secret": true }]));
            assert_eq!(stored(c, &id)[0]["value"], tok.as_str());

            // 새 값을 넣으면 덮어쓴다
            save(c, &keys, &id, json!([{ "key": "token", "value": "NEW", "secret": true }]));
            assert_ne!(stored(c, &id)[0]["value"], tok.as_str());

            // secret 을 해제하면 평문
            save(c, &keys, &id, json!([{ "key": "token", "value": "now-plain", "secret": false }]));
            assert_eq!(stored(c, &id)[0]["value"], "now-plain");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn 만들_때의_secret_도_암호화하고_응답에서_가린다() {
        let db = test_db();
        let keys = Keys::new(Some(KEY), &[]);
        db.with(|c| {
            let body = make(c, &keys, json!({ "name": "created-secret", "sharedVars": [{ "key": "token", "value": "INITIAL-SECRET", "secret": true }] }));
            assert!(!body.to_string().contains("INITIAL-SECRET"));
            assert_eq!(body["sharedVars"][0]["value"], "");
            let id = body["id"].as_str().unwrap();
            assert!(secretbox::is_encrypted(stored(c, id)[0]["value"].as_str().unwrap()));
            // 응답 키 순서는 Node 의 { ...row, steps, sharedVars } 와 같다
            let keys_order: Vec<&str> = body.as_object().unwrap().keys().map(String::as_str).collect();
            assert_eq!(keys_order, ["id", "workspaceId", "name", "steps", "sharedVars", "updatedAt"]);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn 시나리오를_지우면_그_스케줄만_지운다() {
        let db = test_db();
        let keys = Keys::default();
        db.with(|c| {
            let id = make(c, &keys, json!({ "name": "delete-test" }))["id"].as_str().unwrap().to_string();
            let other = make(c, &keys, json!({ "name": "keep-test" }))["id"].as_str().unwrap().to_string();
            c.execute("INSERT INTO schedules (id, flow_id) VALUES ('delete-schedule', ?1), ('keep-schedule', ?2)", [&id, &other])?;
            delete_flow(c, &id)?;
            let n = |sql: &str| c.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap();
            assert_eq!(n(&format!("SELECT count(*) FROM flows WHERE id = '{id}'")), 0);
            assert_eq!(n("SELECT count(*) FROM schedules WHERE id = 'delete-schedule'"), 0);
            assert_eq!(n("SELECT count(*) FROM schedules WHERE id = 'keep-schedule'"), 1);
            assert_eq!(n(&format!("SELECT count(*) FROM flows WHERE id = '{other}'")), 1);
            Ok(())
        })
        .unwrap();
    }

    // optimisticLock 규칙 — 다르면 409 + 현재 updatedAt, 없는 시나리오는 404, 숫자 이름은 거른다.
    #[test]
    fn 낙관적_잠금과_없는_시나리오() {
        let db = test_db();
        let keys = Keys::default();
        db.with(|c| {
            let f = make(c, &keys, json!({ "name": "lock", "steps": [{ "requestId": "r1", "extracts": [] }] }));
            let id = f["id"].as_str().unwrap();
            let (st, v) = update_flow(c, &keys, id, json!({ "name": "x", "ifUpdatedAt": 1 }).to_string().as_bytes())?;
            assert_eq!(st, StatusCode::CONFLICT);
            assert_eq!(v["updatedAt"], f["updatedAt"]);
            let (st, v) = update_flow(c, &keys, id, json!({ "name": "y", "ifUpdatedAt": f["updatedAt"] }).to_string().as_bytes())?;
            assert_eq!(st, StatusCode::OK);
            assert!(v["updatedAt"].is_i64());
            let (st, _) = update_flow(c, &keys, "nope", br#"{"name":"z"}"#)?;
            assert_eq!(st, StatusCode::NOT_FOUND);
            let (st, v) = update_flow(c, &keys, id, b"null")?;
            assert_eq!((st, v["error"].as_str()), (StatusCode::BAD_REQUEST, Some("invalid json")));
            let (st, _) = create_flow(c, &keys, br#"{"name":123}"#)?;
            assert_eq!(st, StatusCode::BAD_REQUEST);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn 실행_기록은_최근순_30건_손상된_steps_는_빈_배열() {
        let db = test_db();
        db.with(|c| {
            for i in 0..35 {
                let steps = if i == 34 { "{oops".to_string() } else { format!(r#"[{{"name":"s{i}"}}]"#) };
                c.execute(
                    "INSERT INTO flow_runs (id, flow_id, executed_by, started_at, steps) VALUES (?1, 'fl', 't', ?2, ?3)",
                    rusqlite::params![format!("r{i}"), i, steps],
                )?;
            }
            let runs = list_runs(c, "fl")?;
            assert_eq!(runs.len(), 30);
            assert_eq!(runs[0]["id"], "r34");
            assert_eq!(runs[0]["steps"], json!([]));
            assert_eq!(runs[1]["steps"], json!([{ "name": "s33" }]));
            Ok(())
        })
        .unwrap();
    }
}
