//! 사용자용 실행 파일 `postq` — `npm install -g postq`·`brew install` 로 깔린 명령이 여기로 온다.
//!
//! 도커·E2E·개발 서버가 쓰는 `postq-server`(설정은 전부 환경 변수, [`crate::Config::from_env`])와 달리
//! 사람이 터미널에서 치는 명령이다. 그래서 기본값을 사람 쪽에 맞춘다:
//!
//! - 데이터는 OS 의 사용자 데이터 폴더([`default_data_dir`]) — 명령을 친 폴더가 어디든 같은 DB 를 쓴다.
//! - 포트는 39200 부터 빈 칸을 찾는다. `--port` 를 주면 그 포트만 쓴다(차 있으면 실패).
//! - 비밀값 암호화 키는 `SECRET_ENCRYPTION_KEY` 가 없으면 데이터 폴더의 `secret.key` 를 쓰고, 없으면 새로 만든다.
//!   키 없이 돌면 자격증명이 평문으로 DB 에 남는다.
//! - `PORT`·`DB_PATH` 는 읽지 않는다 — 흔한 이름이라 다른 도구가 셸에 남겨 둔 값을 모르는 새 집어 온다.
//!   `POSTQ_HOST`(바인딩 규칙)·`POSTQ_STATIC_DIR`·`MIGRATIONS_DIR`(묶음 위치 덮어쓰기)는 그대로 읽는다.
//!
//! 화면(ui/)과 마이그레이션(drizzle/)은 실행 파일 옆에서 찾는다([`find_resource`]) — npm 플랫폼 패키지와
//! 릴리스 묶음은 `postq`, `ui/`, `drizzle/` 를 한 폴더에 두고, Homebrew 는 `bin/` 과 `share/postq/` 로 나눈다.

use std::ffi::OsString;
use std::io::Write;
use std::net::{SocketAddr, TcpListener};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context, Result};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// 기본 포트 탐색 범위 — 흔히 쓰는 개발 포트(3000·8080…)와 겹치지 않는 곳.
pub const DEFAULT_PORT: u16 = 39200;
pub const PORT_SEARCH_SPAN: u16 = 100;
pub const KEY_FILE: &str = "secret.key";
pub const DB_FILE: &str = "postq.db";

const HELP: &str = "\
postq — a local API client (Postman-like) that runs in your browser

Usage:
  postq [options]
  postq backup [FILE] [--data-dir DIR]

Options:
  --port <N>        Port to listen on (default: first free port from 39200)
  --data-dir <DIR>  Where the database and key file live
                    (default: macOS ~/Library/Application Support/postq,
                     Windows %APPDATA%\\postq,
                     Linux $XDG_DATA_HOME/postq or ~/.local/share/postq)
  --no-open         Do not open the browser
  -V, --version     Print version
  -h, --help        Print this help

Data and recovery:
  Data: <data-dir>/postq.db and <data-dir>/secret.key
  Backup: postq backup [FILE] creates a SQLite snapshot and a paired .key file
  Restore: stop postq, remove old postq.db-wal and postq.db-shm, then copy
           the .db and .key as postq.db and secret.key (keep the pair together)
  Before a pending migration, postq keeps the latest 5 snapshots in <data-dir>/backups

Environment:
  POSTQ_HOST        Bind address (default 127.0.0.1; there is no login, keep it on loopback)
  SECRET_ENCRYPTION_KEY  Key for stored secrets (default: <data-dir>/secret.key, created on first run)

Press Ctrl+C to stop.
";

#[derive(Debug, PartialEq, Eq)]
pub struct RunArgs {
    pub port: Option<u16>,
    pub data_dir: Option<PathBuf>,
    pub open: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Run(RunArgs),
    Backup { data_dir: Option<PathBuf>, output: Option<PathBuf> },
    Help,
    Version,
}

