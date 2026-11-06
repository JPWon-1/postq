mod process_lifecycle;
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::Manager;

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 첫 번째로 시도할 포트. 도커 배포본이 쓰는 자리다.
const BASE_PORT: u16 = 3000;
/// 여기까지 훑어 빈 자리를 찾는다.
const MAX_PORT: u16 = 3020;

/// 번들 앱 전용 포트.
///
/// 3000 은 도커 배포본·개발 서버·남의 프로젝트가 늘 다투는 자리다. 거기서 밀려 3001 로
/// 옮겨 뜨면 웹뷰 주소가 바뀌고, 주소가 바뀌면 브라우저 origin 이 바뀌어 localStorage 가
/// 통째로 안 보인다 — 개인 환경 변수(기기에만 있는 토큰)와 선택한 프로젝트·테마가
/// 사라진 것처럼 보인다. 실제로 그 일이 있었다.
///
/// 그래서 번들 앱은 남들이 안 쓰는 자리에 고정으로 뜬다. 포트가 안 변하면 origin 도 안 변한다.
const APP_PORT: u16 = 39100;
/// 그 자리마저 막혔을 때만 바로 옆으로 비킨다(그런 일은 거의 없다).
const APP_MAX_PORT: u16 = 39110;

/// 우리가 띄운 서버. 앱이 살아 있는 동안 잡고 있다가 끝날 때 같이 내린다.
///
/// 놔주면 다음에 켤 때 그 자리를 남이 가져간다 — 그게 이 사달의 시작이었다.
static BUNDLED_RUNTIME: Mutex<Option<PathBuf>> = Mutex::new(None);
static APP_DATA: Mutex<Option<PathBuf>> = Mutex::new(None);

static SERVER: Mutex<Option<InProcess>> = Mutex::new(None);

/// 실제 서버(http)에 붙었는가. failure/loading 같은 data: 화면에서는 false.
/// ⌘R 이 '새로고침' 이어야 하는지 '다시 붙기(복구)' 여야 하는지를 이걸로 가른다.
static ATTACHED: AtomicBool = AtomicBool::new(false);

/// 지금 붙어 있는 포트. 감시 스레드가 '이 포트가 아직 postq 인가' 를 이걸로 본다.
/// 0 = 아직 안 붙음.
static CURRENT_PORT: AtomicU16 = AtomicU16::new(0);

/// 우리가 띄웠지만 기다리다 포기한 서버의 포트. 0 = 없음.
///
/// macOS 가 '데스크탑 폴더 접근' 권한을 묻는 동안 서버 스레드는 .env 를 여는 자리에서 멈춘다.
/// 90초 안에 [허용]을 못 누르면 앱은 안내 화면을 띄우는데, 그 뒤에 허용하면 서버는
/// 멀쩡히 뜬다 — 실제로 7시간 뒤에 떠서 아무도 모른 채 돌고 있었다. 감시 스레드가 이 포트를
/// 계속 확인하다 준비되면 창을 그리로 보낸다.
static PENDING_PORT: AtomicU16 = AtomicU16::new(0);

/// :port 에 떠 있는 것이 postq 인가.
///
/// 이 앱은 껍데기다 — 화면을 통째로 http://localhost:<port> 에서 가져온다. 그래서 다른
/// 프로젝트의 dev 서버가 그 포트를 잡고 있으면 그 프로젝트가 그대로 떴다. 실제로 옆
/// 프로젝트가 떠서, postq 를 열었는데 다른 앱이 나왔다.
///
/// 의존성을 늘리지 않으려고 표준 라이브러리로 GET 한 줄을 보낸다.
fn probe_postq(port: u16) -> Result<(), String> {
    let addr = match ("127.0.0.1", port).to_socket_addrs().ok().and_then(|mut i| i.next()) {
        Some(a) => a,
        None => return Err("주소 해석 실패".into()),
    };
    let mut st = match TcpStream::connect_timeout(&addr, Duration::from_millis(500)) {
        Ok(s) => s,
        Err(e) => return Err(format!("연결 실패: {e}")),
    };
    // dev 는 /api/health 를 첫 요청에 그제서야 컴파일한다 — 1.5s 로는 짧아 멀쩡한
    // 서버를 '준비 안 됨' 으로 오판했다. 넉넉히 준다(로딩 화면이 그동안 떠 있다).
    let _ = st.set_read_timeout(Some(Duration::from_millis(3500)));
    let _ = st.set_write_timeout(Some(Duration::from_millis(600)));
    let req = format!(
        "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nAccept: application/json\r\n\r\n"
    );
    if st.write_all(req.as_bytes()).is_err() {
        return Err("상태 확인 요청 전송 실패".into());
    }
    let mut body = Vec::new();
    let mut buf = [0u8; 4096];
    // 전체 시간 상한. 읽기 한 번마다 3.5초 제한만 있어서, 상대가 3초마다 1바이트씩 흘리면 64KiB 까지
    // 수십 시간 붙잡힐 수 있었다(코덱스가 짚었다). 식별 응답은 작다 — 전체 5초면 넉넉하다.
    let started = Instant::now();
    loop {
        if started.elapsed() > Duration::from_secs(5) {
            break;
        }
        match st.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                body.extend_from_slice(&buf[..n]);
                if body.len() > 64 * 1024 {
                    break;
                }
            }
            Err(e) => { if body.is_empty() { return Err(format!("상태 응답 읽기 실패: {e}")); } else { break; } },
        }
    }
    let response = String::from_utf8_lossy(&body);
    if response.replace(char::is_whitespace, "").contains("\"app\":\"postq\"") {
        Ok(())
    } else {
        let status = response.lines().next().unwrap_or("응답 없음");
        Err(format!("postq 식별 응답 없음 ({status}, {} bytes)", body.len()))
    }
}
fn is_postq(port: u16) -> bool { probe_postq(port).is_ok() }

