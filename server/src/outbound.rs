//! 바깥으로 나가는 호출(그라파나·믹스패널·AI·사용량 수집)이 함께 쓰는 것.
//!
//! Node 는 전역 fetch 하나로 다 불렀다. 기본은 리다이렉트를 따라가고, 경로마다 `redirect: 'error'` 나
//! `'manual'` 을 골랐다. 그 차이가 보안 경계라(수집 토큰·AI 키가 리다이렉트를 따라 다른 서버로 가면 안 된다)
//! 리다이렉트는 자동으로 따라가지 않는다 — 따라가야 하는 호출부가 홉마다 SSRF 가드를 다시 보며 손으로 따라간다.
//!
//! AppState 에 넣지 않은 이유: 다른 라우트 테스트들이 AppState 를 직접 만든다. 필드를 하나 더하면
//! 그 테스트가 전부 깨진다. 클라이언트는 상태가 아니라 연결 풀이라 전역 하나로 충분하다.

use std::sync::OnceLock;

use serde_json::Value;

use crate::js;

/// undici 의 기본 연결 시간 제한(connectTimeout 10초). 이걸 넘기면 Node fetch 는 'fetch failed' 로 던졌다 —
/// 없으면 VPN 밖의 사내 주소 하나가 요청 전체의 시간 제한(스펙 받기는 15초)까지 붙든다.
pub const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Node 서버가 읽던 TLS 설정을 클라이언트에 입힌다 — NODE_EXTRA_CA_CERTS(사내 인증서 PEM 묶음)를 신뢰 루트에 더하고,
/// NODE_TLS_REJECT_UNAUTHORIZED=0 이면 검증을 끈다. Node 는 프로세스 전체에 걸리는 설정이라 모든 fetch 가 같았다.
/// 예전엔 실행기 클라이언트만 이걸 읽어서, 같은 사내 인증서의 스펙 받기·SSE 는 TLS 오류가 났다(codex 리뷰).
pub fn with_node_tls(mut b: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    if let Some(path) = std::env::var("NODE_EXTRA_CA_CERTS").ok().filter(|p| !p.is_empty()) {
        match std::fs::read(&path).map(|pem| reqwest::Certificate::from_pem_bundle(&pem)) {
            Ok(Ok(certs)) => {
                for c in certs {
                    b = b.add_root_certificate(c);
                }
            }
            _ => eprintln!("[postq] NODE_EXTRA_CA_CERTS 를 읽지 못했습니다: {path}"),
        }
    }
    if std::env::var("NODE_TLS_REJECT_UNAUTHORIZED").as_deref() == Ok("0") {
        b = b.danger_accept_invalid_certs(true);
    }
    b
}

/// fetch 처럼 쓰는 클라이언트의 공통 설정 — 시스템 프록시 없음, 연결 시간 제한, Node 의 TLS 설정,
/// 응답 압축 자동 해제(gzip·br·deflate — undici 처럼 본문만 풀어 준다. 예전엔 꺼져 있어 SSE·카탈로그가 압축 바이트를 그대로 읽었다).
fn fetch_like() -> reqwest::ClientBuilder {
    with_node_tls(reqwest::Client::builder().no_proxy().connect_timeout(CONNECT_TIMEOUT))
}

// 리다이렉트를 자동으로 따라가는 클라이언트는 두지 않는다 — 목적지를 SSRF 가드 없이 따라가기 때문이다.
// 따라가야 하는 곳(스펙 가져오기 [`crate::spec_fetch::fetch_spec_json`], 실행기)은 no_redirect 로 받아 홉마다 직접 검사한다.

/// 리다이렉트를 따라가지 않는 클라이언트 — `redirect: 'error'`·`'manual'` 자리. 3xx 를 어떻게 다룰지는 호출부가 정한다.
pub fn no_redirect() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| fetch_like().redirect(reqwest::redirect::Policy::none()).build().expect("reqwest client"))
}

/// undici 가 `redirect: 'error'` 에서 네트워크 오류로 바꾸는 상태 코드.
pub fn is_redirect(status: u16) -> bool {
    matches!(status, 301 | 302 | 303 | 307 | 308)
}

/// fetch 가 던지던 문장 — 화면과 로그가 이 문장을 그대로 보여 준다(시간 초과와 연결 실패를 가른다).
/// 연결 시간 초과([`CONNECT_TIMEOUT`])는 undici 처럼 'fetch failed' 다 — AbortSignal 로 끊긴 것이 아니다.
pub fn fetch_error_message(e: &reqwest::Error) -> String {
    if is_abort_timeout(e) {
        crate::executor::FetchError::timeout_message().into()
    } else {
        crate::executor::FetchError::FETCH_FAILED.into()
    }
}

/// 요청 시간 제한(AbortSignal.timeout)에 걸렸나 — 연결 단계의 시간 초과는 빼고.
pub fn is_abort_timeout(e: &reqwest::Error) -> bool {
    e.is_timeout() && !e.is_connect()
}

/// `res.json()` 이 던지던 자리 — 문장은 Node 와 같지 않다(SyntaxError 문구는 V8 의 것이라 옮기지 않는다).
pub fn parse_json_text(text: &str) -> Result<Value, String> {
    js::parse_json(text).ok_or_else(|| format!("Unexpected token in JSON: {}", js::slice16(text, 40)))
}

