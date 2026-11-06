//! Consistent SQLite snapshots. A snapshot and its optional `secret.key` share a basename.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use rusqlite::Connection;

/// Make a WAL-consistent snapshot without touching the live database file.
pub fn snapshot(conn: &Connection, key_file: &Path, output: &Path) -> Result<()> {
    let key_output = output.with_extension("key");
    if output.exists() || key_output.exists() {
        bail!("backup already exists: {}", output.display());
    }
    let result = (|| -> Result<()> {
        conn.execute("VACUUM INTO ?1", [output.to_string_lossy().as_ref()])
            .with_context(|| format!("could not back up database to {}", output.display()))?;
        if key_file.is_file() {
            std::fs::copy(key_file, &key_output)
                .with_context(|| format!("could not back up key to {}", key_output.display()))?;
        }
        // VACUUM and copy use the process umask. Keep both snapshots private even with umask 022.
        for path in [output, key_output.as_path()] {
            if path.exists() {
                match crate::cli::restrict_to_owner(path) {
                    crate::cli::PermFix::Unchanged | crate::cli::PermFix::Tightened { .. } => {}
                    other => bail!("could not restrict backup permissions for {}: {other:?}", path.display()),
                }
            }
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(output);
        let _ = std::fs::remove_file(key_output);
    }
    result
}

pub fn timestamp(conn: &Connection) -> Result<String> {
    Ok(conn.query_row("SELECT strftime('%Y%m%d-%H%M%S', 'now')", [], |r| r.get(0))?)
}

/// Pick a unique date-stamped filename; same-second launches get a numeric suffix.
pub fn dated_path(conn: &Connection, dir: &Path, suffix: &str) -> Result<PathBuf> {
    let stamp = timestamp(conn)?;
    for n in 0..1000 {
        let extra = if n == 0 { String::new() } else { format!("-{n:03}") };
        let path = dir.join(format!("postq-{stamp}{extra}{suffix}.db"));
        if !path.exists() && !path.with_extension("key").exists() {
            return Ok(path);
        }
    }
    bail!("could not choose a free backup filename in {}", dir.display())
}

pub fn before_migrate(conn: &Connection, db_path: &Path) -> Result<PathBuf> {
    let data_dir = db_path.parent().context("database has no parent directory")?;
    let backups = data_dir.join("backups");
    crate::cli::ensure_data_dir(&backups)?;
    let output = dated_path(conn, &backups, "-before-migrate")?;
    snapshot(conn, &data_dir.join(crate::cli::KEY_FILE), &output)?;
    retain_latest(&backups, 5)?;
    Ok(output)
}

fn retain_latest(dir: &Path, keep: usize) -> Result<()> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("postq-") && n.ends_with("-before-migrate.db")))
        .collect();
    files.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
    for db in files.into_iter().skip(keep) {
        std::fs::remove_file(&db).with_context(|| format!("could not remove old backup {}", db.display()))?;
        let key = db.with_extension("key");
        if key.exists() { std::fs::remove_file(key)?; }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_includes_wal_and_key_and_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("postq.db");
        let key = dir.path().join("secret.key");
        std::fs::write(&key, "original key").unwrap();
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE records (value TEXT); INSERT INTO records VALUES ('saved');").unwrap();
        let output = dir.path().join("copy.db");
        snapshot(&conn, &key, &output).unwrap();
        assert_eq!(std::fs::read_to_string(output.with_extension("key")).unwrap(), "original key");
        let copy = Connection::open(&output).unwrap();
        let value: String = copy.query_row("SELECT value FROM records", [], |r| r.get(0)).unwrap();
        assert_eq!(value, "saved");
        assert!(snapshot(&conn, &key, &output).is_err());
    }

    #[test]
    fn rotation_keeps_five_paired_snapshots() {
        let dir = tempfile::tempdir().unwrap();
        for n in 0..7 {
            let db = dir.path().join(format!("postq-20261106-00000{n}-before-migrate.db"));
            std::fs::write(&db, "db").unwrap();
            std::fs::write(db.with_extension("key"), "key").unwrap();
        }
        retain_latest(dir.path(), 5).unwrap();
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 10);
        assert!(!dir.path().join("postq-20261106-000000-before-migrate.db").exists());
        assert!(!dir.path().join("postq-20261106-000000-before-migrate.key").exists());
    }
}