/// 웹뷰가 띄울 주소.
///
/// 반드시 `localhost` 여야 한다 — `127.0.0.1` 과는 **브라우저 origin 이 다르고**, origin 이
/// 달라지면 localStorage 가 통째로 안 보인다. 거기엔 개인 환경 변수(`ah:personalVars` —
/// 서버에 없고 이 기기에만 있는 토큰들)와 선택한 프로젝트·테마·패널 크기가 들어 있다.
/// 값이 지워지는 건 아니지만 사용자에겐 '설정이 다 날아간' 것으로 보인다.
///
/// 서버를 127.0.0.1 에만 바인딩하는 것(`-H 127.0.0.1`)은 그대로 둔다 — LAN 에 노출하지
/// 않으려는 의도이고, localhost 는 그 주소로 해석되므로 둘은 충돌하지 않는다.
fn origin(port: u16) -> String { format!("http://localhost:{port}") }

/// 아무도 안 쓰는 포트인가.
///
/// 두 주소를 모두 확인한다. 우리 서버는 127.0.0.1 에만 뜨지만(`-H 127.0.0.1`), 거기가
/// 비었다고 포트가 빈 것은 아니다 — 도커는 0.0.0.0 에 바인딩하고, macOS 에선 그 위에
/// 127.0.0.1 바인딩이 또 성공한다. 그래서 127.0.0.1 만 보면 도커가 쓰는 3000 을 '비었다' 고
/// 판단해 그 위에 우리 서버를 또 띄웠다. 루프백 요청은 우리 쪽이 먼저 받으므로 도커 컨테이너가
/// 통째로 가려졌고, 둘은 서로 다른 DB 를 보고 있어 같은 주소인데 내용이 달랐다.
fn is_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok() && TcpListener::bind(("0.0.0.0", port)).is_ok()
}

/// 빌드한 곳 — 디버그 빌드(`npm run app:dev`)에서만 실행 파일에 굽는다.
/// 릴리스 빌드에는 넣지 않는다: 배포한 바이너리에 빌드한 사람의 절대 경로가 남는다.
#[cfg(debug_assertions)]
fn baked_project_dir() -> Option<PathBuf> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().map(PathBuf::from)
}
#[cfg(not(debug_assertions))]
fn baked_project_dir() -> Option<PathBuf> {
    None
}

/// 이 폴더가 postq 프로젝트인가 — src-tauri 와 package.json 의 이름으로 본다.
fn is_project(dir: &std::path::Path) -> bool {
    dir.join("src-tauri/tauri.conf.json").is_file()
        && std::fs::read_to_string(dir.join("package.json")).is_ok_and(|s| s.contains("\"name\": \"postq\""))
}

/// 마지막으로 찾은 프로젝트 폴더를 적어 두는 파일(앱 데이터 안).
fn remembered_file() -> Option<PathBuf> {
    APP_DATA.lock().unwrap().clone().map(|d| d.join("project-dir"))
}

/// 프로젝트 폴더(실데이터·.env 가 있는 곳).
///
/// 순서대로 찾는다: POSTQ_DIR → 구워진 경로(디버그 빌드만) → 지난번에 찾은 경로. 찾으면 적어 둔다.
/// 패키지 앱은 이걸 부르지 않는다(spawn_server) — POSTQ_DIR 이 없으면 앱 데이터 폴더만 쓴다.
///
/// 다 실패하면 None — 검사에서 떨어진 경로를 그대로 돌려주면 그 자리에 있는(postq 가 아닐 수 있는) 폴더의
/// data/dev-snapshot.db·.env 를 읽게 된다. 그때 호출부는 앱 데이터 폴더만 쓴다. POSTQ_DIR 은 사용자가 직접 지정한 값이라 그대로 믿는다.
fn project_dir() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("POSTQ_DIR") {
        return Some(PathBuf::from(p));
    }
    let remember = |d: &PathBuf| {
        if let Some(f) = remembered_file() {
            let _ = std::fs::write(f, d.to_string_lossy().as_bytes());
        }
    };
    if let Some(baked) = baked_project_dir().filter(|d| is_project(d)) {
        remember(&baked);
        return Some(baked);
    }
    if let Some(d) = remembered_file().and_then(|f| std::fs::read_to_string(f).ok()).map(|s| PathBuf::from(s.trim())) {
        if is_project(&d) {
            log::info!("project dir (remembered): {}", d.display());
            return Some(d);
        }
    }
    log::warn!("프로젝트 폴더를 찾지 못했습니다 — 앱 데이터의 DB·설정만 씁니다");
    None
}

