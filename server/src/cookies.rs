//! 쿠키 jar 로직.
//!
//! 서버 프록시 실행이라 쿠키를 서버가 보관한다(로그인 세션 유지용). 실행 시 대상 도메인 매칭 쿠키를
//! Cookie 헤더로 주입하고, 응답 Set-Cookie 를 파싱해 저장한다.
//!
//! 붙여넣기용 [`parse_cookie_string`] 은 쿠키 라우트가, Set-Cookie 파싱·헤더 조립은 실행 경로
//! ([`crate::exec_helpers::inject_jar_cookies`]·[`crate::exec_helpers::save_set_cookies`])가 쓴다.

use std::collections::HashMap;

use crate::js;

#[derive(Clone, Debug, PartialEq)]
pub struct ParsedCookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    /// epoch ms, None = 세션
    pub expires: Option<f64>,
}

/// jar 에 든 쿠키 — 헤더 조립에 필요한 것만.
#[derive(Clone, Debug)]
pub struct JarCookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub expires: Option<f64>,
}

/// Set-Cookie 한 줄을 파싱. 요청 도메인을 기본 도메인으로(Domain 속성 없으면 host-only).
pub fn parse_set_cookie(line: &str, request_host: &str) -> Option<ParsedCookie> {
    let mut parts = line.split(';');
    let nv = parts.next().unwrap_or("");
    let eq = nv.find('=')?;
    let name = js::trim(&nv[..eq]).to_string();
    let value = js::trim(&nv[eq + 1..]).to_string();
    if name.is_empty() {
        return None;
    }
    let mut domain = request_host.to_string();
    let mut path = "/".to_string();
    let mut expires: Option<f64> = None;
    for a in parts {
        // `const [k, ...vp] = a.split('=')` — 값 안의 '=' 는 다시 붙인다.
        let (k, v) = match a.find('=') {
            Some(i) => (&a[..i], js::trim(&a[i + 1..])),
            None => (a, ""),
        };
        let key = js::trim(k).to_lowercase();
        // Domain 속성은 요청 호스트가 그 도메인에 속할 때만 채택(RFC6265 domain-match).
        // 무검증 채택 시 응답이 임의 Domain 을 지정해 같은 스코프의 다른 호스트 요청에 쿠키를
        // 주입할 수 있어(크로스호스트 주입) 차단 — 매칭 안 되면 host-only(요청 호스트) 유지.
        if key == "domain" && !v.is_empty() {
            let d = v.strip_prefix('.').unwrap_or(v).to_lowercase();
            if cookie_matches_host(&d, request_host) {
                domain = d;
            }
        } else if key == "path" && !v.is_empty() {
            path = v.to_string();
        } else if key == "max-age" && !v.is_empty() {
            // v 가 비어 있으면(`Max-Age=`) Number('') 는 0 이라 '지금 만료' 로 읽혔다 —
            // 값이 없는 건 지시가 없는 것이지 삭제 지시가 아니다.
            let s = js::number(v);
            if s.is_finite() {
                expires = Some(js::now_ms() as f64 + s * 1000.0);
            }
        } else if key == "expires" && !v.is_empty() && expires.is_none() {
            if let Some(t) = parse_http_date(v) {
                expires = Some(t);
            }
        }
    }
    // 삭제 지시(만료 과거/Max-Age<=0)도 그대로 반환 — jar 에서 삭제 처리
    Some(ParsedCookie { name, value, domain, path, expires })
}

