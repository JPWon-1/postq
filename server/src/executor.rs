//! 요청 실행 엔진. Node 의 fetch(undici) 가 하던 일까지 여기서 한다.
//!
//! 공개 API
//! - [`execute_request`] → [`ExecResult`] — 해석이 끝난 요청(real)을 보낸다. 실패해도 throw 하지 않고 error 에 싣는다.
//! - [`strip_credential_headers`] — 다른 오리진으로 넘어갈 때 자격증명 헤더 제거.
//! - [`fetch`] / [`read_body_capped`] / [`FetchError`] — 낮은 단계 송신(OAuth 토큰 발급·스키마 조회 등 다른 egress 가 같은 규칙을 쓰게).
//! - [`MAX_BODY_CHARS`] — 응답 저장 상한(UTF-16 단위, Node 의 string.length).
//!
//! 보안 규칙(옮기면서 바꾸면 안 되는 것)
//! - 첫 URL 과 리다이렉트의 **모든 홉**에서 스킴(http/https)·차단 호스트(SSRF 가드)를 다시 본다.
//! - 리다이렉트는 기본 미추종. followRedirects 면 직접 따라간다: 301/302/303(그 밖의 3xx 도) → GET·바디 제거,
//!   307/308 → 메서드·문자열 바디 유지(multipart 는 제거). 다른 오리진이면 authorization/cookie/proxy-authorization 제거.
//! - 응답 본문은 상한(1MB 글자)까지만 읽고 나머지는 받지 않는다 — 큰 응답 하나가 서버를 넘어뜨리지 않게.
//! - 시스템 프록시 환경 변수는 쓰지 않는다(Node fetch 도 안 쓴다) — 프록시를 거치면 SSRF 가드가 본 호스트와
//!   실제 연결 대상이 달라진다.
//!
//! Node fetch 와 맞춘 것: 기본 헤더(accept·accept-language·sec-fetch-mode·user-agent·accept-encoding),
//! 문자열 바디의 기본 Content-Type(text/plain;charset=UTF-8), 본문 없는 POST/PUT 의 content-length: 0,
//! gzip·deflate·br 해제(응답 헤더의 content-encoding 은 그대로 둔다), 응답 헤더를 소문자·이름순으로 모으고
//! 같은 이름은 ", " 로 잇기(set-cookie 는 마지막 값), 금지 포트(fetch 표준의 bad port), URL 안의 자격증명 거부,
//! 문자셋(utf-8·windows-1252; 나머지는 utf-8 로 되돌아간다), 오류 문장(describeError 모양).

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::{Map, Value};
use url::Url;

use crate::js;
use crate::multipart::{build_binary_body, build_form_data, parse_multipart_body};
use crate::resolve::{default_content_type, extract_path_parameters, gql_wrap, merge_query_params, RequestInput, RequestSettings};
use crate::ssrf_guard::{block_private_networks, is_blocked_host, scheme_problem};

/// 저장 크기 상한 — 응답이 무제한으로 커지면 이력 저장 공간을 고갈시킬 수 있어 1MB 글자에서 자르고 truncated 로 표시.
pub const MAX_BODY_CHARS: usize = 1_048_576;
pub const MAX_REDIRECTS: usize = 5;
const DEFAULT_TIMEOUT_MS: f64 = 30_000.0;
const CREDENTIAL_HEADERS: [&str; 3] = ["authorization", "cookie", "proxy-authorization"];

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ExecResult {
    pub status: Option<u16>,
    /// `Object.fromEntries(res.headers)` — 소문자 이름순.
    pub headers: Option<Vec<(String, String)>>,
    pub body: Option<String>,
    pub duration_ms: i64,
    pub error: Option<String>,
    /// 성공한 응답에서만 Some — 실패면 undefined(라우트는 `?? false`).
    pub truncated: Option<bool>,
    /// 응답의 Set-Cookie 원본 줄들 — 쿠키 jar 저장용.
    pub set_cookies: Vec<String>,
}

impl ExecResult {
    fn failed(started: Instant, error: String) -> Self {
        ExecResult { duration_ms: elapsed_ms(started), error: Some(error), ..Default::default() }
    }

    /// 응답 헤더를 JSON 객체로(없으면 None).
    pub fn headers_json(&self) -> Option<Value> {
        self.headers.as_ref().map(|h| headers_to_json(h))
    }
}

pub fn headers_to_json(h: &[(String, String)]) -> Value {
    Value::Object(h.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect::<Map<_, _>>())
}

fn elapsed_ms(started: Instant) -> i64 {
    (started.elapsed().as_secs_f64() * 1000.0).round() as i64
}

/// 다른 오리진으로 넘어갈 때 자격증명 헤더 제거(표준 fetch/브라우저 동작과 같다 — 토큰·쿠키 유출 방지).
pub fn strip_credential_headers(h: &[(String, String)]) -> Vec<(String, String)> {
    h.iter().filter(|(k, _)| !CREDENTIAL_HEADERS.contains(&k.to_lowercase().as_str())).cloned().collect()
}

// ── 오류 문장 ───────────────────────────────────────────────────────────

/// Node 에서 던져지던 오류의 모양 — name·message 와 undici 가 cause 에 숨겨 두는 원인(code 가 있으면 함께).
#[derive(Clone, Debug, PartialEq)]
pub struct FetchError {
    pub name: String,
    pub message: String,
    pub cause: Option<(Option<String>, String)>,
}

impl FetchError {
    fn new(name: &str, message: impl Into<String>) -> Self {
        FetchError { name: name.into(), message: message.into(), cause: None }
    }
    fn fetch_failed(code: Option<&str>, cause: impl Into<String>) -> Self {
        FetchError { name: "TypeError".into(), message: Self::FETCH_FAILED.into(), cause: Some((code.map(str::to_string), cause.into())) }
    }
    /// undici 가 네트워크 오류에 붙이던 message.
    pub const FETCH_FAILED: &'static str = "fetch failed";

    pub fn invalid_url() -> Self {
        Self::new("TypeError", "Invalid URL")
    }
    pub fn timeout() -> Self {
        Self::new("TimeoutError", Self::timeout_message())
    }
    /// AbortSignal.timeout 이 끊을 때의 message(errorText 가 싣는 것).
    pub fn timeout_message() -> &'static str {
        "The operation was aborted due to timeout"
    }

    /// executor.ts 의 describeError — "fetch failed" 대신 cause 의 실제 원인(ECONNREFUSED/ENOTFOUND/...)을 앞에.
    pub fn describe(&self) -> String {
        match &self.cause {
            Some((Some(code), msg)) => format!("{code}: {msg}"),
            Some((None, msg)) => format!("{}: {} ({msg})", self.name, self.message),
            None => format!("{}: {}", self.name, self.message),
        }
    }
}

