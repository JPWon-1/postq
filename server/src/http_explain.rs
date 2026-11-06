//! 오류·상태 코드를 사람 말로 — "fetch failed" 를 그대로 보여주지 않기 위한 층.
//!
//! 공개 API
//! - [`explain_transport_error`] → [`ErrorExplanation`] — executor 오류 문장을 원인+확인사항으로. 모르는 오류는 None.
//! - [`explain_status`] → (label, hint) — 정의 없는 코드는 클래스(2xx/3xx/4xx/5xx) 기본 설명.
//!
//! 실행기 오류 문장([`crate::executor::FetchError::describe`])이 여기 패턴(ECONNREFUSED·ENOTFOUND·…)에 맞게 나오도록
//! 두 파일을 같이 고친다.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{json, Value};

#[derive(Clone, Debug, PartialEq)]
pub struct ErrorExplanation {
    pub title: &'static str,
    pub hints: &'static [&'static str],
}

impl ErrorExplanation {
    pub fn to_json(&self) -> Value {
        json!({ "title": self.title, "hints": self.hints })
    }
}

const TRANSPORT: &[(&str, ErrorExplanation)] = &[
    ("ENOTFOUND|EAI_AGAIN", ErrorExplanation {
        title: "도메인을 찾을 수 없습니다 (DNS 실패)",
        hints: &[
            "URL 의 호스트명에 오타가 없는지 확인하세요",
            "내부 도메인이라면 VPN/내부망에 연결되어 있는지 확인하세요",
            "{{baseUrl}} 값이 지금 선택된 환경에 맞는지 확인하세요",
        ],
    }),
    ("ECONNREFUSED", ErrorExplanation {
        title: "대상 서버가 연결을 거부했습니다",
        hints: &[
            "대상 서버가 떠 있는지 확인하세요",
            "포트 번호가 맞는지 확인하세요",
            "도커에서 실행 중이라면 localhost 대신 host.docker.internal 을 써야 할 수 있습니다",
        ],
    }),
    ("ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|TimeoutError|timeout", ErrorExplanation {
        title: "응답 시간 초과 (30초)",
        hints: &["대상 서버가 느리거나 응답하지 않습니다 — 서버 상태를 확인하세요", "방화벽/네트워크 정책이 이 주소를 막고 있을 수 있습니다"],
    }),
    ("ECONNRESET|socket hang up", ErrorExplanation {
        title: "연결이 중간에 끊겼습니다",
        hints: &["대상 서버가 요청 처리 중 종료됐을 수 있습니다 — 서버 로그를 확인하세요", "재시도해 보세요"],
    }),
    ("certificate|CERT_|SSL|TLS", ErrorExplanation {
        title: "인증서(SSL) 검증에 실패했습니다",
        hints: &["https 주소의 인증서가 만료/자체서명일 수 있습니다", "자체 인증서라면 http 스테이징 주소를 쓰거나 신뢰 루트에 인증서를 추가하세요"],
    }),
    ("BlockedHost", ErrorExplanation { title: "차단된 주소입니다", hints: &["클라우드 메타데이터 주소(169.254.x.x)로는 요청할 수 없습니다"] }),
    ("bad port", ErrorExplanation {
        title: "브라우저/런타임이 차단하는 포트입니다",
        hints: &["1, 7, 9 같은 예약 포트는 fetch 표준이 차단합니다 — 대상 서비스의 실제 포트를 확인하세요"],
    }),
    ("Invalid URL", ErrorExplanation {
        title: "URL 형식이 잘못됐습니다",
        hints: &["http:// 또는 https:// 로 시작하는지 확인하세요", "{{변수}}가 남아 있다면 환경을 선택했는지, 변수가 등록돼 있는지 확인하세요 (위 변수 칩 참고)"],
    }),
];

/// JS 의 /…/i — 패턴이 전부 ASCII 라 양쪽을 ASCII 소문자로 맞춰 보면 같다(regex 의 유니코드 대소문자 표는 켜지 않았다).
fn patterns() -> &'static [Regex] {
    static RE: LazyLock<Vec<Regex>> = LazyLock::new(|| TRANSPORT.iter().map(|(p, _)| Regex::new(&p.to_ascii_lowercase()).expect("설명 패턴")).collect());
    &RE
}

pub fn explain_transport_error(error: &str) -> Option<&'static ErrorExplanation> {
    let lower = error.to_ascii_lowercase();
    patterns().iter().zip(TRANSPORT).find(|(re, _)| re.is_match(&lower)).map(|(_, (_, ex))| ex)
}

