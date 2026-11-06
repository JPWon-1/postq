//! JS 의 작은 의미들을 그대로 옮긴 것 — trim·길이·Number()·truthy·String().
//!
//! Node 라우트는 이것들에 기대어 입력을 걸렀다. Rust 의 비슷한 함수는 미묘하게 다르다
//! (str::trim 은 U+0085 를 지우고 U+FEFF 는 안 지운다, len 은 UTF-8 바이트다). 한쪽에서만
//! 통과하는 입력이 생기면 옮기는 동안 같은 요청이 서버에 따라 다르게 저장된다. 그래서 한 곳에 모은다.
//!
//! JSON.stringify([`stringify`]) 도 여기 하나뿐이다. 라우트를 나눠 옮기면서 세 벌(js_json·json_cols·여기)이
//! 생겼는데, 숫자 표기나 키 순서가 한 벌에서만 고쳐지면 같은 행이 경로에 따라 다른 글자로 저장된다.

use serde_json::Value;

/// String.prototype.trim 이 지우는 글자 — WhiteSpace(Zs·TAB·VT·FF·FEFF) + LineTerminator(LF·CR·LS·PS).
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{A}' | '\u{B}' | '\u{C}' | '\u{D}' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

pub fn trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// string.length — UTF-16 단위.
pub fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// string.slice(0, n) — UTF-16 단위로 자른다. 서로게이트 쌍 한가운데서 끊기면 JS 는 짝 없는 반쪽을 남기지만
/// Rust 문자열은 그걸 담을 수 없어 그 반쪽은 버린다(그 경우만 한 단위 짧다).
pub fn slice16(s: &str, n: usize) -> String {
    let mut used = 0;
    let mut end = 0;
    for (i, c) in s.char_indices() {
        let w = c.len_utf16();
        if used + w > n {
            return s[..i].to_string();
        }
        used += w;
        end = i + c.len_utf8();
    }
    s[..end].to_string()
}

/// Number(string) — 앞뒤 공백 무시, 빈 문자열은 0, 0x/0o/0b, Infinity. 못 읽으면 NaN.
pub fn number(s: &str) -> f64 {
    let t = trim(s);
    if t.is_empty() {
        return 0.0;
    }
    let radix = |p: &str, r: u32| -> f64 {
        if p.is_empty() || !p.chars().all(|c| c.is_digit(r)) {
            return f64::NAN;
        }
        p.chars().fold(0.0, |acc, c| acc * r as f64 + c.to_digit(r).unwrap() as f64)
    };
    let lower = t.get(..2).map(|p| p.to_ascii_lowercase());
    match lower.as_deref() {
        Some("0x") => return radix(&t[2..], 16),
        Some("0o") => return radix(&t[2..], 8),
        Some("0b") => return radix(&t[2..], 2),
        _ => {}
    }
    let (sign, body) = match t.as_bytes()[0] {
        b'+' => (1.0, &t[1..]),
        b'-' => (-1.0, &t[1..]),
        _ => (1.0, t),
    };
    if body == "Infinity" {
        return sign * f64::INFINITY;
    }
    // 부호는 한 번만 — Rust 의 parse 는 남은 부호를 또 받아서 "--1" 이 1 이 됐다(Node 는 NaN, codex 리뷰).
    if body.starts_with(['+', '-']) {
        return f64::NAN;
    }
    // JS 십진 리터럴: 숫자·점·지수만. Rust 의 parse 는 "inf"·"nan" 도 받으므로 먼저 거른다.
    let ok = !body.is_empty()
        && body.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-'))
        && body.bytes().any(|b| b.is_ascii_digit());
    if !ok {
        return f64::NAN;
    }
    body.parse::<f64>().map(|v| sign * v).unwrap_or(f64::NAN)
}

