//! 요청 해석(스코프 맵과 로더는 [`crate::variables`]).
//!
//! 다른 그룹(시나리오·스케줄·MCP)이 같은 규칙으로 요청을 풀도록 여기 하나로 둔다. 치환 규칙이 경로마다
//! 다르면 같은 요청이 화면·시나리오에서 다른 값으로 나간다.
//!
//! 공개 API
//! - 타입: [`Kv`], [`RequestInput`], [`RequestSettings`], [`Resolved`], [`NameSet`]
//! - [`resolve_request`] — `{{var}}`·`{경로}` 치환. real(보낼 것)·redacted(secret 은 참조 그대로)·missing(정렬).
//! - [`resolve_text`]·[`references_secret`]·[`extract_variables`]·[`extract_path_parameters`]
//! - [`dynamic_vars`] — `{{$timestamp}}` 등, 실행 1회에 한 번만 만든다.
//! - [`overlay_kv_vars`]·[`apply_personal_vars`] — 스코프 오버레이(전역 < 환경 < 요청 < 개인).
//! - [`default_content_type`]·[`gql_wrap`]·[`merge_query_params`] — 실행·cURL·코드생성이 같은 규칙을 쓰게.
//! - [`normalize_request_input`] — 라우트 입력 방어.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

use crate::js;
use crate::json_format;
use crate::request_fields::{is_body_type, is_http_method};
use crate::scrub::{JS_SPACE, VAR_NAME_CHARS};
use crate::variables::{Var, VarMap};

/// 요청의 키-값 한 줄(params·headers). description 은 폴더 공통 헤더처럼 원래 있던 것만 싣는다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Kv {
    pub key: String,
    pub value: String,
    pub enabled: bool,
    pub description: Option<String>,
}

impl Kv {
    pub fn new(key: &str, value: &str) -> Self {
        Kv { key: key.into(), value: value.into(), enabled: true, description: None }
    }

    /// `{ key, value, enabled, description? }` — Node 객체의 키 순서 그대로.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("key".into(), Value::String(self.key.clone()));
        m.insert("value".into(), Value::String(self.value.clone()));
        m.insert("enabled".into(), Value::Bool(self.enabled));
        if let Some(d) = &self.description {
            m.insert("description".into(), Value::String(d.clone()));
        }
        Value::Object(m)
    }

    /// to_kv_array 가 정규화한 객체(또는 같은 모양)에서.
    pub fn from_json(v: &Value) -> Kv {
        let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        Kv {
            key: s("key"),
            value: s("value"),
            enabled: v.get("enabled") != Some(&Value::Bool(false)),
            description: v.get("description").and_then(Value::as_str).map(str::to_string),
        }
    }

    /// 정규화를 안 거친 클라이언트 KV(graphql introspect 의 headers) — JS 처럼 enabled 는 참 같은 값일 때만 켠 것,
    /// key·value 는 String(). 객체가 아니면 None.
    pub fn from_raw(v: &Value) -> Option<Kv> {
        let o = v.as_object()?;
        let s = |k: &str| match o.get(k) {
            None | Some(Value::Null) => String::new(),
            Some(x) => js::to_string(x),
        };
        Some(Kv { key: s("key"), value: s("value"), enabled: js::truthy(o.get("enabled")), description: None })
    }
}

pub fn kv_list_json(list: &[Kv]) -> Value {
    Value::Array(list.iter().map(Kv::to_json).collect())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequestInput {
    pub method: String,
    pub url: String,
    pub params: Vec<Kv>,
    pub headers: Vec<Kv>,
    /// 'none' | 'json' | 'form' | 'raw' | 'graphql' | 'multipart'
    pub body_type: String,
    pub body: String,
}

impl RequestInput {
    /// resolveRequest 의 map() 이 만드는 객체 순서 — method, bodyType, url, body, params, headers.
    /// 이력의 resolved 열이 이 모양으로 저장된다.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("method".into(), Value::String(self.method.clone()));
        m.insert("bodyType".into(), Value::String(self.body_type.clone()));
        m.insert("url".into(), Value::String(self.url.clone()));
        m.insert("body".into(), Value::String(self.body.clone()));
        m.insert("params".into(), kv_list_json(&self.params));
        m.insert("headers".into(), kv_list_json(&self.headers));
        Value::Object(m)
    }
}

