//! DB 의 JSON 텍스트 열을 쓰기 전에 방어 정규화한다.
//!
//! 손상/잘못된 형식의 값(손편집 export 파일 import·레거시·수동 DB 편집)이 목록 조회나 실행 경로를
//! 500 내지 못하게 한다. 컨테이너 형식뿐 아니라 '배열 요소' 모양까지 본다 — [null]·[42]·{value:123} 같은
//! 요소가 소비자의 .map/.replace/.enabled 에서 터지는 자리는 한참 뒤라 원인을 못 찾는다.
//!
//! 여러 라우트를 따로 옮기면서 같은 헬퍼가 네 벌 생겼었다. 입력 모양(행에서 읽은 JSON 값·문자열·SQLite 값)만
//! 다를 뿐 규칙은 하나여야 하므로, 입구만 셋으로 두고 판단은 [`safe_json`] 한 곳에서 한다.
//! JSON 을 다시 문자열로 쓰는 일(JSON.stringify)은 여기서 하지 않는다 — [`crate::js::stringify`] 하나만 쓴다.

use rusqlite::types::ValueRef;
use serde_json::{Map, Value};

use crate::js;

/// `safeJson(s)` — 실패하면 None(undefined). 값이 없거나 null 이어도 None.
///
/// JS 의 JSON.parse 는 문자열이 아닌 값을 String() 으로 바꿔 읽는다. better-sqlite3 는 text 열에 든 숫자를
/// 숫자로 주고, 저장본(snapshot)은 열이 이미 숫자·배열로 들어올 수 있다. 그 경우까지 같은 답을 내려고
/// 그 규칙도 따른다(5 → 5, [1] → "1" → 1, {} → "[object Object]" → 실패).
pub fn safe_json(v: Option<&Value>) -> Option<Value> {
    match v? {
        Value::Null => None,
        Value::String(s) => safe_json_str(Some(s)),
        other => safe_json_str(Some(&js::to_string(other))),
    }
}

/// 문자열에서 바로 — `safeJson(str)`. "null" 은 Some(Null) 이다(JSON.parse 와 같다).
pub fn safe_json_str(s: Option<&str>) -> Option<Value> {
    crate::js::parse_json(s?)
}

/// SQLite 값에서 바로 — 행을 JSON 객체로 만들지 않고 열 하나만 읽는 자리용. 규칙은 [`safe_json`] 과 같다.
pub fn safe_json_ref(v: ValueRef<'_>) -> Option<Value> {
    match v {
        ValueRef::Null => None,
        // JSON.parse(숫자) 는 그 숫자다. TEXT 열은 숫자를 글자로 바꿔 담으므로 실제로는 거의 오지 않는다.
        // 숫자는 better-sqlite3 가 읽는 그대로(2^53 넘는 정수는 double 로 반올림) — rows::raw 와 같다.
        ValueRef::Integer(_) | ValueRef::Real(_) => Some(crate::rows::raw(v)).filter(|x| !x.is_null()),
        // Buffer 도 String(buf) 는 그 내용이라 글자로 읽는다.
        ValueRef::Text(t) | ValueRef::Blob(t) => safe_json_str(Some(&String::from_utf8_lossy(t))),
    }
}

/// plain object 요소만 남긴 배열(null·원시값·중첩배열 요소 제거). 배열이 아니면 [].
pub fn to_object_array(v: Option<&Value>) -> Vec<Value> {
    match v {
        Some(Value::Array(a)) => a.iter().filter(|e| e.is_object()).cloned().collect(),
        _ => vec![],
    }
}

/// plain object 면 그대로, 아니면 {}.
pub fn to_object(v: Option<&Value>) -> Value {
    match v {
        Some(o @ Value::Object(_)) => o.clone(),
        _ => Value::Object(Map::new()),
    }
}

/// 문자열 요소만 남긴 배열(tags 처럼 string[] 인 열).
pub fn to_string_array(v: Option<&Value>) -> Vec<Value> {
    match v {
        Some(Value::Array(a)) => a.iter().filter(|e| e.is_string()).cloned().collect(),
        _ => vec![],
    }
}

