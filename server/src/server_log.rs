//! 서버 로그 링 버퍼.
//!
//! 앱 안에서 서버 쪽 오류를 보려고 마지막 N건을 메모리에 들고 있다가 /api/logs 로 내려준다.
//! 재시작하면 비지만, 그건 컨테이너·데스크톱 로그 파일이 이미 보존한다.

use std::collections::VecDeque;
use std::sync::Mutex;

use serde::Serialize;

use crate::js;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Error,
    Warn,
    Info,
}

impl Level {
    pub fn parse(s: &str) -> Option<Level> {
        match s {
            "error" => Some(Level::Error),
            "warn" => Some(Level::Warn),
            "info" => Some(Level::Info),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Entry {
    pub id: u64,
    pub at: i64,
    pub level: Level,
    /// 어디서 났는지 — 라우트 경로나 작업 이름
    pub scope: String,
    pub message: String,
    /// 스택 등 추가 정보. 준 것만 실린다(없으면 JSON 에서 빠진다 — Node 의 undefined 와 같게).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// 이 로그가 가리키는 화면(예: '?flow=<id>')
    #[serde(skip_serializing_if = "Option::is_none")]
    pub href: Option<String>,
}

/// 상한 — 무한히 쌓이면 장기 구동 시 메모리를 먹는다. 한 건의 길이도 묶는다(거대한 스택 한 건이 버퍼를 키우지 않게).
pub const MAX: usize = 300;
const SCOPE_MAX: usize = 256;
const MESSAGE_MAX: usize = 4096;
const DETAIL_MAX: usize = 16384;
const HREF_MAX: usize = 2048;

struct Ring {
    buf: VecDeque<Entry>,
    seq: u64,
}

static RING: Mutex<Ring> = Mutex::new(Ring { buf: VecDeque::new(), seq: 0 });

fn ring() -> std::sync::MutexGuard<'static, Ring> {
    // 로그를 남기다 패닉한 스레드가 있어도 버퍼는 계속 쓴다 — 로그 때문에 서버가 멈추면 안 된다.
    RING.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn log(level: Level, scope: &str, message: &str, detail: Option<&str>, href: Option<&str>) {
    // 자르기는 잠금 전에 한다.
    let (scope, message) = (js::slice16(scope, SCOPE_MAX), js::slice16(message, MESSAGE_MAX));
    let (detail, href) = (detail.map(|d| js::slice16(d, DETAIL_MAX)), href.map(|h| js::slice16(h, HREF_MAX)));
    // 번호 매기기와 버퍼 넣기는 한 잠금 안에서 해서 버퍼 순서와 번호 순서가 어긋나지 않게 한다.
    // 출력은 잠금을 놓은 뒤에 한다. 예전엔 잠근 채 println 을 해서, 로그를 받는 파이프가 막히면
    // /api/logs 를 부르는 요청까지 런타임 스레드에서 함께 멈췄다(codex 리뷰).
    let e = {
        let mut r = ring();
        r.seq += 1;
        let e = Entry { id: r.seq, at: js::now_ms(), level, scope, message, detail, href };
        // 테스트에서는 버퍼를 들여다보는 server_log 테스트 스레드의 로그만 담는다 — 다른 테스트(스케줄·secret 등)가
        // 병렬로 남기는 로그가 끼어들어 순서·개수 검사가 가끔 깨졌다.
        #[cfg(test)]
        let keep = CAPTURE.with(|c| c.get());
        #[cfg(not(test))]
        let keep = true;
        if keep {
            r.buf.push_back(e.clone());
        }
        while r.buf.len() > MAX {
            r.buf.pop_front();
        }
        e
    };
    // 데스크톱은 stdout/stderr 를 파일로 받고, 컨테이너도 같은 줄을 모은다 — Node 와 같은 한 줄 JSON.
    let mut line = serde_json::Map::new();
    line.insert("event".into(), "server_log".into());
    if let Ok(serde_json::Value::Object(m)) = serde_json::to_value(&e) {
        line.extend(m);
    }
    let line = serde_json::Value::Object(line).to_string();
    match level {
        Level::Info => println!("{line}"),
        _ => eprintln!("{line}"),
    }
}

/// 최근순으로 최대 limit 건. level 로 좁힐 수 있다 — 좁힌 뒤에 limit 이 걸린다.
pub fn read(limit: usize, level: Option<Level>) -> Vec<Entry> {
    let r = ring();
    r.buf.iter().rev().filter(|e| level.map_or(true, |l| e.level == l)).take(limit).cloned().collect()
}

pub fn clear() {
    ring().buf.clear();
}

#[cfg(test)]
pub(crate) static TEST_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
thread_local! {
    static CAPTURE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
mod tests {
    use super::*;

    // 버퍼가 전역이라 테스트끼리 잠가서 차례로 돈다.
    fn fresh() -> std::sync::MutexGuard<'static, ()> {
        let g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        CAPTURE.with(|c| c.set(true));
        clear();
        g
    }
    fn messages(v: &[Entry]) -> Vec<&str> {
        v.iter().map(|e| e.message.as_str()).collect()
    }

    #[test]
    fn 최근_것이_먼저_나온다() {
        let _g = fresh();
        log(Level::Info, "a", "첫째", None, None);
        log(Level::Info, "b", "둘째", None, None);
        assert_eq!(messages(&read(200, None)), ["둘째", "첫째"]);
    }

    #[test]
    fn level_로_좁힌_뒤에_limit_이_걸린다() {
        let _g = fresh();
        log(Level::Error, "boom", "터졌다", None, None);
        for i in 0..50 {
            log(Level::Info, "noise", &format!("잡음 {i}"), None, None);
        }
        assert_eq!(messages(&read(5, Some(Level::Error))), ["터졌다"]);
        assert_eq!(read(5, None).len(), 5);
    }

    #[test]
    fn 상한을_넘으면_오래된_쪽이_빠진다() {
        let _g = fresh();
        for i in 0..400 {
            log(Level::Info, "s", &format!("m{i}"), None, None);
        }
        let all = read(1000, None);
        assert_eq!(all.len(), 300);
        assert_eq!(all[0].message, "m399");
        assert_eq!(all[all.len() - 1].message, "m100");
    }

    #[test]
    fn id_는_계속_증가한다() {
        let _g = fresh();
        log(Level::Info, "s", "1", None, None);
        log(Level::Info, "s", "2", None, None);
        let v = read(200, None);
        assert!(v[0].id > v[1].id);
    }

    #[test]
    fn detail_href_는_준_것만_실린다() {
        let _g = fresh();
        log(Level::Error, "s", "m", Some("스택"), Some("?flow=1"));
        let j = serde_json::to_value(&read(200, None)[0]).unwrap();
        assert_eq!(j["detail"], "스택");
        assert_eq!(j["href"], "?flow=1");
        log(Level::Error, "s", "m2", None, None);
        let j = serde_json::to_value(&read(200, None)[0]).unwrap();
        assert!(j.get("detail").is_none());
    }

    #[test]
    fn 비우면_비워진다() {
        let _g = fresh();
        log(Level::Info, "s", "m", None, None);
        clear();
        assert!(read(200, None).is_empty());
    }

    #[test]
    fn 한_건의_길이도_묶는다() {
        let _g = fresh();
        log(Level::Error, "test", &"x".repeat(100000), Some(&"y".repeat(100000)), None);
        let row = &read(200, None)[0];
        assert_eq!(row.message.len(), 4096);
        assert_eq!(row.detail.as_ref().unwrap().len(), 16384);
    }
}