/// `!!v` — 0·""·null·false·NaN 만 거짓. 문자열 "false" 는 참이다.
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map_or(true, |f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// Number → String (JS 의 Number.prototype.toString). 정수는 소수점 없이, 1e21 이상과 1e-6 미만은 지수 표기.
/// Rust 의 Display 는 지수 경계(1e-7 → 0.0000001)도, 같은 길이 후보 중 고르는 자릿수도 JS 와 달라서
/// 같은 steps 가 Node 와 다른 글자로 저장됐다(codex 리뷰). 그래서 ECMAScript 규칙을 그대로 구현한 ryu-js 를 쓴다.
pub fn number_to_string(f: f64) -> String {
    if f.is_nan() {
        return "NaN".into();
    }
    if f.is_infinite() {
        return if f > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if f == 0.0 {
        return "0".into();
    }
    // 자릿수는 ryu-js 가 ECMAScript Number::toString 규칙 그대로 고른다. Rust 의 Display 도 '가장 짧은 표기' 지만
    // 같은 길이 후보가 둘일 때 고르는 쪽이 달라서 652282746268236.2 를 ...236.3 으로 썼다(codex 리뷰, 10만 개 중 21건).
    // 지수 표기 경계(1e21 이상, 1e-6 미만)와 "1e+21" 모양도 ryu-js 가 JS 와 같게 낸다.
    ryu_js::Buffer::new().format(f).to_string()
}

/// String(v) / 템플릿 리터럴 `${v}` — 배열은 쉼표로 잇고, 객체는 "[object Object]".
pub fn to_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => match (n.as_i64(), n.as_u64()) {
            (Some(i), _) if (i.unsigned_abs()) < (1u64 << 53) => i.to_string(),
            (_, Some(u)) if u < (1u64 << 53) => u.to_string(),
            _ => number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        },
        Value::String(s) => s.clone(),
        // 배열 안의 null 은 빈 칸이 된다([null,1].join() === ",1").
        Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { to_string(x) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `req.json()` — 본문을 UTF-8 로 풀고(깨진 바이트는 U+FFFD, 앞의 BOM 은 지운다) JSON 으로 읽는다. 못 읽으면 None.
pub fn parse_body(body: &[u8]) -> Option<Value> {
    let text = String::from_utf8_lossy(body);
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(&text);
    parse_json(text)
}

/// JSON.parse(text) — 못 읽으면 None. 아직 serde_json::from_str 를 직접 부르는 자리(저장본·계약)도 규칙은 같다.
///
/// 알려진 차이: 짝 없는 서로게이트 이스케이프(`"\ud800"`)와 범위 밖 숫자(`1e400`)는 JS 는 받지만 여기서는 None 이다.
/// 서로게이트를 U+FFFD 로 바꿔 받아 보기도 했지만, 서로 다른 키가 한 키로 합쳐지고 JSON 열의 원문이 바뀌어
/// (Node 의 JSON.stringify 는 `\ud800` 을 그대로 보존한다) 조용한 데이터 손실이 됐다 — 거절이 더 낫다(codex 리뷰).
/// 맞추려면 UTF-16 문자열을 담을 수 있는 JSON 표현이 필요하다.
pub fn parse_json(text: &str) -> Option<Value> {
    serde_json::from_str(text).ok()
}

/// `new URL(req.url).searchParams.get(name)` — 같은 이름이 여럿이면 첫 값.
pub fn query_get(query: Option<&str>, name: &str) -> Option<String> {
    form_urlencoded::parse(query.unwrap_or("").as_bytes()).find(|(k, _)| k == name).map(|(_, v)| v.into_owned())
}

/// 지금 시각(ms) — Date.now().
pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// JS 배열 인덱스 모양의 키인가 — 0 이상 2^32-2 이하, 앞자리 0 없음. JS 객체는 이런 키를 숫자 순으로 맨 앞에 둔다.
pub fn is_index_key(k: &str) -> bool {
    if k.is_empty() || k.len() > 10 || !k.bytes().all(|b| b.is_ascii_digit()) || (k.len() > 1 && k.starts_with('0')) {
        return false;
    }
    k.parse::<u64>().map_or(false, |n| n < u32::MAX as u64)
}

/// JSON.stringify(v) — 응답·저장 문자열이 Node 가 만든 것과 같아야 한다(sha256 digest·DB 의 JSON 열).
/// serde_json 과 다른 점: 숫자는 JS 표기(1.0 → 1), 객체는 JS 객체처럼 정수 모양 키를 숫자 순으로 앞에 둔다
/// (Node 에서는 JSON.parse 한 순간 이미 그 순서가 된다).
pub fn stringify(v: &Value) -> String {
    let mut out = String::new();
    write_json(&mut out, v, None, 0);
    out
}

/// JSON.stringify(v, null, indent)
pub fn stringify_pretty(v: &Value, indent: usize) -> String {
    let mut out = String::new();
    write_json(&mut out, v, Some(indent), 0);
    out
}

/// JS 객체의 키 순서 — 정수 모양 키(숫자 오름차순) 다음 나머지(넣은 순서).
pub fn object_keys(o: &serde_json::Map<String, Value>) -> Vec<&String> {
    let mut idx: Vec<&String> = o.keys().filter(|k| is_index_key(k)).collect();
    idx.sort_by_key(|k| k.parse::<u64>().unwrap_or(0));
    idx.extend(o.keys().filter(|k| !is_index_key(k)));
    idx
}

fn write_json(out: &mut String, v: &Value, indent: Option<usize>, depth: usize) {
    let newline = |out: &mut String, d: usize| {
        if let Some(n) = indent {
            out.push('\n');
            out.extend(std::iter::repeat(' ').take(n * d));
        }
    };
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        // NaN·Infinity 는 serde 에 없다 — JSON 숫자는 늘 유한하다.
        Value::Number(_) => out.push_str(&to_string(v)),
        Value::String(s) => out.push_str(&serde_json::to_string(s).unwrap_or_default()),
        Value::Array(a) => {
            if a.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(out, depth + 1);
                write_json(out, x, indent, depth + 1);
            }
            newline(out, depth);
            out.push(']');
        }
        Value::Object(o) => {
            if o.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (i, k) in object_keys(o).into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(out, depth + 1);
                out.push_str(&serde_json::to_string(k).unwrap_or_default());
                out.push(':');
                if indent.is_some() {
                    out.push(' ');
                }
                write_json(out, &o[k], indent, depth + 1);
            }
            newline(out, depth);
            out.push('}');
        }
    }
}

