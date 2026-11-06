//! 보내기 직전 JSON 바디 정리.
//!
//! 공개 API
//! - [`looks_like_json`] — `{`·`[` 로 시작하는 글인가(앞뒤 공백 무시).
//! - [`strip_json_comments`] — `//` 주석을 같은 길이의 공백으로(오류 위치를 원문과 맞추는 검사용).
//! - [`strip_json_comments_for_send`] — 보낼 때 쓰는 주석 제거(주석만 있던 줄은 줄째 지운다).
//! - [`drop_dangling_commas`] — 주석을 빼서 생긴 끝 쉼표 정리(문자열 안은 손대지 않는다).
//!
//! 화면이 ⌘/ 로 줄을 잠시 빼 두는 방식이라, 보내기 직전에 걷어내지 않으면 서버가 400 을 준다.
//! JS 는 UTF-16 단위로 돌지만 다루는 글자('"', '\\', '/', ',', 공백)가 모두 BMP 라 char 단위와 결과가 같다.

use crate::js::{self, is_js_space};

/// 이 글이 JSON 으로 보이는가 — 선언된 바디 타입이 Raw 여도 내용이 JSON 이면 정리한다.
pub fn looks_like_json(text: &str) -> bool {
    let raw = js::trim(text);
    !raw.is_empty() && (raw.starts_with('{') || raw.starts_with('['))
}

/// `//` 주석을 줄 끝까지 공백으로 바꾼다(줄바꿈은 남긴다). 문자열 안의 `//` 는 내용이다.
pub fn strip_json_comments(text: &str) -> String {
    let c: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut in_string = false;
    let mut i = 0;
    while i < c.len() {
        let ch = c[i];
        if in_string {
            if ch == '\\' {
                // text.slice(i, i + 2) — 끝이면 한 글자만.
                out.push(ch);
                if let Some(n) = c.get(i + 1) {
                    out.push(*n);
                }
                i += 2;
                continue;
            }
            if ch == '"' {
                in_string = false;
            }
            out.push(ch);
            i += 1;
            continue;
        }
        if ch == '"' {
            in_string = true;
            out.push(ch);
            i += 1;
            continue;
        }
        if ch == '/' && c.get(i + 1) == Some(&'/') {
            let mut j = i;
            while j < c.len() && c[j] != '\n' {
                j += 1;
            }
            // ' '.repeat(j - i) — JS 길이는 UTF-16 단위다. 주석 안의 서로게이트 쌍은 공백 두 칸이 된다.
            let units: usize = c[i..j].iter().map(|x| x.len_utf16()).sum();
            out.extend(std::iter::repeat(' ').take(units));
            i = j;
            continue;
        }
        out.push(ch);
        i += 1;
    }
    out
}

/// 보낼 때·curl 로 복사할 때 쓰는 주석 제거 — 주석만 있던 줄은 줄째 지우고, 주석이 붙어 있던 줄은 끝 공백을 걷는다.
/// 원래부터 빈 줄은 사용자가 둔 것이라 남긴다.
pub fn strip_json_comments_for_send(text: &str) -> String {
    let original: Vec<&str> = text.split('\n').collect();
    let stripped = strip_json_comments(text);
    let mut out: Vec<String> = Vec::new();
    for (i, line) in stripped.split('\n').enumerate() {
        if Some(&line) == original.get(i) {
            out.push(line.to_string());
            continue;
        }
        let cleaned = line.trim_end_matches(is_js_space);
        if js::trim(cleaned).is_empty() {
            continue;
        }
        out.push(cleaned.to_string());
    }
    out.join("\n")
}

/// 주석만 남고 값이 사라진 줄 때문에 생기는 끝 쉼표를 정리한다(예: [1, 2,] → [1, 2]). 문자열 안은 건드리지 않는다.
pub fn drop_dangling_commas(text: &str) -> String {
    let c: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut in_string = false;
    let mut i = 0;
    while i < c.len() {
        let ch = c[i];
        if in_string {
            out.push(ch);
            if ch == '\\' {
                if let Some(n) = c.get(i + 1) {
                    out.push(*n);
                }
                i += 2;
                continue;
            }
            if ch == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        if ch == '"' {
            in_string = true;
            out.push(ch);
            i += 1;
            continue;
        }
        if ch == ',' {
            let mut j = i + 1;
            while j < c.len() && is_js_space(c[j]) {
                j += 1;
            }
            if matches!(c.get(j), Some('}') | Some(']')) {
                i += 1; // 끝 쉼표 — 버린다(뒤의 공백은 그대로 둔다)
                continue;
            }
        }
        out.push(ch);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 주석과_끝_쉼표를_보내기_전에_걷어낸다() {
        let body = "{\n  \"a\": 1,\n  // \"b\": 2\n}";
        assert_eq!(drop_dangling_commas(&strip_json_comments_for_send(body)), "{\n  \"a\": 1\n}");
        // 문자열 안의 // 와 ,} 는 내용이다
        let s = r#"{"url":"http://x","p":"a,}"}"#;
        assert_eq!(drop_dangling_commas(&strip_json_comments_for_send(s)), s);
        assert_eq!(strip_json_comments("{\"a\":1 // 꼬리\n}"), "{\"a\":1      \n}");
        assert_eq!(strip_json_comments_for_send("{\"a\":1 // 꼬리\n\n}"), "{\"a\":1\n\n}");
    }

    #[test]
    fn json_처럼_보이는가() {
        assert!(looks_like_json("  {\"a\":1}"));
        assert!(looks_like_json("[1]"));
        assert!(!looks_like_json("a=1"));
        assert!(!looks_like_json("   "));
    }
}