/// normalizeRequestInput — 필드가 빠지거나 모양이 틀린 입력은 None(라우트가 400). params·headers 는
/// key 가 문자열인 항목만, enabled 는 안 적었으면 켠 것.
pub fn normalize_request_input(v: Option<&Value>) -> Option<RequestInput> {
    let o = v?.as_object()?;
    if !is_http_method(o.get("method")?) {
        return None;
    }
    let url = o.get("url")?.as_str()?.to_string();
    let kv_list = |v: Option<&Value>| -> Vec<Kv> {
        let Some(Value::Array(a)) = v else { return vec![] };
        a.iter()
            .filter_map(|x| {
                let o = x.as_object()?;
                let key = o.get("key")?.as_str()?;
                Some(Kv {
                    key: key.to_string(),
                    value: o.get("value").and_then(Value::as_str).unwrap_or("").to_string(),
                    enabled: o.get("enabled") != Some(&Value::Bool(false)),
                    description: None,
                })
            })
            .collect()
    };
    Some(RequestInput {
        method: o["method"].as_str().unwrap_or("GET").to_string(),
        url,
        params: kv_list(o.get("params")),
        headers: kv_list(o.get("headers")),
        body_type: o.get("bodyType").filter(|b| is_body_type(b)).and_then(Value::as_str).unwrap_or("none").to_string(),
        body: o.get("body").and_then(Value::as_str).unwrap_or("").to_string(),
    })
}

/// 요청별 실행 설정 — 미설정이면 executor 기본값(리다이렉트 미추종, 30s).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RequestSettings {
    pub follow_redirects: bool,
    /// `timeoutMs && timeoutMs > 0` 을 통과한 값만. 없으면 30초.
    pub timeout_ms: Option<f64>,
}

impl RequestSettings {
    /// 저장된 settings 열이나 클라이언트가 보낸 객체를 JS 처럼 읽는다 — followRedirects 는 참 같은 값,
    /// timeoutMs 는 `ms && ms > 0` (문자열 "5000" 도 비교에서 숫자가 된다).
    pub fn from_json(v: Option<&Value>) -> Self {
        let follow = js::truthy(v.and_then(|v| v.get("followRedirects")));
        let timeout = v.and_then(|v| v.get("timeoutMs")).and_then(|t| match t {
            Value::Number(n) => n.as_f64(),
            Value::String(s) => Some(js::number(s)),
            Value::Bool(true) => Some(1.0),
            _ => None,
        });
        RequestSettings { follow_redirects: follow, timeout_ms: timeout.filter(|t| *t > 0.0) }
    }
}

/// bodyType 에 대응하는 기본 Content-Type. Content-Type 헤더가 없을 때만 붙인다.
/// 실행·copy as cURL·코드생성이 이 한 곳을 공유해 스니펫이 실제 전송과 일치하게 한다.
pub fn default_content_type(body_type: &str) -> Option<&'static str> {
    match body_type {
        "json" | "graphql" => Some("application/json"),
        "form" => Some("application/x-www-form-urlencoded"),
        _ => None,
    }
}

/// URL 쿼리에 Params 테이블을 병합한다. 같은 키가 URL 에 있으면 테이블이 이겨 `foo=1&foo=1` 이중 전송을 막는다.
/// URLSearchParams 는 한 번이라도 고치면 쿼리 전체를 다시 직렬화한다(공백은 +) — 그 동작까지 같게.
pub fn merge_query_params(url: &mut url::Url, params: &[Kv]) {
    let enabled: Vec<&Kv> = params.iter().filter(|p| p.enabled && !p.key.is_empty()).collect();
    if enabled.is_empty() {
        return; // delete·append 를 한 번도 안 부르면 원래 쿼리 글자 그대로
    }
    let mut pairs: Vec<(String, String)> = url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    pairs.retain(|(k, _)| !enabled.iter().any(|p| &p.key == k));
    for p in &enabled {
        pairs.push((p.key.clone(), p.value.clone()));
    }
    let q = form_urlencoded::Serializer::new(String::new()).extend_pairs(pairs.iter()).finish();
    url.set_query(if q.is_empty() { None } else { Some(&q) });
}