/// 기본 DB 와 읽을 환경 파일(뒤가 이김). 확인된 프로젝트 폴더(`project`)가 있을 때만 그 아래의
/// data/dev-snapshot.db·.env·.env.local 을 쓴다 — 없으면 앱 데이터 폴더의 postq.db·app.env 만.
fn data_paths(project: Option<&std::path::Path>, app_data: &std::path::Path) -> (PathBuf, Vec<PathBuf>) {
    let db = project
        .map(|d| d.join("data/dev-snapshot.db"))
        .filter(|db| db.exists())
        .unwrap_or_else(|| app_data.join("postq.db"));
    let mut env_files: Vec<PathBuf> = project.into_iter().flat_map(|d| [d.join(".env"), d.join(".env.local")]).collect();
    env_files.push(app_data.join("app.env"));
    (db, env_files)
}

/// 같은 프로세스 안에서 도는 서버(postq_server). 자식 프로세스가 아니라서 앱이 끝날 때 서버도 같이 끝나고,
/// 고아 서버가 포트를 물고 남지 않는다.
struct InProcess {
    port: u16,
    thread: std::thread::JoinHandle<()>,
    /// 서버가 준비 전에 멈췄을 때의 이유 — 안내 화면에 그대로 보여 준다.
    error: Arc<Mutex<Option<String>>>,
}

/// 패키지 앱이면 서버의 stdout·stderr 를 앱 데이터의 logs/ 로 돌린다.
///
/// 안내 화면은 logs/server-stdout.log·server-stderr.log 를 보내 달라고 한다. 아이콘으로 켠 앱의 stderr 는 버려지므로
/// 그대로 두면 서버 출력이 아무 데도 안 남는다 — 그래서 프로세스의 1·2번 파일을 파이프로 바꿔 끼우고, 크기 상한이 있는 같은 기록기(capture)로 받는다.
#[cfg(unix)]
fn redirect_output(logs: &std::path::Path) {
    use std::os::fd::FromRawFd;
    if std::fs::create_dir_all(logs).is_err() {
        return;
    }
    for (fd, name) in [(1, "server-stdout.log"), (2, "server-stderr.log")] {
        let mut pipe = [0; 2];
        // SAFETY: pipe 는 두 칸짜리 배열에 새 fd 를 쓴다. dup2 는 열린 fd 를 1·2번에 덮어쓸 뿐이다.
        unsafe {
            if libc::pipe(pipe.as_mut_ptr()) != 0 {
                continue;
            }
            if libc::dup2(pipe[1], fd) < 0 {
                libc::close(pipe[0]);
                libc::close(pipe[1]);
                continue;
            }
            libc::close(pipe[1]);
            process_lifecycle::capture(std::fs::File::from_raw_fd(pipe[0]), logs.join(name));
        }
    }
}

/// 그 포트에 우리 서버를 띄운다 — 같은 프로세스의 별도 스레드에서, 자기 tokio 런타임으로.
///
/// 환경 파일 읽기도 그 스레드에서 한다. macOS 가 '데스크탑 폴더 접근' 권한을 묻는 동안 파일 열기가 멈추는데,
/// 그게 창을 옮기는 스레드를 붙잡으면 안내 화면조차 못 띄운다.
fn spawn_server(port: u16) -> Result<InProcess, String> {
    let bundled = BUNDLED_RUNTIME.lock().unwrap().clone();
    // 번들 앱의 화면·마이그레이션은 앱 묶음 안에 있다. 프로젝트 폴더(데스크탑 아래일 수 있다)는 서버 스레드에서 찾는다 —
    // 거기 파일을 여는 순간 macOS 가 접근 허락을 물을 수 있고, 그 동안 멈추는 건 서버 스레드여야 한다.
    let dir = match (&bundled, std::env::var_os("POSTQ_DIR")) {
        (Some(b), None) => b.clone(),
        // 번들이 아닌(소스에서 띄운) 앱인데 프로젝트 폴더를 못 찾았다 — 확인 안 된 폴더의 화면·마이그레이션을 쓰지 않는다.
        _ => project_dir().ok_or_else(|| "postq 프로젝트 폴더를 찾지 못했습니다 — POSTQ_DIR 로 지정하세요".to_string())?,
    };
    let migrations = dir.join("drizzle");
    if !migrations.is_dir() {
        return Err(format!("DB 마이그레이션 폴더를 찾지 못했습니다: {}", migrations.display()));
    }
    // 화면: 번들은 runtime/ui(prepare-runtime.mjs 가 넣는다), 소스 폴더면 npm run build:static 결과(out/).
    let static_dir = [dir.join("ui"), dir.join("out")].into_iter().find(|d| d.join("index.html").is_file());
    if static_dir.is_none() {
        log::warn!("화면 폴더가 없습니다 — API 만 뜹니다 ({}/ui 또는 out)", dir.display());
    }
    let error = Arc::new(Mutex::new(None));
    let slot = error.clone();
    let thread = std::thread::Builder::new()
        .name("postq-server".into())
        .spawn(move || {
            let run = || -> Result<(), String> {
                // 확인된 프로젝트 폴더가 없으면(None) 그 아래의 DB·.env 는 아예 보지 않는다 — 앱 데이터 폴더만.
                // 패키지 앱은 POSTQ_DIR 을 줬을 때만 프로젝트 폴더를 본다 — 내려받은 앱이 홈 아래의 다른 체크아웃
                // DB·.env 를 몰래 쓰면 안 된다.
                let legacy = if bundled.is_some() && std::env::var_os("POSTQ_DIR").is_none() { None } else { project_dir() };
                let app_data = APP_DATA
                    .lock()
                    .unwrap()
                    .clone()
                    .or_else(|| legacy.as_ref().map(|d| d.join("data")))
                    .ok_or_else(|| "앱 데이터 폴더를 정하지 못했습니다".to_string())?;
                let (default_db, env_files) = data_paths(legacy.as_deref(), &app_data);
                // DB_PATH 는 앱을 띄운 환경의 값만 본다 — env 파일의 DB_PATH 는 쓰지 않는다.
                let db_path = std::env::var("DB_PATH").unwrap_or_else(|_| default_db.to_string_lossy().into_owned());
                log::info!("db: {db_path}");
                // 사용자 설정은 앱 묶음 밖에 둔다. 뒤 파일이 이기고, 이미 있는 환경 변수가 최우선이다.
                let refs: Vec<&std::path::Path> = env_files.iter().map(|p| p.as_path()).collect();
                let merged = postq_server::env_file::load(&refs).map_err(|e| format!("환경 파일을 읽지 못했습니다: {e}"))?;
                let applied = postq_server::env_file::apply(&merged);
                log::info!("env files loaded: {} keys", applied.len());
                // 앱이 정하는 값 — 파일·바깥 환경보다 앞선다. 서버 코드가 환경 변수로 읽는다.
                std::env::set_var("POSTQ_HOST", "127.0.0.1");
                std::env::set_var("PORT", port.to_string());
                std::env::set_var("DB_PATH", &db_path);
                let mut config = postq_server::Config::from_env();
                config.host = "127.0.0.1".into();
                config.port = port;
                config.db_path = db_path.clone();
                config.migrations_dir = migrations.clone();
                config.static_dir = static_dir.clone();
                let rt = tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .thread_name("postq-rt")
                    .build()
                    .map_err(|e| format!("서버 런타임을 만들지 못했습니다: {e}"))?;
                rt.block_on(postq_server::serve(config, |addr| log::info!("server bound {addr}")))
                    .map_err(|e| format!("{e:#}"))
            };
            if let Err(e) = run() {
                log::error!("server stopped: {e}");
                eprintln!("[postq] 서버 중단: {e}");
                *slot.lock().unwrap() = Some(e);
            }
        })
        .map_err(|e| format!("서버 스레드를 띄우지 못했습니다: {e}"))?;
    log::info!("server started in-process port={port}");
    Ok(InProcess { port, thread, error })
}

