//! 인프로세스 스케줄러. 배경 작업 이름은 "scheduler".
//!
//! 공개 API
//! - [`start`] — serve() 가 한 번 부른다(멱등). 1분마다 due 스케줄을 찾아 시나리오를 실행하고, 정책(always/failure)에
//!   따라 알림을 보내고, EXECUTION_RETENTION_DAYS 가 있으면 오래된 실행 이력을 정리한다.
//! - [`run_schedule`] — 스케줄 하나를 지금 실행(수동 트리거 POST /api/schedules/{id} 와 tick 이 공유).
//! - [`scheduler_state`] — GET /api/schedules?runtime=1.
//! - [`is_due`] / [`retention_cutoff`] — 순수 함수.
//!
//! 같은 DB 를 보는 서버가 둘이 될 수 있어서(번들 앱 + 개발 서버)
//! 실행 직전 lastRunAt 을 조건부 UPDATE(compare-and-swap)로 선점한다 — SQLite 가 쓰기를 직렬화하므로 그게 곧 락이다.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use rusqlite::OptionalExtension;
use serde_json::{json, Map, Value};

use crate::execution_policy::ExecutionSource;
use crate::server_log::{self, Level};
use crate::slack::{build_slack_message, send_notification, ScenarioRunSummary, SummaryStep};
use crate::{js, AppState};

#[derive(Default)]
struct State {
    started: bool,
    last_tick_at: Option<i64>,
    /// 같은 스케줄이 동시에 두 번 돌지 않도록 — 긴 flow(>1분) 실행 중 다음 tick 이 같은 스케줄을 다시 잡아
    /// 중복 부작용(중복 POST·알림)을 내는 것을 막는다(프로세스 안).
    in_flight: HashSet<String>,
}

fn state() -> &'static Mutex<State> {
    static S: OnceLock<Mutex<State>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(State::default()))
}

fn lock() -> std::sync::MutexGuard<'static, State> {
    state().lock().unwrap_or_else(|e| e.into_inner())
}

pub fn scheduler_state() -> Value {
    let s = lock();
    json!({ "started": s.started, "lastTickAt": s.last_tick_at, "running": s.in_flight.len(), "mode": "server-process" })
}

/// 이 스케줄이 지금 실행 대상인지(활성 + 마지막 실행 후 interval 경과).
pub fn is_due(enabled: bool, last_run_at: Option<i64>, interval_minutes: i64, now: i64) -> bool {
    if !enabled {
        return false;
    }
    // `!s.lastRunAt` — 0 도 '한 번도 안 돎' 이다.
    match last_run_at {
        None | Some(0) => true,
        Some(last) => now - last >= interval_minutes * 60_000,
    }
}

/// 실행 이력 보존 커트라인. days 가 무효(숫자 아님·0 이하)면 None — 정리하지 않는다(무제한 보존이 안전한 기본값).
pub fn retention_cutoff(days_raw: Option<&str>, now: i64) -> Option<i64> {
    let days = days_raw.map_or(f64::NAN, js::number);
    if !days.is_finite() || days <= 0.0 {
        return None;
    }
    Some(now - (days * 86_400_000.0) as i64)
}

#[derive(Clone, Debug, PartialEq)]
pub struct RunOutcome {
    pub ran: bool,
    pub failed: Option<bool>,
    pub error: Option<String>,
}

impl RunOutcome {
    fn not_run(error: &str) -> Self {
        RunOutcome { ran: false, failed: None, error: Some(error.into()) }
    }
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("ran".into(), json!(self.ran));
        if let Some(f) = self.failed {
            m.insert("failed".into(), json!(f));
        }
        if let Some(e) = &self.error {
            m.insert("error".into(), json!(e));
        }
        Value::Object(m)
    }
}

struct Sched {
    workspace_id: String,
    flow_id: String,
    environment_id: Option<String>,
    slack_webhook_url: Option<String>,
    notify_on: String,
    last_run_at: Option<i64>,
}