/// GraphQL 바디 정규화: 이미 {query:...} JSON 이면 그대로, 원시 쿼리 문자열이면 {query} 로 감싼다.
/// graphql 이 아니면 JSON 처럼 보일 때만 `//` 주석과 그 때문에 생긴 끝 쉼표를 걷어낸다 —
/// 평문 바디의 '//' 는 주석이 아니라 내용일 수 있다.
pub fn gql_wrap(body_type: &str, body: &str) -> String {
    if body_type != "graphql" {
        return if json_format::looks_like_json(body) {
            json_format::drop_dangling_commas(&json_format::strip_json_comments_for_send(body))
        } else {
            body.to_string()
        };
    }
    let trimmed = js::trim(body);
    // `parsed && typeof parsed === 'object' && 'query' in parsed` — 배열에는 'query' 키가 없다.
    if let Some(Value::Object(o)) = js::parse_json(trimmed) {
        if o.contains_key("query") {
            return trimmed.to_string();
        }
    }
    js::stringify(&serde_json::json!({ "query": body }))
}

/// `{{ name }}` / `{{ name | json }}` — 이름 글자는 VAR_NAME_CHARS, 공백은 JS 의 \s.
fn var_pattern() -> &'static Regex {
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        let s = JS_SPACE;
        Regex::new(&format!(r"\{{\{{{s}*({VAR_NAME_CHARS}+){s}*(\|{s}*json)?{s}*\}}\}}")).expect("변수 패턴")
    });
    &RE
}

/// 내장 동적변수 이름 — 자동완성 후보/미등록 경고 제외에 공유.
pub const DYNAMIC_VARS: [&str; 4] = ["$timestamp", "$isoTimestamp", "$uuid", "$randomInt"];

/// [0, 1) 난수 — Math.random() 자리.
pub fn random_f64() -> f64 {
    let mut b = [0u8; 8];
    getrandom::getrandom(&mut b).ok();
    (u64::from_le_bytes(b) >> 11) as f64 / (1u64 << 53) as f64
}

/// 실행 1회당 한 번만 만드는 동적변수. 치환은 real·redacted 두 번 일어나므로, 그때마다 만들면 두 값이 달라진다 —
/// 실행 진입 시 미리 vars 에 구워 넣는다. 모두 비밀 아님.
pub fn dynamic_vars() -> VarMap {
    let now = js::now_ms();
    let mut m = VarMap::new();
    let mut put = |k: &str, v: String| m.insert(k, Var { value: v, secret: false });
    put("$timestamp", now.to_string());
    put("$isoTimestamp", js::iso_string(now));
    put("$uuid", uuid::Uuid::new_v4().to_string());
    put("$randomInt", ((random_f64() * 1_000_000.0).floor() as i64).to_string());
    m
}

/// 넣은 순서를 지키는 이름 집합(JS Set). 못 채운 변수 이름을 모은다.
#[derive(Clone, Debug, Default)]
pub struct NameSet {
    items: Vec<String>,
}

impl NameSet {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn insert(&mut self, k: &str) {
        if !self.items.iter().any(|x| x == k) {
            self.items.push(k.to_string());
        }
    }
    pub fn extend<'a>(&mut self, other: impl IntoIterator<Item = &'a String>) {
        for k in other {
            self.insert(k);
        }
    }
    pub fn items(&self) -> &[String] {
        &self.items
    }
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
    /// `[...set].sort()` — JS 기본 정렬은 UTF-16 코드 단위 순서다(Rust 문자열 비교는 코드 포인트 순이라 갈릴 수 있다).
    pub fn sorted(&self) -> Vec<String> {
        sort16(self.items.clone())
    }
}

/// `arr.sort()` 의 문자열 비교(UTF-16 코드 단위).
pub fn sort16(mut v: Vec<String>) -> Vec<String> {
    v.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    v
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Real,
    Redacted,
}

fn sub(text: &str, vars: &VarMap, mode: Mode, missing: &mut NameSet) -> String {
    var_pattern()
        .replace_all(text, |c: &regex::Captures<'_>| {
            let raw = &c[0];
            let Some(v) = vars.get(&c[1]) else {
                missing.insert(&c[1]);
                return raw.to_string();
            };
            if mode == Mode::Redacted && v.secret {
                return raw.to_string(); // 마스킹 유지(필터 포함 원문 그대로)
            }
            // |json: 값을 JSON 문자열 리터럴로(따옴표·개행 이스케이프). raw 는 그대로 삽입.
            if c.get(2).is_some() {
                js::stringify(&Value::String(v.value.clone()))
            } else {
                v.value.clone()
            }
        })
        .into_owned()
}