/// 어느 주소를 열지 정한다.
///
/// 1) 3000 에 이미 postq 가 있으면 그걸 쓴다(도커로 띄워 둔 경우).
/// 2) 아니면 빈 포트를 찾아 우리 서버를 띄우고 그 자리를 쓴다.
///    남이 3000 을 잡고 있어도 앱은 열려야 한다 — 못 연다고 말하는 것보다 여는 게 낫다.
fn resolve_origin() -> Result<String, String> {
    // Packaged apps must run their bundled version, not silently attach to an older
    // developer server. Explicit POSTQ_DIR keeps the existing development workflow.
    let packaged = BUNDLED_RUNTIME.lock().unwrap().is_some()
        && std::env::var_os("POSTQ_DIR").is_none();
    if !packaged {
        for port in BASE_PORT..=MAX_PORT {
            if is_postq(port) {
                return Ok(origin(port));
            }
        }
    }
    // 이미 띄운 서버가 살아 있으면 그 자리를 그대로 쓴다 — 같은 프로세스라 내릴 수도 없고, 새로 띄우면 포트가
    // 밀려 origin 이 바뀐다(개인 설정이 빈 것처럼 보인다). 멈춘 서버(스레드가 끝남)만 새로 띄운다.
    let running = {
        let mut slot = SERVER.lock().unwrap();
        if slot.as_ref().is_some_and(|s| s.thread.is_finished()) {
            *slot = None;
        }
        slot.as_ref().map(|s| s.port)
    };
    let port = match running {
        Some(port) => port,
        None => {
            // 없으면 빈 포트에 우리가 띄운다. 남이 3000 을 잡고 있어도 앱은 열려야 한다.
            // 번들 앱은 전용 대역을 쓴다 — 포트가 고정이어야 origin 이 고정되고, origin 이 고정이어야
            // 개인 설정이 유지된다. 개발 실행은 기존 3000 대역 그대로.
            let (from, to) = if packaged { (APP_PORT, APP_MAX_PORT) } else { (BASE_PORT, MAX_PORT) };
            // 앱을 껐다 바로 다시 켜면, 앞 프로세스가 아직 고정 포트를 쥐고 있을 수 있다. 그 틈에 뜨면 다음 포트로
            // 밀려나 origin 이 바뀌고 — 개인 설정(토큰·프로젝트)이 전부 빈 것처럼 보인다. 잠깐 비워질 때까지 기다린다.
            if packaged && !is_free(APP_PORT) && is_postq(APP_PORT) {
                let wait_until = Instant::now() + Duration::from_secs(5);
                while Instant::now() < wait_until && !is_free(APP_PORT) {
                    std::thread::sleep(Duration::from_millis(200));
                }
            }
            let port = (from..=to)
                .find(|p| is_free(*p))
                .ok_or_else(|| format!("{from}~{to} 에 빈 포트가 없습니다"))?;
            let server = spawn_server(port)?;
            *SERVER.lock().unwrap() = Some(server);
            port
        }
    };
    PENDING_PORT.store(0, Ordering::Relaxed);

    // 뜰 때까지 기다린다. 보통 즉시지만, macOS 가 폴더 권한을 묻는 동안엔 환경 파일 읽기에서 멈춘다 — 넉넉히 잡는다.
    let deadline = Instant::now() + Duration::from_secs(90);
    let mut last_error = String::from("상태 확인 전");
    let mut last_logged = Instant::now();
    while Instant::now() < deadline {
        let stopped = {
            let mut slot = SERVER.lock().unwrap();
            let finished = slot.as_ref().is_some_and(|s| s.thread.is_finished());
            let reason = slot.as_ref().and_then(|s| s.error.lock().unwrap().clone());
            if finished {
                *slot = None;
            }
            finished.then(|| reason.unwrap_or_else(|| "이유 없음".into()))
        };
        if let Some(reason) = stopped {
            log::error!("server exited before ready port={port}: {reason}");
            return Err(format!("서버가 준비 전에 멈췄습니다 — {reason}. 앱 데이터 폴더의 logs/server-stderr.log를 확인하세요."));
        }
        match probe_postq(port) {
            Ok(()) => { log::info!("server ready port={port}"); return Ok(origin(port)); }
            Err(error) => last_error = error,
        }
        if last_logged.elapsed() >= Duration::from_secs(10) {
            log::warn!("server readiness pending port={port}: {last_error}");
            last_logged = Instant::now();
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    log::error!("server readiness timed out port={port}: {last_error}");
    PENDING_PORT.store(port, Ordering::Relaxed);
    Err(format!("서버가 {port} 에서 90초 안에 준비되지 않았습니다. 마지막 확인: {last_error}"))
}

/// HTML 을 data: URL 로 안전하게 감싼다.
///
/// 예전엔 한글을 그대로 넣었더니 화면에 %EC%84%9C… 처럼 깨져 나왔다 — Url::parse 가
/// 인코딩한 바이트를 브라우저가 charset 대로 못 되돌린 것이다. 그래서 여기서 본문 전체를
/// UTF-8 퍼센트 인코딩해 넣는다. 브라우저는 charset=utf-8 로 그대로 되읽어 한글이 산다.
fn data_html(body: &str) -> String {
    let mut out = String::from("data:text/html;charset=utf-8,");
    for &b in body.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// 서버가 준비될 때까지 잠깐 보여줄 '시작 중' 화면. 창이 빈 채로 멈춰 있으면
/// 앱이 죽은 것처럼 보인다 — 콜드 dev 는 수십 초가 걸린다.
fn loading_page() -> String {
    data_html(
        "<!doctype html><meta charset=\"utf-8\"><title>postq</title>\
<style>body{margin:0;min-height:100vh;display:flex;flex-direction:column;gap:10px;\
align-items:center;justify-content:center;background:#1d2027;color:#909aa8;\
font:14px ui-sans-serif,system-ui,-apple-system,sans-serif}\
.s{font-size:13px;color:#5b6b85}</style>\
<div>postq 서버를 준비하고 있습니다…</div>\
<div class=\"s\">처음 켤 때는 수십 초 걸릴 수 있습니다.</div>",
    )
}

/// 서버를 못 띄웠을 때 창에 띄울 안내.
///
/// 설치한 앱(packaged)에 `npm run dev` 를 권하면 안 된다 — 앱을 켠 사람은 소스도 터미널도
/// 없을 수 있다. 설치본에서 가장 흔한 원인은 macOS 권한 창이라 그걸 먼저 말한다.
fn failure_page(reason: &str, packaged: bool) -> String {
    let next_step = if packaged {
        "<p>macOS 가 <b>폴더 접근 권한</b>을 묻는 창을 띄웠다면 <b>[허용]</b>을 누르세요. \
서버가 준비되면 이 창이 저절로 열립니다. 안 열리면 <b>⌘R</b>.</p>\
<p>그래도 안 되면 앱 데이터 폴더의 <code>logs/server-stderr.log</code> 를 전달해 주세요.</p>"
    } else {
        "<p>터미널에서 <code>npm run dev</code> 로 띄운 뒤 <b>⌘R</b> 을 누르면 다시 시도합니다.</p>"
    };
    data_html(&format!(
        "<!doctype html><meta charset=\"utf-8\"><title>postq</title>\
<style>body{{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;\
background:#1d2027;color:#e9ecf1;word-break:keep-all;\
font:14px/1.7 ui-sans-serif,system-ui,-apple-system,sans-serif}}\
.b{{max-width:520px;padding:32px 36px}}h1{{margin:0 0 12px;font-size:19px}}\
p{{margin:0 0 12px;color:#b0b8c4}}code{{font:12px ui-monospace,Menlo,monospace;\
background:#282c35;border-radius:6px;padding:2px 6px}}</style>\
<div class=\"b\"><h1>postq 서버를 띄우지 못했습니다</h1>\
<p>{reason}</p>{next_step}</div>"
    ))
}

/// 새로고침 메뉴 항목의 id — 눌렀을 때 이 id 로 알아본다.
/// 창이 이 주소로 가도 되는가.
///
/// 마우스 뒤로가기(⌘[)를 앱의 첫 화면에서 한 번 더 누르면 웹뷰가 '시작 중' 안내 화면으로,
/// 거기서 또 누르면 :3000 으로 돌아갔다 — 멈춘 것처럼 보이고 빠져나올 길이 없었다.
/// 서버에 붙은 뒤에는 그 서버 안에서만 움직이게 한다. 뒤로가기는 앱 첫 화면에서 멈춘다.
/// 붙기 전(시작 중·안내 화면)에는 우리가 창을 옮기는 중이라 전부 허용한다.
fn allow_navigation(url: &tauri::Url) -> bool {
    if !ATTACHED.load(Ordering::Relaxed) {
        return true;
    }
    let port = CURRENT_PORT.load(Ordering::Relaxed);
    if port == 0 {
        return true;
    }
    let local = matches!(url.host_str(), Some("localhost") | Some("127.0.0.1"));
    let allowed = local && url.port() == Some(port);
    if !allowed {
        log::info!("navigation blocked: {}", url.scheme());
    }
    allowed
}

/// 웹뷰의 파일 다운로드를 받아 준다.
///
/// 웹뷰는 기본으로 `<a download>`·blob 다운로드를 무시한다 — 응답 저장, 데이터 내보내기, OpenAPI 내보내기가
/// 데스크톱 앱에서만 아무 반응이 없었다(브라우저 :3000 에선 됐다). 사용자의 다운로드 폴더에 저장하고,
/// 같은 이름이 있으면 덮어쓰지 않고 번호를 붙인다. 끝나면 Finder 에서 그 파일을 보여준다 — 저장됐다는
/// 표시가 없으면 사람들은 다시 누른다.
fn handle_download(_webview: tauri::Webview, event: tauri::webview::DownloadEvent<'_>) -> bool {
    use tauri::webview::DownloadEvent;
    match event {
        DownloadEvent::Requested { url, destination } => {
            let dir = std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Downloads")).unwrap_or_else(std::env::temp_dir);
            let suggested = destination.file_name().map(|n| n.to_string_lossy().into_owned())
                .filter(|n| !n.is_empty())
                .or_else(|| url.path_segments().and_then(|mut s| s.next_back()).map(str::to_string).filter(|n| !n.is_empty()))
                .unwrap_or_else(|| "download".to_string());
            let path = PathBuf::from(&suggested);
            let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "download".into());
            let ext = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
            let mut target = dir.join(format!("{stem}{ext}"));
            let mut n = 1;
            while target.exists() {
                target = dir.join(format!("{stem} ({n}){ext}"));
                n += 1;
            }
            log::info!("download requested -> {}", target.display());
            *destination = target;
            true
        }
        DownloadEvent::Finished { path, success, .. } => {
            log::info!("download finished success={success} path={:?}", path);
            if success {
                if let Some(p) = path {
                    let _ = Command::new("open").arg("-R").arg(p).spawn();
                }
            }
            true
        }
        _ => true,
    }
}

/// 서버를 찾거나 띄운 뒤 창을 그쪽으로 보낸다. 못 하면 안내 화면을 띄운다.
/// resolve 는 오래 걸릴 수 있으니 반드시 백그라운드 스레드에서 부른다.
fn attach(handle: &tauri::AppHandle) {
    let packaged = BUNDLED_RUNTIME.lock().unwrap().is_some() && std::env::var_os("POSTQ_DIR").is_none();
    let url = match resolve_origin() {
        Ok(u) => u,
        Err(reason) => failure_page(&reason, packaged),
    };
    if let Some(win) = handle.get_webview_window("main") {
        if let Ok(u) = url.parse() {
            // 포트·붙음 표시를 '먼저' 적는다 — 탐색 허용 검사(allow_navigation)가 이 값을 본다.
            // navigate 뒤에 적으면, 검사가 먼저 돌아 붙을 주소를 막고 창이 '시작 중' 에 멈춘다.
            // http 로 시작하면 실제 서버에 붙은 것. data:(안내 화면)이면 아직 아니다.
            let attached = url.starts_with("http");
            // 붙은 포트를 기억해 감시 스레드가 지켜본다. "http://localhost:3001" → 3001.
            if attached {
                if let Some(port) = url.rsplit(':').next().and_then(|s| s.parse::<u16>().ok()) {
                    CURRENT_PORT.store(port, Ordering::Relaxed);
                }
            }
            ATTACHED.store(attached, Ordering::Relaxed);
            let _ = win.navigate(u);
        }
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// 붙은 서버가 바뀌었는지 지켜본다.
///
/// 이 앱은 껍데기라, 한 번 :3000 의 postq 에 붙은 뒤 그 서버가 죽고 다른 프로젝트가
/// 그 포트를 잡으면, 앱은 그 남의 화면을 계속 보게 된다(실제로 wedwed 가 3000 을 뺏어
/// 404 가 떴다). ⌘R 을 눌러도 같은 포트라 그대로다.
///
/// 그래서 주기적으로 '지금 포트가 아직 postq 인가' 를 확인하고, 아니면 자동으로 다시
/// 붙는다(우리 서버가 죽었으면 빈 포트에 새로 띄운다). 한 번 삐끗한 걸로 옮기지 않게
/// 두 번 연속 실패했을 때만 움직인다 — 잠깐의 부하로 헬스가 늦을 수 있다.
fn monitor_origin(handle: &tauri::AppHandle) {
    let mut misses = 0u8;
    loop {
        std::thread::sleep(Duration::from_secs(7));
        // 안내 화면인데, 포기했던 서버가 그 사이 떴다(권한 창에 늦게 허용한 경우) — 그리로 붙는다.
        if !ATTACHED.load(Ordering::Relaxed) {
            misses = 0;
            let pending = PENDING_PORT.load(Ordering::Relaxed);
            if pending != 0 && probe_postq(pending).is_ok() {
                PENDING_PORT.store(0, Ordering::Relaxed);
                log::info!("late server ready port={pending}");
                if let Some(win) = handle.get_webview_window("main") {
                    if let Ok(u) = origin(pending).parse() {
                        CURRENT_PORT.store(pending, Ordering::Relaxed);
                        ATTACHED.store(true, Ordering::Relaxed);
                        let _ = win.navigate(u);
                    }
                }
            }
            continue;
        }
        let port = CURRENT_PORT.load(Ordering::Relaxed);
        if port == 0 {
            continue;
        }
        if is_postq(port) {
            misses = 0;
        } else {
            misses += 1;
            if misses >= 2 {
                misses = 0;
                // 붙은 서버가 postq 이 아니게 됐다. 로딩 화면으로 바꾸고 다시 붙는다.
                ATTACHED.store(false, Ordering::Relaxed);
                if let Some(win) = handle.get_webview_window("main") {
                    if let Ok(u) = loading_page().parse() {
                        let _ = win.navigate(u);
                    }
                }
                attach(handle);
            }
        }
    }
}

const RELOAD: &str = "reload";
/// 환경설정 메뉴 항목의 id. macOS 는 ⌘, 가 환경설정이라 사람들이 그걸 먼저 누른다.
const PREFS: &str = "prefs";
const CLOSE_REQUEST: &str = "close-request-tab";

/// 앱 메뉴.
///
/// 예전엔 메뉴가 아예 없었다. Tauri 는 브라우저 크롬을 안 주므로 주소창도 새로고침
/// 버튼도 없고, ⌘R 도 안 먹었다 — 서버를 다시 띄워도 창을 닫았다 여는 수밖에 없었다.
/// 웹뷰를 쓰는 앱에서 새로고침이 없는 건 사실상 '복구 수단이 없는' 상태다.
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let reload = MenuItem::with_id(app, RELOAD, "새로고침", true, Some("CmdOrCtrl+R"))?;

    // macOS 는 첫 서브메뉴가 앱 메뉴다. 표준 항목(가리기·종료)을 빼면
    // ⌘Q 조차 안 먹어 창을 강제로 닫아야 한다.
    let app_menu = Submenu::with_items(
        app,
        "postq",
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(AboutMetadata::default()))?,
            &PredefinedMenuItem::separator(app)?,
            // macOS 관례상 환경설정은 앱 메뉴의 About 바로 아래, 단축키는 ⌘, 다.
            // 화면 왼쪽 아래 [설정] 과 같은 곳을 연다 — 들어가는 문이 둘이어도 방은 하나다.
            &MenuItem::with_id(app, PREFS, "환경설정…", true, Some("CmdOrCtrl+,"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    // 편집 메뉴가 없으면 ⌘C/⌘V 가 웹뷰에서 안 먹는다 — macOS 는 메뉴로 그 단축키를 건다.
    let edit_menu = Submenu::with_items(
        app,
        "편집",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let view_menu = Submenu::with_items(app, "보기", true, &[&reload])?;

    let window_menu = Submenu::with_items(
        app,
        "창",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
            &MenuItem::with_id(app, CLOSE_REQUEST, "요청 탭 닫기", true, Some("CmdOrCtrl+W"))?,
        ],
    )?;

    Menu::with_items(app, &[&app_menu, &edit_menu, &view_menu, &window_menu])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if let Some(data) = postq_server::cli::default_data_dir() {
                postq_server::cli::ensure_data_dir(&data)?;
                *APP_DATA.lock().unwrap() = Some(data);
            }
            if let Ok(resources) = app.path().resource_dir() {
                let runtime = resources.join("runtime");
                // 번들 런타임 = 화면(ui/)과 DB 마이그레이션(drizzle/). 서버는 이 실행 파일 안에 들어 있다.
                if runtime.join("drizzle").is_dir() { *BUNDLED_RUNTIME.lock().unwrap() = Some(runtime); }
            }
            #[cfg(unix)]
            if BUNDLED_RUNTIME.lock().unwrap().is_some() && std::env::var_os("POSTQ_DIR").is_none() {
                if let Some(data) = APP_DATA.lock().unwrap().clone() {
                    redirect_output(&data.join("logs"));
                }
            }
            {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let menu = build_menu(app.handle())?;
            app.set_menu(menu)?;

            // 창은 코드로 만든다 — 설정 파일로 만들면 첫 화면이 :3000(남의 앱일 수도)이고,
            // 탐색을 거를 자리(on_navigation)가 없다. 처음부터 '시작 중' 화면으로 연다.
            let win = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                // data: 로는 창을 만들 수 없다(webview-data-url 기능 필요). 빈 창으로 만들고 곧바로 옮긴다.
                tauri::WebviewUrl::External("about:blank".parse().expect("about:blank")),
            )
            .title("postq")
            .inner_size(1440.0, 900.0)
            .resizable(true)
            .disable_drag_drop_handler()
            .on_navigation(allow_navigation)
            .on_download(handle_download)
            .visible(false)
            .build()?;
            if let Ok(u) = loading_page().parse() {
                let _ = win.navigate(u);
            }
            let _ = win.show();
            let _ = win.set_focus();
            // 붙기는 오래 걸릴 수 있으니 백그라운드에서. 끝나면 실제 서버(또는 안내)로 옮긴다.
            let handle = app.handle().clone();
            std::thread::spawn(move || attach(&handle));
            // 붙은 뒤 서버가 바뀌는지(포트 탈취·서버 죽음) 지켜보다 자동 복구한다.
            let watch = app.handle().clone();
            std::thread::spawn(move || monitor_origin(&watch));
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id() == CLOSE_REQUEST {
                if let Some(win) = app.webview_windows().into_values().find(|w| w.is_focused().unwrap_or(false)) {
                    let _ = win.eval("window.dispatchEvent(new Event('postq:close-request-tab'))");
                }
                return;
            }
            if event.id() == PREFS {
                // 웹 쪽 설정 다이얼로그를 연다. 레일의 [설정] 과 같은 버튼을 누르는 것과 같다 —
                // 여는 길을 하나로 두면 나중에 화면이 바뀌어도 여기만 따라가면 된다.
                let target = app
                    .webview_windows()
                    .into_values()
                    .find(|w| w.is_focused().unwrap_or(false))
                    .or_else(|| app.webview_windows().into_values().next());
                if let Some(win) = target {
                    let _ = win.eval(
                        "document.querySelector('[data-testid=\"rail-settings\"]')?.click()",
                    );
                }
                return;
            }
            if event.id() == RELOAD {
                // 아직 실제 서버에 못 붙은 상태(안내/시작 화면)면 ⌘R 은 '새로고침' 이 아니라
                // '다시 붙기' 여야 한다 — data: 안내 화면을 reload 해봐야 같은 화면만 다시 뜬다.
                // 서버를 띄운 뒤 ⌘R 로 붙으라는 안내가 실제로 동작하려면 여기서 재시도한다.
                if !ATTACHED.load(Ordering::Relaxed) {
                    let handle = app.clone();
                    std::thread::spawn(move || attach(&handle));
                    return;
                }
                // 붙은 뒤에는 평범한 새로고침. 포커스된 창만 — 여럿일 때 남의 창 작업이
                // 날아가지 않게. (tauri.conf 에 label:"main" 을 두었지만, 여기선 어느 창이든
                // 포커스된 것을 새로고침하는 게 맞아 라벨로 집지 않는다.)
                let target = app
                    .webview_windows()
                    .into_values()
                    .find(|w| w.is_focused().unwrap_or(false))
                    .or_else(|| app.webview_windows().into_values().next());
                if let Some(win) = target {
                    let _ = win.eval("window.location.reload()");
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        // 서버는 같은 프로세스라 앱이 끝나면 함께 끝난다 — 따로 내릴 자식이 없다.
        .run(|_app, _event| {});
}

#[cfg(test)]
mod readiness_tests {
    use super::*;
    fn response_probe(response: &'static str) -> Result<(), String> {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut buf = [0; 2048];
            let _ = socket.read(&mut buf);
            socket.write_all(response.as_bytes()).unwrap();
        });
        let result = probe_postq(port);
        server.join().unwrap();
        result
    }
    #[test]
    fn readiness_recognizes_app_and_describes_wrong_responses() {
        assert!(response_probe("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{\"app\":\"postq\",\"ok\":true}").is_ok());
        let error = response_probe("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\nfailed").unwrap_err();
        assert!(error.contains("502 Bad Gateway"));
        assert!(!error.contains("failed"));
    }
}

#[cfg(test)]
mod data_path_tests {
    use super::*;

    // codex 리뷰 P2: 프로젝트 폴더를 못 찾으면 검증 안 된 구워진 경로의 DB·.env 를 읽었다.
    #[test]
    fn 프로젝트_폴더가_없으면_앱_데이터만_쓴다() {
        let tmp = std::env::temp_dir().join(format!("postq-paths-{}", std::process::id()));
        let (proj, app) = (tmp.join("proj"), tmp.join("app"));
        std::fs::create_dir_all(proj.join("data")).unwrap();
        std::fs::create_dir_all(&app).unwrap();
        std::fs::write(proj.join("data/dev-snapshot.db"), b"").unwrap();

        let (db, envs) = data_paths(None, &app);
        assert_eq!(db, app.join("postq.db"));
        assert_eq!(envs, vec![app.join("app.env")]);

        let (db, envs) = data_paths(Some(&proj), &app);
        assert_eq!(db, proj.join("data/dev-snapshot.db"));
        assert_eq!(envs, vec![proj.join(".env"), proj.join(".env.local"), app.join("app.env")]);

        // 확인된 폴더라도 실데이터가 없으면 앱 데이터의 DB
        std::fs::remove_file(proj.join("data/dev-snapshot.db")).unwrap();
        assert_eq!(data_paths(Some(&proj), &app).0, app.join("postq.db"));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
