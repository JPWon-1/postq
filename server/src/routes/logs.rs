//! `/api/logs`. 앱 안에서 보는 서버 로그(?level=error&limit=200).

use axum::extract::RawQuery;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::js;
use crate::server_log::{self, Level};
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/logs", get(list).delete(clear))
}

/// `Math.min(Math.max(Number(limit ?? 200) || 200, 1), 300)` — 0·NaN 은 200, 그 뒤 1..300 으로 묶는다.
/// 소수는 slice(-limit) 가 버림하므로 버림한다.
fn limit_of(raw: Option<&str>) -> usize {
    let n = raw.map_or(200.0, js::number);
    let n = if n == 0.0 || n.is_nan() { 200.0 } else { n };
    n.max(1.0).min(300.0).trunc() as usize
}

async fn list(RawQuery(q): RawQuery) -> Json<Vec<Value>> {
    let level = js::query_get(q.as_deref(), "level").and_then(|l| Level::parse(&l));
    let limit = limit_of(js::query_get(q.as_deref(), "limit").as_deref());
    Json(server_log::read(limit, level).into_iter().filter_map(|e| serde_json::to_value(e).ok()).collect())
}

/// 화면에서 [지우기] — 메모리 버퍼만 비운다(컨테이너 로그는 그대로 남는다).
async fn clear() -> Json<Value> {
    server_log::clear();
    Json(json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limit_은_node_와_같이_묶인다() {
        assert_eq!(limit_of(None), 200);
        assert_eq!(limit_of(Some("")), 200);
        assert_eq!(limit_of(Some("0")), 200);
        assert_eq!(limit_of(Some("abc")), 200);
        assert_eq!(limit_of(Some("-5")), 1);
        assert_eq!(limit_of(Some("2.5")), 2);
        assert_eq!(limit_of(Some("0.5")), 1);
        assert_eq!(limit_of(Some("1000")), 300);
        assert_eq!(limit_of(Some("Infinity")), 300);
        assert_eq!(limit_of(Some("0x10")), 16);
    }
}