/// 요청 draft 전체(url/params/headers/body)에서 {{변수}} 이름을 등장 순서대로(중복 제거). 알려진 동적변수만 뺀다 —
/// 오타($tiemstamp)는 경고에 남겨야 리터럴로 새 나가지 않는다.
pub fn extract_variables(input: &RequestInput) -> Vec<String> {
    let mut acc = NameSet::new();
    let mut scan = |t: &str| {
        for c in var_pattern().captures_iter(t) {
            acc.insert(&c[1]);
        }
    };
    scan(&input.url);
    for p in input.params.iter().filter(|p| p.enabled) {
        scan(&p.value);
    }
    for h in input.headers.iter().filter(|h| h.enabled) {
        scan(&h.value);
    }
    if input.body_type != "binary" { scan(&input.body); }
    acc.items.into_iter().filter(|n| !DYNAMIC_VARS.contains(&n.as_str())).collect()
}

/// {key,value} 배열을 VarMap 위에 오버레이한다(비-secret). 빈 값·빈 키는 무시 — 동명 상위 변수(secret 포함)를
/// 빈 문자열로 덮지 않게. 요청별 변수·시나리오 공유변수에 쓴다. 입력은 클라이언트 JSON 그대로 받는다.
pub fn overlay_kv_vars(base: &VarMap, kv: &[Value]) -> VarMap {
    let mut out = base.clone();
    for v in kv {
        let Some(key) = v.get("key").and_then(Value::as_str).filter(|k| !k.is_empty()) else { continue };
        let val = match v.get("value") {
            Some(Value::String(s)) => s.clone(),
            None | Some(Value::Null) => String::new(),
            Some(other) => js::to_string(other),
        };
        if !val.is_empty() {
            out.insert(key, Var { value: val, secret: false });
        }
    }
    out
}

/// 단일 문자열의 {{var}} 를 real 모드로 치환(미해석은 원문 유지). missing 을 주면 못 채운 이름을 담는다 —
/// 예전엔 pre-step 인자 안의 미해석 변수를 아무도 몰랐다.
pub fn resolve_text(text: &str, vars: &VarMap, missing: Option<&mut NameSet>) -> String {
    let mut local = NameSet::new();
    sub(text, vars, Mode::Real, missing.unwrap_or(&mut local))
}

/// text 안 {{var}} 참조 중 secret 변수가 하나라도 있으면 true — pre-step 파생값에 secret 을 전파하는 데 쓴다.
pub fn references_secret(text: &str, vars: &VarMap) -> bool {
    var_pattern().captures_iter(text).any(|c| vars.get(&c[1]).map_or(false, |v| v.secret))
}

/// 팀 공유 변수 위에 개인 오버라이드를 덮는다(개인 값 우선, 항상 secret — 이력에 실값이 남지 않는다). 빈 값은 무시.
/// personal 은 클라이언트 JSON(`Record<string,string>`) 그대로 — 객체가 아니면 원본 그대로.
pub fn apply_personal_vars(team: &VarMap, personal: Option<&Value>) -> VarMap {
    let Some(Value::Object(p)) = personal else { return team.clone() };
    let mut out = team.clone();
    for k in js::object_keys(p) {
        let v = &p[k.as_str()];
        if v.as_str() == Some("") {
            continue;
        }
        // 값이 문자열이 아니면 Node 는 치환 때 그 값을 그대로 이어 붙인다 — String() 과 같다.
        let value = match v {
            Value::String(s) => s.clone(),
            other => js::to_string(other),
        };
        out.insert(k, Var { value, secret: true });
    }
    out
}

/// \p{L}\p{N}_.$- — 변수 패턴과 같은 글자 표(regex 크레이트)로 본다.
fn is_var_name_char(c: char) -> bool {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("^{VAR_NAME_CHARS}$")).expect("이름 글자"));
    let mut b = [0u8; 4];
    RE.is_match(c.encode_utf8(&mut b))
}