/// Expires 날짜 — Node 의 Date.parse 대신. 쿠키에 실제로 오는 모양만 읽는다:
/// `Wdy, DD Mon YYYY HH:MM:SS GMT`, `Wdy, DD-Mon-YY(YY) HH:MM:SS GMT`, asctime(`Wdy Mon DD HH:MM:SS YYYY`).
/// Date.parse 가 받아 주는 그 밖의 자유 형식은 못 읽는다(그 경우 세션 쿠키로 남는다).
fn parse_http_date(s: &str) -> Option<f64> {
    const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    let toks: Vec<&str> = s.split(|c: char| c == ' ' || c == ',' || c == '-').filter(|t| !t.is_empty()).collect();
    let (mut day, mut mon, mut year, mut hms) = (None, None, None, None);
    for t in toks {
        let lower = t.to_ascii_lowercase();
        if t.contains(':') {
            let p: Vec<i64> = t.split(':').map(|x| x.parse().ok()).collect::<Option<_>>()?;
            if p.len() < 2 || p.len() > 3 {
                return None;
            }
            hms = Some((p[0], p[1], *p.get(2).unwrap_or(&0)));
        } else if let Some(m) = MONTHS.iter().position(|m| lower.starts_with(m)) {
            mon = Some(m as i64);
        } else if let Ok(n) = t.parse::<i64>() {
            if day.is_none() && t.len() <= 2 && year.is_none() {
                day = Some(n);
            } else if year.is_none() {
                year = Some(if t.len() <= 2 { if n < 50 { 2000 + n } else { 1900 + n } } else { n });
            } else {
                return None;
            }
        }
        // 요일·GMT 같은 나머지 글자는 건너뛴다.
    }
    let (d, m, y) = (day?, mon?, year?);
    let (hh, mm, ss) = hms.unwrap_or((0, 0, 0));
    if !(1..=31).contains(&d) || hh > 24 || mm > 59 || ss > 59 {
        return None;
    }
    let days = days_from_civil(y, m + 1, d);
    Some(((days * 86_400 + hh * 3600 + mm * 60 + ss) * 1000) as f64)
}

/// 1970-01-01 기준 일 수 (proleptic Gregorian).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// 쿠키 Domain 으로 하위 전체를 잡을 수 없는 이름들 — 공용 접미사.
///
/// 전체 Public Suffix List 가 아니다. 여기서 막으려는 건 딱 하나, 응답이 `Domain=com` 같은 걸 지정해
/// 그 뒤의 모든 .com 요청에 쿠키를 실어 보내는 것이다. 라벨이 하나뿐인 이름은 전부 막고,
/// 실제로 쓰는 2라벨 접미사만 적는다.
const PUBLIC_SUFFIXES: [&str; 15] =
    ["co.kr", "or.kr", "ne.kr", "go.kr", "ac.kr", "re.kr", "pe.kr", "co.jp", "co.uk", "org.uk", "com.au", "com.br", "com.cn", "com.sg", "co.in"];

fn is_public_suffix(d: &str) -> bool {
    // 라벨이 하나면(점이 없으면) 그 자체가 최상위다. localhost 도 여기 걸리지만,
    // host-only 매칭(h == d)이 먼저 통과하므로 로컬 개발은 영향이 없다.
    !d.contains('.') || PUBLIC_SUFFIXES.contains(&d)
}

/// 요청 호스트에 이 쿠키의 domain 이 적용되는지 (host-only 또는 도메인 서픽스 매칭).
/// 공용 접미사로는 하위를 잡지 못한다 — 저장(Domain 채택)과 전송(헤더 조립) 둘 다 이 함수를 지난다.
pub fn cookie_matches_host(cookie_domain: &str, request_host: &str) -> bool {
    let h = request_host.to_lowercase();
    let d = cookie_domain.to_lowercase();
    if h == d {
        return true; // host-only — 정확히 그 호스트에만
    }
    if is_public_suffix(&d) {
        return false;
    }
    h.ends_with(&format!(".{d}"))
}

