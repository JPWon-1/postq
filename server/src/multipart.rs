//! multipart/form-data 바디와 그 직렬화.
//!
//! body 는 JSON 문자열: `{ fields: [{name, value}], files: [{name, filename, contentType, dataBase64}] }`.
//! 파일은 브라우저가 base64 로 실어 실행 때만 보낸다(템플릿에 저장 안 함 — 큰 파일 방어).
//!
//! 공개 API
//! - [`parse_multipart_body`] → [`MultipartSpec`] — 깨진 JSON 이면 빈 스펙.
//! - [`build_form_data`] → [`FormData`] — Node fetch(undici)가 FormData 를 보낼 때와 같은 바이트 모양.
//!   잘못된 항목은 Node 가 던지던 오류 문장으로 Err(실행 결과의 error 가 된다).

use base64::alphabet;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use base64::Engine;
use serde_json::Value;

use crate::js;

#[derive(Clone, Debug, Default)]
pub struct MultipartSpec {
    /// 원소는 클라이언트 JSON 그대로 — Node 도 모양을 검사하지 않고 쓰다가 던졌다.
    pub fields: Vec<Value>,
    pub files: Vec<Value>,
}

pub fn parse_multipart_body(body: &str) -> MultipartSpec {
    let Some(p) = js::parse_json(body) else { return MultipartSpec::default() };
    let arr = |k: &str| p.get(k).and_then(Value::as_array).cloned().unwrap_or_default();
    // JSON.parse('null') 이면 p.fields 에서 TypeError → catch → 빈 스펙. get 이 None 이라 같은 결과다.
    MultipartSpec { fields: arr("fields"), files: arr("files") }
}

/// 직렬화된 multipart 본문과 Content-Type 값.
#[derive(Clone, Debug)]
pub struct FormData {
    pub bytes: Vec<u8>,
    pub content_type: String,
}

/// `Cannot read properties of null (reading 'name')` — Node 가 null 원소에서 던지던 문장.
fn read_prop<'a>(v: &'a Value, key: &str) -> Result<Option<&'a Value>, String> {
    match v {
        Value::Null => Err(format!("TypeError: Cannot read properties of null (reading '{key}')")),
        Value::Object(o) => Ok(o.get(key)),
        _ => Ok(None), // 원시값의 프로퍼티는 undefined
    }
}

/// webidl USVString 변환 — undefined 는 "undefined".
fn usv(v: Option<&Value>) -> String {
    v.map_or_else(|| "undefined".into(), js::to_string)
}

/// undici 의 escape(normalizeLinefeeds(name)).
fn escape_name(s: &str) -> String {
    normalize_linefeeds(s).replace('\n', "%0A").replace('\r', "%0D").replace('"', "%22")
}

/// `/\r?\n|\r/g → '\r\n'`
fn normalize_linefeeds(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        match c {
            '\r' => {
                if it.peek() == Some(&'\n') {
                    it.next();
                }
                out.push_str("\r\n");
            }
            '\n' => out.push_str("\r\n"),
            c => out.push(c),
        }
    }
    out
}

/// atob — '관대한' base64(forgiving-base64): ASCII 공백 무시, 패딩 생략 허용, 남는 비트 무시. 틀리면 Node 가 던지던 문장.
fn atob(s: &str) -> Result<Vec<u8>, String> {
    let mut clean: String = s.chars().filter(|c| !matches!(c, '\t' | '\n' | '\u{C}' | '\r' | ' ')).collect();
    if clean.len() % 4 == 0 {
        if clean.ends_with("==") {
            clean.truncate(clean.len() - 2);
        } else if clean.ends_with('=') {
            clean.truncate(clean.len() - 1);
        }
    }
    let bad = || "InvalidCharacterError: Invalid character".to_string();
    if clean.len() % 4 == 1 || !clean.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/') {
        return Err(bad());
    }
    const ENGINE: GeneralPurpose = GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent).with_decode_allow_trailing_bits(true),
    );
    ENGINE.decode(clean.as_bytes()).map_err(|_| bad())
}

/// Blob 의 type 정규화 — 0x20~0x7E 밖 글자가 있으면 '', 아니면 소문자.
fn blob_type(t: &str) -> String {
    if t.chars().any(|c| !(' '..='~').contains(&c)) {
        String::new()
    } else {
        t.to_ascii_lowercase()
    }
}

