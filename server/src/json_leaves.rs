//! dot 경로로 JSON 값 꺼내기.
//!
//! 공개 API
//! - [`get_by_path`] — `a.b[0].c` 로 리프(문자열·숫자·불리언)를 꺼내 `String(v)` 로. 리프가 아니거나 없으면 None.
//!
//! post-step 추출과 assertion(jsonPath) 이 같이 쓴다 — 두 곳의 경로 해석이 다르면 '추출은 되는데 검증은 실패' 가 난다.

use serde_json::Value;

use crate::js;

enum Seg {
    Key(String),
    Index(usize),
}

/// `/([^[\]]+)|\[(\d+)\]/g` 를 한 세그먼트에 돌린 결과.
fn parts(seg: &str) -> Vec<Seg> {
    let c: Vec<char> = seg.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < c.len() {
        if c[i] != '[' && c[i] != ']' {
            let start = i;
            while i < c.len() && c[i] != '[' && c[i] != ']' {
                i += 1;
            }
            out.push(Seg::Key(c[start..i].iter().collect()));
            continue;
        }
        if c[i] == '[' {
            let mut j = i + 1;
            while j < c.len() && c[j].is_ascii_digit() {
                j += 1;
            }
            if j > i + 1 && c.get(j) == Some(&']') {
                let digits: String = c[i + 1..j].iter().collect();
                // Number('0123') = 123 — 아주 큰 수는 어떤 배열에도 없는 칸이다.
                out.push(Seg::Index(digits.parse().unwrap_or(usize::MAX)));
                i = j + 1;
                continue;
            }
        }
        i += 1; // 짝이 안 맞는 [ ] 는 정규식이 건너뛴다
    }
    out
}

/// dot 표기 경로(`a.b[0].c`)로 값을 꺼낸다. 리프가 아니거나 미존재면 None.
pub fn get_by_path(root: &Value, path: &str) -> Option<String> {
    let segs: Vec<Seg> = path.split('.').flat_map(parts).collect();
    let mut cur = root.clone();
    for s in segs {
        cur = match (&cur, s) {
            (Value::Object(o), Seg::Key(k)) => o.get(&k).cloned()?,
            // 객체의 [0] 은 "0" 키다(JS 프로퍼티 키는 문자열).
            (Value::Object(o), Seg::Index(n)) => o.get(&n.to_string()).cloned()?,
            (Value::Array(a), Seg::Index(n)) => a.get(n).cloned()?,
            (Value::Array(a), Seg::Key(k)) => {
                // 배열의 프로퍼티 — length 는 숫자, "0" 같은 키는 칸이다. 그 밖의 것(map·push…)은 함수라 리프가 아니다.
                if k == "length" {
                    Value::from(a.len())
                } else if js::is_index_key(&k) {
                    a.get(k.parse::<usize>().ok()?).cloned()?
                } else {
                    return None;
                }
            }
            _ => return None, // null·원시값 아래로는 못 내려간다
        };
    }
    match &cur {
        Value::String(_) | Value::Number(_) | Value::Bool(_) => Some(js::to_string(&cur)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn 경로로_리프를_꺼낸다() {
        let v = json!({ "a": { "b": [ { "c": 1.5 }, { "c": "x" } ] }, "ok": true, "n": null, "o": { "0": "zero" } });
        assert_eq!(get_by_path(&v, "a.b[0].c").as_deref(), Some("1.5"));
        assert_eq!(get_by_path(&v, "a.b[1].c").as_deref(), Some("x"));
        assert_eq!(get_by_path(&v, "ok").as_deref(), Some("true"));
        assert_eq!(get_by_path(&v, "n"), None);
        assert_eq!(get_by_path(&v, "a.b"), None);
        assert_eq!(get_by_path(&v, "a.b.length").as_deref(), Some("2"));
        assert_eq!(get_by_path(&v, "o[0]").as_deref(), Some("zero"));
        assert_eq!(get_by_path(&v, "missing.x"), None);
        assert_eq!(get_by_path(&json!([10, 20]), "[1]").as_deref(), Some("20"));
    }
}