/// reqwest 오류 → undici 가 냈을 원인. 정확한 문장까지는 못 맞춘다(Node 는 해석된 IP 를 싣는다) —
/// 화면의 설명(httpExplain)이 기대는 코드(ECONNREFUSED·ENOTFOUND·ETIMEDOUT·ECONNRESET·CERT_)는 같게 낸다.
fn classify(e: &reqwest::Error, url: &Url) -> FetchError {
    let host = url.host_str().unwrap_or("").trim_start_matches('[').trim_end_matches(']').to_string();
    let port = url.port_or_known_default().unwrap_or(0);
    // undici 의 연결 시간 제한(10초) — 요청 시간 제한(AbortSignal)과 달리 'fetch failed' 로 던졌다.
    if e.is_timeout() && e.is_connect() {
        let ms = crate::outbound::CONNECT_TIMEOUT.as_millis();
        return FetchError::fetch_failed(Some("UND_ERR_CONNECT_TIMEOUT"), format!("Connect Timeout Error (attempted address: {host}:{port}, timeout: {ms}ms)"));
    }
    if e.is_timeout() {
        return FetchError::timeout();
    }
    let mut chain = String::new();
    let mut io_kind = None;
    let mut src: Option<&(dyn std::error::Error + 'static)> = Some(e);
    while let Some(s) = src {
        if !chain.is_empty() {
            chain.push_str(": ");
        }
        chain.push_str(&s.to_string());
        if let Some(io) = s.downcast_ref::<std::io::Error>() {
            io_kind = Some(io.kind());
        }
        src = s.source();
    }
    let lower = chain.to_lowercase();
    use std::io::ErrorKind as K;
    match io_kind {
        Some(K::ConnectionRefused) => return FetchError::fetch_failed(Some("ECONNREFUSED"), format!("connect ECONNREFUSED {host}:{port}")),
        Some(K::TimedOut) => return FetchError::fetch_failed(Some("ETIMEDOUT"), format!("connect ETIMEDOUT {host}:{port}")),
        Some(K::ConnectionReset) => return FetchError::fetch_failed(Some("ECONNRESET"), "read ECONNRESET"),
        Some(K::ConnectionAborted | K::UnexpectedEof | K::BrokenPipe) => return FetchError::fetch_failed(Some("UND_ERR_SOCKET"), "other side closed"),
        _ => {}
    }
    if lower.contains("dns error") || lower.contains("failed to lookup address") {
        return FetchError::fetch_failed(Some("ENOTFOUND"), format!("getaddrinfo ENOTFOUND {host}"));
    }
    if lower.contains("certificate") || lower.contains("tls") || lower.contains("handshake") {
        let (code, msg) = if lower.contains("expired") {
            ("CERT_HAS_EXPIRED", "certificate has expired".to_string())
        } else if lower.contains("notvalidforname") || lower.contains("not valid for name") {
            ("ERR_TLS_CERT_ALTNAME_INVALID", format!("Hostname/IP does not match certificate's altnames: Host: {host}."))
        } else if lower.contains("unknownissuer") || lower.contains("unknown issuer") {
            ("UNABLE_TO_VERIFY_LEAF_SIGNATURE", "unable to verify the first certificate".to_string())
        } else {
            ("ERR_SSL_CERT", chain.clone())
        };
        return FetchError::fetch_failed(Some(code), msg);
    }
    if lower.contains("connection closed") || lower.contains("incomplete message") {
        return FetchError::fetch_failed(Some("UND_ERR_SOCKET"), "other side closed");
    }
    // 원인 사슬의 마지막 문장(가장 구체적인 것)
    let inner = chain.rsplit(": ").next().unwrap_or(&chain).to_string();
    FetchError::fetch_failed(None, inner)
}

// ── 송신 ────────────────────────────────────────────────────────────────

/// fetch 표준의 금지 포트 — undici 가 'bad port' 로 거절한다. 사용자는 1·7·9 같은 포트에서 이 설명을 본다.
const BAD_PORTS: &[u16] = &[
    0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115,
    117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601,
    636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697,
    10080,
];

/// 실행용 HTTP 클라이언트 — 리다이렉트는 직접 따라가고(각 홉 SSRF 재검사), 시스템 프록시는 쓰지 않는다.
/// NODE_EXTRA_CA_CERTS(사내 인증서)·NODE_TLS_REJECT_UNAUTHORIZED=0 은 Node 서버가 읽던 설정이라 그대로 따른다.
pub fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        // 압축은 여기서 풀지 않는다 — read_body_capped 가 직접 풀어 상한을 걸고, 이력에는 원래 content-encoding 이 남아야 한다.
        let b = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .http1_only()
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .connect_timeout(crate::outbound::CONNECT_TIMEOUT);
        let b = crate::outbound::with_node_tls(b);
        b.build().expect("HTTP 클라이언트")
    })
}

/// 보낼 바디. multipart 는 바이트와 boundary 가 든 Content-Type.
#[derive(Clone, Debug)]
pub enum SendBody {
    Text(String),
    Binary { bytes: Vec<u8>, content_type: String },
    Form { bytes: Vec<u8>, content_type: String },
}

/// webidl 헤더 검사 — 이름은 token, 값은 NUL·CR·LF 없이(앞뒤 HTTP 공백은 지운다).
fn header_pair(name: &str, value: &str) -> Result<(HeaderName, HeaderValue), FetchError> {
    let n = HeaderName::from_bytes(name.as_bytes())
        .map_err(|_| FetchError::new("TypeError", format!("Headers.append: \"{name}\" is an invalid header name.")))?;
    let v = value.trim_matches(|c| matches!(c, '\t' | '\n' | '\r' | ' '));
    if v.contains(['\0', '\r', '\n']) {
        return Err(FetchError::new("TypeError", format!("Headers.append: \"{value}\" is an invalid header value.")));
    }
    let hv = HeaderValue::from_bytes(v.as_bytes())
        .map_err(|_| FetchError::new("TypeError", format!("Headers.append: \"{value}\" is an invalid header value.")))?;
    Ok((n, hv))
}

/// 요청 하나를 그대로 보낸다(리다이렉트 미추종). URL·포트·헤더 검사는 Node fetch 가 던지던 것과 같은 자리에서.
fn wire_headers(url: &str, method: &str, headers: &[(String, String)], body: Option<&SendBody>) -> Result<HeaderMap, FetchError> {
    // 같은 이름(대소문자 무시)은 Headers.append 처럼 ", " 로 잇는다.
    let mut map = HeaderMap::new();
    for (k, v) in headers {
        let (n, hv) = header_pair(k, v)?;
        if let Some(prev) = map.get(&n) {
            let mut joined = prev.as_bytes().to_vec();
            joined.extend_from_slice(b", ");
            joined.extend_from_slice(hv.as_bytes());
            map.insert(n, HeaderValue::from_bytes(&joined).unwrap_or(hv));
        } else {
            map.insert(n, hv);
        }
    }
    let mut put_default = |k: &'static str, v: &str| {
        if !map.contains_key(k) {
            map.insert(HeaderName::from_static(k), HeaderValue::from_str(v).expect("기본 헤더"));
        }
    };
    match body {
        Some(SendBody::Text(_)) => put_default("content-type", "text/plain;charset=UTF-8"),
        Some(SendBody::Form { content_type, .. } | SendBody::Binary { content_type, .. }) => put_default("content-type", content_type),
        None => {}
    }
    put_default("accept", "*/*");
    put_default("accept-language", "*");
    put_default("sec-fetch-mode", "cors");
    put_default("user-agent", "node");
    put_default("accept-encoding", if url.starts_with("https:") { "br, gzip, deflate" } else { "gzip, deflate" });
    // 본문 없는 POST/PUT 은 content-length: 0 (fetch 표준). 411 을 주는 서버가 있다.
    if body.is_none() && matches!(method, "POST" | "PUT") && !map.contains_key("content-length") {
        map.insert(reqwest::header::CONTENT_LENGTH, HeaderValue::from_static("0"));
    }
    Ok(map)
}

pub async fn fetch(url: &Url, method: &str, headers: &[(String, String)], body: Option<&SendBody>) -> Result<reqwest::Response, FetchError> {
    if !url.username().is_empty() || url.password().is_some() {
        return Err(FetchError::new("TypeError", format!("Request cannot be constructed from a URL that includes credentials: {}", url.as_str())));
    }
    if scheme_problem(&format!("{}:", url.scheme())).is_some() {
        return Err(FetchError::fetch_failed(None, "unknown scheme"));
    }
    if url.port().map_or(false, |p| BAD_PORTS.contains(&p)) {
        return Err(FetchError::fetch_failed(None, "bad port"));
    }
    let m = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| FetchError::new("TypeError", format!("'{method}' is not a valid HTTP method.")))?;
    let map = wire_headers(url.as_str(), method, headers, body)?;
    let mut rb = client().request(m, url.clone()).headers(map);
    match body {
        Some(SendBody::Text(s)) => rb = rb.body(s.clone()),
        Some(SendBody::Form { bytes, .. } | SendBody::Binary { bytes, .. }) => rb = rb.body(bytes.clone()),
        None => {}
    }
    rb.send().await.map_err(|e| classify(&e, url))
}

/// 응답 헤더 — Headers 를 순회한 것처럼: 소문자 이름순, 같은 이름은 ", " 로 잇는다. set-cookie 는 줄마다 따로 나와
/// Object.fromEntries 에서 마지막 값만 남는다. 값은 latin1 로 읽는다(undici 와 같다).
pub fn response_headers(h: &HeaderMap) -> Vec<(String, String)> {
    let mut names: Vec<&str> = h.keys().map(|k| k.as_str()).collect();
    names.sort();
    names.dedup();
    names
        .into_iter()
        .map(|n| {
            let vals: Vec<String> = h.get_all(n).iter().map(|v| latin1(v.as_bytes())).collect();
            let v = if n == "set-cookie" { vals.last().cloned().unwrap_or_default() } else { vals.join(", ") };
            (n.to_string(), v)
        })
        .collect()
}

/// `res.headers.getSetCookie()` — 줄마다 따로.
pub fn set_cookie_lines(h: &HeaderMap) -> Vec<String> {
    h.get_all("set-cookie").iter().map(|v| latin1(v.as_bytes())).collect()
}

fn header_get(h: &HeaderMap, name: &str) -> Option<String> {
    let vals: Vec<String> = h.get_all(name).iter().map(|v| latin1(v.as_bytes())).collect();
    (!vals.is_empty()).then(|| vals.join(", "))
}

fn latin1(b: &[u8]) -> String {
    b.iter().map(|&c| c as char).collect()
}

// ── 응답 본문 ───────────────────────────────────────────────────────────

/// 압축 해제 한 단계에서 한 번에 내보내는 최대 바이트 — 이만큼 풀 때마다 상한을 다시 본다.
/// 통째로 쓰기형 해제기에 넣으면 brotli(10^6:1 이상)는 작은 청크 하나가 수 GB 로 부푼 뒤에야
/// 상한 검사를 받는다. undici 는 역압이 걸린 스트림으로 풀어 1MB 근처에서 멈춘다 — 그 걸음을 흉내 낸다.
const DECODE_STEP: usize = 16 * 1024;

type BrotliState = brotli_decompressor::BrotliState<brotli_decompressor::StandardAlloc, brotli_decompressor::StandardAlloc, brotli_decompressor::StandardAlloc>;