fn set_status(c: &rusqlite::Connection, id: &str, status: &str) -> rusqlite::Result<usize> {
    c.prepare_cached(r#"update "schedules" set "last_run_at" = ?, "last_status" = ? where "schedules"."id" = ?"#)?
        .execute(rusqlite::params![js::now_ms(), status, id])
}

/// 스케줄 하나를 지금 실행한다(수동 트리거·tick 공유).
pub async fn run_schedule(s: &AppState, schedule_id: &str) -> RunOutcome {
    let sched = {
        let id = schedule_id.to_string();
        s.db
            .run(move |c| {
                Ok(c.prepare_cached(
                    r#"select "workspace_id", "flow_id", "environment_id", "slack_webhook_url", "notify_on", "last_run_at" from "schedules" where "schedules"."id" = ?"#,
                )?
                .query_row([&id], |r| {
                    Ok(Sched {
                        workspace_id: crate::rows::text(r, 0)?,
                        flow_id: crate::rows::text(r, 1)?,
                        environment_id: r.get(2)?,
                        slack_webhook_url: r.get(3)?,
                        notify_on: crate::rows::text(r, 4)?,
                        last_run_at: r.get(5)?,
                    })
                })
                .optional()?)
            })
            .await
    };
    let sched = match sched {
        Ok(Some(x)) => x,
        Ok(None) => return RunOutcome::not_run("schedule not found"),
        Err(e) => return RunOutcome::not_run(&e.to_string()),
    };
    if lock().in_flight.contains(schedule_id) {
        return RunOutcome::not_run("already running");
    }
    // 진입 즉시 lastRunAt 선점(compare-and-swap) — 그냥 덮어쓰면 같은 DB 를 보는 서버가 둘일 때 둘 다 옛 값을 읽고
    // 둘 다 통과해 같은 스케줄을 두 번 실행한다(주문·결제 POST 가 두 번 나간다). 진 쪽은 물러난다.
    let claimed = {
        let (id, last) = (schedule_id.to_string(), sched.last_run_at);
        s.db
            .run(move |c| {
                let n = match last {
                    None => c
                        .prepare_cached(r#"update "schedules" set "last_run_at" = ?, "last_status" = 'running' where ("schedules"."id" = ? and "schedules"."last_run_at" is null)"#)?
                        .execute(rusqlite::params![js::now_ms(), id])?,
                    Some(v) => c
                        .prepare_cached(r#"update "schedules" set "last_run_at" = ?, "last_status" = 'running' where ("schedules"."id" = ? and "schedules"."last_run_at" = ?)"#)?
                        .execute(rusqlite::params![js::now_ms(), id, v])?,
                };
                Ok(n)
            })
            .await
    };
    if claimed.map_or(true, |n| n == 0) {
        return RunOutcome::not_run("already running");
    }
    lock().in_flight.insert(schedule_id.to_string());
    let outcome = match run_claimed(s, schedule_id, &sched).await {
        Ok(o) => o,
        Err(e) => {
            // 예외를 삼키지 않고 상태·로그로 남긴다 — 예전엔 lastRunAt 미기록으로 매 tick 무한 재시도+무로그였다.
            eprintln!("[scheduler] 스케줄 {schedule_id} 실행 실패: {e}");
            server_log::log(Level::Error, "스케줄 실행", &format!("스케줄 {schedule_id} 실행 실패"), Some(&format!("{e:?}")), None);
            let id = schedule_id.to_string();
            let _ = s.db.run(move |c| Ok(set_status(c, &id, "error")?)).await;
            RunOutcome::not_run(&e.to_string())
        }
    };
    lock().in_flight.remove(schedule_id);
    outcome
}

async fn run_claimed(s: &AppState, schedule_id: &str, sched: &Sched) -> anyhow::Result<RunOutcome> {
    let (flow_name, ws_name) = {
        let (fid, ws) = (sched.flow_id.clone(), sched.workspace_id.clone());
        s.db
            .run(move |c| {
                let flow: Option<String> =
                    c.prepare_cached(r#"select "name" from "flows" where "flows"."id" = ?"#)?.query_row([&fid], |r| crate::rows::text(r, 0)).optional()?;
                let ws: Option<String> =
                    c.prepare_cached(r#"select "name" from "workspaces" where "workspaces"."id" = ?"#)?.query_row([&ws], |r| crate::rows::text(r, 0)).optional()?;
                Ok((flow, ws))
            })
            .await?
    };
    let Some(flow_name) = flow_name else {
        let id = schedule_id.to_string();
        s.db.run(move |c| Ok(set_status(c, &id, "flow-missing")?)).await?;
        return Ok(RunOutcome::not_run("flow deleted"));
    };

    // 시나리오 실행을 직접 부른다 — 출처는 'schedule'(HTTP 로는 위조할 수 없는 서버 내부 값).
    let mut body = json!({ "executedBy": "스케줄러" });
    if let Some(env) = &sched.environment_id {
        body["environmentId"] = json!(env);
    }
    let (code, run) = crate::routes::flow_run::run_flow(s, &sched.flow_id, &body, ExecutionSource::Schedule).await?;
    if !code.is_success() {
        anyhow::bail!("시나리오 실행 실패 ({})", code.as_u16());
    }
    let stopped_at = run.get("stoppedAt").and_then(Value::as_u64).map(|v| v as usize);
    let failed = stopped_at.is_some();
    let steps: Vec<SummaryStep> = run
        .get("steps")
        .and_then(Value::as_array)
        .map(|a| a.as_slice())
        .unwrap_or(&[])
        .iter()
        .enumerate()
        .map(|(i, st)| {
            let ex = st.get("execution");
            let status = ex.and_then(|e| e.get("responseStatus")).and_then(Value::as_u64).map(|v| v as u16);
            let check = ex.and_then(|e| e.get("checkPassed")).filter(|v| !v.is_null());
            let step_failed = js::truthy(ex.and_then(|e| e.get("error")))
                || check == Some(&Value::Bool(false))
                || (check.is_none() && status.map_or(false, |v| v >= 400));
            SummaryStep { step: i + 1, name: st.get("name").and_then(Value::as_str).map(str::to_string), status, failed: step_failed }
        })
        .collect();
    let summary = ScenarioRunSummary { flow_name: flow_name.clone(), stopped_at, steps };

    if let Some(hook) = sched.slack_webhook_url.as_deref().filter(|h| !h.is_empty()) {
        if sched.notify_on == "always" || failed {
            // 반환값을 버리면 webhook 이 만료·오타·차단일 때 알림이 조용히 사라진다 — 알림을 켜 둔 사람은
            // '실패가 없었구나' 로 읽는다. 실행 자체는 성공일 수 있으므로 lastStatus 는 안 바꾸고 로그로 남긴다.
            if let Err(e) = send_notification(hook, &build_slack_message(&summary, ws_name.as_deref().unwrap_or("기본"))).await {
                server_log::log(
                    Level::Error,
                    &format!("스케줄 알림 · {flow_name}"),
                    &format!("알림을 보내지 못했습니다 — {}", if e.is_empty() { "원인 미상" } else { &e }),
                    Some(&format!("webhook 주소와 채널 설정을 확인하세요. 시나리오 실행 자체는 {}했습니다.", if failed { "실패" } else { "성공" })),
                    Some(&format!("?flow={}", sched.flow_id)),
                );
            }
        }
    }
    {
        let id = schedule_id.to_string();
        s.db.run(move |c| Ok(set_status(c, &id, if failed { "failed" } else { "ok" })?)).await?;
    }
    // 새벽에 자동으로 도는 것이라 로그가 제일 필요하다 — 앱 안에서도 보이게.
    let detail: Vec<String> = summary
        .steps
        .iter()
        .map(|st| format!("{}. {} → {}", st.step, st.name.as_deref().unwrap_or(""), st.status.map_or("ERR".to_string(), |v| v.to_string())))
        .collect();
    server_log::log(
        if failed { Level::Error } else { Level::Info },
        &format!("스케줄 · {flow_name}"),
        &if failed { format!("{}번째 스텝에서 중단", stopped_at.unwrap_or(0) + 1) } else { format!("{}스텝 전부 성공", summary.steps.len()) },
        Some(&detail.join("\n")),
        Some(&format!("?flow={}", sched.flow_id)),
    );
    Ok(RunOutcome { ran: true, failed: Some(failed), error: None })
}

static LAST_PRUNE_AT: AtomicI64 = AtomicI64::new(0);

/// EXECUTION_RETENTION_DAYS 가 있으면 그보다 오래된 실행 이력을 정리한다(시간당 1회). pinned(예시 응답으로 고정)는 제외.
async fn prune_executions(s: &AppState) {
    let now = js::now_ms();
    let Some(cutoff) = retention_cutoff(std::env::var("EXECUTION_RETENTION_DAYS").ok().as_deref(), now) else { return };
    if now - LAST_PRUNE_AT.load(Ordering::Relaxed) < 3_600_000 {
        return;
    }
    LAST_PRUNE_AT.store(now, Ordering::Relaxed);
    // 실패(DB 잠김 등)는 다음 기회에.
    let _ = s
        .db
        .run(move |c| Ok(c.prepare_cached(r#"delete from "executions" where ("executions"."executed_at" < ? and "executions"."pinned" = ?)"#)?.execute(rusqlite::params![cutoff, 0])?))
        .await;
}

static TICKING: AtomicBool = AtomicBool::new(false);

async fn tick(s: &AppState) {
    // 이전 tick 이 아직 안 끝났으면 겹쳐 돌지 않는다(느린 flow 다발 방어).
    if TICKING.swap(true, Ordering::SeqCst) {
        return;
    }
    let now = js::now_ms();
    lock().last_tick_at = Some(now);
    let due = s
        .db
        .run(move |c| {
            let mut st = c.prepare_cached(r#"select "id", "enabled", "last_run_at", "interval_minutes" from "schedules" where "schedules"."enabled" = ?"#)?;
            let rows = st
                .query_map([1], |r| Ok((crate::rows::text(r, 0)?, r.get::<_, Option<i64>>(1)?.unwrap_or(0) != 0, r.get::<_, Option<i64>>(2)?, r.get::<_, Option<i64>>(3)?.unwrap_or(60))))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows.into_iter().filter(|(_, en, last, iv)| is_due(*en, *last, *iv, now)).map(|(id, ..)| id).collect::<Vec<_>>())
        })
        .await;
    if let Ok(due) = due {
        for id in due {
            run_schedule(s, &id).await;
        }
        prune_executions(s).await;
    }
    TICKING.store(false, Ordering::SeqCst);
}

/// 서버 기동 시 1회(멱등). 첫 tick 은 1분 뒤 — Node 의 setInterval 과 같다.
pub fn start(s: AppState) {
    {
        let mut st = lock();
        if st.started {
            return;
        }
        st.started = true;
    }
    tokio::spawn(async move {
        let period = Duration::from_secs(60);
        let mut iv = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
        iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            iv.tick().await;
            tick(&s).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 실행_대상_판정() {
        let now = 1_000_000_000_000;
        assert!(!is_due(false, None, 5, now));
        assert!(is_due(true, None, 5, now));
        assert!(!is_due(true, Some(now - 4 * 60_000), 5, now));
        assert!(is_due(true, Some(now - 5 * 60_000), 5, now));
        assert!(is_due(true, Some(now - 6 * 60_000), 5, now));
    }

    #[test]
    fn 보존_커트라인() {
        let now = 1_000_000_000_000;
        assert_eq!(retention_cutoff(Some("30"), now), Some(now - 30 * 86_400_000));
        assert_eq!(retention_cutoff(Some("7"), now), Some(now - 7 * 86_400_000));
        for bad in [None, Some(""), Some("0"), Some("-1"), Some("abc")] {
            assert_eq!(retention_cutoff(bad, now), None, "{bad:?}");
        }
    }

    fn app_state(db: crate::Db) -> AppState {
        AppState {
            db,
            config: crate::Config { host: "127.0.0.1".into(), port: 0, db_path: ":memory:".into(), migrations_dir: "drizzle".into(), static_dir: None },
        }
    }

    #[tokio::test]
    async fn 같은_db_를_보는_서버가_둘이어도_한_번만() {
        let db = crate::variables::tests::test_db();
        db.with(|c| {
            c.execute_batch(
                r#"INSERT INTO flows (id, workspace_id, name, steps, updated_at) VALUES ('cas-flow', 'default', 'cas', '[]', 1);
                   INSERT INTO schedules (id, workspace_id, flow_id, interval_minutes, enabled, last_run_at, notify_on) VALUES ('cas-sched', 'default', 'cas-flow', 5, 1, 1000, 'failure');
                   UPDATE schedules SET last_run_at = 2000 WHERE id = 'cas-sched';"#,
            )?;
            Ok(())
        })
        .unwrap();
        // 다른 프로세스가 먼저 선점해 lastRunAt 이 바뀐 상태에서 옛 값(1000)으로 들어오면 물러나야 한다 —
        // 여기서는 run_schedule 이 직접 읽으니, 스텝이 없는 시나리오를 돌려 '선점 → 실행 → 상태 기록' 경로를 본다.
        let s = app_state(db.clone());
        let out = run_schedule(&s, "cas-sched").await;
        // 스텝이 없는 시나리오는 400 → 실행 실패로 기록된다.
        assert!(!out.ran);
        assert_eq!(out.error.as_deref(), Some("시나리오 실행 실패 (400)"));
        let status: String = db.with(|c| Ok(c.query_row("SELECT last_status FROM schedules WHERE id='cas-sched'", [], |r| r.get(0))?)).unwrap();
        assert_eq!(status, "error");
        assert_eq!(run_schedule(&s, "nope").await, RunOutcome::not_run("schedule not found"));
        // 선점: 같은 lastRunAt 을 읽은 두 쪽 중 하나만 바꾼다.
        let changes = |last: i64| db.with(move |c| Ok(c.execute("UPDATE schedules SET last_run_at = ?1, last_status='running' WHERE id='cas-sched' AND last_run_at = ?2", [last + 1, last])?)).unwrap();
        let observed: i64 = db.with(|c| Ok(c.query_row("SELECT last_run_at FROM schedules WHERE id='cas-sched'", [], |r| r.get(0))?)).unwrap();
        assert_eq!(changes(observed), 1);
        assert_eq!(changes(observed), 0);
    }

    #[tokio::test]
    async fn 시나리오가_지워졌으면_flow_missing() {
        let db = crate::variables::tests::test_db();
        db.with(|c| {
            c.execute("INSERT INTO schedules (id, workspace_id, flow_id, interval_minutes, enabled, notify_on) VALUES ('s1', 'default', 'gone', 5, 1, 'failure')", [])?;
            Ok(())
        })
        .unwrap();
        let s = app_state(db.clone());
        assert_eq!(run_schedule(&s, "s1").await, RunOutcome::not_run("flow deleted"));
        let status: String = db.with(|c| Ok(c.query_row("SELECT last_status FROM schedules WHERE id='s1'", [], |r| r.get(0))?)).unwrap();
        assert_eq!(status, "flow-missing");
        assert_eq!(RunOutcome { ran: true, failed: Some(false), error: None }.to_json().to_string(), r#"{"ran":true,"failed":false}"#);
    }
}
