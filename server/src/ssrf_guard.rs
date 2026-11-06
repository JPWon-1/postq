//! SSRF 가드.
//!
//! 기본(셀프호스트) 모드: 클라우드 메타데이터(IMDS)만 차단. localhost/사설망은 정당한 대상이라 허용.
//! 하드닝(공개 egress) 모드: BLOCK_PRIVATE_NETWORKS=1 / EGRESS_MODE=public 이면 사설망·loopback·링크로컬·
//! CGNAT·IPv6 ULA 까지 차단. 한계: 호스트명이 사설 IP 로 '해석'되는 DNS 리바인딩은 이 문자열 계층에서 못 막는다.

const META_HOSTS: &[&str] = &["metadata.google.internal", "metadata.goog"];

fn is_digits(s: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())
}

/// `^\d{1,3}(\.\d{1,3}){3}$`
fn is_dotted_quad(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    parts.len() == 4 && parts.iter().all(|p| is_digits(p, 1, 3))
}

/// dotted-quad 가 사설/예약 대역이면 종류, 아니면 None. (마지막 마디는 보지 않는다 — TS 와 같다)
fn ipv4_reserved(ip: &str) -> Option<&'static str> {
    if !is_dotted_quad(ip) {
        return None;
    }
    let mut it = ip.split('.').map(|p| p.parse::<u32>().unwrap_or(0));
    let (a, b) = (it.next()?, it.next()?);
    match (a, b) {
        (127, _) => Some("loopback"),
        (10, _) => Some("private"),
        (172, 16..=31) => Some("private"),
        (192, 168) => Some("private"),
        (169, 254) => Some("linklocal"),
        (100, 64..=127) => Some("cgnat"),
        (0, _) => Some("reserved"),
        _ => None,
    }
}

fn quad(n: u32) -> String {
    format!("{}.{}.{}.{}", (n >> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255)
}

/// 숫자형 호스트(십진/16진/dotted)를 dotted-quad 로 정규화. 아니면 None.
fn to_ipv4(host: &str) -> Option<String> {
    if is_dotted_quad(host) {
        return Some(host.to_string());
    }
    let n: u128 = if !host.is_empty() && host.bytes().all(|b| b.is_ascii_digit()) {
        // 자릿수가 아주 많으면 범위 밖이다(Number 로는 거대한 수 → 범위 검사에서 걸러진다).
        host.parse().unwrap_or(u128::MAX)
    } else if host.len() > 2 && host.as_bytes()[..2].eq_ignore_ascii_case(b"0x") && host[2..].bytes().all(|b| b.is_ascii_hexdigit()) {
        u128::from_str_radix(&host[2..], 16).unwrap_or(u128::MAX)
    } else {
        return None;
    };
    (n <= 0xffff_ffff).then(|| quad(n as u32))
}

/// IPv4-mapped IPv6(::ffff:a.b.c.d 또는 URL 파서가 만드는 ::ffff:aabb:ccdd 16진)를 dotted IPv4 로 환원.
fn unmap_v4(h: &str) -> String {
    let Some(tail) = h.get(..7).filter(|p| p.eq_ignore_ascii_case("::ffff:")).map(|_| &h[7..]) else {
        return h.to_string();
    };
    if tail.is_empty() || !tail.bytes().all(|b| b.is_ascii_hexdigit() || b == b'.' || b == b':') {
        return h.to_string();
    }
    if is_dotted_quad(tail) {
        return tail.to_string();
    }
    if let Some((hi, lo)) = tail.split_once(':') {
        let ok = |p: &str| (1..=4).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_hexdigit());
        if ok(hi) && ok(lo) {
            let (hi, lo) = (u32::from_str_radix(hi, 16).unwrap(), u32::from_str_radix(lo, 16).unwrap());
            return quad((hi << 16) | lo);
        }
    }
    h.to_string()
}