/// 풀어 낸 조각을 받는 쪽. true 를 돌려주면 '그만'(상한 도달) — 해제기는 남은 입력을 더 풀지 않는다.
type Sink<'a> = &'a mut dyn FnMut(&[u8]) -> std::io::Result<bool>;

/// 압축 해제 단계 하나 — 들어온 것을 DECODE_STEP 이하 조각으로 풀어 sink 에 넘긴다.
enum Decoder {
    Gzip(flate2::write::MultiGzDecoder<Vec<u8>>),
    Zlib(flate2::write::ZlibDecoder<Vec<u8>>),
    Raw(flate2::write::DeflateDecoder<Vec<u8>>),
    /// deflate 는 zlib 머리가 붙었는지 첫 바이트를 보고 정한다(undici 와 같다). 그 전까지는 기다린다.
    DeflatePending,
    /// 저수준 API 를 쓴다 — DecompressorWriter::write 는 입력을 다 먹을 때까지 출력을 안쪽 writer 로 밀어 넣어서
    /// 한 번의 호출이 얼마나 부풀지 막을 길이 없다.
    Brotli { state: Box<BrotliState>, out: Vec<u8>, total_out: usize, done: bool },
}

/// flate2 쓰기형 해제기: write() 한 번은 입력 일부만 먹고 내부 버퍼(32KB) 하나 분량만 내보낸다 —
/// write_all 로 통째로 넣지 않고 한 걸음씩 밀며 매번 sink 에 상한을 묻는다.
fn feed_flate<W: std::io::Write>(d: &mut W, inner: impl Fn(&mut W) -> &mut Vec<u8>, input: &[u8], sink: Sink) -> std::io::Result<bool> {
    let mut pos = 0;
    while pos < input.len() {
        let n = d.write(&input[pos..])?;
        if n == 0 {
            return Err(std::io::ErrorKind::WriteZero.into()); // write_all 과 같은 실패
        }
        pos += n;
        let out = std::mem::take(inner(d));
        for piece in out.chunks(DECODE_STEP) {
            if sink(piece)? {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn emit(out: Vec<u8>, sink: Sink) -> std::io::Result<bool> {
    for piece in out.chunks(DECODE_STEP) {
        if sink(piece)? {
            return Ok(true);
        }
    }
    Ok(false)
}

impl Decoder {
    fn brotli() -> Self {
        let a = brotli_decompressor::StandardAlloc::default();
        Decoder::Brotli { state: Box::new(BrotliState::new(a, a, a)), out: vec![0; DECODE_STEP], total_out: 0, done: false }
    }

    /// brotli 를 DECODE_STEP 출력 단위로 돌린다. input 이 비면 끝내기(남은 출력 비우기).
    /// 반환 (sink 가 멈추라 했나, 스트림이 깨졌나).
    fn run_brotli(state: &mut BrotliState, out: &mut [u8], total_out: &mut usize, done: &mut bool, input: &[u8], sink: Sink) -> std::io::Result<(bool, bool)> {
        use brotli_decompressor::BrotliResult as R;
        let mut avail_in = input.len();
        let mut in_off = 0;
        loop {
            let mut avail_out = out.len();
            let mut out_off = 0;
            let ret = brotli_decompressor::BrotliDecompressStream(&mut avail_in, &mut in_off, input, &mut avail_out, &mut out_off, out, total_out, state);
            if out_off > 0 && sink(&out[..out_off])? {
                return Ok((true, false));
            }
            match ret {
                R::NeedsMoreOutput => continue,
                R::NeedsMoreInput => return Ok((false, !input.is_empty() && avail_in != 0)),
                R::ResultSuccess => {
                    *done = true;
                    return Ok((false, avail_in != 0)); // 끝난 뒤 꼬리가 남으면 예전(write_all)처럼 실패
                }
                R::ResultFailure => return Ok((false, true)),
            }
        }
    }

    fn feed(&mut self, input: &[u8], sink: Sink) -> std::io::Result<bool> {
        if input.is_empty() {
            return Ok(false);
        }
        if let Decoder::DeflatePending = self {
            *self = if input[0] & 0x0F == 0x08 {
                Decoder::Zlib(flate2::write::ZlibDecoder::new(Vec::new()))
            } else {
                Decoder::Raw(flate2::write::DeflateDecoder::new(Vec::new()))
            };
        }
        match self {
            Decoder::Gzip(d) => feed_flate(d, |d| d.get_mut(), input, sink),
            Decoder::Zlib(d) => feed_flate(d, |d| d.get_mut(), input, sink),
            Decoder::Raw(d) => feed_flate(d, |d| d.get_mut(), input, sink),
            Decoder::Brotli { state, out, total_out, done } => {
                if *done {
                    return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "trailing data after brotli stream"));
                }
                let (stop, bad) = Self::run_brotli(state, out, total_out, done, input, sink)?;
                if bad {
                    return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "corrupt brotli stream"));
                }
                Ok(stop)
            }
            Decoder::DeflatePending => Ok(false),
        }
    }

    /// 끝 — 잘린 압축 스트림도 받은 데까지 쓴다(undici 의 finishFlush: Z_SYNC_FLUSH 와 같다).
    fn finish(&mut self, sink: Sink) -> std::io::Result<bool> {
        match self {
            Decoder::Gzip(d) => {
                let _ = d.try_finish();
                emit(std::mem::take(d.get_mut()), sink)
            }
            Decoder::Zlib(d) => {
                let _ = d.try_finish();
                emit(std::mem::take(d.get_mut()), sink)
            }
            Decoder::Raw(d) => {
                let _ = d.try_finish();
                emit(std::mem::take(d.get_mut()), sink)
            }
            Decoder::Brotli { state, out, total_out, done } => {
                if *done {
                    return Ok(false);
                }
                // 잘린 스트림이라도 오류는 삼킨다(예전 close() 결과를 버리던 것과 같다).
                Ok(Self::run_brotli(state, out, total_out, done, &[], sink)?.0)
            }
            Decoder::DeflatePending => Ok(false),
        }
    }
}

/// 해제 단계들을 줄줄이 통과시킨다 — 앞 단계가 조각을 내놓는 즉시 다음 단계로 넘겨서,
/// 어느 단계도 한 번에 DECODE_STEP 넘게 쌓지 않는다. last 가 true(상한 도달)면 전부 멈춘다.
fn decode_chain(decoders: &mut [Decoder], data: &[u8], last: &mut dyn FnMut(&[u8]) -> bool) -> std::io::Result<bool> {
    match decoders.split_first_mut() {
        None => Ok(last(data)),
        Some((d, rest)) => d.feed(data, &mut |out: &[u8]| decode_chain(rest, out, last)),
    }
}

