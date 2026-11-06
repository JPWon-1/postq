//! SQLite 연결과 마이그레이션.
//!
//! 마이그레이션 파일은 `npx drizzle-kit generate` 로 schema.ts 에서 만든다(drizzle/). 기록 방식도 drizzle 의
//! 것을 따른다 — 이미 적힌 기록을 '안 돌린 것' 으로 보면 같은 CREATE·ALTER 를 두 번 돌리다 깨진다.

use std::path::Path;
use std::sync::{Arc, Mutex};

use anyhow::{bail, Context, Result};
use rusqlite::Connection;
use serde::Deserialize;
use sha2::{Digest, Sha256};

/// 연결 하나를 잠가 쓴다. 이 앱은 한 사람이 쓰는 도구라 동시 쓰기가 드물고,
/// SQLite 는 어차피 쓰기를 하나씩만 받는다. 읽기가 많아지면 그때 풀로 바꾼다.
#[derive(Clone)]
pub struct Db(Arc<Mutex<Connection>>);

impl Db {
    pub fn open(path: &str, migrations_dir: &Path) -> Result<Self> {
        let existing_db = path != ":memory:" && std::fs::metadata(path).is_ok_and(|m| m.len() > 0);
        if path != ":memory:" {
            if let Some(dir) = Path::new(path).parent() {
                if !dir.as_os_str().is_empty() {
                    std::fs::create_dir_all(dir).with_context(|| format!("DB 폴더를 만들지 못했습니다: {}", dir.display()))?;
                }
            }
        }
        let conn = Connection::open(path).with_context(|| format!("DB 를 열지 못했습니다: {path}"))?;
        // 외래키 검사를 켠다 — 지금 스키마에 외래키는 없지만, 생기면 바로 검사되게.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        // 같은 파일을 여는 서버가 둘일 수 있다(번들 앱 + 개발 서버) — 잠겨 있으면 바로 실패하지 말고 잠시 기다린다.
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        migrate(&conn, migrations_dir, existing_db.then_some(Path::new(path)))?;
        Ok(Db(Arc::new(Mutex::new(conn))))
    }

    /// 연결을 잠근 채 f 를 돌린다. 핸들러에서는 [`Db::run`] 으로 블로킹 스레드에서 부른다.
    pub fn with<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let conn = self.0.lock().map_err(|_| anyhow::anyhow!("DB 잠금이 깨졌습니다"))?;
        f(&conn)
    }

    /// 비동기 핸들러용 — SQLite 호출은 블로킹이라 런타임 스레드를 붙잡지 않게 옮겨서 돈다.
    pub async fn run<T: Send + 'static>(&self, f: impl FnOnce(&Connection) -> Result<T> + Send + 'static) -> Result<T> {
        let db = self.clone();
        tokio::task::spawn_blocking(move || db.with(f)).await?
    }
}

#[derive(Deserialize)]
struct Journal {
    entries: Vec<JournalEntry>,
}

#[derive(Deserialize)]
struct JournalEntry {
    when: i64,
    tag: String,
}