/// 인자(프로그램 이름 뺀 것)를 읽는다. `--port 1`·`--port=1` 둘 다 받는다.
pub fn parse_args<I: IntoIterator<Item = OsString>>(args: I) -> Result<Command, String> {
    let mut run = RunArgs { port: None, data_dir: None, open: true };
    let mut backup = false;
    let mut output = None;
    let mut it = args.into_iter();
    while let Some(raw) = it.next() {
        let arg = raw.to_str().ok_or_else(|| format!("invalid argument: {}", raw.to_string_lossy()))?.to_string();
        let (name, inline) = match arg.split_once('=') {
            Some((n, v)) if n.starts_with("--") => (n.to_string(), Some(OsString::from(v))),
            _ => (arg.clone(), None),
        };
        let mut value = |flag: &str| -> Result<OsString, String> {
            match inline.clone().or_else(|| it.next()) {
                Some(v) if !v.is_empty() => Ok(v),
                _ => Err(format!("{flag} needs a value")),
            }
        };
        match name.as_str() {
            "-h" | "--help" => return Ok(Command::Help),
            "-V" | "--version" => return Ok(Command::Version),
            "backup" if !backup && output.is_none() => backup = true,
            "--no-open" if inline.is_none() => run.open = false,
            "--port" => {
                let v = value("--port")?;
                let s = v.to_string_lossy();
                run.port = Some(s.parse::<u16>().map_err(|_| format!("--port must be 0-65535, got {s}"))?);
            }
            "--data-dir" => run.data_dir = Some(PathBuf::from(value("--data-dir")?)),
            _ if backup && !arg.starts_with('-') && output.is_none() => output = Some(PathBuf::from(raw)),
            _ => return Err(format!("unknown option: {arg} (see --help)")),
        }
    }
    if backup {
        if run.port.is_some() || !run.open { return Err("--port and --no-open only apply when running postq".into()); }
        return Ok(Command::Backup { data_dir: run.data_dir, output });
    }
    Ok(Command::Run(run))
}

/// OS 사용자 데이터 폴더 아래 `postq`. 기준 변수가 없으면 None.
pub fn default_data_dir() -> Option<PathBuf> {
    data_dir_for(std::env::consts::OS, |k| std::env::var_os(k).filter(|v| !v.is_empty()))
}

/// [`default_data_dir`] 의 규칙 — 테스트가 OS 와 환경 변수를 바꿔 넣는다.
pub fn data_dir_for(os: &str, env: impl Fn(&str) -> Option<OsString>) -> Option<PathBuf> {
    let home = || env("HOME").map(PathBuf::from);
    let base = match os {
        "macos" => home()?.join("Library").join("Application Support"),
        "windows" => PathBuf::from(env("APPDATA")?),
        _ => match env("XDG_DATA_HOME").map(PathBuf::from).filter(|p| p.is_absolute()) {
            Some(p) => p,
            None => home()?.join(".local").join("share"),
        },
    };
    Some(base.join("postq"))
}

/// 데이터 폴더를 만든다. 유닉스에서는 주인만 열 수 있게(0700) — DB 와 키가 들어간다.
/// 이미 있던 폴더도 그룹·다른 사용자 권한이 열려 있으면 닫는다([`restrict_to_owner`]).
pub fn ensure_data_dir(dir: &Path) -> Result<()> {
    if dir.is_dir() {
        warn_perm(dir, restrict_to_owner(dir));
        return Ok(());
    }
    std::fs::create_dir_all(dir).with_context(|| format!("could not create data dir {}", dir.display()))?;
    // 방금 만든 폴더(umask 로 0755 등)는 알리지 않고 닫는다. 못 닫았을 때만 경고.
    match restrict_to_owner(dir) {
        PermFix::Tightened { .. } | PermFix::Unchanged => {}
        other => warn_perm(dir, other),
    }
    Ok(())
}

/// [`restrict_to_owner`] 의 결과.
#[derive(Debug, PartialEq, Eq)]
pub enum PermFix {
    /// 이미 주인만 쓸 수 있었다(또는 유닉스가 아니다).
    Unchanged,
    /// 그룹·다른 사용자 권한을 지웠다(이전, 이후 모드).
    Tightened { from: u32, to: u32 },
    /// 내 것이 아니라 손대지 않았다(파일 주인 uid).
    NotOwner { owner: u32 },
    /// 바꾸려 했으나 실패했다.
    Failed(String),
}