/// jar 쿠키들 → Cookie 요청 헤더 값. 만료된 것 제외.
pub fn build_cookie_header(cookies: &[JarCookie], request_host: &str) -> String {
    let now = js::now_ms() as f64;
    let mut active: Vec<&JarCookie> =
        cookies.iter().filter(|c| cookie_matches_host(&c.domain, request_host) && c.expires.map_or(true, |e| e > now)).collect();
    // 같은 이름이 여러 도메인에 있으면 더 구체적인 쪽(긴 도메인)이 이긴다 — 짧은 것부터 넣어 뒤가 덮게 한다.
    // sort_by_key 는 안정 정렬이라 길이가 같으면 원래 순서(JS 의 sort 와 같다).
    active.sort_by_key(|c| js::len16(&c.domain));
    // JS Map — 처음 넣은 자리를 지키고 값만 바뀐다.
    let mut order: Vec<&str> = Vec::new();
    let mut by_name: HashMap<&str, &str> = HashMap::new();
    for c in active {
        if by_name.insert(&c.name, &c.value).is_none() {
            order.push(&c.name);
        }
    }
    // 값에 개행이나 세미콜론이 섞이면 헤더 한 줄이 쪼개진다. 헤더를 만드는 자리에서 한 번 더 막는다.
    let clean = |x: &str| x.chars().filter(|c| !matches!(c, '\r' | '\n' | ';')).collect::<String>();
    order.iter().map(|n| format!("{}={}", clean(n), clean(by_name[n]))).collect::<Vec<_>>().join("; ")
}

/// 만료 지시 여부(삭제해야 하는 쿠키).
pub fn is_expired(c: &ParsedCookie) -> bool {
    c.expires.map_or(false, |e| e <= js::now_ms() as f64)
}

