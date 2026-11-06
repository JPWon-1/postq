//! 기동 때 스키마 마이그레이션 다음에 도는 데이터 이관 — [`encrypt_existing_secrets`] ← src/db/encryptAtRest.ts
//!
//! 예전엔 Rust 가 스키마만 올리고 이걸 건너뛰었다. 그래서 키를 처음 켠 DB 를 Rust 로 열면 기존 평문 자격증명이
//! 계속 평문으로 남았다(codex 리뷰 P1).

use anyhow::{anyhow, bail, Result};
use rusqlite::types::Value as Sql;
use rusqlite::Connection;
use serde_json::Value;

use crate::js;
use crate::secretbox::{self, Keys};

pub fn run(conn: &Connection, keys: &Keys) -> Result<()> {
    encrypt_existing_secrets(conn, keys)?;
    Ok(())
}

/// 한 트랜잭션 안에서 f 를 돌린다 — 도중에 실패하면 평문/암호문이 섞인 채 남지 않게(Node 의 sqlite.transaction).
fn transaction<T>(conn: &Connection, f: impl FnOnce() -> Result<T>) -> Result<T> {
    conn.execute_batch("BEGIN")?;
    match f() {
        Ok(v) => {
            conn.execute_batch("COMMIT")?;
            Ok(v)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

/// 평문 secret 값 하나를 암호문으로. None 이면 건드리지 않는다.
/// Node 는 `if (!v.value || isEncrypted(v.value)) continue` 다음 encryptSecret(v.value) 이다 —
/// 문자열이 아닌 참 값(0 이 아닌 숫자)이면 createCipheriv 가 TypeError 를 던져 이관 전체가 실패한다. 같은 자리에서 실패한다.
fn encrypt_cell(keys: &Keys, table: &str, v: &Sql) -> Result<Option<String>> {
    match v {
        Sql::Null => Ok(None),
        Sql::Text(s) if s.is_empty() || secretbox::is_encrypted(s) => Ok(None),
        Sql::Text(s) => Ok(Some(secretbox::encrypt_with(keys, s))),
        // Buffer 는 cipher.update 가 그 바이트를 그대로 암호화한다. 빈 Buffer 도 참 값이고, enc 접두로 시작해도
        // isEncrypted 는 문자열만 보므로 Node 는 암호화한다. 글자로 바꿔 넘기면 이 셋이 다 달라진다(codex 리뷰).
        Sql::Blob(b) => Ok(secretbox::encrypt_bytes_with(keys, b)),
        Sql::Integer(0) => Ok(None),
        Sql::Real(f) if *f == 0.0 || f.is_nan() => Ok(None),
        // TEXT 친화 열이라 숫자는 글자로 바뀌어 담기므로 실제로는 오지 않는다.
        other => bail!("{table}.value 에 문자열이 아닌 값({other:?})이 있어 암호화하지 못했습니다"),
    }
}

/// 기존 평문 시크릿을 암호문으로 옮긴다. 키가 없으면 아무것도 안 한다. 이미 암호문인 값은 그대로라 매 기동 돌아도 같다.
pub fn encrypt_existing_secrets(conn: &Connection, keys: &Keys) -> Result<usize> {
    if keys.current.is_none() {
        return Ok(0);
    }
    let mut unreadable: Vec<String> = vec![];
    let n = transaction(conn, || {
        let mut n = 0;
        // 1) 변수 중 secret 으로 표시된 것, 2) 쿠키 값(세션 쿠키라 자격증명과 같다)
        for (table, select) in [("variables", "SELECT id, value FROM variables WHERE secret = 1"), ("cookies", "SELECT id, value FROM cookies")] {
            let rows: Vec<(String, Sql)> =
                conn.prepare(select)?.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
            let mut upd = conn.prepare(&format!("UPDATE {table} SET value = ?1 WHERE id = ?2"))?;
            for (id, value) in rows {
                if let Some(enc) = encrypt_cell(keys, table, &value)? {
                    upd.execute(rusqlite::params![enc, id])?;
                    n += 1;
                }
            }
        }
        // 3) 폴더/요청의 인증 설정(JSON) — token·password·value·clientSecret 만 암호화된다
        for (table, col) in [("folders", "shared_auth"), ("requests", "auth")] {
            let rows: Vec<(String, Sql)> = conn
                .prepare(&format!("SELECT id, {col} AS auth FROM {table}"))?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<_, _>>()?;
            let mut upd = conn.prepare(&format!("UPDATE {table} SET {col} = ?1 WHERE id = ?2"))?;
            for (id, raw) in rows {
                // `if (!r.auth) continue` — 텍스트 열이라 null·'' 만 거른다. 숫자로 들어간 행은 JSON.parse 가 숫자로 읽는다.
                let text = match raw {
                    Sql::Null => continue,
                    Sql::Text(s) if s.is_empty() => continue,
                    Sql::Text(s) => s,
                    Sql::Integer(0) => continue,
                    Sql::Integer(i) => i.to_string(),
                    Sql::Real(f) if f == 0.0 || f.is_nan() => continue,
                    Sql::Real(f) => js::number_to_string(f),
                    Sql::Blob(b) => String::from_utf8_lossy(&b).into_owned(),
                };
                // 손상된 행은 건너뛴다. 단 짝 없는 서로게이트가 든 JSON 은 Node 는 읽어 이관하지만 여기서는 못 읽는다
                // (js::parse_json 참고) — 평문 secret 이 남을 수 있으니 조용히 넘기지 않고 알린다.
                let Some(parsed) = js::parse_json(&text) else {
                    unreadable.push(format!("{table}.{col} ({id})"));
                    continue;
                };
                if !js::truthy(Some(&parsed)) || parsed.get("type").and_then(Value::as_str) == Some("none") {
                    continue;
                }
                let next = secretbox::encrypt_auth_config_with(keys, &parsed).map_err(|e| anyhow!("{table}.{col} ({id}) 암호화 실패: {e}"))?;
                let next = js::stringify(&next);
                if next == text {
                    continue;
                }
                upd.execute(rusqlite::params![next, id])?;
                n += 1;
            }
        }
        Ok(n)
    })?;
    if n > 0 {
        println!("[secretbox] 기존 평문 시크릿 {n}건을 암호화했습니다.");
    }
    if !unreadable.is_empty() {
        let msg = format!("인증 설정 {}건을 JSON 으로 읽지 못해 암호화하지 않았습니다", unreadable.len());
        crate::server_log::log(crate::server_log::Level::Warn, "secret 이관", &msg, Some(&unreadable.join("\n")), None);
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Db;

    fn db() -> (tempfile::TempDir, Db) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.db");
        let migrations = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../drizzle");
        let db = Db::open(path.to_str().unwrap(), &migrations).unwrap();
        (dir, db)
    }

    fn keys() -> Keys {
        Keys::new(Some("test-key"), &[])
    }

    fn seed_plain(c: &Connection) {
        c.execute_batch(
            r#"INSERT INTO environments (id, workspace_id, name) VALUES ('e1', 'default', 'dev');
               INSERT INTO variables (id, environment_id, key, value, secret) VALUES ('v1', 'e1', 'tok', 'plain-secret', 1);
               INSERT INTO variables (id, environment_id, key, value, secret) VALUES ('v2', 'e1', 'host', 'example.com', 0);
               INSERT INTO variables (id, environment_id, key, value, secret) VALUES ('v3', 'e1', 'empty', '', 1);"#,
        )
        .unwrap();
    }

    fn value_of(c: &Connection, id: &str) -> String {
        c.query_row("SELECT value FROM variables WHERE id = ?1", [id], |r| r.get(0)).unwrap()
    }

    #[test]
    fn 키가_없으면_아무것도_안_한다() {
        let (_d, db) = db();
        db.with(|c| {
            seed_plain(c);
            assert_eq!(encrypt_existing_secrets(c, &Keys::default())?, 0);
            assert_eq!(value_of(c, "v1"), "plain-secret");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn secret_변수만_암호화하고_두번째는_아무것도_안_한다() {
        let (_d, db) = db();
        db.with(|c| {
            seed_plain(c);
            assert_eq!(encrypt_existing_secrets(c, &keys())?, 1);
            let v1 = value_of(c, "v1");
            assert!(secretbox::is_encrypted(&v1));
            assert_eq!(secretbox::decrypt_with(&keys(), &v1), "plain-secret");
            assert_eq!(value_of(c, "v2"), "example.com", "secret 아닌 변수는 그대로");
            assert_eq!(value_of(c, "v3"), "", "빈 값은 그대로");
            assert_eq!(encrypt_existing_secrets(c, &keys())?, 0, "멱등");
            assert_eq!(value_of(c, "v1"), v1);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn 요청_인증의_secret_필드만_암호화하고_손상된_행은_건너뛴다() {
        let (_d, db) = db();
        db.with(|c| {
            c.execute_batch(
                r#"INSERT INTO folders (id, name) VALUES ('f1', 'F');
                   INSERT INTO requests (id, folder_id, name, auth, updated_at) VALUES ('r1', 'f1', 'a', '{"type":"bearer","token":"abc"}', 0);
                   INSERT INTO requests (id, folder_id, name, auth, updated_at) VALUES ('r2', 'f1', 'b', '{broken', 0);
                   INSERT INTO requests (id, folder_id, name, auth, updated_at) VALUES ('r3', 'f1', 'c', '{"type":"none"}', 0);"#,
            )?;
            assert_eq!(encrypt_existing_secrets(c, &keys())?, 1);
            let auth = |id: &str| -> String { c.query_row("SELECT auth FROM requests WHERE id = ?1", [id], |r| r.get(0)).unwrap() };
            let r1: Value = serde_json::from_str(&auth("r1")).unwrap();
            assert_eq!(r1["type"], "bearer");
            assert_eq!(secretbox::decrypt_with(&keys(), r1["token"].as_str().unwrap()), "abc");
            assert_eq!(auth("r2"), "{broken");
            assert_eq!(auth("r3"), r#"{"type":"none"}"#);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn 숫자로_넣은_secret_도_글자로_담겨_암호화된다() {
        let (_d, db) = db();
        db.with(|c| {
            seed_plain(c);
            // value 는 TEXT 친화 열이라 5 가 '5' 로 담긴다 — Node 도 '5' 로 읽어 암호화한다.
            c.execute("INSERT INTO variables (id, environment_id, key, value, secret) VALUES ('v4', 'e1', 'n', 5, 1)", [])?;
            assert_eq!(encrypt_existing_secrets(c, &keys())?, 2);
            assert_eq!(secretbox::decrypt_with(&keys(), &value_of(c, "v4")), "5");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn blob_secret_은_바이트_그대로_암호화한다() {
        let (_d, db) = db();
        db.with(|c| {
            seed_plain(c);
            c.execute_batch(
                r#"INSERT INTO variables (id, environment_id, key, value, secret) VALUES ('b1', 'e1', 'a', X'', 1);
                   INSERT INTO variables (id, environment_id, key, value, secret) VALUES ('b2', 'e1', 'b', X'FF', 1);
                   INSERT INTO variables (id, environment_id, key, value, secret) VALUES ('b3', 'e1', 'c', CAST('enc:v1:plain' AS BLOB), 1);"#,
            )?;
            assert_eq!(encrypt_existing_secrets(c, &keys())?, 4);
            // 복호화한 바이트가 원본 바이트와 같은지 본다(decrypt_with 는 글자를 돌려주므로 바이트는 직접 푼다).
            for (id, want) in [("b1", vec![]), ("b2", vec![0xFF]), ("b3", b"enc:v1:plain".to_vec())] {
                let stored = value_of(c, id);
                assert!(secretbox::is_encrypted(&stored), "{id}");
                assert_eq!(secretbox::decrypt_bytes_with(&keys(), &stored), Some(want), "{id}");
            }
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn 인증_필드가_문자열이_아니면_실패하고_되돌린다() {
        let (_d, db) = db();
        db.with(|c| {
            seed_plain(c);
            // Node 는 encryptSecret(123) 에서 TypeError 를 던져 트랜잭션 전체가 되돌려진다.
            c.execute_batch(
                r#"INSERT INTO folders (id, name) VALUES ('f1', 'F');
                   INSERT INTO requests (id, folder_id, name, auth, updated_at) VALUES ('r1', 'f1', 'a', '{"type":"bearer","token":123}', 0);"#,
            )?;
            assert!(encrypt_existing_secrets(c, &keys()).is_err());
            assert_eq!(value_of(c, "v1"), "plain-secret", "앞서 바꾼 변수도 되돌려졌다");
            Ok(())
        })
        .unwrap();
    }
}