/// 유닉스에서 `path` 의 그룹·다른 사용자 권한 비트(0o077)를 지운다 — 0755 폴더는 0700, 0644 키는 0600 이 된다.
/// 이 프로세스(유효 uid)가 주인일 때만 바꾼다. root 로 남의 폴더를 가리켰을 때 주인을 잠가 버리지 않게.
/// 심볼릭 링크는 따라간 대상의 권한을 본다(chmod 도 대상에 걸린다).
pub fn restrict_to_owner(path: &Path) -> PermFix {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let meta = match std::fs::metadata(path) {
            Ok(m) => m,
            Err(e) => return PermFix::Failed(e.to_string()),
        };
        let mode = meta.mode() & 0o7777;
        if mode & 0o077 == 0 {
            return PermFix::Unchanged;
        }
        // SAFETY: geteuid 는 인자가 없고 실패하지 않는다.
        let me = unsafe { libc::geteuid() };
        if meta.uid() != me {
            return PermFix::NotOwner { owner: meta.uid() };
        }
        let to = mode & !0o077;
        match std::fs::set_permissions(path, std::fs::Permissions::from_mode(to)) {
            Ok(()) => PermFix::Tightened { from: mode, to },
            Err(e) => PermFix::Failed(e.to_string()),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        PermFix::Unchanged
    }
}

/// 권한 보정 결과를 사람에게 알린다. 못 고쳤으면 경고만 하고 계속 돈다 — 키를 못 읽어 멈추는 것보다 낫고, 무엇을 할지 적어 준다.
fn warn_perm(path: &Path, fix: PermFix) {
    match fix {
        PermFix::Unchanged => {}
        PermFix::Tightened { from, to } => {
            eprintln!("[postq] {} was readable by other users ({from:o}) — changed to {to:o}", path.display())
        }
        PermFix::NotOwner { owner } => eprintln!(
            "[postq] warning: {} is owned by uid {owner}, not you, and other users can read it — check its permissions (chmod go-rwx)",
            path.display()
        ),
        PermFix::Failed(e) => eprintln!(
            "[postq] warning: {} is readable by other users and could not be fixed ({e}) — run: chmod go-rwx {}",
            path.display(),
            path.display()
        ),
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum KeySource {
    /// 이미 있던 키 파일을 읽었다.
    File,
    /// 키 파일이 없어 새로 만들었다.
    Created,
}

/// `<dir>/secret.key` 를 읽고, 없으면 무작위 32바이트(hex 64자)로 만든다. 돌려주는 값은 hex 문자열.
/// 있는데 비었거나 읽을 수 없으면 덮어쓰지 않고 실패한다 — 덮어쓰면 그 키로 잠근 비밀값을 영영 못 푼다.
pub fn load_or_create_key(dir: &Path) -> Result<(String, KeySource)> {
    let path = dir.join(KEY_FILE);
    if let Some(key) = read_key(&path)? {
        // 손으로 옮겨 놓았거나 umask 022 로 만든 키(0644)는 다른 사용자가 읽는다.
        warn_perm(&path, restrict_to_owner(&path));
        return Ok((key, KeySource::File));
    }
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|e| anyhow::anyhow!("could not get random bytes: {e}"))?;
    let key = hex::encode(bytes);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    match opts.open(&path) {
        Ok(mut f) => {
            f.write_all(format!("{key}\n").as_bytes()).with_context(|| format!("could not write {}", path.display()))?;
            f.sync_all().ok();
            Ok((key, KeySource::Created))
        }
        // 동시에 띄운 다른 postq 가 먼저 만들었다 — 그 키를 쓴다.
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => match read_key(&path)? {
            Some(key) => {
                warn_perm(&path, restrict_to_owner(&path));
                Ok((key, KeySource::File))
            }
            None => bail!("key file {} is empty", path.display()),
        },
        Err(e) => Err(e).with_context(|| format!("could not create {}", path.display())),
    }
}

fn read_key(path: &Path) -> Result<Option<String>> {
    match std::fs::read_to_string(path) {
        Ok(s) => {
            let key = s.trim();
            if key.is_empty() {
                bail!("key file {} is empty — restore it from a backup, or delete it only if the database holds no secrets", path.display());
            }
            Ok(Some(key.to_string()))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("could not read {}", path.display())),
    }
}

/// 화면·마이그레이션 폴더를 찾는다: 환경 변수 → 실행 파일 옆 `<sub>/` → `<exe>/../share/postq/<sub>`(Homebrew).
pub fn find_resource(env_value: Option<PathBuf>, exe_dir: Option<&Path>, sub: &str) -> Option<PathBuf> {
    if let Some(p) = env_value {
        return Some(p);
    }
    let dir = exe_dir?;
    [dir.join(sub), dir.join("..").join("share").join("postq").join(sub)].into_iter().find(|p| p.is_dir())
}

/// 실행 파일이 든 폴더. 심볼릭 링크(Homebrew 의 bin/postq → Cellar)는 풀어서 본다.
fn exe_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe = std::fs::canonicalize(&exe).unwrap_or(exe);
    exe.parent().map(Path::to_path_buf)
}