/// 남은 압축 꼬리를 바깥 단계부터 비운다 — 앞 단계의 끝이 다음 단계의 입력이다.
fn finish_chain(decoders: &mut [Decoder], last: &mut dyn FnMut(&[u8]) -> bool) -> std::io::Result<bool> {
    for i in 0..decoders.len() {
        let (head, rest) = decoders.split_at_mut(i + 1);
        if head[i].finish(&mut |out: &[u8]| decode_chain(rest, out, last))? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// content-encoding → 해제 단계들(바깥 것부터). 모르는 코딩이 하나라도 있으면 아무것도 풀지 않는다(undici 와 같다).
fn decoders_for(content_encoding: Option<&str>) -> Vec<Decoder> {
    let Some(ce) = content_encoding else { return vec![] };
    let mut out = Vec::new();
    for coding in ce.to_lowercase().split(',').map(str::trim).rev() {
        match coding {
            "gzip" | "x-gzip" => out.push(Decoder::Gzip(flate2::write::MultiGzDecoder::new(Vec::new()))),
            "deflate" => out.push(Decoder::DeflatePending),
            "br" => out.push(Decoder::brotli()),
            "" | "identity" => {}
            _ => return vec![],
        }
    }
    out
}

/// content-type 의 charset → TextDecoder 가 고르는 인코딩. Node 는 `new TextDecoder(charset || 'utf-8')` 이고,
/// 못 만드는 라벨이면(모르는 이름, 또는 iso-2022-kr 처럼 'replacement' 로 묶인 라벨 — TextDecoder 가 RangeError 를 던진다)
/// utf-8 로 되돌아간다. 라벨 해석(앞뒤 공백·대소문자)은 encoding_rs 가 WHATWG Encoding 표준대로 한다.
/// 예전엔 utf-8·windows-1252 둘만 직접 풀어서 사내 EUC-KR 응답이 깨졌다(codex 리뷰).
fn charset_of(content_type: Option<&str>) -> &'static encoding_rs::Encoding {
    let ct = content_type.unwrap_or("");
    let lower = ct.to_ascii_lowercase();
    let Some(i) = lower.find("charset=") else { return encoding_rs::UTF_8 };
    let label: String = ct[i + 8..].split(';').next().unwrap_or("").chars().filter(|c| *c != '"' && *c != '\'').collect();
    match encoding_rs::Encoding::for_label(js::trim(&label).as_bytes()) {
        Some(e) if e != encoding_rs::REPLACEMENT => e,
        _ => encoding_rs::UTF_8,
    }
}

/// 스트리밍 글자 풀기 — TextDecoder 의 decode(chunk, { stream: true }) 와 같다. 청크 경계에서 끊긴 글자는
/// 다음 청크와 이어 풀고, 깨진 바이트는 U+FFFD. BOM 은 그 인코딩의 것일 때만 맨 앞에서 한 번 지운다(ignoreBOM: false).
struct TextStream {
    decoder: encoding_rs::Decoder,
    out: String,
    units: usize,
}

impl TextStream {
    fn new(encoding: &'static encoding_rs::Encoding) -> Self {
        // new_decoder() 는 BOM 을 보고 인코딩을 바꿔 버린다(TextDecoder 는 그러지 않는다) — 지우기만 하는 쪽을 쓴다.
        TextStream { decoder: encoding.new_decoder_with_bom_removal(), out: String::new(), units: 0 }
    }

    fn decode(&mut self, bytes: &[u8], last: bool) {
        let mut piece = String::with_capacity(self.decoder.max_utf8_buffer_length(bytes.len()).unwrap_or(bytes.len() * 3 + 4));
        let (_, _, _) = self.decoder.decode_to_string(bytes, &mut piece, last);
        self.units += js::len16(&piece);
        self.out.push_str(&piece);
    }

    fn push(&mut self, bytes: &[u8]) {
        self.decode(bytes, false);
    }

    fn finish(&mut self) {
        self.decode(&[], true);
    }
}

/// 응답 본문을 상한(max_units, UTF-16 단위)까지만 읽는다. 넘는 순간 멈추고 나머지는 받지 않는다 —
/// 통째로 받고 자르면 메모리는 이미 다 먹은 뒤다(로그 내려받기 같은 엔드포인트 한 번에 컨테이너가 넘어간다).
/// 반환: (본문, 잘렸는가). 잘렸으면 끝에 "\n…[truncated]".
pub async fn read_body_capped(res: reqwest::Response, max_units: usize, skip_decoding: bool) -> Result<(String, bool), FetchError> {
    let url = res.url().clone();
    let headers = res.headers().clone();
    let mut decoders = if skip_decoding { vec![] } else { decoders_for(header_get(&headers, "content-encoding").as_deref()) };
    let mut text = TextStream::new(charset_of(header_get(&headers, "content-type").as_deref()));
    let mut stream = res.bytes_stream();
    let mut truncated = false;
    let decode_err = |e: std::io::Error| FetchError::fetch_failed(Some("Z_DATA_ERROR"), e.to_string());
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| classify(&e, &url))?;
        // 조각마다 상한을 본다 — 청크 하나가 통째로 풀린 뒤가 아니라.
        let stop = decode_chain(&mut decoders, &chunk, &mut |out| {
            text.push(out);
            text.units > max_units
        })
        .map_err(decode_err)?;
        if stop {
            truncated = true;
            break;
        }
    }
    if !truncated {
        let stop = finish_chain(&mut decoders, &mut |out| {
            text.push(out);
            text.units > max_units
        })
        .map_err(decode_err)?;
        if stop || text.units > max_units {
            truncated = true;
        } else {
            text.finish();
            truncated = text.units > max_units;
        }
    }
    drop(stream); // 상한에서 끊었으면 남은 것을 계속 받지 않는다
    if truncated {
        let mut out = js::slice16(&text.out, max_units);
        out.push_str("\n…[truncated]");
        return Ok((out, true));
    }
    Ok((text.out, false))
}

// ── 실행 ────────────────────────────────────────────────────────────────

/// SSRF 가드를 유지하며 리다이렉트를 수동 추종한다 — 매 홉 Location 의 스킴·호스트를 재검사해
/// 302→메타데이터/내부주소 재발사를 막는다. 다른 오리진으로 넘어가면 자격증명 헤더를 넘기지 않는다.
async fn follow_redirects(start: &Url, method: &str, headers: Vec<(String, String)>, body: Option<SendBody>) -> Result<(reqwest::Response, String), FetchError> {
    let mut url = start.clone();
    let mut method = method.to_string();
    let mut body = body;
    let mut headers = headers;
    let mut origin = start.origin().ascii_serialization();
    for hop in 0.. {
        let res = fetch(&url, &method, &headers, body.as_ref()).await?;
        let status = res.status().as_u16();
        let location = header_get(res.headers(), "location");
        let Some(location) = location.filter(|_| (300..400).contains(&status)) else { return Ok((res, method)) };
        if hop >= MAX_REDIRECTS {
            return Ok((res, method)); // 상한 도달 시 마지막 3xx 를 그대로
        }
        // 이 홉의 본문은 안 쓴다 — 붙들고 있으면 연결이 안 풀리고, 큰 본문이면 홉마다 쌓인다.
        drop(res);
        let next = url.join(&location).map_err(|_| FetchError::invalid_url())?;
        // 스킴도 매 홉 — 302 로 file:// 이나 ftp:// 로 튀는 것을 호스트 검사만으로는 못 막는다.
        if let Some(bad) = scheme_problem(&format!("{}:", next.scheme())) {
            return Err(FetchError::new("Error", format!("BlockedScheme: 리다이렉트 대상 {bad}")));
        }
        if is_blocked_host(next.host_str().unwrap_or(""), block_private_networks()) {
            return Err(FetchError::new("Error", "BlockedHost: 리다이렉트 대상이 차단된 주소입니다(메타데이터/사설망)"));
        }
        let next_origin = next.origin().ascii_serialization();
        if next_origin != origin {
            headers = strip_credential_headers(&headers);
        }
        origin = next_origin;
        url = next;
        if status == 307 || status == 308 {
            if !matches!(body, Some(SendBody::Text(_) | SendBody::Binary { .. })) {
                body = None; // 문자열 바디만 다시 보낸다(multipart 는 안전하게 제거)
            }
        } else {
            method = "GET".into();
            body = None;
        }
    }
    unreachable!()
}

/// AbortSignal.timeout(ms) 가 실제로 기다리는 시간. Node 타이머는 1 ≤ ms ≤ 2^31-1 밖이면
/// (TimeoutOverflowWarning 을 내고) 1ms 로 바꾼다 — 그래서 3e9 같은 값은 '무제한' 이 아니라 '즉시 시간 초과' 다.
/// 여기서 2^53 으로 눌러 두면 매달린 상대가 요청을 영영 붙든다.
fn abort_timeout_ms(ms: f64) -> u64 {
    const TIMEOUT_MAX: f64 = 2_147_483_647.0;
    if !(1.0..=TIMEOUT_MAX).contains(&ms) {
        1
    } else {
        ms.trunc() as u64
    }
}

/// Final application headers and serialized body, shared by execution and preview/snippets.
fn request_parts(r: &RequestInput) -> Result<(Vec<(String, String)>, Option<SendBody>), FetchError> {
    // `headers[h.key] = h.value` — 같은 키는 자리 그대로 값만 바뀐다.
    let mut headers: Vec<(String, String)> = Vec::new();
    for h in r.headers.iter().filter(|h| h.enabled && !h.key.is_empty()) {
        match headers.iter_mut().find(|(k, _)| k == &h.key) {
            Some(slot) => slot.1 = h.value.clone(),
            None => headers.push((h.key.clone(), h.value.clone())),
        }
    }
    let method = r.method.to_uppercase();
    let has_body = r.body_type != "none" && method != "GET" && method != "HEAD";
    let is_multipart = r.body_type == "multipart";
    let has_ct = headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("content-type"));
    if has_body && !has_ct && !is_multipart {
        if let Some(ct) = default_content_type(&r.body_type) {
            headers.push(("Content-Type".into(), ct.into()));
        }
    }
    // multipart 의 Content-Type(boundary 포함)은 직렬화가 정한다 — 손으로 넣은 값이 있으면 boundary 가 빠져 깨진다.
    if is_multipart {
        headers.retain(|(k, _)| !k.eq_ignore_ascii_case("content-type"));
    }
    let body = if !has_body {
        None
    } else if r.body_type == "binary" {
        let file = build_binary_body(&r.body).map_err(|m| FetchError::new("Error", m))?;
        Some(SendBody::Binary { bytes: file.bytes, content_type: file.content_type })
    } else if is_multipart {
        let fd = build_form_data(&parse_multipart_body(&r.body)).map_err(|m| {
            let (name, msg) = m.split_once(": ").unwrap_or(("Error", &m));
            FetchError::new(name, msg)
        })?;
        Some(SendBody::Form { bytes: fd.bytes, content_type: fd.content_type })
    } else {
        Some(SendBody::Text(gql_wrap(&r.body_type, &r.body)))
    };
    Ok((headers, body))
}

