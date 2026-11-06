//! 도커·E2E 용 단독 실행 파일. 데스크톱 앱은 이 크레이트를 직접 불러 같은 프로세스에서 띄운다.
//!
//!   postq-server                    서버를 띄운다(설정은 환경 변수 — Config::from_env)
//!   postq-server backup <파일>       DB_PATH 의 일관 스냅샷을 <파일> 로 뜬다(VACUUM INTO). scripts/backup.sh 가 쓴다.
//!                                    WAL 모드의 라이브 DB 를 파일째 복사하면 본체와 -wal 의 시점이 어긋난다.

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [] => {
            let config = postq_server::Config::from_env();
            postq_server::serve(config, |addr| println!("[postq] 서버 http://{addr}")).await
        }
        [cmd, out] if cmd == "backup" => {
            let db = postq_server::Config::from_env().db_path;
            if std::path::Path::new(out).exists() {
                anyhow::bail!("이미 있는 파일입니다: {out}");
            }
            let conn = rusqlite::Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            conn.execute("VACUUM INTO ?1", [out])?;
            println!("[postq] 백업 {db} → {out}");
            Ok(())
        }
        _ => anyhow::bail!("사용법: postq-server [backup <파일>]"),
    }
}