fn known(status: u16) -> Option<(&'static str, Option<&'static str>)> {
    Some(match status {
        200 => ("OK — 성공", None),
        201 => ("Created — 생성됨", None),
        202 => ("Accepted — 접수됨(비동기 처리 중)", None),
        204 => ("No Content — 성공(응답 본문 없음)", None),
        301 => ("Moved Permanently — 영구 이동", Some("Location 응답 헤더의 새 주소를 확인하세요")),
        302 => ("Found — 임시 이동", Some("Location 응답 헤더의 새 주소를 확인하세요")),
        304 => ("Not Modified — 변경 없음(캐시)", None),
        400 => ("Bad Request — 잘못된 요청", Some("바디 형식과 필수 파라미터를 확인하세요 (응답 바디에 상세 사유가 있는 경우가 많습니다)")),
        401 => ("Unauthorized — 인증 실패", Some("Authorization 헤더와 토큰 값을 확인하세요 (만료됐다면 재발급)")),
        403 => ("Forbidden — 권한 없음", Some("계정 권한 또는 IP 허용 목록을 확인하세요")),
        404 => ("Not Found — 없는 경로/리소스", Some("URL 경로와 경로 안의 ID 값을 확인하세요")),
        405 => ("Method Not Allowed — 허용되지 않는 메서드", Some("GET/POST 등 메서드가 스펙과 맞는지 확인하세요")),
        409 => ("Conflict — 충돌", Some("중복 생성이거나 리소스 상태가 요청과 충돌합니다")),
        415 => ("Unsupported Media Type — 지원하지 않는 형식", Some("Content-Type 헤더(예: application/json)를 확인하세요")),
        422 => ("Unprocessable Entity — 검증 실패", Some("필드 값 규칙(형식/범위)을 응답 바디에서 확인하세요")),
        429 => ("Too Many Requests — 요청 과다", Some("잠시 후 재시도하세요 (Retry-After 헤더 참고)")),
        500 => ("Internal Server Error — 서버 내부 오류", Some("응답 바디와 대상 서버 로그를 확인하세요")),
        502 => ("Bad Gateway — 게이트웨이 오류", Some("업스트림 서버가 죽었거나 배포 중일 수 있습니다")),
        503 => ("Service Unavailable — 서비스 불가", Some("대상 서비스가 점검/배포 중일 수 있습니다")),
        504 => ("Gateway Timeout — 게이트웨이 시간 초과", Some("업스트림 서버가 제때 응답하지 못했습니다")),
        _ => return None,
    })
}

/// 상태 코드 설명 — (label, hint).
pub fn explain_status(status: u16) -> (String, Option<&'static str>) {
    if let Some((l, h)) = known(status) {
        return (l.into(), h);
    }
    match status {
        200..=299 => ("성공".into(), None),
        300..=399 => ("리다이렉트".into(), None),
        400..=499 => ("클라이언트 오류".into(), Some("요청 값(경로/헤더/바디)을 확인하세요")),
        500.. => ("서버 오류".into(), Some("대상 서버 측 문제입니다 — 응답 바디/서버 로그를 확인하세요")),
        _ => (format!("HTTP {status}"), None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 전송_오류_번역() {
        assert!(explain_transport_error("ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:9999").unwrap().title.contains("연결을 거부"));
        assert!(explain_transport_error("ENOTFOUND: getaddrinfo ENOTFOUND api.nope.com").unwrap().title.contains("DNS"));
        assert!(explain_transport_error("TimeoutError: The operation was aborted due to timeout").unwrap().title.contains("시간 초과"));
        assert!(explain_transport_error("TypeError: Invalid URL").unwrap().hints.join(" ").contains("{{변수}}"));
        assert!(explain_transport_error("BlockedHost: 메타데이터 주소").unwrap().title.contains("차단"));
        assert!(explain_transport_error("TypeError: fetch failed (bad port)").unwrap().title.contains("포트"));
        assert_eq!(explain_transport_error("SomethingWeird: ???"), None);
    }

    #[test]
    fn 상태_설명() {
        assert!(explain_status(401).0.contains("인증 실패"));
        assert!(explain_status(401).1.unwrap().contains("Authorization"));
        assert!(explain_status(404).1.unwrap().contains("경로"));
        assert!(explain_status(200).0.contains("성공"));
        assert!(explain_status(418).0.contains("클라이언트 오류"));
        assert!(explain_status(599).0.contains("서버 오류"));
        assert_eq!(explain_status(100).0, "HTTP 100");
    }
}