/// 본문을 상한(UTF-16 단위)까지만 읽어 글자로. 넘으면 Err(None), 연결이 끊기거나 압축이 깨지면 Err(Some(문장)).
/// 읽기는 실행기의 [`crate::executor::read_body_capped`] 하나다 — 압축 해제(gzip·br 폭탄 방어 포함)·charset 이 같다.
pub async fn read_capped(res: reqwest::Response, cap: usize) -> Result<String, Option<String>> {
    match crate::executor::read_body_capped(res, cap, false).await {
        Ok((_, true)) => Err(None),
        Ok((text, false)) => Ok(text),
        Err(e) => Err(Some(e.message)),
    }
}

/// `Number(v)` — JSON 값 하나를 JS 의 Number() 로. undefined 는 NaN.
pub fn number_of(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => js::number(s),
        // Number([]) === 0, Number([5]) === 5 — 배열은 String() 을 거쳐 읽힌다.
        Some(a @ Value::Array(_)) => js::number(&js::to_string(a)),
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// `Number.isInteger(v)` — 숫자 값만.
pub fn is_integer(v: Option<&Value>) -> bool {
    v.and_then(Value::as_f64).map_or(false, |f| f.is_finite() && f.fract() == 0.0)
}

/// `Number.isSafeInteger(v)`.
pub fn is_safe_integer(v: Option<&Value>) -> bool {
    v.and_then(Value::as_f64).map_or(false, |f| f.is_finite() && f.fract() == 0.0 && f.abs() <= 9_007_199_254_740_991.0)
}

/// f64 를 JSON 숫자로 — NaN·무한대는 JSON.stringify 처럼 null.
/// 정수 값은 정수로 싣는다 — JS 에는 89000 과 89000.0 의 구분이 없어 JSON.stringify 는 `89000` 을 쓴다.
/// serde_json 은 f64 를 `89000.0` 으로 써서, 그대로 두면 질의·응답 글자가 Node 와 달라진다.
pub fn num(f: f64) -> Value {
    if f.is_finite() && f.fract() == 0.0 && f.abs() <= 9_007_199_254_740_991.0 {
        // -0 도 JSON.stringify 는 "0" 이다.
        return Value::from(f as i64);
    }
    serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number)
}

/// 배열 기본 sort() — UTF-16 단위 비교.
pub fn js_sort_strings(v: &mut [String]) {
    v.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
}

/// JS 정규식(u 플래그 없음)을 옮길 때 쓴다. `\w`·`\d`·`\b` 가 ASCII 기준이라는 점이 JS 와 같다.
/// 바이트 정규식이라 비ASCII 글자는 UTF-8 바이트열로 다뤄진다 — 옮긴 패턴은 경계를 ASCII 글자에만 둔다.
pub fn js_regex(pattern: &str) -> Result<regex::bytes::Regex, regex::Error> {
    regex::bytes::Regex::new(&format!("(?-u){pattern}"))
}

/// 바이트 정규식 치환 결과를 다시 문자열로 — 경계가 ASCII 라 UTF-8 이 깨지지 않는다.
pub fn replace_all(re: &regex::bytes::Regex, text: &str, rep: &str) -> String {
    String::from_utf8_lossy(&re.replace_all(text.as_bytes(), rep.as_bytes())).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn number_of_는_js_number() {
        assert_eq!(number_of(Some(&json!(null))), 0.0);
        assert!(number_of(None).is_nan());
        assert_eq!(number_of(Some(&json!("12"))), 12.0);
        assert_eq!(number_of(Some(&json!([5]))), 5.0);
        assert_eq!(number_of(Some(&json!([]))), 0.0);
        assert!(number_of(Some(&json!({}))).is_nan());
    }

    #[test]
    fn js_정규식은_ascii_단어() {
        let re = js_regex(r"\bab\b").unwrap();
        assert!(re.is_match("x ab y".as_bytes()));
        assert!(re.is_match("가ab나".as_bytes())); // JS 의 \b 도 한글을 단어 글자로 안 본다
    }
}

#[cfg(test)]
mod connect_timeout_tests {
    // 연결 단계의 시간 초과는 is_connect 가 같이 서야 'fetch failed' 로 갈 수 있다(is_abort_timeout 의 전제).
    #[tokio::test]
    async fn 연결_시간_초과는_abort_시간_초과가_아니다() {
        let c = reqwest::Client::builder().no_proxy().connect_timeout(std::time::Duration::from_millis(200)).build().unwrap();
        // 10.255.255.1 — 라우팅되지 않아 SYN 이 돌아오지 않는 주소.
        let e = c.get("http://10.255.255.1:81/").send().await.unwrap_err();
        // 망에 따라 곧바로 '도달 불가' 가 오기도 한다 — 그때는 시간 초과를 볼 수 없으니 넘어간다.
        if !e.is_timeout() {
            return;
        }
        assert!(e.is_connect(), "{e:?}");
        assert!(!super::is_abort_timeout(&e));
        assert_eq!(super::fetch_error_message(&e), "fetch failed");
    }
}