/// 브라우저에서 복사한 Cookie 문자열("a=1; b=2; c=3")을 개별 쿠키로 파싱한다.
/// DevTools 의 Request Headers > Cookie 나 document.cookie 를 그대로 붙여넣는 용도.
/// 세미콜론/개행 구분 모두 허용, name= 뒤 = 포함 값 보존.
pub fn parse_cookie_string(input: &str) -> Vec<(String, String)> {
    input
        .split(|c| c == ';' || c == '\n')
        .map(js::trim)
        .filter(|s| !s.is_empty())
        .filter_map(|pair| {
            let eq = pair.find('=')?;
            let name = js::trim(&pair[..eq]);
            let value = js::trim(&pair[eq + 1..]);
            (!name.is_empty()).then(|| (name.to_string(), value.to_string()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jar(name: &str, value: &str, domain: &str, expires: Option<f64>) -> JarCookie {
        JarCookie { name: name.into(), value: value.into(), domain: domain.into(), expires }
    }
    fn now() -> f64 {
        js::now_ms() as f64
    }

    #[test]
    fn set_cookie_속성_파싱_domain_없으면_요청_호스트() {
        let c = parse_set_cookie("SESSIONID=abc123; Path=/; HttpOnly", "api.example.com").unwrap();
        assert_eq!(c, ParsedCookie { name: "SESSIONID".into(), value: "abc123".into(), domain: "api.example.com".into(), path: "/".into(), expires: None });
    }

    #[test]
    fn 요청_호스트가_속하지_않는_domain_은_거부() {
        assert_eq!(parse_set_cookie("a=1; Domain=evil.com", "api.example.com").unwrap().domain, "api.example.com");
        assert_eq!(parse_set_cookie("a=1; Domain=example.com", "other.org").unwrap().domain, "other.org");
    }

    #[test]
    fn domain_은_앞_점_제거하고_소문자() {
        assert_eq!(parse_set_cookie("a=1; Domain=.Example.com", "x.example.com").unwrap().domain, "example.com");
    }

    #[test]
    fn max_age_로_만료_계산() {
        let c = parse_set_cookie("a=1; Max-Age=3600", "h").unwrap();
        assert!(c.expires.unwrap() > now() + 3_500_000.0);
    }

    #[test]
    fn expires_날짜를_읽는다() {
        let c = parse_set_cookie("a=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT", "h").unwrap();
        assert_eq!(c.expires, Some(1_445_412_480_000.0));
        let c = parse_set_cookie("a=1; expires=Wed, 21-Oct-15 07:28:00 GMT", "h").unwrap();
        assert_eq!(c.expires, Some(1_445_412_480_000.0));
        // Max-Age 가 먼저 오면 Expires 는 무시
        let c = parse_set_cookie("a=1; Max-Age=0; Expires=Wed, 21 Oct 2099 07:28:00 GMT", "h").unwrap();
        assert!(c.expires.unwrap() <= now());
    }

    #[test]
    fn name_없으면_none() {
        assert_eq!(parse_set_cookie("; Path=/", "h"), None);
    }

    #[test]
    fn 정확_일치와_도메인_서픽스() {
        assert!(cookie_matches_host("example.com", "example.com"));
        assert!(cookie_matches_host("example.com", "api.example.com"));
        assert!(!cookie_matches_host("other.com", "api.example.com"));
    }

    #[test]
    fn 매칭_도메인_미만료만_헤더로() {
        let j = [jar("sid", "A", "example.com", None), jar("old", "B", "example.com", Some(now() - 1000.0)), jar("other", "C", "nope.com", None)];
        assert_eq!(build_cookie_header(&j, "api.example.com"), "sid=A");
    }

    #[test]
    fn 같은_이름은_구체적인_도메인이_이긴다() {
        let broad = jar("sid", "broad", "example.com", None);
        let exact = jar("sid", "exact", "api.example.com", None);
        assert_eq!(build_cookie_header(&[broad.clone(), exact.clone()], "api.example.com"), "sid=exact");
        assert_eq!(build_cookie_header(&[exact, broad], "api.example.com"), "sid=exact");
    }

    #[test]
    fn 만료_지시는_삭제_대상() {
        let c = |e| ParsedCookie { name: "a".into(), value: "".into(), domain: "h".into(), path: "/".into(), expires: e };
        assert!(is_expired(&c(Some(now() - 1.0))));
        assert!(!is_expired(&c(None)));
    }

    #[test]
    fn 브라우저_cookie_문자열을_개별_쿠키로() {
        let p = |a: &str, b: &str| (a.to_string(), b.to_string());
        assert_eq!(parse_cookie_string("SID=abc; theme=dark; _ga=GA1.2.3"), vec![p("SID", "abc"), p("theme", "dark"), p("_ga", "GA1.2.3")]);
        assert_eq!(parse_cookie_string("token=a=b=c\nx=1"), vec![p("token", "a=b=c"), p("x", "1")]);
        assert_eq!(parse_cookie_string("; =v; ok=1;"), vec![p("ok", "1")]);
    }

    #[test]
    fn 공용_접미사로는_하위를_못_잡는다() {
        assert_eq!(parse_set_cookie("sid=SECRET; Domain=com", "staging.example.com").unwrap().domain, "staging.example.com");
        let leaked = jar("sid", "SECRET", "com", None);
        assert_eq!(build_cookie_header(&[leaked.clone()], "totally-unrelated.com"), "");
        assert_eq!(build_cookie_header(&[leaked], "com"), "sid=SECRET");
        assert_eq!(parse_set_cookie("a=1; Domain=co.kr", "shop.co.kr").unwrap().domain, "shop.co.kr");
        assert!(!cookie_matches_host("co.kr", "other.co.kr"));
        assert_eq!(parse_set_cookie("a=1; Domain=example.com", "shop.example.com").unwrap().domain, "example.com");
        assert!(cookie_matches_host("example.com", "shop.example.com"));
        assert!(cookie_matches_host("localhost", "localhost"));
    }

    #[test]
    fn 값의_개행_세미콜론은_헤더를_못_쪼갠다() {
        assert_eq!(build_cookie_header(&[jar("sid", "a\r\nX-Evil: 1", "x.com", None)], "x.com"), "sid=aX-Evil: 1");
    }

    #[test]
    fn max_age_가_비어_있으면_삭제_지시가_아니다() {
        assert_eq!(parse_set_cookie("a=1; Max-Age=", "x.com").unwrap().expires, None);
    }
}