/// 포트를 잡는다. `explicit` 이면 그 포트만, 아니면 39200 부터 100칸 안에서 처음 빈 곳.
pub fn bind(host: &str, explicit: Option<u16>) -> Result<TcpListener> {
    if let Some(port) = explicit {
        return TcpListener::bind((host, port)).with_context(|| format!("could not listen on {host}:{port} (in use? try another --port)"));
    }
    let end = DEFAULT_PORT + PORT_SEARCH_SPAN;
    for port in DEFAULT_PORT..end {
        if let Ok(l) = TcpListener::bind((host, port)) {
            return Ok(l);
        }
    }
    bail!("no free port in {host}:{DEFAULT_PORT}-{} — pass --port", end - 1)
}

/// 화면 주소. 모든 주소(0.0.0.0·::)에 열었으면 이 컴퓨터에서 여는 주소로 바꿔 보여 준다.
pub fn display_url(addr: SocketAddr) -> String {
    let ip = addr.ip();
    let shown = if ip.is_unspecified() { SocketAddr::new(std::net::Ipv4Addr::LOCALHOST.into(), addr.port()) } else { addr };
    format!("http://{shown}")
}

/// 기본 브라우저로 연다. 실패해도 서버는 계속 돈다(주소는 이미 찍었다).
pub fn open_browser(url: &str) {
    let mut cmd = if cfg!(target_os = "macos") {
        let mut c = std::process::Command::new("open");
        c.arg(url);
        c
    } else if cfg!(windows) {
        // start 의 첫 따옴표 인자는 창 제목이다 — 비워 두지 않으면 주소를 제목으로 먹는다.
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", "", url]);
        c
    } else {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(url);
        c
    };
    cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    match cmd.spawn() {
        // 끝나기를 기다려 거둔다(좀비를 남기지 않게) — 서버를 붙잡지 않도록 따로 돈다.
        Ok(mut child) => {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
        Err(e) => eprintln!("[postq] could not open a browser ({e}); open {url} yourself"),
    }
}

/// Ctrl+C(유닉스는 SIGTERM·SIGHUP 도, 윈도우는 콘솔 닫기·Ctrl+Break 도)를 한 번 기다린다.
async fn wait_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = signal(SignalKind::terminate()).ok();
        let mut hup = signal(SignalKind::hangup()).ok();
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = async { match term.as_mut() { Some(s) => { s.recv().await; } None => std::future::pending().await } } => {}
            _ = async { match hup.as_mut() { Some(s) => { s.recv().await; } None => std::future::pending().await } } => {}
        }
    }
    #[cfg(windows)]
    {
        use tokio::signal::windows;
        let mut brk = windows::ctrl_break().ok();
        let mut close = windows::ctrl_close().ok();
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = async { match brk.as_mut() { Some(s) => { s.recv().await; } None => std::future::pending().await } } => {}
            _ = async { match close.as_mut() { Some(s) => { s.recv().await; } None => std::future::pending().await } } => {}
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

/// 신호가 오면 새 연결을 그만 받는다. 열린 연결(SSE 등)이 끝나지 않으면 3초 뒤, 또는 신호를 한 번 더 받으면 바로 나간다.
async fn shutdown_signal() {
    wait_signal().await;
    eprintln!("[postq] stopping…");
    tokio::spawn(async {
        tokio::select! {
            _ = wait_signal() => {}
            _ = tokio::time::sleep(Duration::from_secs(3)) => {}
        }
        std::process::exit(0);
    });
}

/// `postq` 의 main. 돌려주는 값이 종료 코드다.
pub fn main() -> i32 {
    match parse_args(std::env::args_os().skip(1)) {
        Ok(Command::Help) => {
            print!("{HELP}");
            0
        }
        Ok(Command::Version) => {
            println!("postq {VERSION}");
            0
        }
        Ok(Command::Backup { data_dir, output }) => match backup(data_dir, output) {
            Ok(()) => 0,
            Err(e) => { eprintln!("[postq] error: {e:#}"); 1 }
        },
        Ok(Command::Run(args)) => match run(args) {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("[postq] error: {e:#}");
                1
            }
        },
        Err(msg) => {
            eprintln!("postq: {msg}");
            2
        }
    }
}