/// MultipartSpec → 본문. 필드 먼저, 파일 다음(multipart.ts 의 append 순서).
pub fn build_form_data(spec: &MultipartSpec) -> Result<FormData, String> {
    let mut rnd = [0u8; 8];
    getrandom::getrandom(&mut rnd).ok();
    let boundary = format!("----formdata-undici-0{:011}", u64::from_le_bytes(rnd) % 100_000_000_000);
    let mut out: Vec<u8> = Vec::new();
    let prefix = format!("--{boundary}\r\nContent-Disposition: form-data");
    for f in &spec.fields {
        let name = read_prop(f, "name")?;
        if !js::truthy(name) {
            continue;
        }
        let value = usv(read_prop(f, "value")?);
        out.extend_from_slice(format!("{prefix}; name=\"{}\"\r\n\r\n{}\r\n", escape_name(&usv(name)), normalize_linefeeds(&value)).as_bytes());
    }
    for file in &spec.files {
        let name = read_prop(file, "name")?;
        let filename = read_prop(file, "filename")?;
        if !js::truthy(name) || !js::truthy(filename) {
            continue;
        }
        // `b64.includes(',')` — 문자열이 아니면 Node 는 TypeError. data: URI 접두는 떼어 낸다.
        let b64 = match read_prop(file, "dataBase64")? {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(a)) => js::to_string(&Value::Array(a.clone())),
            _ => return Err("TypeError: b64.includes is not a function".into()),
        };
        let clean = b64.find(',').map_or(b64.as_str(), |i| &b64[i + 1..]);
        let data = atob(clean)?;
        let ct = match read_prop(file, "contentType")? {
            Some(v) if js::truthy(Some(v)) => blob_type(&js::to_string(v)),
            _ => "application/octet-stream".into(),
        };
        let ct = if ct.is_empty() { "application/octet-stream".to_string() } else { ct };
        // File.name 은 escape 만(줄바꿈 정규화 없이) — undici 와 같다.
        let fname = usv(filename).replace('\n', "%0A").replace('\r', "%0D").replace('"', "%22");
        out.extend_from_slice(
            format!("{prefix}; name=\"{}\"; filename=\"{fname}\"\r\nContent-Type: {ct}\r\n\r\n", escape_name(&usv(name))).as_bytes(),
        );
        out.extend_from_slice(&data);
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    Ok(FormData { bytes: out, content_type: format!("multipart/form-data; boundary={boundary}") })
}

/// 단일 파일의 원본 바이트. 로컬 파일 경로를 서버가 읽지 않는다.
pub fn build_binary_body(body: &str) -> Result<FormData, String> {
    let value: Value = serde_json::from_str(body).map_err(|_| "바이너리 본문 파일을 첨부하세요".to_string())?;
    let b64 = value.get("dataBase64").and_then(Value::as_str).ok_or("바이너리 본문 파일을 다시 첨부하세요")?;
    let clean = b64.find(',').map_or(b64, |i| &b64[i + 1..]);
    let bytes = atob(clean)?;
    let ct = blob_type(value.get("contentType").and_then(Value::as_str).unwrap_or(""));
    Ok(FormData { bytes, content_type: if ct.is_empty() { "application/octet-stream".into() } else { ct } })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn 바디_파싱() {
        let s = parse_multipart_body(&json!({ "fields": [{ "name": "a", "value": "1" }], "files": [] }).to_string());
        assert_eq!(s.fields.len(), 1);
        assert!(parse_multipart_body("not json").fields.is_empty());
        assert!(parse_multipart_body(r#"{"fields":"x"}"#).fields.is_empty());
        assert!(parse_multipart_body("null").files.is_empty());
    }

    #[test]
    fn 본문은_필드_다음_파일() {
        let spec = MultipartSpec {
            fields: vec![json!({ "name": "title", "value": "doc\nx" }), json!({ "name": "", "value": "skip" })],
            files: vec![json!({ "name": "file", "filename": "a\".txt", "contentType": "text/plain", "dataBase64": "data:text/plain;base64,aGk=" })],
        };
        let fd = build_form_data(&spec).unwrap();
        let body = String::from_utf8(fd.bytes).unwrap();
        let b = fd.content_type.strip_prefix("multipart/form-data; boundary=").unwrap();
        assert!(b.starts_with("----formdata-undici-0") && b.len() == "----formdata-undici-0".len() + 11);
        assert_eq!(
            body,
            format!("--{b}\r\nContent-Disposition: form-data; name=\"title\"\r\n\r\ndoc\r\nx\r\n--{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a%22.txt\"\r\nContent-Type: text/plain\r\n\r\nhi\r\n--{b}--\r\n")
        );
    }

    #[test]
    fn atob_은_관대하다() {
        assert_eq!(atob("aGk").unwrap(), b"hi");
        assert_eq!(atob(" aG k= ").unwrap(), b"hi");
        assert!(atob("a").is_err());
        assert!(atob("a$==").is_err());
        assert!(build_form_data(&MultipartSpec { fields: vec![Value::Null], files: vec![] }).unwrap_err().contains("reading 'name'"));
    }
}