/// drizzle-orm/sqlite-core 의 migrator 와 같은 규칙:
/// - 기록 테이블은 `__drizzle_migrations(id, hash, created_at)`
/// - 마지막 기록의 created_at 보다 journal 의 `when` 이 큰 것만 돌린다
/// - 파일은 `--> statement-breakpoint` 로 나눠 한 트랜잭션에서 돌리고, hash 는 파일 원문의 sha256
pub fn migrate(conn: &Connection, dir: &Path, existing_db: Option<&Path>) -> Result<()> {
    let journal_path = dir.join("meta/_journal.json");
    let journal: Journal = serde_json::from_str(
        &std::fs::read_to_string(&journal_path).with_context(|| format!("마이그레이션 목록을 읽지 못했습니다: {}", journal_path.display()))?,
    )?;
    let has_history: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations')",
        [], |r| r.get(0),
    )?;
    // drizzle 은 `Number(lastDbMigration[2]) < migration.folderMillis` 로 비교한다. 예전엔 i64 로만 읽고 모든 오류를
    // '기록 없음' 으로 삼켜서, created_at 이 실수로 들어 있는 DB 에서 마이그레이션을 처음부터 다시 돌리다
    // 'table already exists' 로 기동이 깨졌다(codex 리뷰). 행이 없을 때만 '기록 없음' 이다.
    let last: Option<f64> = if !has_history { None } else { match conn.query_row(r#"SELECT created_at FROM "__drizzle_migrations" ORDER BY created_at DESC LIMIT 1"#, [], |r| {
        r.get::<_, rusqlite::types::Value>(0)
    }) {
        Ok(v) => Some(match v {
            rusqlite::types::Value::Null => 0.0, // Number(null) === 0
            rusqlite::types::Value::Integer(i) => i as f64,
            rusqlite::types::Value::Real(f) => f,
            rusqlite::types::Value::Text(t) => crate::js::number(&t),
            // Number(Buffer) 는 그 글자를 숫자로 읽는다(Number(String(buf))).
            rusqlite::types::Value::Blob(b) => crate::js::number(&String::from_utf8_lossy(&b)),
        }),
        Err(rusqlite::Error::QueryReturnedNoRows) => None,
        Err(e) => return Err(anyhow::Error::new(e).context("마이그레이션 기록을 읽지 못했습니다")),
    }};
    // NaN 과의 비교는 JS 처럼 거짓 — 그 경우 아무것도 돌리지 않는다.
    let pending: Vec<&JournalEntry> = journal.entries.iter().filter(|e| last.map_or(true, |l| l < e.when as f64)).collect();
    if pending.is_empty() {
        return Ok(());
    }
    // Only a pre-existing database with pending changes needs a rollback point.
    // VACUUM INTO reads the live WAL consistently and runs before any schema write.
    if let Some(path) = existing_db {
        let backup = crate::backup::before_migrate(conn, path)?;
        eprintln!("[postq] before-migrate backup: {}", backup.display());
    }
    conn.execute_batch("BEGIN")?;
    let result = (|| -> Result<()> {
        conn.execute(r#"CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)"#, [])?;
        for e in &pending {
            let path = dir.join(format!("{}.sql", e.tag));
            let sql = std::fs::read_to_string(&path).with_context(|| format!("마이그레이션 파일을 읽지 못했습니다: {}", path.display()))?;
            for stmt in sql.split("--> statement-breakpoint") {
                if stmt.trim().is_empty() {
                    continue;
                }
                conn.execute_batch(stmt).with_context(|| format!("마이그레이션 {} 실패", e.tag))?;
            }
            let hash = hex::encode(Sha256::digest(sql.as_bytes()));
            conn.execute(r#"INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?1, ?2)"#, rusqlite::params![hash, e.when])?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => conn.execute_batch("COMMIT")?,
        Err(err) => {
            let _ = conn.execute_batch("ROLLBACK");
            bail!(err)
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn migrations() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../drizzle")
    }

    #[test]
    fn 실수로_적힌_마지막_기록도_읽고_다시_돌리지_않는다() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.db");
        drop(Db::open(path.to_str().unwrap(), &migrations()).unwrap());
        {
            let c = Connection::open(&path).unwrap();
            c.execute(r#"UPDATE "__drizzle_migrations" SET created_at = 9999999999999.5"#, []).unwrap();
        }
        // 예전엔 여기서 이력을 못 읽은 것으로 보고 0000 부터 다시 돌리다 'already exists' 로 실패했다.
        Db::open(path.to_str().unwrap(), &migrations()).unwrap();
        {
            let c = Connection::open(&path).unwrap();
            c.execute(r#"UPDATE "__drizzle_migrations" SET created_at = CAST('9999999999999.5' AS BLOB)"#, []).unwrap();
        }
        Db::open(path.to_str().unwrap(), &migrations()).unwrap();
    }

    #[test]
    fn 빈_db_에_전부_돌리고_두번째는_아무것도_안_한다() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.db");
        let db = Db::open(path.to_str().unwrap(), &migrations()).unwrap();
        let n: i64 = db.with(|c| Ok(c.query_row(r#"SELECT count(*) FROM "__drizzle_migrations""#, [], |r| r.get(0))?)).unwrap();
        let journal: Journal = serde_json::from_str(&std::fs::read_to_string(migrations().join("meta/_journal.json")).unwrap()).unwrap();
        assert_eq!(n as usize, journal.entries.len());
        // 첫 마이그레이션이 기본 프로젝트를 만든다 — 폴더·환경의 workspace_id 기본값이 'default' 다.
        let ws: String = db.with(|c| Ok(c.query_row("SELECT name FROM workspaces WHERE id = 'default'", [], |r| r.get(0))?)).unwrap();
        assert_eq!(ws, "기본");
        drop(db);
        let db = Db::open(path.to_str().unwrap(), &migrations()).unwrap();
        let again: i64 = db.with(|c| Ok(c.query_row(r#"SELECT count(*) FROM "__drizzle_migrations""#, [], |r| r.get(0))?)).unwrap();
        assert_eq!(again, n);
        assert!(!dir.path().join("backups").exists());
    }

    #[test]
    fn 기존_db에_대기중인_마이그레이션이_있을_때만_키와_함께_백업한다() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("postq.db");
        std::fs::write(dir.path().join("secret.key"), "test-key").unwrap();
        drop(Db::open(path.to_str().unwrap(), &migrations()).unwrap());
        assert!(!dir.path().join("backups").exists());

        let custom = tempfile::tempdir().unwrap();
        std::fs::create_dir(custom.path().join("meta")).unwrap();
        let mut journal: serde_json::Value = serde_json::from_slice(&std::fs::read(migrations().join("meta/_journal.json")).unwrap()).unwrap();
        journal["entries"].as_array_mut().unwrap().push(serde_json::json!({"idx":2,"version":"6","when":1793717814853_i64,"tag":"0002_test"}));
        std::fs::write(custom.path().join("meta/_journal.json"), serde_json::to_vec(&journal).unwrap()).unwrap();
        std::fs::write(custom.path().join("0002_test.sql"), "ALTER TABLE workspaces ADD COLUMN test_backup TEXT;").unwrap();
        drop(Db::open(path.to_str().unwrap(), custom.path()).unwrap());
        let backups = dir.path().join("backups");
        let files: Vec<_> = std::fs::read_dir(&backups).unwrap().map(|e| e.unwrap().path()).collect();
        assert_eq!(files.len(), 2);
        let backup = files.into_iter().find(|p| p.extension().is_some_and(|e| e == "db")).unwrap();
        assert_eq!(std::fs::read_to_string(backup.with_extension("key")).unwrap(), "test-key");
        let old = Connection::open(&backup).unwrap();
        let columns: i64 = old.query_row("SELECT count(*) FROM pragma_table_info('workspaces') WHERE name='test_backup'", [], |r| r.get(0)).unwrap();
        assert_eq!(columns, 0);
        drop(Db::open(path.to_str().unwrap(), custom.path()).unwrap());
        assert_eq!(std::fs::read_dir(backups).unwrap().count(), 2);
    }
}