fn backup(data_dir: Option<PathBuf>, output: Option<PathBuf>) -> Result<()> {
    let dir = match data_dir {
        Some(d) => d,
        None => default_data_dir().context("could not find a user data folder (HOME/APPDATA unset) — pass --data-dir")?,
    };
    let db = dir.join(DB_FILE);
    if !db.is_file() { bail!("database not found: {}", db.display()); }
    let conn = rusqlite::Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let output = match output {
        Some(path) => path,
        None => {
            let backups = dir.join("backups");
            ensure_data_dir(&backups)?;
            crate::backup::dated_path(&conn, &backups, "")?
        }
    };
    crate::backup::snapshot(&conn, &dir.join(KEY_FILE), &output)?;
    println!("[postq] backup: {}{}", output.display(), if output.with_extension("key").exists() { " (and paired .key)" } else { " (no key file present)" });
    Ok(())
}

fn run(args: RunArgs) -> Result<()> {
    let get = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
    let data_dir = match args.data_dir {
        Some(d) => d,
        None => default_data_dir().context("could not find a user data folder (HOME/APPDATA unset) — pass --data-dir")?,
    };
    ensure_data_dir(&data_dir)?;

    // 키는 런타임(스레드)을 띄우기 전에 환경 변수에 넣는다 — secretbox 가 부를 때마다 환경 변수에서 읽는다.
    if std::env::var("SECRET_ENCRYPTION_KEY").map_or(true, |v| v.is_empty()) {
        let (key, source) = load_or_create_key(&data_dir)?;
        if source == KeySource::Created {
            eprintln!(
                "[postq] created {} — it encrypts stored secrets; back it up with the database",
                data_dir.join(KEY_FILE).display()
            );
        }
        std::env::set_var("SECRET_ENCRYPTION_KEY", key);
    }

    let exe_dir = exe_dir();
    let migrations_dir = find_resource(get("MIGRATIONS_DIR"), exe_dir.as_deref(), "drizzle")
        .context("migrations folder (drizzle/) not found next to the executable — reinstall postq, or set MIGRATIONS_DIR")?;
    let static_dir = find_resource(get("POSTQ_STATIC_DIR"), exe_dir.as_deref(), "ui");
    if static_dir.is_none() {
        eprintln!("[postq] UI folder (ui/) not found next to the executable — serving the API only");
    }

    let host = std::env::var("POSTQ_HOST").ok().filter(|v| !v.is_empty()).unwrap_or_else(|| "127.0.0.1".into());
    let listener = bind(&host, args.port)?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    let config = crate::Config {
        host,
        port,
        db_path: data_dir.join(DB_FILE).to_string_lossy().into_owned(),
        migrations_dir,
        static_dir,
    };

    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    let open = args.open;
    let result = rt.block_on(async move {
        let listener = tokio::net::TcpListener::from_std(listener)?;
        crate::serve_listener(
            config,
            listener,
            |addr| {
                let url = display_url(addr);
                println!("postq {VERSION} running at {url}  (Ctrl+C to stop)");
                if open {
                    open_browser(&url);
                }
            },
            shutdown_signal(),
        )
        .await
    });
    // 스케줄러가 돌리던 블로킹 작업을 무한정 기다리지 않는다.
    rt.shutdown_timeout(Duration::from_secs(1));
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Result<Command, String> {
        parse_args(list.iter().map(OsString::from))
    }

    #[test]
    fn 인자를_읽는다() {
        assert_eq!(args(&[]).unwrap(), Command::Run(RunArgs { port: None, data_dir: None, open: true }));
        assert_eq!(
            args(&["--port", "4000", "--data-dir", "/tmp/x", "--no-open"]).unwrap(),
            Command::Run(RunArgs { port: Some(4000), data_dir: Some(PathBuf::from("/tmp/x")), open: false })
        );
        assert_eq!(
            args(&["--port=0", "--data-dir=d"]).unwrap(),
            Command::Run(RunArgs { port: Some(0), data_dir: Some(PathBuf::from("d")), open: true })
        );
        assert_eq!(args(&["--version"]).unwrap(), Command::Version);
        assert_eq!(args(&["-V"]).unwrap(), Command::Version);
        assert_eq!(args(&["--no-open", "-h"]).unwrap(), Command::Help);
        assert_eq!(args(&["backup"]).unwrap(), Command::Backup { data_dir: None, output: None });
        assert_eq!(args(&["backup", "copy.db", "--data-dir", "/tmp/x"]).unwrap(), Command::Backup { data_dir: Some(PathBuf::from("/tmp/x")), output: Some(PathBuf::from("copy.db")) });
        assert!(args(&["backup", "--port", "39201"]).is_err());
        assert!(args(&["--port"]).is_err());
        assert!(args(&["--port", "70000"]).is_err());
        assert!(args(&["--port="]).is_err());
        assert!(args(&["--bogus"]).is_err());
        assert!(args(&["--no-open=1"]).is_err());
        assert!(args(&["serve"]).is_err());
    }

    #[test]
    fn 사용자_백업_명령은_db와_키를_복사한다() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join(DB_FILE);
        std::fs::write(dir.path().join(KEY_FILE), "key").unwrap();
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch("CREATE TABLE data (value TEXT); INSERT INTO data VALUES ('ok');").unwrap();
        drop(conn);
        let out = dir.path().join("manual.db");
        backup(Some(dir.path().to_path_buf()), Some(out.clone())).unwrap();
        assert_eq!(std::fs::read_to_string(out.with_extension("key")).unwrap(), "key");
        assert!(backup(Some(dir.path().to_path_buf()), Some(out)).is_err());
    }

    #[test]
    fn os_별_기본_데이터_폴더() {
        let env = |pairs: &'static [(&'static str, &'static str)]| move |k: &str| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| OsString::from(v));
        assert_eq!(
            data_dir_for("macos", env(&[("HOME", "/h")])),
            Some(PathBuf::from("/h/Library/Application Support/postq"))
        );
        assert_eq!(data_dir_for("windows", env(&[("APPDATA", "C:\\Users\\u\\AppData\\Roaming")])), Some(PathBuf::from("C:\\Users\\u\\AppData\\Roaming").join("postq")));
        assert_eq!(data_dir_for("windows", env(&[("HOME", "/h")])), None);
        assert_eq!(data_dir_for("linux", env(&[("HOME", "/home/u")])), Some(PathBuf::from("/home/u/.local/share/postq")));
        assert_eq!(data_dir_for("linux", env(&[("HOME", "/home/u"), ("XDG_DATA_HOME", "/xdg")])), Some(PathBuf::from("/xdg/postq")));
        // XDG 규약: 상대 경로는 무시한다.
        assert_eq!(data_dir_for("linux", env(&[("HOME", "/home/u"), ("XDG_DATA_HOME", "rel")])), Some(PathBuf::from("/home/u/.local/share/postq")));
        assert_eq!(data_dir_for("linux", env(&[])), None);
    }

    #[test]
    fn 키_파일을_만들고_다시_읽는다() {
        let dir = tempfile::tempdir().unwrap();
        let (k1, s1) = load_or_create_key(dir.path()).unwrap();
        assert_eq!(s1, KeySource::Created);
        assert_eq!(k1.len(), 64);
        assert!(k1.bytes().all(|b| b.is_ascii_hexdigit()));
        let (k2, s2) = load_or_create_key(dir.path()).unwrap();
        assert_eq!((k2.as_str(), s2), (k1.as_str(), KeySource::File));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join(KEY_FILE)).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn 빈_키_파일은_덮어쓰지_않는다() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(KEY_FILE), "\n").unwrap();
        assert!(load_or_create_key(dir.path()).is_err());
        assert_eq!(std::fs::read_to_string(dir.path().join(KEY_FILE)).unwrap(), "\n");
    }

    #[cfg(unix)]
    fn mode_of(p: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(p).unwrap().permissions().mode() & 0o7777
    }

    #[cfg(unix)]
    #[test]
    fn 이미_있던_데이터_폴더와_키의_권한을_닫는다() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("data");
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        let key = dir.join(KEY_FILE);
        std::fs::write(&key, "ab".repeat(32) + "\n").unwrap();
        std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o644)).unwrap();

        ensure_data_dir(&dir).unwrap();
        assert_eq!(mode_of(&dir), 0o700);
        let (k, src) = load_or_create_key(&dir).unwrap();
        assert_eq!((k, src), ("ab".repeat(32), KeySource::File));
        assert_eq!(mode_of(&key), 0o600);

        // 이미 닫혀 있으면 그대로, 더 좁은 권한(0400)은 넓히지 않는다.
        std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o400)).unwrap();
        assert_eq!(restrict_to_owner(&key), PermFix::Unchanged);
        assert_eq!(mode_of(&key), 0o400);
        // 0640 → 0600, 주인 비트는 그대로 둔다.
        std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o640)).unwrap();
        assert_eq!(restrict_to_owner(&key), PermFix::Tightened { from: 0o640, to: 0o600 });
    }

    #[cfg(unix)]
    #[test]
    fn 새로_만든_데이터_폴더는_0700() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("a/b");
        ensure_data_dir(&dir).unwrap();
        assert_eq!(mode_of(&dir), 0o700);
    }

    #[cfg(unix)]
    #[test]
    fn 없는_경로는_실패로_알린다() {
        let root = tempfile::tempdir().unwrap();
        assert!(matches!(restrict_to_owner(&root.path().join("nope")), PermFix::Failed(_)));
    }

    #[test]
    fn 실행_파일_옆_그다음_share_에서_찾는다() {
        let root = tempfile::tempdir().unwrap();
        let bin = root.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        assert_eq!(find_resource(None, Some(bin.as_path()), "ui"), None);
        let share = root.path().join("share/postq/ui");
        std::fs::create_dir_all(&share).unwrap();
        assert_eq!(find_resource(None, Some(bin.as_path()), "ui"), Some(bin.join("../share/postq/ui")));
        std::fs::create_dir_all(bin.join("ui")).unwrap();
        assert_eq!(find_resource(None, Some(bin.as_path()), "ui"), Some(bin.join("ui")));
        assert_eq!(find_resource(Some(PathBuf::from("/env")), Some(bin.as_path()), "ui"), Some(PathBuf::from("/env")));
    }

    #[test]
    fn 찬_포트는_건너뛰고_명시한_포트는_실패한다() {
        // 기본 범위 첫 칸을 막아 두면 다음 칸을 잡는다. 다른 프로세스가 이미 쓰고 있을 수 있으니 '막은 포트가 아님' 만 본다.
        let blocker = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let taken = blocker.local_addr().unwrap().port();
        assert!(bind("127.0.0.1", Some(taken)).is_err());
        let l = bind("127.0.0.1", None).unwrap();
        let p = l.local_addr().unwrap().port();
        assert!((DEFAULT_PORT..DEFAULT_PORT + PORT_SEARCH_SPAN).contains(&p));
    }

    #[test]
    fn 화면_주소() {
        assert_eq!(display_url("127.0.0.1:39200".parse().unwrap()), "http://127.0.0.1:39200");
        assert_eq!(display_url("0.0.0.0:39200".parse().unwrap()), "http://127.0.0.1:39200");
        assert_eq!(display_url("[::1]:39200".parse().unwrap()), "http://[::1]:39200");
    }
}
