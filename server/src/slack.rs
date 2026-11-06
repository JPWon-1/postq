//! 시나리오 실행 결과 알림 — Slack/Discord/Teams/범용 webhook.
//!
//! 공개 API
//! - [`detect_channel`] / [`notify_payload`] — 채널마다 페이로드 모양이 달라서 호스트로 추정한다.
//! - [`ScenarioRunSummary`] / [`build_slack_message`].
//! - [`send_notification`] — 던지지 않고 `Err(이유)` 로 알린다. 반환값을 안 보면 실패가 아무 데도 안 남는다.
//!
//! webhook URL 은 사용자가 등록한 값 — 다른 egress 와 같은 SSRF 가드(스킴·메타데이터/사설망)를 걸고,
//! 리다이렉트는 따라가지 않는다(내부 주소로 다시 쏘게 만드는 우회를 막는다).

use std::time::Duration;

use serde_json::json;
use url::Url;

use crate::executor::{fetch, SendBody};
use crate::js;
use crate::ssrf_guard::{block_private_networks, is_blocked_host, scheme_problem};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotifyChannel {
    Slack,
    Discord,
    Teams,
    Generic,
}

impl NotifyChannel {
    pub fn as_str(self) -> &'static str {
        match self {
            NotifyChannel::Slack => "slack",
            NotifyChannel::Discord => "discord",
            NotifyChannel::Teams => "teams",
            NotifyChannel::Generic => "generic",
        }
    }
}

/// URL 의 hostname — `new URL(raw).hostname` 처럼 IPv6 는 대괄호째(executor 와 같은 값으로 SSRF 가드를 본다).
fn hostname(u: &Url) -> String {
    u.host_str().unwrap_or("").to_string()
}

pub fn detect_channel(url: &str) -> NotifyChannel {
    let Ok(u) = Url::parse(url) else { return NotifyChannel::Generic };
    let h = hostname(&u).to_lowercase();
    if h.contains("discord.com") || h.contains("discordapp.com") {
        NotifyChannel::Discord
    } else if h.contains("office.com") || h.contains("office365.com") {
        NotifyChannel::Teams
    } else if h.contains("slack.com") {
        NotifyChannel::Slack
    } else {
        NotifyChannel::Generic
    }
}

/// Discord 는 {content}, 그 외(slack/teams/generic)는 {text}.
pub fn notify_payload(channel: NotifyChannel, text: &str) -> String {
    if channel == NotifyChannel::Discord {
        js::stringify(&json!({ "content": text }))
    } else {
        js::stringify(&json!({ "text": text }))
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct SummaryStep {
    pub step: usize,
    pub name: Option<String>,
    pub status: Option<u16>,
    pub failed: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ScenarioRunSummary {
    pub flow_name: String,
    pub stopped_at: Option<usize>,
    pub steps: Vec<SummaryStep>,
}

pub fn build_slack_message(run: &ScenarioRunSummary, workspace_name: &str) -> String {
    let head = match run.stopped_at {
        Some(at) => format!("🔴 *[{workspace_name}] 시나리오 실패: {}* — {}단계에서 중단", run.flow_name, at + 1),
        None => format!("✅ *[{workspace_name}] 시나리오 성공: {}* — {}단계 완료", run.flow_name, run.steps.len()),
    };
    let mut lines = vec![head];
    for s in &run.steps {
        let mark = if s.failed { '✗' } else { '✓' };
        let status = s.status.map_or("ERR".to_string(), |v| v.to_string());
        lines.push(format!("{mark} {}. {} ({status})", s.step, s.name.as_deref().unwrap_or("")));
    }
    lines.join("\n")
}

pub async fn send_notification(webhook_url: &str, text: &str) -> Result<(), String> {
    let Ok(parsed) = Url::parse(webhook_url) else { return Err("알림 webhook URL 이 올바르지 않습니다".into()) };
    if let Some(bad) = scheme_problem(&format!("{}:", parsed.scheme())) {
        return Err(format!("알림 webhook — {bad}"));
    }
    if is_blocked_host(&hostname(&parsed), block_private_networks()) {
        return Err("알림 webhook URL 이 차단된 주소입니다(메타데이터/사설망)".into());
    }
    let channel = detect_channel(webhook_url);
    let headers = vec![("Content-Type".to_string(), "application/json".to_string())];
    let body = SendBody::Text(notify_payload(channel, text));
    // executor::fetch 는 한 홉만 보낸다(리다이렉트 미추종) — redirect:'manual' 과 같다.
    let sent = tokio::time::timeout(Duration::from_secs(10), fetch(&parsed, "POST", &headers, Some(&body))).await;
    let res = match sent {
        Err(_) => return Err(crate::executor::FetchError::timeout_message().into()),
        Ok(Err(e)) => return Err(e.message),
        Ok(Ok(r)) => r,
    };
    let status = res.status().as_u16();
    if (300..400).contains(&status) {
        return Err("알림 webhook URL 이 리다이렉트되었습니다(보안상 차단)".into());
    }
    if res.status().is_success() {
        Ok(())
    } else {
        Err(format!("알림 {} {status}", channel.as_str()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // slack.test.ts · scheduler.test.ts 의 알림 부분을 옮긴 것.
    #[tokio::test]
    async fn ssrf_가드와_잘못된_url() {
        let e = send_notification("http://169.254.169.254/hook", "hi").await.unwrap_err();
        assert!(e.contains("차단"));
        let e = send_notification("not a url", "hi").await.unwrap_err();
        assert!(e.contains("올바르지 않습니다"));
    }

    #[test]
    fn 채널_추정과_페이로드() {
        assert_eq!(detect_channel("https://hooks.slack.com/services/x"), NotifyChannel::Slack);
        assert_eq!(detect_channel("https://discord.com/api/webhooks/x"), NotifyChannel::Discord);
        assert_eq!(detect_channel("https://team.webhook.office.com/x"), NotifyChannel::Teams);
        assert_eq!(detect_channel("https://my.internal/hook"), NotifyChannel::Generic);
        assert_eq!(notify_payload(NotifyChannel::Discord, "hi"), r#"{"content":"hi"}"#);
        assert_eq!(notify_payload(NotifyChannel::Slack, "hi"), r#"{"text":"hi"}"#);
        assert_eq!(notify_payload(NotifyChannel::Teams, "hi"), r#"{"text":"hi"}"#);
    }

    #[test]
    fn 메시지() {
        let step = |step, name: &str, status, failed| SummaryStep { step, name: Some(name.into()), status: Some(status), failed };
        let ok = build_slack_message(
            &ScenarioRunSummary { flow_name: "스모크".into(), stopped_at: None, steps: vec![step(1, "로그인", 200, false), step(2, "조회", 200, false)] },
            "팀A",
        );
        assert!(ok.contains("✅"));
        assert!(ok.contains("[팀A] 시나리오 성공: 스모크"));
        assert!(ok.contains("✓ 1. 로그인 (200)"));
        let bad = build_slack_message(
            &ScenarioRunSummary { flow_name: "스모크".into(), stopped_at: Some(1), steps: vec![step(1, "로그인", 200, false), step(2, "조회", 500, true)] },
            "팀A",
        );
        assert!(bad.contains("🔴"));
        assert!(bad.contains("2단계에서 중단"));
        assert!(bad.contains("✗ 2. 조회 (500)"));
    }
}
