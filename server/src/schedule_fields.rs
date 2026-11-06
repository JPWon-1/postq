//! 스케줄에 들어갈 값의 허용 범위.
//!
//! 만들 때와 고칠 때가 같은 규칙을 쓰게 한곳에 둔다. 스케줄은 사람이 안 볼 때 도는 것이라,
//! 잘못 만들어져도 등록 시점엔 아무 일이 없다가 새벽에 조용히 실패한다 — 들어오는 자리에서 막는다.

use serde_json::Value;

use crate::js;

/// 주기의 상한 — 31일. 그보다 긴 주기는 스케줄이 아니라 잊어버린 것이다.
pub const MAX_INTERVAL_MINUTES: i64 = 60 * 24 * 31;

/// 주기(분)를 읽는다. 숫자로 볼 수 없거나 범위를 벗어나면 None.
/// 숫자 또는 공백이 아닌 숫자 문자열만 받는다(Number(v) 규칙) — 오타를 조용히 60분으로 바꾸지 않는다.
pub fn parse_interval_minutes(v: Option<&Value>) -> Option<i64> {
    let n = match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) if !js::trim(s).is_empty() => js::number(s),
        _ => f64::NAN,
    };
    if !n.is_finite() {
        return None;
    }
    let i = n.trunc();
    (i >= 1.0 && i <= MAX_INTERVAL_MINUTES as f64).then_some(i as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn 숫자와_숫자_문자열을_받는다() {
        assert_eq!(parse_interval_minutes(Some(&json!(5))), Some(5));
        assert_eq!(parse_interval_minutes(Some(&json!("15"))), Some(15));
        assert_eq!(parse_interval_minutes(Some(&json!(5.9))), Some(5)); // 분 단위라 버린다
    }

    #[test]
    fn 숫자로_볼_수_없으면_none() {
        for v in [json!("아무거나"), json!(""), json!("  "), json!(null), json!({}), json!([])] {
            assert_eq!(parse_interval_minutes(Some(&v)), None, "{v}");
        }
        assert_eq!(parse_interval_minutes(None), None);
    }

    #[test]
    fn 범위를_벗어나면_none() {
        assert_eq!(parse_interval_minutes(Some(&json!(0))), None);
        assert_eq!(parse_interval_minutes(Some(&json!(-5))), None);
        assert_eq!(parse_interval_minutes(Some(&json!(MAX_INTERVAL_MINUTES))), Some(MAX_INTERVAL_MINUTES));
        assert_eq!(parse_interval_minutes(Some(&json!(MAX_INTERVAL_MINUTES + 1))), None);
    }
}
