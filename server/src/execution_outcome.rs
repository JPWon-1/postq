//! '이 실행은 실패인가'.
//!
//! 예전엔 화면마다 실패의 정의가 달라 같은 실행이 한 화면에선 실패, 실패 목록에선 성공으로 나왔다.
//! 규칙: 전송 오류가 있으면 실패, 응답 확인 조건이 있으면 그 판정(404 를 기대한 요청이 404 면 성공),
//! 조건이 없으면(null) HTTP 코드로(400 이상 실패). 행 판정과 SQL 은 반드시 같이 고친다.

/// 실패 판정의 SQL — `executions` 테이블 열 이름 그대로.
pub const FAILED_SQL: &str = r#"("error" IS NOT NULL OR "check_passed" = 0 OR ("check_passed" IS NULL AND "response_status" >= 400))"#;

/// 이미 읽어 온 행에 쓰는 판정. check_passed 는 drizzle boolean(1 만 true) 으로 읽은 값.
pub fn is_failed_row(error_is_null: bool, check_passed: Option<bool>, status: Option<f64>) -> bool {
    if !error_is_null {
        return true;
    }
    match check_passed {
        Some(false) => true,
        Some(true) => false,
        None => status.map_or(false, |s| s >= 400.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 기대한_404_는_성공_200_이라도_조건이_깨지면_실패() {
        assert!(!is_failed_row(true, Some(true), Some(404.0)));
        assert!(is_failed_row(true, Some(false), Some(200.0)));
        assert!(is_failed_row(true, None, Some(500.0)));
        assert!(!is_failed_row(true, None, Some(200.0)));
        assert!(!is_failed_row(true, None, None));
        assert!(is_failed_row(false, Some(true), Some(200.0)));
    }

    #[test]
    fn 행_판정이_sql_판정과_같다() {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE executions (id TEXT, error TEXT, check_passed INTEGER, response_status INTEGER);
             INSERT INTO executions VALUES ('a', NULL, 1, 404), ('b', NULL, 0, 200), ('c', NULL, NULL, 500),
               ('d', NULL, NULL, 200), ('e', 'x', 1, 200), ('f', NULL, NULL, NULL), ('g', '', NULL, 200);",
        )
        .unwrap();
        let failed: Vec<String> = c
            .prepare(&format!("SELECT id FROM executions WHERE {FAILED_SQL} ORDER BY id"))
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let mut by_row = vec![];
        let mut st = c.prepare("SELECT id, error IS NULL, check_passed, response_status FROM executions ORDER BY id").unwrap();
        let rows = st
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?, r.get::<_, Option<i64>>(2)?, r.get::<_, Option<f64>>(3)?)))
            .unwrap();
        for row in rows {
            let (id, en, cp, st) = row.unwrap();
            if is_failed_row(en, cp.map(|v| v == 1), st) {
                by_row.push(id);
            }
        }
        assert_eq!(failed, by_row);
    }
}