/// The preview uses the exact header defaults and serialization used by fetch.
pub fn prepared_input(r: &RequestInput) -> Result<RequestInput, FetchError> {
    let (headers, body) = request_parts(r)?;
    let mut out = r.clone();
    // Unknown variables may leave the URL incomplete; preserve them for editing.
    if let Ok(mut url) = Url::parse(&r.url) {
        merge_query_params(&mut url, &r.params);
        out.url = url.to_string().replace("%7B", "{").replace("%7D", "}");
        out.params.clear();
    }
    let map = wire_headers(&r.url, &r.method.to_uppercase(), &headers, body.as_ref())?;
    out.headers = map.iter().map(|(key, value)| {
        let name = headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(key.as_str())).map(|(k, _)| k.as_str()).unwrap_or(key.as_str());
        crate::resolve::Kv::new(name, &String::from_utf8_lossy(value.as_bytes()))
    }).collect();
    match body {
        None => { out.body_type = "none".into(); out.body.clear(); }
        Some(SendBody::Text(text)) => { out.body_type = "raw".into(); out.body = text; }
        Some(SendBody::Form { bytes, content_type }) => {
            // Preserve the exact boundary/body together; code generators use a local file.
            use base64::Engine;
            out.body_type = "binary".into();
            out.body = serde_json::json!({"filename": "multipart-body.bin", "contentType": content_type,
                "dataBase64": base64::engine::general_purpose::STANDARD.encode(bytes)}).to_string();
        }
        Some(SendBody::Binary { .. }) => {}
    }
    Ok(out)
}