/// `/(?<!\{)\{([\p{L}\p{N}_.$-]+)\}(?!\})/gu` — regex 크레이트는 앞뒤 살피기를 못 해 직접 훑는다.
/// 반환: (전체 시작, 전체 끝, 이름) 바이트 위치.
fn path_matches(path: &str) -> Vec<(usize, usize, String)> {
    let c: Vec<(usize, char)> = path.char_indices().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < c.len() {
        if c[i].1 == '{' && (i == 0 || c[i - 1].1 != '{') {
            let mut j = i + 1;
            while j < c.len() && is_var_name_char(c[j].1) {
                j += 1;
            }
            if j > i + 1 && j < c.len() && c[j].1 == '}' && c.get(j + 1).map_or(true, |x| x.1 != '}') {
                out.push((c[i].0, c[j].0 + 1, path[c[i + 1].0..c[j].0].to_string()));
                i = j + 1;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// OpenAPI 경로 자리표시자(`{id}`)만 — {{환경변수}} 와 쿼리·fragment 는 제외. 등장 순서, 중복 제거.
pub fn extract_path_parameters(url: &str) -> Vec<String> {
    let path = url.split(['?', '#']).next().unwrap_or("");
    let mut acc = NameSet::new();
    for (_, _, name) in path_matches(path) {
        acc.insert(&name);
    }
    acc.items
}

fn resolve_path(url: &str, vars: &VarMap, mode: Mode, missing: &mut NameSet) -> String {
    let end = url.find(['?', '#']);
    let path = end.map_or(url, |e| &url[..e]);
    let mut out = String::with_capacity(url.len());
    let mut last = 0;
    for (s, e, name) in path_matches(path) {
        out.push_str(&path[last..s]);
        let raw = &path[s..e];
        match vars.get(&name) {
            Some(v) if !v.value.is_empty() => {
                if mode == Mode::Redacted && v.secret {
                    out.push_str(raw);
                } else {
                    // 경로 한 칸의 값 — '/'·'?'·'#' 까지 인코딩해야 다른 경로·쿼리로 새지 않는다.
                    out.push_str(&js::encode_uri_component(&v.value));
                }
            }
            _ => {
                missing.insert(&name);
                out.push_str(raw);
            }
        }
        last = e;
    }
    out.push_str(&path[last..]);
    if let Some(e) = end {
        out.push_str(&url[e..]);
    }
    out
}

/// 해석 결과 — real 은 보낼 것, redacted 는 이력에 남길 것(secret 은 {{참조}} 그대로), missing 은 정렬된 미해석 이름.
#[derive(Clone, Debug)]
pub struct Resolved {
    pub real: RequestInput,
    pub redacted: RequestInput,
    pub missing: Vec<String>,
}

pub fn resolve_request(input: &RequestInput, vars: &VarMap) -> Resolved {
    let mut missing = NameSet::new();
    let mut map = |mode: Mode| {
        let path = resolve_path(&input.url, vars, mode, &mut missing);
        let url = sub(&path, vars, mode, &mut missing);
        let body = if input.body_type == "binary" { input.body.clone() } else { sub(&input.body, vars, mode, &mut missing) };
        let params = input.params.iter().map(|p| Kv { value: sub(&p.value, vars, mode, &mut missing), ..p.clone() }).collect();
        let headers = input.headers.iter().map(|h| Kv { value: sub(&h.value, vars, mode, &mut missing), ..h.clone() }).collect();
        RequestInput { method: input.method.clone(), body_type: input.body_type.clone(), url, body, params, headers }
    };
    let real = map(Mode::Real);
    let redacted = map(Mode::Redacted);
    Resolved { real, redacted, missing: missing.sorted() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn vm(items: &[(&str, &str, bool)]) -> VarMap {
        let mut m = VarMap::new();
        for (k, v, s) in items {
            m.insert(k, Var { value: v.to_string(), secret: *s });
        }
        m
    }
    fn req(url: &str, body: &str) -> RequestInput {
        RequestInput { method: "GET".into(), url: url.into(), params: vec![], headers: vec![], body_type: "none".into(), body: body.into() }
    }
    fn base_input() -> RequestInput {
        RequestInput {
            method: "POST".into(),
            url: "{{baseUrl}}/orders".into(),
            params: vec![Kv::new("q", "{{token}}")],
            headers: vec![Kv::new("Authorization", "Bearer {{token}}")],
            body_type: "json".into(),
            body: r#"{"base":"{{baseUrl}}","x":"{{nope}}"}"#.into(),
        }
    }
    fn base_vars() -> VarMap {
        vm(&[("baseUrl", "https://api.example.com", false), ("token", "SECRET-123", true)])
    }

    #[test]
    fn real_은_실값_redacted_는_secret_참조_유지() {
        let r = resolve_request(&base_input(), &base_vars());
        assert_eq!(r.real.url, "https://api.example.com/orders");
        assert_eq!(r.real.headers[0].value, "Bearer SECRET-123");
        assert_eq!(r.redacted.headers[0].value, "Bearer {{token}}");
        assert_eq!(r.redacted.params[0].value, "{{token}}");
        assert!(r.redacted.body.contains("https://api.example.com"));
        assert_eq!(r.missing, ["nope"]);
        assert!(r.real.body.contains("{{nope}}"));
    }

    #[test]
    fn 변수_이름_추출() {
        let i = RequestInput {
            method: "POST".into(),
            url: "{{baseUrl}}/orders/{{orderId}}".into(),
            params: vec![Kv::new("q", "{{query}}"), Kv { enabled: false, ..Kv::new("a", "{{off}}") }],
            headers: vec![Kv::new("Authorization", "Bearer {{token}}")],
            body_type: "json".into(),
            body: r#"{"member": "{{memberCode}}", "again": "{{baseUrl}}"}"#.into(),
        };
        assert_eq!(extract_variables(&i), ["baseUrl", "orderId", "query", "token", "memberCode"]);
        assert_eq!(extract_variables(&req("{{baseUrl}}/{{$uuid}}?t={{$timestamp}}", "")), ["baseUrl"]);
        assert_eq!(extract_variables(&req("{{$tiemstamp}}/{{$foo}}", "")), ["$tiemstamp", "$foo"]);
    }

    #[test]
    fn 동적변수는_한_실행_안에서_같은_값() {
        let d = dynamic_vars();
        let r = resolve_request(&req("{{$timestamp}}", "{{$timestamp}}"), &d);
        assert_eq!(r.real.url, r.redacted.url);
        assert_eq!(r.real.url, r.real.body);
        assert!(d.get("$timestamp").unwrap().value.bytes().all(|b| b.is_ascii_digit()));
        assert_eq!(d.get("$uuid").unwrap().value.len(), 36);
        assert!(d.get("$isoTimestamp").unwrap().value.contains('T'));
    }

    #[test]
    fn secret_참조_감지_와_개인_오버라이드() {
        let v = vm(&[("s", "x", true), ("p", "y", false)]);
        assert!(references_secret("a{{s}}b", &v));
        assert!(!references_secret("a{{p}}b", &v));
        assert!(references_secret("{{p}}{{s}}", &v));
        let team = vm(&[("baseUrl", "https://team", false), ("token", "TEAM", true)]);
        let out = apply_personal_vars(&team, Some(&json!({ "token": "MINE", "x": "" , "my": "v"})));
        assert_eq!(out.get("token").unwrap(), &Var { value: "MINE".into(), secret: true });
        assert_eq!(out.get("baseUrl").unwrap().secret, false);
        assert!(out.get("x").is_none());
        assert_eq!(out.get("my").unwrap().secret, true);
    }

    #[test]
    fn json_필터는_문자열_리터럴로_이스케이프() {
        let v = vm(&[("msg", "line1\n\"quoted\"", false)]);
        let mut i = req("http://x", r#"{"m": {{msg|json}}}"#);
        i.body_type = "json".into();
        let r = resolve_request(&i, &v);
        assert_eq!(serde_json::from_str::<Value>(&r.real.body).unwrap()["m"], "line1\n\"quoted\"");
        let v = vm(&[("msg", "hi", false)]);
        assert_eq!(resolve_request(&req("http://x/{{ msg | json }}", ""), &v).real.url, "http://x/\"hi\"");
    }

    #[test]
    fn 요청별_변수_오버레이() {
        let base = vm(&[("a", "A", true), ("b", "B", false)]);
        let out = overlay_kv_vars(&base, &[json!({"key": "a", "value": ""}), json!({"key": "b", "value": "B2"}), json!({"key": "", "value": "x"}), json!({"key": "c", "value": "C"})]);
        assert_eq!(out.get("a").unwrap(), &Var { value: "A".into(), secret: true });
        assert_eq!(out.get("b").unwrap(), &Var { value: "B2".into(), secret: false });
        assert_eq!(out.get("c").unwrap().value, "C");
        assert!(out.get("").is_none());
    }

    #[test]
    fn 한글_변수_이름() {
        let v = vm(&[("토큰", "T-1", false), ("baseUrl", "https://x", false)]);
        assert_eq!(resolve_text("{{baseUrl}}/u/{{토큰}}", &v, None), "https://x/u/T-1");
        let mut m = NameSet::new();
        resolve_text("{{없는한글}}", &v, Some(&mut m));
        assert_eq!(m.items(), ["없는한글"]);
        assert_eq!(resolve_text("토큰", &v, None), "토큰");
    }

    #[test]
    fn 경로_파라미터는_환경변수_쿼리와_구분하고_인코딩() {
        let url = "{{baseUrl}}/orders/{serialCode}/{serialCode}?q={query}#{{fragment}}";
        assert_eq!(extract_path_parameters(url), ["serialCode"]);
        let mut vars = base_vars();
        vars.insert("serialCode", Var { value: "한 글/A?x=1#%".into(), secret: false });
        let mut i = base_input();
        i.url = url.into();
        assert_eq!(
            resolve_request(&i, &vars).real.url,
            "https://api.example.com/orders/%ED%95%9C%20%EA%B8%80%2FA%3Fx%3D1%23%25/%ED%95%9C%20%EA%B8%80%2FA%3Fx%3D1%23%25?q={query}#{{fragment}}"
        );
        assert!(resolve_request(&i, &base_vars()).missing.contains(&"serialCode".to_string()));
        let mut vars = base_vars();
        vars.insert("serialCode", Var { value: "PRIVATE".into(), secret: true });
        i.url = "{{baseUrl}}/{serialCode}".into();
        let hidden = resolve_request(&i, &vars);
        assert_eq!(hidden.real.url, "https://api.example.com/PRIVATE");
        assert_eq!(hidden.redacted.url, "https://api.example.com/{serialCode}");
        assert_eq!(extract_path_parameters("/a/{{x}}/{y}}/{z}"), ["z"]);
    }

    // executor.test.ts 의 gqlWrap.
    #[test]
    fn gql_wrap_규칙() {
        assert_eq!(gql_wrap("graphql", "{ me { id } }"), r#"{"query":"{ me { id } }"}"#);
        let j = r#"{"query":"{me{id}}","variables":{"x":1}}"#;
        assert_eq!(gql_wrap("graphql", j), j);
        assert_eq!(gql_wrap("json", r#"{"a":1}"#), r#"{"a":1}"#);
        assert_eq!(gql_wrap("json", "{\n \"a\": 1,\n // \"b\": 2\n}"), "{\n \"a\": 1\n}");
        assert_eq!(gql_wrap("raw", "a // b"), "a // b");
    }

    #[test]
    fn 쿼리_병합은_테이블이_이긴다() {
        let mut u = url::Url::parse("http://h/x?foo=1&keep=9").unwrap();
        merge_query_params(&mut u, &[Kv::new("foo", "2")]);
        assert_eq!(u.as_str(), "http://h/x?keep=9&foo=2");
        let mut u = url::Url::parse("http://h/x?a=%20b").unwrap();
        merge_query_params(&mut u, &[]);
        assert_eq!(u.as_str(), "http://h/x?a=%20b");
        merge_query_params(&mut u, &[Kv { enabled: false, ..Kv::new("z", "1") }, Kv::new("c", "d e")]);
        assert_eq!(u.as_str(), "http://h/x?a=+b&c=d+e");
    }

    #[test]
    fn 입력_정규화() {
        assert!(normalize_request_input(Some(&json!({"method": "GET"}))).is_none());
        assert!(normalize_request_input(Some(&json!({"method": "G T", "url": "x"}))).is_none());
        let i = normalize_request_input(Some(&json!({"method": "POST", "url": "u", "params": [null, {"key": 1}, {"key": "k"}], "bodyType": "xml", "body": 5}))).unwrap();
        assert_eq!(i.params, vec![Kv::new("k", "")]);
        assert_eq!(i.body_type, "none");
        assert_eq!(i.body, "");
    }
}