/// KV 배열 정규화 — key/value 는 문자열로 강제(누락·null 은 ''), enabled 는 명시적 false 만 false,
/// description 은 문자열일 때만. 소비자가 p.value.replace()·h.enabled 를 무가드로 부르므로 이 모양을 반드시 보장한다.
/// 키 순서는 Node 가 만든 객체와 같다(key, value, enabled, description).
pub fn to_kv_array(v: Option<&Value>) -> Vec<Value> {
    to_object_array(v)
        .iter()
        .map(|e| {
            let text = |k: &str| match e.get(k) {
                Some(Value::String(s)) => s.clone(),
                None | Some(Value::Null) => String::new(),
                Some(other) => js::to_string(other),
            };
            let mut kv = Map::new();
            kv.insert("key".into(), Value::String(text("key")));
            kv.insert("value".into(), Value::String(text("value")));
            kv.insert("enabled".into(), Value::Bool(e.get("enabled") != Some(&Value::Bool(false))));
            if let Some(d @ Value::String(_)) = e.get("description") {
                kv.insert("description".into(), d.clone());
            }
            Value::Object(kv)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn safe_json_정상은_그대로_깨진것은_none() {
        assert_eq!(safe_json(Some(&json!(r#"{"a":1}"#))), Some(json!({"a": 1})));
        assert_eq!(safe_json(Some(&json!("[1,2]"))), Some(json!([1, 2])));
        assert_eq!(safe_json(Some(&json!("{oops"))), None);
        assert_eq!(safe_json(Some(&json!(null))), None);
        assert_eq!(safe_json(None), None);
        assert_eq!(safe_json(Some(&json!(""))), None);
        // 문자열이 아니면 String() 해서 읽는다
        assert_eq!(safe_json(Some(&json!(5))), Some(json!(5)));
        assert_eq!(safe_json(Some(&json!({"a": 1}))), None);
    }

    #[test]
    fn safe_json_str_과_ref_도_같은_규칙() {
        assert_eq!(safe_json_str(Some(r#"{"a":1}"#)), Some(json!({"a": 1})));
        assert_eq!(safe_json_str(Some("{oops")), None);
        assert_eq!(safe_json_str(None), None);
        assert_eq!(safe_json_str(Some("")), None);
        assert_eq!(safe_json_ref(ValueRef::Text(b"oops")), None);
        assert_eq!(safe_json_ref(ValueRef::Null), None);
        assert_eq!(safe_json_ref(ValueRef::Text(b"[1]")), Some(json!([1])));
    }

    #[test]
    fn to_object_array_는_객체_요소만() {
        assert_eq!(to_object_array(Some(&json!([{"a": 1}, null, 42, "x", []]))), vec![json!({"a": 1})]);
        for v in [json!(null), json!({}), json!("str"), json!(7)] {
            assert!(to_object_array(Some(&v)).is_empty());
        }
        assert!(to_object_array(None).is_empty());
        assert_eq!(to_object_array(Some(&json!([{ "a": 1 }, null, 42, "x", [], { "b": 2 }]))).len(), 2);
    }

    #[test]
    fn to_object_는_plain_object_만() {
        assert_eq!(to_object(Some(&json!({"a": 1}))), json!({"a": 1}));
        for v in [json!([]), json!(null), json!("x"), json!(3)] {
            assert_eq!(to_object(Some(&v)), json!({}));
        }
        assert_eq!(to_object(None), json!({}));
    }

    #[test]
    fn to_string_array_는_문자열_요소만() {
        assert_eq!(to_string_array(Some(&json!(["a", 1, null, "b", {}]))), vec![json!("a"), json!("b")]);
        assert!(to_string_array(Some(&json!("a,b"))).is_empty());
    }

    #[test]
    fn to_kv_array_는_소비자가_쓰는_모양을_보장한다() {
        assert_eq!(to_kv_array(Some(&json!([{"key": "n", "value": 123}]))), vec![json!({"key": "n", "value": "123", "enabled": true})]);
        assert_eq!(to_kv_array(Some(&json!([{"key": 7, "value": true}]))), vec![json!({"key": "7", "value": "true", "enabled": true})]);
        assert_eq!(to_kv_array(Some(&json!([{}]))), vec![json!({"key": "", "value": "", "enabled": true})]);
        assert_eq!(to_kv_array(Some(&json!([{"key": null}]))), vec![json!({"key": "", "value": "", "enabled": true})]);
        let en = |e: Value| to_kv_array(Some(&json!([{"key": "a", "value": "1", "enabled": e}])))[0]["enabled"].clone();
        assert_eq!(en(json!(false)), json!(false));
        assert_eq!(en(json!(0)), json!(true)); // 0 은 false 가 아니다
        assert_eq!(en(json!("no")), json!(true));
        assert_eq!(to_kv_array(Some(&json!([{"key": "a", "value": "1", "description": "설명"}])))[0]["description"], json!("설명"));
        assert!(to_kv_array(Some(&json!([{"key": "a", "value": "1", "description": 42}])))[0].get("description").is_none());
        assert_eq!(to_kv_array(Some(&json!([null, {"key": "a", "value": "1"}, "x"]))), vec![json!({"key": "a", "value": "1", "enabled": true})]);
        assert_eq!(
            to_kv_array(Some(&json!([null, 3, [1], { "key": "H", "value": "V", "enabled": 0, "description": "d" }]))),
            vec![json!({ "key": "H", "value": "V", "enabled": true, "description": "d" })]
        );
        assert!(to_kv_array(Some(&json!("nope"))).is_empty());
        assert!(to_kv_array(None).is_empty());
        // 키 순서는 Node 가 만든 객체와 같다
        let kv = to_kv_array(Some(&json!([{ "description": "d", "enabled": false, "value": "v", "key": "k" }])));
        assert_eq!(kv[0].to_string(), r#"{"key":"k","value":"v","enabled":false,"description":"d"}"#);
    }
}