/// 해석이 끝난 요청을 보낸다. 실패(잘못된 URL·차단·네트워크·시간 초과)는 throw 대신 error 로 돌려준다.
pub async fn execute_request(r: &RequestInput, settings: &RequestSettings) -> ExecResult {
    let missing_path = extract_path_parameters(&r.url);
    if !missing_path.is_empty() {
        return ExecResult { duration_ms: 0, error: Some(format!("경로 파라미터를 입력하세요: {}", missing_path.join(", "))), ..Default::default() };
    }
    let started = Instant::now();
    // AbortSignal.timeout(ms) — 정수 ms. 연결·헤더·본문 읽기 전체에 걸린다.
    let deadline = tokio::time::Instant::now() + Duration::from_millis(abort_timeout_ms(settings.timeout_ms.filter(|t| *t > 0.0).unwrap_or(DEFAULT_TIMEOUT_MS)));
    let run = async {
        let mut url = Url::parse(&r.url).map_err(|_| FetchError::invalid_url())?;
        // 스킴 먼저 — file://·ftp:// 는 fetch 가 '우연히' 못 보내던 것이라 알 수 없는 말이 떴다.
        if let Some(bad) = scheme_problem(&format!("{}:", url.scheme())) {
            return Ok(Err(format!("BlockedScheme: {bad}")));
        }
        // 메타데이터 차단(기본). BLOCK_PRIVATE_NETWORKS/EGRESS_MODE=public 이면 사설망까지 전면 차단.
        if is_blocked_host(url.host_str().unwrap_or(""), block_private_networks()) {
            return Ok(Err("BlockedHost: 이 주소로는 요청할 수 없습니다(메타데이터/사설망 차단)".to_string()));
        }
        merge_query_params(&mut url, &r.params);
        let method = r.method.to_uppercase();
        let (headers, body) = request_parts(r)?;
        // 리다이렉트: 기본은 미추종(302→메타데이터 재발사 SSRF 방지). followRedirects 면 각 홉 재검사하며 추종.
        let (res, final_method) = if settings.follow_redirects {
            follow_redirects(&url, &method, headers, body).await?
        } else {
            (fetch(&url, &method, &headers, body.as_ref()).await?, method.clone())
        };
        let status = res.status().as_u16();
        let resp_headers = response_headers(res.headers());
        let set_cookies = set_cookie_lines(res.headers());
        // HEAD·204/205/304 는 본문이 없고 undici 도 풀지 않는다.
        let skip = final_method == "HEAD" || matches!(status, 101 | 204 | 205 | 304);
        let (body, truncated) = read_body_capped(res, MAX_BODY_CHARS, skip).await?;
        Ok::<_, FetchError>(Ok((status, resp_headers, body, truncated, set_cookies)))
    };
    match tokio::time::timeout_at(deadline, run).await {
        Err(_) => ExecResult::failed(started, FetchError::timeout().describe()),
        Ok(Err(e)) => ExecResult::failed(started, e.describe()),
        Ok(Ok(Err(blocked))) => ExecResult::failed(started, blocked),
        Ok(Ok(Ok((status, headers, body, truncated, set_cookies)))) => ExecResult {
            status: Some(status),
            headers: Some(headers),
            body: Some(body),
            duration_ms: elapsed_ms(started),
            error: None,
            truncated: Some(truncated),
            set_cookies,
        },
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::resolve::Kv;
    use std::io::Write as _;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// 테스트용 HTTP 서버 — 받은 요청 원문을 모으고, handler 가 돌려준 원시 응답을 그대로 쓴다.
    pub struct Mock {
        pub base: String,
        pub seen: Arc<Mutex<Vec<String>>>,
    }

    pub async fn mock(handler: impl Fn(&str, &str, u16) -> Vec<u8> + Send + Sync + 'static) -> Mock {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s2 = seen.clone();
        let handler = Arc::new(handler);
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { return };
                let seen = s2.clone();
                let handler = handler.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut tmp = [0u8; 65536];
                    // 머리 + content-length 만큼 읽는다
                    loop {
                        let n = sock.read(&mut tmp).await.unwrap_or(0);
                        if n == 0 {
                            break;
                        }
                        buf.extend_from_slice(&tmp[..n]);
                        let text = String::from_utf8_lossy(&buf).to_string();
                        if let Some(end) = text.find("\r\n\r\n") {
                            let cl = text[..end]
                                .lines()
                                .find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                                .unwrap_or(0);
                            if buf.len() >= end + 4 + cl {
                                break;
                            }
                        }
                    }
                    let req = String::from_utf8_lossy(&buf).to_string();
                    let line = req.lines().next().unwrap_or("").to_string();
                    let path = line.split(' ').nth(1).unwrap_or("").to_string();
                    seen.lock().unwrap().push(req.clone());
                    let out = handler(&path, &req, port);
                    let _ = sock.write_all(&out).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        Mock { base: format!("http://127.0.0.1:{port}"), seen }
    }

    pub fn resp(status: &str, headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
        let mut out = format!("HTTP/1.1 {status}\r\nconnection: close\r\ncontent-length: {}\r\n", body.len());
        for (k, v) in headers {
            out.push_str(&format!("{k}: {v}\r\n"));
        }
        out.push_str("\r\n");
        let mut b = out.into_bytes();
        b.extend_from_slice(body);
        b
    }

    /// 요청 원문 → (머리 줄들 소문자, 바디)
    pub fn split(req: &str) -> (String, String) {
        let (h, b) = req.split_once("\r\n\r\n").unwrap_or((req, ""));
        (h.to_lowercase(), b.to_string())
    }

    fn input(method: &str, url: &str) -> RequestInput {
        RequestInput { method: method.into(), url: url.into(), params: vec![], headers: vec![], body_type: "none".into(), body: String::new() }
    }

    async fn echo() -> Mock {
        mock(|path, req, port| {
            let (h, b) = split(req);
            match path {
                "/huge" => resp("200 OK", &[("content-type", "text/plain")], "x".repeat(1_048_576 + 500).as_bytes()),
                "/redirect" => resp("302 Found", &[("location", "/orders")], b"REDIRECT-TARGET-SHOULD-NOT-APPEAR"),
                "/redir-cross" => resp("302 Found", &[("location", &format!("http://localhost:{port}/hdrs"))], b""),
                "/redir-same" => resp("307 Temporary Redirect", &[("location", "/hdrs")], b""),
                "/to-meta" => resp("302 Found", &[("location", "http://169.254.169.254/latest/meta-data")], b""),
                "/to-file" => resp("302 Found", &[("location", "file:///etc/passwd")], b""),
                "/loop" => resp("302 Found", &[("location", "/loop")], b""),
                "/303" => resp("303 See Other", &[("location", "/echo")], b""),
                "/308" => resp("308 Permanent Redirect", &[("location", "/echo")], b""),
                "/gzip" => {
                    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
                    e.write_all("압축된 본문".as_bytes()).unwrap();
                    resp("200 OK", &[("content-type", "text/plain; charset=utf-8"), ("content-encoding", "gzip")], &e.finish().unwrap())
                }
                "/deflate" => {
                    let mut e = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
                    e.write_all(b"zlib body").unwrap();
                    resp("200 OK", &[("content-encoding", "deflate")], &e.finish().unwrap())
                }
                "/latin1" => resp("200 OK", &[("content-type", "text/plain; charset=\"ISO-8859-1\"")], &[0x63, 0x61, 0x66, 0xE9, 0x80]),
                "/cookies" => resp("200 OK", &[("set-cookie", "a=1; Path=/"), ("set-cookie", "b=2"), ("x-dup", "1"), ("x-dup", "2"), ("X-Upper", "u")], b"ok"),
                _ => {
                    // 이름은 대소문자 무시, 값은 원문 그대로(split 은 머리 전체를 소문자로 만든다).
                    let raw_head = req.split_once("\r\n\r\n").map_or(req, |(a, _)| a);
                    let find = |name: &str| {
                        raw_head.lines().find_map(|l| {
                            let (k, v) = l.split_once(": ")?;
                            k.eq_ignore_ascii_case(name).then(|| v.to_string())
                        })
                    };
                    let (auth, cookie, ct) = (find("authorization"), find("cookie"), find("content-type"));
                    let method = req.split(' ').next().unwrap_or("").to_string();
                    let j = serde_json::json!({ "path": path, "method": method, "body": b, "auth": auth, "cookie": cookie, "ct": ct, "head": h });
                    resp("200 OK", &[("content-type", "application/json")], j.to_string().as_bytes())
                }
            }
        })
        .await
    }

    fn body_json(r: &ExecResult) -> Value {
        serde_json::from_str(r.body.as_deref().unwrap()).unwrap()
    }

    #[tokio::test]
    async fn 쿼리_헤더_바디가_전달되고_응답을_캡처() {
        let m = echo().await;
        let mut i = input("POST", &format!("{}/orders", m.base));
        i.params = vec![Kv::new("a", "1"), Kv { enabled: false, ..Kv::new("b", "2") }];
        i.headers = vec![Kv::new("Authorization", "Bearer t")];
        i.body_type = "json".into();
        i.body = r#"{"x":1}"#.into();
        let r = execute_request(&i, &RequestSettings::default()).await;
        assert_eq!(r.status, Some(200), "{:?}", r.error);
        let e = body_json(&r);
        assert_eq!(e["path"], "/orders?a=1");
        assert_eq!(e["method"], "POST");
        assert_eq!(e["body"], r#"{"x":1}"#);
        assert_eq!(e["auth"], "Bearer t");
        assert_eq!(e["ct"], "application/json");
        // Node fetch 의 기본 헤더
        let head = e["head"].as_str().unwrap();
        for h in ["accept: */*", "user-agent: node", "accept-language: *", "sec-fetch-mode: cors", "accept-encoding: gzip, deflate"] {
            assert!(head.contains(h), "{h}");
        }
        assert_eq!(r.truncated, Some(false));
        // 응답 헤더는 소문자 이름순
        let names: Vec<&str> = r.headers.as_ref().unwrap().iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(names, ["connection", "content-length", "content-type"]);
    }

    #[tokio::test]
    async fn 쿼리_병합_폼_기본_ct_명시_ct_raw_기본_ct() {
        let m = echo().await;
        let mut i = input("GET", &format!("{}/x?foo=1&keep=9", m.base));
        i.params = vec![Kv::new("foo", "2")];
        assert_eq!(body_json(&execute_request(&i, &RequestSettings::default()).await)["path"], "/x?keep=9&foo=2");

        let mut i = input("POST", &format!("{}/form", m.base));
        i.body_type = "form".into();
        i.body = "a=1&b=2".into();
        let e = body_json(&execute_request(&i, &RequestSettings::default()).await);
        assert_eq!(e["ct"], "application/x-www-form-urlencoded");
        assert_eq!(e["body"], "a=1&b=2");

        let mut i = input("POST", &format!("{}/ct", m.base));
        i.body_type = "json".into();
        i.body = "{}".into();
        i.headers = vec![Kv::new("content-type", "application/vnd.custom+json")];
        assert_eq!(body_json(&execute_request(&i, &RequestSettings::default()).await)["ct"], "application/vnd.custom+json");

        // raw 바디는 fetch 의 문자열 기본값
        let mut i = input("POST", &format!("{}/raw", m.base));
        i.body_type = "raw".into();
        i.body = "hello".into();
        assert_eq!(body_json(&execute_request(&i, &RequestSettings::default()).await)["ct"], "text/plain;charset=UTF-8");

        // 본문 없는 POST 는 content-length: 0
        let e = body_json(&execute_request(&input("POST", &format!("{}/empty", m.base)), &RequestSettings::default()).await);
        assert!(e["head"].as_str().unwrap().contains("content-length: 0"));
    }

    #[tokio::test]
    async fn 접속_불가_잘못된_url_금지_포트_자격증명_url() {
        let r = execute_request(&input("GET", "http://127.0.0.1:1"), &RequestSettings::default()).await;
        assert_eq!(r.status, None);
        assert_eq!(r.error.as_deref(), Some("TypeError: fetch failed (bad port)"));
        assert_eq!(r.truncated, None);
        let r = execute_request(&input("GET", "notaurl"), &RequestSettings::default()).await;
        assert_eq!(r.error.as_deref(), Some("TypeError: Invalid URL"));
        // 닫힌 포트
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        let r = execute_request(&input("GET", &format!("http://127.0.0.1:{port}/")), &RequestSettings::default()).await;
        assert_eq!(r.error.as_deref(), Some(format!("ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:{port}").as_str()));
        let r = execute_request(&input("GET", "http://u:p@127.0.0.1:9999/"), &RequestSettings::default()).await;
        assert!(r.error.unwrap().starts_with("TypeError: Request cannot be constructed from a URL that includes credentials"));
    }

    #[tokio::test]
    async fn 스킴과_차단_호스트는_보내기_전에_막는다() {
        let r = execute_request(&input("GET", "file:///etc/passwd"), &RequestSettings::default()).await;
        assert_eq!(r.error.as_deref(), Some("BlockedScheme: file:// 는 보낼 수 없습니다 — http:// 또는 https:// 만 지원합니다"));
        for u in ["http://169.254.169.254/latest", "http://[::ffff:169.254.169.254]/", "http://2852039166/", "http://metadata.google.internal/"] {
            let r = execute_request(&input("GET", u), &RequestSettings::default()).await;
            assert_eq!(r.error.as_deref(), Some("BlockedHost: 이 주소로는 요청할 수 없습니다(메타데이터/사설망 차단)"), "{u}");
        }
    }

    #[tokio::test]
    async fn 응답은_상한에서_잘린다() {
        let m = echo().await;
        let r = execute_request(&input("GET", &format!("{}/huge", m.base)), &RequestSettings::default()).await;
        assert_eq!(r.status, Some(200));
        assert_eq!(r.truncated, Some(true));
        let b = r.body.unwrap();
        assert!(b.ends_with("\n…[truncated]"));
        assert_eq!(js::len16(&b), MAX_BODY_CHARS + "\n…[truncated]".len() - 2); // '…' 는 UTF-8 3바이트·UTF-16 1단위
    }

    #[tokio::test]
    async fn 리다이렉트는_기본_미추종() {
        let m = echo().await;
        let r = execute_request(&input("GET", &format!("{}/redirect", m.base)), &RequestSettings::default()).await;
        assert_eq!(r.status, Some(302));
        assert!(!r.body.unwrap().contains("\"path\":\"/orders\""));
        assert_eq!(m.seen.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn follow_redirects_는_가드하며_추종한다() {
        let m = echo().await;
        let follow = RequestSettings { follow_redirects: true, timeout_ms: None };
        let r = execute_request(&input("GET", &format!("{}/redirect", m.base)), &follow).await;
        assert_eq!(r.status, Some(200));
        assert_eq!(body_json(&r)["path"], "/orders");

        // 다른 오리진(localhost)으로 넘어가면 Authorization·Cookie·Proxy-Authorization 을 떼어 낸다.
        let mut i = input("GET", &format!("{}/redir-cross", m.base));
        i.headers = vec![Kv::new("Authorization", "Bearer SECRET"), Kv::new("Cookie", "sid=xyz"), Kv::new("Proxy-Authorization", "Basic x"), Kv::new("X-Trace", "1")];
        let e = body_json(&execute_request(&i, &follow).await);
        assert_eq!(e["auth"], Value::Null);
        assert_eq!(e["cookie"], Value::Null);
        assert!(!e["head"].as_str().unwrap().contains("proxy-authorization"));
        assert!(e["head"].as_str().unwrap().contains("x-trace: 1"));

        // 같은 오리진이면 유지, 307 은 메서드·바디 유지
        let mut i = input("POST", &format!("{}/redir-same", m.base));
        i.headers = vec![Kv::new("Authorization", "Bearer KEEP")];
        i.body_type = "json".into();
        i.body = r#"{"k":1}"#.into();
        let e = body_json(&execute_request(&i, &follow).await);
        assert_eq!(e["auth"], "Bearer KEEP");
        assert_eq!(e["method"], "POST");
        assert_eq!(e["body"], r#"{"k":1}"#);

        // 303 → GET·바디 제거, 308 → 유지
        i.url = format!("{}/303", m.base);
        let e = body_json(&execute_request(&i, &follow).await);
        assert_eq!((e["method"].as_str(), e["body"].as_str()), (Some("GET"), Some("")));
        i.url = format!("{}/308", m.base);
        let e = body_json(&execute_request(&i, &follow).await);
        assert_eq!((e["method"].as_str(), e["body"].as_str()), (Some("POST"), Some(r#"{"k":1}"#)));
    }

    #[tokio::test]
    async fn 리다이렉트_홉마다_ssrf_가드를_다시_본다() {
        let m = echo().await;
        let follow = RequestSettings { follow_redirects: true, timeout_ms: None };
        let r = execute_request(&input("GET", &format!("{}/to-meta", m.base)), &follow).await;
        assert_eq!(r.error.as_deref(), Some("Error: BlockedHost: 리다이렉트 대상이 차단된 주소입니다(메타데이터/사설망)"));
        let r = execute_request(&input("GET", &format!("{}/to-file", m.base)), &follow).await;
        assert_eq!(r.error.as_deref(), Some("Error: BlockedScheme: 리다이렉트 대상 file:// 는 보낼 수 없습니다 — http:// 또는 https:// 만 지원합니다"));
        // 미추종이면 3xx 를 그대로 돌려준다(가드 대상이 아니다)
        let r = execute_request(&input("GET", &format!("{}/to-meta", m.base)), &RequestSettings::default()).await;
        assert_eq!(r.status, Some(302));
        // 상한: 5번 따라간 뒤의 3xx 를 그대로
        let before = m.seen.lock().unwrap().len();
        let r = execute_request(&input("GET", &format!("{}/loop", m.base)), &follow).await;
        assert_eq!(r.status, Some(302));
        assert_eq!(m.seen.lock().unwrap().len() - before, MAX_REDIRECTS + 1);
    }

    #[test]
    fn 자격증명_헤더_제거는_대소문자_무시() {
        let h: Vec<(String, String)> = [("Authorization", "Bearer x"), ("COOKIE", "a=1"), ("X-Trace", "1"), ("content-type", "application/json"), ("proxy-Authorization", "p")]
            .iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect();
        assert_eq!(strip_credential_headers(&h), vec![("X-Trace".to_string(), "1".to_string()), ("content-type".to_string(), "application/json".to_string())]);
    }

    #[tokio::test]
    async fn 압축_문자셋_set_cookie_헤더_모양() {
        let m = echo().await;
        let r = execute_request(&input("GET", &format!("{}/gzip", m.base)), &RequestSettings::default()).await;
        assert_eq!(r.body.as_deref(), Some("압축된 본문"));
        // content-encoding 헤더는 그대로 남는다
        assert!(r.headers.as_ref().unwrap().iter().any(|(k, v)| k == "content-encoding" && v == "gzip"));
        let r = execute_request(&input("GET", &format!("{}/deflate", m.base)), &RequestSettings::default()).await;
        assert_eq!(r.body.as_deref(), Some("zlib body"));
        let r = execute_request(&input("GET", &format!("{}/latin1", m.base)), &RequestSettings::default()).await;
        assert_eq!(r.body.as_deref(), Some("café€"));
        let r = execute_request(&input("GET", &format!("{}/cookies", m.base)), &RequestSettings::default()).await;
        assert_eq!(r.set_cookies, ["a=1; Path=/", "b=2"]);
        let h = r.headers.unwrap();
        assert!(h.contains(&("set-cookie".to_string(), "b=2".to_string())));
        assert!(h.contains(&("x-dup".to_string(), "1, 2".to_string())));
        assert!(h.contains(&("x-upper".to_string(), "u".to_string())));
    }

    #[test]
    fn utf8_스트림은_청크_경계와_bom_을_다룬다() {
        let mut t = TextStream::new(encoding_rs::UTF_8);
        for b in "\u{FEFF}가나".as_bytes() {
            t.push(&[*b]);
        }
        t.push(&[0xFF, 0xEA]);
        t.finish();
        assert_eq!(t.out, "가나\u{FFFD}\u{FFFD}");
    }

    #[test]
    fn textdecoder_가_아는_문자셋은_다_푼다() {
        let decode = |ct: &str, bytes: &[u8]| {
            let mut t = TextStream::new(charset_of(Some(ct)));
            // 한 바이트씩 — 청크 경계에서 2바이트 글자가 끊겨도 이어 푸는지
            for b in bytes {
                t.push(&[*b]);
            }
            t.finish();
            t.out
        };
        // "한글 응답" 의 EUC-KR (codex 리뷰 재현값). 예전엔 "�ѱ� ����" 이 됐다.
        assert_eq!(decode("text/plain; charset=EUC-KR", &[0xC7, 0xD1, 0xB1, 0xDB, 0x20, 0xC0, 0xC0, 0xB4, 0xE4]), "한글 응답");
        assert_eq!(decode("text/plain;charset=\"Shift_JIS\"", &[0x82, 0xA0]), "あ");
        assert_eq!(decode("text/plain; charset=utf-16le", &[0xFF, 0xFE, 0x41, 0x00]), "A", "같은 인코딩의 BOM 은 지운다");
        assert_eq!(decode("text/html;charset='latin1'", &[0x63, 0x61, 0x66, 0xE9, 0x80]), "café€", "latin1 은 windows-1252");
        // 모르는 라벨·replacement 라벨은 utf-8 로
        assert_eq!(charset_of(Some("text/plain; charset=nope")), encoding_rs::UTF_8);
        assert_eq!(charset_of(Some("text/plain; charset=iso-2022-kr")), encoding_rs::UTF_8);
        assert_eq!(charset_of(None), encoding_rs::UTF_8);
    }

    #[tokio::test]
    async fn 시간_초과는_timeout_error() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (_s, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(5)).await;
        });
        let r = execute_request(&input("GET", &format!("http://127.0.0.1:{port}/")), &RequestSettings { follow_redirects: false, timeout_ms: Some(200.0) }).await;
        assert_eq!(r.error.as_deref(), Some("TimeoutError: The operation was aborted due to timeout"));
    }

    #[tokio::test]
    async fn binary_preserves_bytes_mime_and_redirects() {
        use base64::Engine;
        let router = axum::Router::new().route("/file", axum::routing::any(|headers: axum::http::HeaderMap, bytes: axum::body::Bytes| async move {
            axum::Json(serde_json::json!({ "b64": base64::engine::general_purpose::STANDARD.encode(bytes), "ct": headers.get("content-type").unwrap().to_str().unwrap() }))
        })).route("/redirect", axum::routing::any(|| async { axum::response::Redirect::temporary("/file") }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let mut i = input("POST", &format!("http://{addr}/redirect"));
        i.body_type = "binary".into();
        i.body = serde_json::json!({ "filename": "x.bin", "contentType": "application/x-test", "dataBase64": "AAH/gA0K" }).to_string();
        let result = body_json(&execute_request(&i, &RequestSettings { follow_redirects: true, timeout_ms: None }).await);
        assert_eq!(result["b64"], "AAH/gA0K");
        assert_eq!(result["ct"], "application/x-test");
        i.headers = vec![Kv::new("Content-Type", "custom/type")];
        let result = body_json(&execute_request(&i, &RequestSettings { follow_redirects: true, timeout_ms: None }).await);
        assert_eq!(result["ct"], "custom/type");
        i.body = serde_json::json!({ "dataBase64": "" }).to_string();
        assert_eq!(body_json(&execute_request(&i, &RequestSettings { follow_redirects: true, timeout_ms: None }).await)["b64"], "");
        i.body = serde_json::json!({ "filename": "/private/file", "dataBase64": null }).to_string();
        assert!(execute_request(&i, &RequestSettings::default()).await.error.unwrap().contains("다시 첨부"));
        i.body = serde_json::json!({ "dataBase64": "not base64!" }).to_string();
        assert!(execute_request(&i, &RequestSettings::default()).await.error.is_some());
        task.abort();
    }

    #[tokio::test]
    async fn multipart_는_파일을_보낸다() {
        let m = echo().await;
        let mut i = input("POST", &format!("{}/upload", m.base));
        i.body_type = "multipart".into();
        i.headers = vec![Kv::new("Content-Type", "multipart/form-data")]; // boundary 없는 수동 값은 지운다
        i.body = serde_json::json!({ "fields": [{ "name": "title", "value": "doc" }], "files": [{ "name": "file", "filename": "a.txt", "contentType": "text/plain", "dataBase64": "aGk=" }] }).to_string();
        let e = body_json(&execute_request(&i, &RequestSettings::default()).await);
        let body = e["body"].as_str().unwrap();
        assert!(body.contains("name=\"title\""));
        assert!(body.contains("filename=\"a.txt\""));
        assert!(body.contains("hi"));
        assert!(e["ct"].as_str().unwrap().starts_with("multipart/form-data; boundary=----formdata-undici-0"));
    }

    #[tokio::test]
    async fn 경로_값_누락은_전송_전에_거부() {
        let r = execute_request(&input("GET", "http://127.0.0.1:9/orders/{serialCode}"), &RequestSettings::default()).await;
        assert_eq!(r.error.as_deref(), Some("경로 파라미터를 입력하세요: serialCode"));
        assert_eq!(r.status, None);
        assert_eq!(r.duration_ms, 0);
    }

    #[test]
    fn describe_error_모양() {
        assert_eq!(FetchError::fetch_failed(Some("ECONNREFUSED"), "connect ECONNREFUSED 1.2.3.4:5").describe(), "ECONNREFUSED: connect ECONNREFUSED 1.2.3.4:5");
        assert_eq!(FetchError::fetch_failed(None, "bad port").describe(), "TypeError: fetch failed (bad port)");
        assert_eq!(FetchError::invalid_url().describe(), "TypeError: Invalid URL");
    }

    /// `head -c 268435456 /dev/zero | brotli -q 11` — 211바이트가 256MB 로 풀린다(압축률 10^6:1 이상).
    const BR_BOMB_256M: &[u8] = &[0xcf, 0xff, 0xff, 0x7f, 0xf8, 0x27, 0x00, 0xe2, 0xb1, 0x40, 0x20, 0xf7, 0xfe, 0x9f, 0xff, 0xff, 0xff, 0xf0, 0x4f, 0x00, 0xc4, 0x61, 0x01, 0x80, 0xee, 0xfd, 0x3f, 0xff, 0xff, 0xff, 0xe1, 0x9f, 0x00, 0x88, 0xc3, 0x22, 0x00, 0xdd, 0xfb, 0x7f, 0xfe, 0xff, 0xff, 0xc3, 0x3f, 0x01, 0x10, 0x87, 0x05, 0x00, 0xba, 0xf7, 0xff, 0xfc, 0xff, 0xff, 0x87, 0x7f, 0x02, 0x20, 0x0e, 0x0b, 0x00, 0x74, 0xef, 0xff, 0xf9, 0xff, 0xff, 0x0f, 0xff, 0x04, 0x40, 0x1c, 0x16, 0x00, 0xe8, 0xde, 0xff, 0xf3, 0xff, 0xff, 0x1f, 0xfe, 0x09, 0x80, 0x38, 0x2c, 0x00, 0xd0, 0xbd, 0xff, 0xe7, 0xff, 0xff, 0x3f, 0xfc, 0x13, 0x00, 0x71, 0x58, 0x00, 0xa0, 0x7b, 0xff, 0xcf, 0xff, 0xff, 0x7f, 0xf8, 0x27, 0x00, 0xe2, 0xb0, 0x00, 0x40, 0xf7, 0xfe, 0x9f, 0xff, 0xff, 0xff, 0xf0, 0x4f, 0x00, 0xc4, 0x61, 0x01, 0x80, 0xee, 0xfd, 0x3f, 0xff, 0xff, 0xff, 0xe1, 0x9f, 0x00, 0x88, 0xc3, 0x02, 0x00, 0xdd, 0xfb, 0x7f, 0xfe, 0xff, 0xff, 0xc3, 0x3f, 0x01, 0x10, 0x87, 0x05, 0x00, 0xba, 0xf7, 0xff, 0xfc, 0xff, 0xff, 0x87, 0x7f, 0x02, 0x20, 0x0e, 0x0b, 0x00, 0x74, 0xef, 0xff, 0xf9, 0xff, 0xff, 0x0f, 0xff, 0x04, 0x40, 0x1c, 0x16, 0x00, 0xe8, 0xde, 0xff, 0xf3, 0xff, 0xff, 0x1f, 0xfe, 0x09, 0x80, 0x38, 0x2c, 0x00, 0xd0, 0xbd, 0xff, 0xe7, 0xff, 0xff, 0x3f, 0xfc, 0x13, 0x00, 0x71, 0x58, 0x00, 0xa0, 0x7b, 0xff, 0x3f];
    /// brotli 로 압축한 "hello\n"(brotli-decompressor 의 테스트 벡터).
    const BR_HELLO: &[u8] = b"\x8f\x02\x80\x68\x65\x6c\x6c\x6f\x0a\x03";

    /// 해제 사슬에 bomb 을 넣고 last 가 받은 조각들을 잰다 — (가장 큰 조각, 멈출 때까지 받은 총량).
    fn measure(decoders: &mut [Decoder], data: &[u8], cap: usize) -> (usize, usize, bool) {
        let (mut max_piece, mut total) = (0usize, 0usize);
        let mut last = |out: &[u8]| {
            max_piece = max_piece.max(out.len());
            total += out.len();
            total > cap
        };
        // flate2 는 마지막 걸음의 출력을 내부 버퍼에 들고 있다가 finish 에서 내놓는다 — 끝까지 돌려서 잰다.
        let stop = decode_chain(decoders, data, &mut last).unwrap() || finish_chain(decoders, &mut last).unwrap();
        (max_piece, total, stop)
    }

    #[test]
    fn brotli_폭탄은_상한_근처에서_멈춘다() {
        // 예전엔 청크 하나를 통째로 풀어 Vec 에 쌓은 뒤 상한을 봤다 — 211바이트가 256MB 로 부푼 다음이었다.
        let mut d = decoders_for(Some("br"));
        let (max_piece, total, stop) = measure(&mut d, BR_BOMB_256M, MAX_BODY_CHARS);
        assert!(stop);
        assert!(max_piece <= DECODE_STEP, "조각 {max_piece}");
        assert!(total <= MAX_BODY_CHARS + DECODE_STEP, "총 {total}");
    }

    #[test]
    fn 겹친_압축도_단계마다_조각으로_흐른다() {
        // content-encoding: br, gzip — 바깥 gzip 을 풀면 brotli 폭탄이 나온다. 중간 단계도 통째로 쌓지 않는다.
        let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        e.write_all(BR_BOMB_256M).unwrap();
        let gz = e.finish().unwrap();
        let mut d = decoders_for(Some("br, gzip"));
        let (max_piece, total, stop) = measure(&mut d, &gz, MAX_BODY_CHARS);
        assert!(stop && max_piece <= DECODE_STEP && total <= MAX_BODY_CHARS + DECODE_STEP, "{max_piece} {total}");

        // gzip 폭탄(16MB 0) 도 마찬가지
        let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
        e.write_all(&vec![0u8; 16 << 20]).unwrap();
        let gz = e.finish().unwrap();
        let mut d = decoders_for(Some("gzip"));
        let (max_piece, total, stop) = measure(&mut d, &gz, MAX_BODY_CHARS);
        assert!(stop && max_piece <= DECODE_STEP && total <= MAX_BODY_CHARS + DECODE_STEP, "{max_piece} {total}");
    }

    #[test]
    fn brotli_는_조각_경계와_끝을_다룬다() {
        // 한 바이트씩 넣어도, 끝에서 finish 로 비워도 같은 결과.
        let mut d = decoders_for(Some("br"));
        let mut got = Vec::new();
        for b in BR_HELLO {
            decode_chain(&mut d, &[*b], &mut |o| {
                got.extend_from_slice(o);
                false
            })
            .unwrap();
        }
        finish_chain(&mut d, &mut |o| {
            got.extend_from_slice(o);
            false
        })
        .unwrap();
        assert_eq!(got, b"hello\n");
        // 스트림이 끝난 뒤 꼬리 바이트는 깨진 본문(예전 write_all 과 같다)
        let mut d = decoders_for(Some("br"));
        let mut tail = BR_HELLO.to_vec();
        tail.extend_from_slice(b"junk");
        assert!(decode_chain(&mut d, &tail, &mut |_| false).is_err());
        // 깨진 brotli
        let mut d = decoders_for(Some("br"));
        assert!(decode_chain(&mut d, &[0xFF; 16], &mut |_| false).is_err());
    }

    #[tokio::test]
    async fn brotli_폭탄_응답은_잘리고_본문은_1mb() {
        let m = mock(|path, _req, _| match path {
            "/bomb" => resp("200 OK", &[("content-type", "text/plain"), ("content-encoding", "br")], BR_BOMB_256M),
            _ => resp("200 OK", &[("content-encoding", "br")], BR_HELLO),
        })
        .await;
        let r = execute_request(&input("GET", &format!("{}/bomb", m.base)), &RequestSettings::default()).await;
        assert_eq!((r.status, r.truncated), (Some(200), Some(true)));
        let b = r.body.unwrap();
        assert_eq!(js::len16(&b), MAX_BODY_CHARS + js::len16("\n…[truncated]"));
        let r = execute_request(&input("GET", &format!("{}/hello", m.base)), &RequestSettings::default()).await;
        assert_eq!((r.body.as_deref(), r.truncated), (Some("hello\n"), Some(false)));
    }

    #[test]
    fn abort_timeout_은_node_타이머_범위를_따른다() {
        assert_eq!(abort_timeout_ms(30_000.0), 30_000);
        assert_eq!(abort_timeout_ms(1500.7), 1500);
        assert_eq!(abort_timeout_ms(2_147_483_647.0), 2_147_483_647);
        // 2^31-1 을 넘으면 Node 는 1ms 로 바꾼다(TimeoutOverflowWarning) — 무제한이 아니다.
        assert_eq!(abort_timeout_ms(2_147_483_648.0), 1);
        assert_eq!(abort_timeout_ms(3e9), 1);
        assert_eq!(abort_timeout_ms(1e15), 1);
        assert_eq!(abort_timeout_ms(0.5), 1);
    }

    #[tokio::test]
    async fn 너무_큰_timeout_은_즉시_시간_초과() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (_s, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(30)).await;
        });
        let t = Instant::now();
        let r = execute_request(&input("GET", &format!("http://127.0.0.1:{port}/")), &RequestSettings { follow_redirects: false, timeout_ms: Some(1e15) }).await;
        assert_eq!(r.error.as_deref(), Some("TimeoutError: The operation was aborted due to timeout"));
        assert!(t.elapsed() < Duration::from_secs(5));
    }
}