/// encodeURIComponent — 영숫자와 -_.!~*'() 만 그대로 둔다.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// decodeURIComponent — 깨진 %열·잘못된 UTF-8 이면 Err(JS 의 URIError).
pub fn decode_uri_component(s: &str) -> Result<String, ()> {
    if !s.contains('%') {
        return Ok(s.to_string());
    }
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = b.get(i + 1..i + 3).ok_or(())?;
            if !hex.iter().all(u8::is_ascii_hexdigit) {
                return Err(());
            }
            out.push(u8::from_str_radix(std::str::from_utf8(hex).map_err(|_| ())?, 16).map_err(|_| ())?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    // 글자 그대로 있던 부분은 이미 완전한 UTF-8 이라(연속 바이트로 시작하지 않는다),
    // 이어 붙인 바이트열 하나를 검사하면 %열끼리 짝이 맞는지까지 함께 본다.
    String::from_utf8(out).map_err(|_| ())
}

/// new Date(ms).toISOString() — 2026-11-01T12:34:56.789Z
pub fn iso_string(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let milli = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    // civil_from_days(Howard Hinnant) — 그레고리력 날짜. 시간 크레이트를 이것 하나 때문에 들이지 않는다.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{milli:03}Z", sod / 3600, sod % 3600 / 60, sod % 60)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn number_은_부호를_한번만_받는다() {
        assert!(number("--1").is_nan());
        assert!(number("+-1").is_nan());
        assert!(number("-+1").is_nan());
        assert_eq!(number("-1"), -1.0);
        assert_eq!(number("+1.5e2"), 150.0);
        assert_eq!(number("1e-2"), 0.01);
    }

    #[test]
    fn parse_json_은_짝없는_서로게이트를_받지_않는다() {
        // 받으면 데이터가 바뀐다 — parse_json 주석 참고.
        assert_eq!(parse_json(r#"{"name":"\ud800"}"#), None);
        assert_eq!(parse_json(r#"["\ud83d\ude00"]"#), Some(json!(["😀"])));
        assert_eq!(parse_json(r#""\\ud800""#), Some(json!("\\ud800")));
        assert_eq!(parse_json("{broken"), None);
        assert_eq!(parse_json(r#"{"x":1e400}"#), None);
    }

    #[test]
    fn 숫자_자릿수는_js_와_같다() {
        // node -e 'console.log(JSON.stringify([...]))' 로 얻은 값.
        assert_eq!(number_to_string(652282746268236.2), "652282746268236.2");
        assert_eq!(number_to_string(-245777903432188.63), "-245777903432188.62");
        assert_eq!(number_to_string(1e21), "1e+21");
        assert_eq!(number_to_string(1e-7), "1e-7");
        assert_eq!(number_to_string(1e-6), "0.000001");
        assert_eq!(number_to_string(-0.0), "0");
        assert_eq!(number_to_string(5e-324), "5e-324");
        assert_eq!(number_to_string(f64::NAN), "NaN");
        assert_eq!(number_to_string(f64::NEG_INFINITY), "-Infinity");
    }

    #[test]
    fn stringify_는_json_stringify_와_같다() {
        let v: Value = serde_json::from_str(r#"{"b":1.0,"2":[],"a":{},"1":"x\u0001"}"#).unwrap();
        assert_eq!(stringify(&v), r#"{"1":"x\u0001","2":[],"b":1,"a":{}}"#);
        assert_eq!(
            stringify_pretty(&json!({"a":[1,{"b":null}],"c":[]}), 2),
            "{\n  \"a\": [\n    1,\n    {\n      \"b\": null\n    }\n  ],\n  \"c\": []\n}"
        );
    }

    #[test]
    fn stringify_숫자와_키_순서() {
        assert_eq!(stringify(&json!({"b": 1.0, "a": [1.5, null, "x\n"]})), r#"{"b":1,"a":[1.5,null,"x\n"]}"#);
        // 인덱스 모양 키는 앞으로, 숫자 순으로("01" 은 인덱스가 아니다)
        let v: Value = serde_json::from_str(r#"{"z":1,"10":2,"2":3,"01":4}"#).unwrap();
        assert_eq!(stringify(&v), r#"{"2":3,"10":2,"z":1,"01":4}"#);
        let v: Value = serde_json::from_str(r#"{"b":1,"10":2,"a":1.0,"2":-0.0,"01":3.5}"#).unwrap();
        assert_eq!(stringify(&v), r#"{"2":0,"10":2,"b":1,"a":1,"01":3.5}"#);
        let v: Value = serde_json::from_str(r#"[1.0, 1.5, -0, 1e21, 12345678901234567890]"#).unwrap();
        assert_eq!(stringify(&v), "[1,1.5,0,1e+21,12345678901234567000]");
        assert_eq!(stringify(&json!("\u{1}가\"\\")), r#""\u0001가\"\\""#);
    }

    #[test]
    fn 들여쓰기는_json_stringify_null_2_와_같다() {
        let v = json!({ "a": [1, { "b": "x\n" }], "e": {}, "f": [] });
        assert_eq!(stringify_pretty(&v, 2), "{\n  \"a\": [\n    1,\n    {\n      \"b\": \"x\\n\"\n    }\n  ],\n  \"e\": {},\n  \"f\": []\n}");
    }

    #[test]
    fn uri_component_인코딩_디코딩() {
        assert_eq!(encode_uri_component("feature/foo 쿠"), "feature%2Ffoo%20%EC%BF%A0");
        assert_eq!(encode_uri_component("a-_.!~*'()"), "a-_.!~*'()");
        assert_eq!(decode_uri_component("%EC%A3%BC%EB%AC%B8").unwrap(), "주문");
        assert!(decode_uri_component("100%").is_err());
        assert!(decode_uri_component("%E2%82").is_err());
        assert!(decode_uri_component("%zz").is_err());
        assert_eq!(decode_uri_component("a+b").unwrap(), "a+b");
    }

    #[test]
    fn iso_string_은_toisostring_과_같다() {
        assert_eq!(iso_string(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_string(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert_eq!(iso_string(1_793_534_096_789), "2026-11-01T11:54:56.789Z");
    }

    #[test]
    fn trim_은_js_와_같은_글자를_지운다() {
        assert_eq!(trim("\u{FEFF} a \u{3000}"), "a");
        assert_eq!(trim("\u{85}a"), "\u{85}a"); // NEL 은 JS 공백이 아니다
    }

    #[test]
    fn number_는_js_의_number_와_같다() {
        assert_eq!(number(""), 0.0);
        assert_eq!(number(" 5 "), 5.0);
        assert_eq!(number("0x10"), 16.0);
        assert_eq!(number("1e2"), 100.0);
        assert_eq!(number("-Infinity"), f64::NEG_INFINITY);
        assert!(number("abc").is_nan());
        assert!(number("inf").is_nan());
        assert!(number("1 2").is_nan());
    }

    #[test]
    fn slice16_은_utf16_단위() {
        assert_eq!(slice16("가나다", 2), "가나");
        assert_eq!(slice16("a😀b", 2), "a"); // 쌍 한가운데 — 반쪽은 버린다
        assert_eq!(slice16("a😀b", 3), "a😀");
    }

    #[test]
    fn to_string_은_템플릿_리터럴과_같다() {
        assert_eq!(to_string(&json!(5)), "5");
        assert_eq!(to_string(&json!(1.5)), "1.5");
        assert_eq!(to_string(&json!([1, null, "a"])), "1,,a");
        assert_eq!(to_string(&json!({"a": 1})), "[object Object]");
        assert_eq!(to_string(&json!(1e21)), "1e+21");
        // JS 는 1e-6 부터 소수, 그보다 작으면 지수
        assert_eq!(to_string(&json!(0.000001)), "0.000001");
        assert_eq!(to_string(&json!(1e-7)), "1e-7");
        assert_eq!(to_string(&json!(-1.5e-8)), "-1.5e-8");
        assert_eq!(stringify(&json!([1e-8])), "[1e-8]");
    }

    #[test]
    fn truthy_는_js_와_같다() {
        assert!(!truthy(Some(&json!(0))));
        assert!(!truthy(Some(&json!(""))));
        assert!(truthy(Some(&json!("false"))));
        assert!(truthy(Some(&json!([]))));
        assert!(!truthy(None));
    }
}