/// 차단 대상이면 true. block_private=false(기본): 메타데이터/IMDS 만. true: 사설망까지 전면 차단.
pub fn is_blocked_host(hostname: &str, block_private: bool) -> bool {
    // 소문자·대괄호·후행점 정규화 — `replace(/^\[|\]$/g, '')` 는 앞의 [ 와 뒤의 ] 를 따로 지운다.
    let lower = hostname.to_lowercase();
    let s = lower.strip_prefix('[').unwrap_or(&lower);
    let s = s.strip_suffix(']').unwrap_or(s);
    let raw = s.trim_end_matches('.');
    let h = unmap_v4(raw);
    if META_HOSTS.contains(&h.as_str()) || h == "fd00:ec2::254" {
        return true;
    }
    let ip = to_ipv4(&h).unwrap_or_else(|| h.clone());
    if ip.starts_with("169.254.") || ip == "100.100.100.200" || h.starts_with("fe80:") {
        return true;
    }
    if block_private {
        if raw == "localhost" || raw.ends_with(".localhost") || ipv4_reserved(&ip).is_some() {
            return true;
        }
        // IPv6 loopback(::1)·미지정(::)·ULA(fc00::/7). `h.startsWith('fd')` 는 'fdic.gov' 같은 이름도 막는다 —
        // TS 의 동작 그대로 둔다(옮기는 중에 차단 범위가 달라지면 안 된다).
        if h == "::1" || h == "::" || ula_prefix(&h) || h == "fc00" || h.starts_with("fd") {
            return true;
        }
    }
    false
}

/// `/^f[cd][0-9a-f]{0,2}:/`
fn ula_prefix(h: &str) -> bool {
    let b = h.as_bytes();
    if b.len() < 3 || b[0] != b'f' || !(b[1] == b'c' || b[1] == b'd') {
        return false;
    }
    let rest = &b[2..];
    let hex = rest.iter().take(2).take_while(|c| c.is_ascii_hexdigit()).count();
    // {0,2} 는 되돌아가며 맞춘다 — 16진 n 자 뒤에 ':' 가 오는 n(0..=hex) 이 하나라도 있으면 된다.
    (0..=hex).any(|n| rest.get(n) == Some(&b':'))
}

/// 환경 변수로 공개 egress 하드닝 모드 여부 판단.
pub fn block_private_networks() -> bool {
    std::env::var("BLOCK_PRIVATE_NETWORKS").as_deref() == Ok("1") || std::env::var("EGRESS_MODE").as_deref() == Ok("public")
}

/// http/https 만 허용한다. 반환값은 거절 사유(통과면 None) — 호출부가 그대로 사용자에게 보여준다.
pub fn scheme_problem(protocol: &str) -> Option<String> {
    let p = protocol.to_lowercase();
    if p == "http:" || p == "https:" {
        return None;
    }
    Some(format!("{p}// 는 보낼 수 없습니다 — http:// 또는 https:// 만 지원합니다"))
}

#[cfg(test)]
mod tests {
    /// 사용자가 준 주소로 밖에 나가는 곳은 실행 경로만이 아니다 — SSE 스트림, 슬랙 webhook, OAuth 토큰 요청
    /// (clientSecret 을 싣는다), 스펙 가져오기가 각자 요청을 보낸다. 새 경로를 만들면서
    /// 가드를 빠뜨리지 않게, 각 소스가 두 가드(스킴·호스트 — 막는 것이 다르다)를 모두 부르는지 본다.
    /// (옛 Node 쪽 ssrfScheme.test.ts 의 같은 검사를 옮겨 왔다.)
    #[test]
    fn 밖으로_나가는_곳마다_스킴과_호스트_가드가_걸려_있다() {
        let sources = [
            ("routes/sse.rs", include_str!("routes/sse.rs")),
            ("slack.rs", include_str!("slack.rs")),
            ("request_auth.rs", include_str!("request_auth.rs")),
            ("spec_fetch.rs", include_str!("spec_fetch.rs")),
            ("executor.rs", include_str!("executor.rs")),
        ];
        for (name, src) in sources {
            assert!(src.contains("scheme_problem"), "{name} 에 스킴 가드가 없다");
            assert!(src.contains("is_blocked_host"), "{name} 에 호스트 가드가 없다");
        }
        // 자동 추종 클라이언트는 리다이렉트 목적지를 가드 없이 따라간다 — 사용자가 준 주소에는 쓰지 않는다.
        // (스펙 가져오기가 이걸 써서 302 → 127.0.0.1·메타데이터를 받아 왔다 — codex 리뷰.)
        // 이 검사 문장 자체가 걸리지 않게 이름을 둘로 나눠 찾는다.
        let auto_follow = ["outbound::", "follow()"].concat();
        for (name, src) in sources {
            assert!(!src.contains(&auto_follow), "{name} 이 리다이렉트 자동 추종 클라이언트를 쓴다");
        }
    }

    use super::*;

    #[test]
    fn 한글_호스트에서_패닉하지_않는다() {
        // 예전엔 host[..2] 가 바이트로 잘라 'not a char boundary' 로 패닉했다(codex 리뷰).
        assert!(!is_blocked_host("한글.example", false));
        assert!(!is_blocked_host("é", false));
    }

    fn b(h: &str) -> bool {
        is_blocked_host(h, false)
    }
    fn hard(h: &str) -> bool {
        is_blocked_host(h, true)
    }

    #[test]
    fn 메타데이터_차단() {
        assert!(b("169.254.169.254"));
        assert!(b("169.254.0.1"));
        assert!(b("metadata.google.internal"));
        assert!(b("metadata.goog"));
        assert!(b("2852039166"));
        assert!(b("0xA9FEA9FE"));
        assert!(b("[fd00:ec2::254]"));
        assert!(b("fe80::1"));
        assert!(b("::ffff:169.254.169.254"));
        assert!(b("100.100.100.200"));
        assert!(b("::ffff:a9fe:a9fe"));
        // new URL('http://[::ffff:169.254.169.254]/').hostname 이 만드는 모양
        assert!(b("[::ffff:a9fe:a9fe]"));
        assert!(b("metadata.google.internal."));
        assert!(b("169.254.169.254."));
    }

    #[test]
    fn 기본_모드는_사내_대상을_허용한다() {
        for h in ["localhost", "127.0.0.1", "10.0.0.5", "192.168.1.10", "host.docker.internal", "api.internal.company.com"] {
            assert!(!b(h), "{h}");
        }
    }

    #[test]
    fn 하드닝_모드는_사설망을_막는다() {
        for h in ["localhost", "127.0.0.1", "10.0.0.5", "172.16.5.5", "192.168.1.10", "100.64.0.1", "0.0.0.0", "::1", "[fd12:3456::1]"] {
            assert!(hard(h), "{h}");
        }
        assert!(!hard("172.32.0.1"));
        for h in ["api.stripe.com", "8.8.8.8", "52.1.2.3"] {
            assert!(!hard(h), "{h}");
        }
        assert!(is_blocked_host("169.254.169.254", false));
        assert!(is_blocked_host("169.254.169.254", true));
        // TS 와 같은 과잉 차단(보고서에 적은 것) — 바꾸면 이 줄이 알려 준다.
        assert!(hard("fdic.gov"));
        assert!(hard("fc1:"));
        assert!(hard("fcab:1"));
        assert!(!hard("fcabc:1"));
    }

    #[test]
    fn 스킴_가드() {
        assert_eq!(scheme_problem("http:"), None);
        assert_eq!(scheme_problem("https:"), None);
        assert_eq!(scheme_problem("HTTPS:"), None);
        for p in ["file:", "ftp:", "gopher:", "data:", "ws:", "javascript:"] {
            let msg = scheme_problem(p).unwrap_or_default();
            assert!(msg.contains(&p[..p.len() - 1]), "{p}");
        }
        assert!(scheme_problem("file:").unwrap().contains("https://"));
    }
}
