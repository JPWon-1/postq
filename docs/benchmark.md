# postq vs Postman — 크기·메모리

현재 npm 설치 명령은 `npm install -g @postq/postq`다. 아래 0.1.0 수치는 이름 변경 전 로컬 tarball에서 잰 역사적 기록이며, 플랫폼 패키지 이름은 그대로다.

[English below](#english)

두 가지를 따로 쟀다. 단위 MiB = 1024×1024 바이트.

1. [Postman 데스크톱 앱 vs postq](#postman-데스크톱-앱-vs-postq) — 앱을 켜 두기만 했을 때(대기)의 메모리와 디스크
2. [Postman CLI vs postq](#postman-cli-vs-postq) — 같은 컬렉션을 실행할 때의 메모리·시간

**측정 환경(둘 다)** — MacBook Pro (Mac16,7, Apple M4 Pro, 메모리 24 GB) · macOS 26.6.2 · 2026-11-03

## 큰 작업 공간 응답성 (2026-11-06)

임시 DB에 폴더 10개, 요청 1,000개, 이력 10,000건을 넣고 release 서버와 headless Chromium
(1440×900)에서 각각 5회 재서 중앙값을 냈다. 실제 사용자 DB와 포트는 사용하지 않았다.
서버 시간은 응답 본문 수신까지, 화면 시간은 브라우저의 화면 조작 이벤트부터 해당 내용이 DOM에
나타날 때까지다. 첫 화면은 내비게이션 시작부터, 트리는 첫 화면 이후 폴더 이름 표시까지다.

| 구간 | 서버 응답 변경 전 → 후 | 화면 표시 변경 전 → 후 |
|---|---:|---:|
| 앱 시작 → `/api/health`, 첫 화면 | 27.9 → 28.5 ms | 46.5 → 28.1 ms |
| 컬렉션 트리 (`/api/folders` + slim 요청 목록) | 0.9 + 5.3 → 0.8 + 5.4 ms | 61.9 → 69.3 ms |
| 요청 열기 (`/api/requests/{id}` → URL 입력칸) | 0.7 → 0.6 ms | **387.9 → 103.1 ms** |
| 이력 목록 (최근 200건 → 첫 행) | 3.3 → 3.3 ms | **518.7 → 56.1 ms** |
| ⌘K 검색 (폴더 + slim 요청 목록) | 0.9 + 5.0 → 0.8 + 4.4 ms | 20.8 → 17.7 ms |

100ms를 넘은 두 화면은 서버 쿼리보다 첫 진입 때 화면 모듈을 내려받는 지연이 컸다.
요청·이력 화면을 초기 번들에 포함했고, 이력 첫 조회에 걸린 180ms 대기를 없앴다.
초기 JS는 228KB에서 266KB로 늘었다. 요청 입력칸은 중앙값 103.1ms로 경계에 가깝지만
기존 387.9ms에서 73% 줄었다. DB 인덱스와 데이터 캐시는 추가하지 않았다.

재현: `npm run build`, `env -u HOSTNAME CARGO_INCREMENTAL=0 cargo build --release --bin postq-server`
(server/에서), `node scripts/bench-large.mjs --runs 5`. 변경 전 화면은 커밋 `d5a07e6`의 정적 빌드로
측정했다. 스크립트는 임시 DB와 자신이 띄운 서버만 정리한다.

## Postman 데스크톱 앱 vs postq

| 항목 | Postman 데스크톱 12.27.2 | postq 데스크톱 앱 0.1.0 | postq CLI 0.1.0 + 브라우저 탭 |
|---|---:|---:|---:|
| 디스크 — 앱·설치 | **460.5 MiB** (앱 번들) | **23.7 MiB** (`postq.app`) | **5.7 MiB** (`npm install -g`, 패키지 2개) |
| 디스크 — 사용자 데이터 폴더 | 384.4 MiB (`~/Library/Application Support/Postman`, 쓰던 상태) | 1.3 MiB (새로 깐 뒤 5번 켰다 끈 상태, 폴더 4개 합) | — |
| 대기 프로세스 수 | 6 (메인·GPU·네트워크·렌더러·crashpad·ShipIt) | 6 (앱 본체 + WebKit GPU·Networking·WebContent×3) | 서버 1 (+ npm 런처 node 1) |
| 대기 메모리 — RSS 합 (`ps`) | **835 MiB** (3회: 835·834·862) | **269.5 MiB** (5회 중앙값) | 서버 **5.6 MiB** (+ 런처 node 34.7 MiB) |
| 대기 메모리 — footprint 합 (`footprint -p`) | **≈856 MB** (1회) | **107.1 MiB** (5회 중앙값) | 서버 2.8 MiB · 런처 포함 15.4 MiB |
| 화면을 그리는 쪽 | 앱 안(Electron) — 위 값에 포함 | 앱 안(WebKit) — 위 값에 포함 | 브라우저 탭 따로: headless Chromium 탭 렌더러 footprint 50.4 MiB (RSS 140.4 MiB) |

### 무엇을 쟀나 — 조건이 다르다

- **Postman 데스크톱** — 사용자가 직접 켜 둔 `Postman 12.27.2`(Lightweight API Client, 로그인 안 함, 빈 Untitled Request 탭 1개, 대기)를
  **읽기만** 했다(켜거나 끄거나 조작하지 않음). 그 앱의 프로세스 6개 각각의 `ps` RSS 를 더한 값을 3초 간격 3회, `footprint -p <pid>` 를
  프로세스마다 한 번씩 재서 더했다(메인 127 + GPU 475 + 렌더러 232 + 네트워크 17 + crashpad 2.4 + ShipIt 3.0 MB).
  앱을 켠 지 얼마나 됐는지, 사용자 데이터 폴더에 무엇이 쌓였는지는 통제하지 못했다 — 새로 깐 상태가 아니다.
  번들·데이터 크기는 `du -sk`. footprint 의 MB 는 1024² 단위다(같은 도구가 35,456,104 B 를 34 MB 로 찍는다).
- **postq 데스크톱 앱** — `npm run app:build -- --bundles app` 으로 만든 `.app` 을 임시 폴더에 복사해
  `open -g -n <복사본>` 으로 띄우고(-g: 앞으로 가져오지 않음) 10초 뒤 재고, 그 앱 본체만 SIGTERM 으로 끄기를 5회 반복한 중앙값이다.
  빈 DB, 첫 화면(이어서 하기) 상태. 5회 모두 측정 시점에 맨 앞 앱이 아니었다(`lsappinfo front`).
  WebKit 프로세스(`com.apple.WebKit.*`)는 launchd 가 띄워 부모 PID 로는 못 찾는다 — macOS 의 '책임 프로세스'
  (`responsibility_get_pid_responsible_for_pid`, 활동 모니터가 쓰는 값)가 그 앱 본체인 것만 골랐다. 같은 Mac 에서 떠 있던
  다른 WebKit 앱의 프로세스는 책임 프로세스가 달라 섞이지 않는다.
  데이터 폴더는 `~/Library/Application Support/postq` 0.2 + `~/Library/WebKit/…` 0.3 + `~/Library/Caches/…` 0.8 + `~/Library/Logs/…` 0.0 MiB.
- **postq CLI** — 로컬에서 만든 npm 패키지 두 개를 임시 prefix 에 `npm install -g --prefix` 로 깔고(레지스트리에서 받은 것 아님),
  `postq --no-open --port <빈 포트> --data-dir <임시>` 로 띄워 10초 뒤 잰 값(5회 중앙값). 이 경우 화면은 사용자의 브라우저 탭이 그린다 —
  표의 탭 값은 Playwright 의 headless Chromium(1.61.1 번들) 탭 하나로 화면을 열고 10초 뒤 그 탭 렌더러 프로세스를 잰 것이다.
  headless Chromium 전체(4개 프로세스) RSS 합은 338.2 MiB 였지만, 평소 쓰는 브라우저는 이미 떠 있으므로 늘어나는 몫은 탭 하나에 가깝다.
  평소 쓰는 브라우저(Chrome·Safari) 탭은 재지 않았다.
- **RSS 합은 공유 메모리를 여러 번 센다**(같은 프레임워크를 여러 프로세스가 매핑). 각 프로세스가 실제로 차지한 몫은 footprint 쪽이 가깝다.
  두 앱 모두 같은 방법(프로세스별 값을 더함)으로 셌다.
- Postman 과 postq 를 같은 시각에 재지 않았다. Postman 은 사용자가 쓰던 앱이라 다시 켜서 같은 조건(빈 데이터·10초 뒤)으로 맞추지 않았다.

### 다시 재기

```bash
npm run app:build -- --bundles app
node scripts/bench-desktop.mjs --app src-tauri/target/release/bundle/macos/postq.app --runs 5 --wait 10
node scripts/bench-desktop.mjs --cli <prefix>/bin/postq --npm-prefix <prefix> --runs 5 --wait 10
node scripts/bench-desktop.mjs --running "/Applications/Postman.app" --runs 3   # 이미 떠 있는 앱을 읽기만(켜거나 끄지 않음)
```

`--running` 은 위 Postman 수치를 잰 것과 같은 방법(ps RSS 합 · 프로세스별 footprint 합)을 스크립트로 옮긴 것이다. 표의 Postman 수치는
이 스크립트가 아니라 같은 명령(`ps`, `footprint -p`, `du -sk`)을 손으로 돌려 얻었다.

## Postman CLI vs postq

`scripts/bench-postman.mjs` 로 잰 값이다. 같은 기계에서 같은 컬렉션(요청 4개, 로컬 echo 서버 `e2e/echo-server.mjs` 대상)을
각 5회 실행해 **중앙값**을 적었다. 단위 MiB = 1024×1024 바이트.

**측정 환경** — 위와 같은 Mac · Node.js v22.22.0 ·
postman-cli 1.84.0 (npm `postman-cli`, `@postman/pm-bin-macos-arm64`) · postq 0.1.0 release 빌드 · 2026-11-03

### 무엇을 쟀나 — 둘은 같은 종류가 아니다

- **Postman CLI** 는 컬렉션 실행기다. `postman collection run collection.json` 한 번(로그인 없이 — 결과를 클라우드에 올리지 않는다).
- **postq** 는 서버(API + 정적 화면 + SQLite + 스케줄러 + MCP)다. 같은 컬렉션을 `/api/import/postman` 으로 가져와
  `scripts/run-collection.mjs`(→ `POST /api/folders/{id}/run`)로 실행했다. 화면을 여는 브라우저 메모리는 넣지 않았다.
- Postman 데스크톱 앱 수치는 이 표가 아니라 [위 절](#postman-데스크톱-앱-vs-postq)에 있다.

### 결과

| 항목 | Postman CLI | postq |
|---|---:|---:|
| 설치 크기(디스크) — `npm install -g` | **366.2 MiB** (`postman-cli` 0.3 + `@postman/pm-bin-macos-arm64` 365.9) | **5.6 MiB** (`postq` 0.02 + `postq-darwin-arm64` 5.6) |
| 내려받는 크기 | — | npm tarball 2.9 MiB (메인 7.7 KiB + darwin-arm64 2.9 MiB) · 릴리스 묶음 `postq-0.1.0-darwin-arm64.tar.gz` 2.9 MiB |
| 대기 상태 메모리(RSS) | — (상주하지 않음) | **5.4 MiB** (서버, 빈 DB, 띄우고 3초 뒤) |
| 컬렉션 4건 실행 — 프로세스 트리 최대 RSS 합 | **606.1 MiB** | **서버 7.3 MiB** + 실행 스크립트(node) 45.1 MiB |
| 컬렉션 4건 실행 — `/usr/bin/time -l` maximum resident set size | 568.5 MiB | 실행 스크립트(node) 47.4 MiB |
| 시작 → 첫 응답 | 656 ms (`postman --version` 끝날 때까지) | 14 ms (서버 시작 → `/api/health` 200) |
| 컬렉션 4건 실행 전체 시간 | 1,725 ms | 142 ms (실행 스크립트 시작~끝, node 기동 포함) |

참고
- 이 표는 UI 개편 전 빌드로 잰 값이다. UI 개편 뒤 같은 방법으로 다시 잰 npm 설치 크기는 5.7 MiB(5.67)다(위 절).
- postq 의 npm 설치 크기는 로컬에서 만든 패키지 두 개(`scripts/package-release.mjs --main` → `npm pack`)를 임시 prefix 에 `npm install -g --prefix` 로 깔고
  당시 `lib/node_modules/postq*` 의 du 를 더한 값이다(`node scripts/bench-postman.mjs --sizes-only`). 레지스트리에서 받은 것은 아니다. 현재 스크립트는 `@postq/postq`와 플랫폼 패키지 경로를 센다.
  Homebrew 설치는 같은 릴리스 묶음을 풀어 놓는 것이라 크기가 비슷할 것으로 보지만, 이 표에는 재서 넣지 않았다.
- Postman CLI 는 표의 값(`--postman-dir` 로 준 설치를 du) 외에, 이 Mac 에 `npm install -g postman-cli` 로 깔린 전역 설치를 du 로 재면 349 MiB 였다.
- postq 의 실행 스크립트 45 MiB 는 대부분 Node.js 자체다. 같은 실행을 `curl -X POST .../api/folders/{id}/run` 으로 부르면 서버 쪽 7 MiB 만 남는다.
- Postman CLI 설치 크기는 npm 이 내려받는 플랫폼별 실행 파일 패키지(이 기계에서는 macos-arm64 하나)까지 더했다. 처음 실행 때 `~/.postman`(설정·로그, 12 KiB)이 생긴다.
- `/usr/bin/time -l` 의 값은 자식 프로세스 중 가장 큰 하나의 최대 RSS 이고, 트리 합계는 `ps` 를 20 ms 마다 찍어 루트와 모든 자손의 RSS 를 더한 값의 최댓값이다.
- Windows·Linux 에서는 재지 않았다. 스크립트는 Linux 에서 `/usr/bin/time -v` 를 쓰고, Windows 에서는 메모리 표본을 `n/a` 로 둔다(크기·시간만).

### 다시 재기

```bash
npm run build && (cd server && cargo build --release)
npm install --prefix /tmp/pm postman-cli            # 또는 npm install -g postman-cli
node scripts/bench-postman.mjs --postman-dir /tmp/pm/node_modules --runs 5 --json bench.json
node scripts/bench-postman.mjs --sizes-only          # 설치 크기만(npm 설치 포함)
```

---

## English

### Large workspace responsiveness (2026-11-06)

With 1,000 requests and 10,000 executions in a temporary database, five-run medians on the
release server and headless Chromium were: request editor **387.9 → 103.1 ms** and history list
**518.7 → 56.1 ms** from user action to visible content. Server responses stayed below 6 ms.
The slow first visits came from loading the request and history UI chunks; history also waited
180 ms before fetching. Both views now load with the initial bundle and history fetches immediately.
Initial JS grew from 228 to 266 KB. Reproduce with `node scripts/bench-large.mjs --runs 5` after
building the static UI and release server. The script uses only temporary data and headless Chromium.

Two separate comparisons, both on a MacBook Pro (Mac16,7, Apple M4 Pro, 24 GB), macOS 26.6.2, 2026-11-03. MiB = 1024×1024 bytes.

### Postman desktop app vs postq

| | Postman desktop 12.27.2 | postq desktop app 0.1.0 | postq CLI 0.1.0 + browser tab |
|---|---:|---:|---:|
| Disk — app / install | **460.5 MiB** (app bundle) | **23.7 MiB** (`postq.app`) | **5.7 MiB** (`npm install -g`, 2 packages) |
| Disk — user data folder | 384.4 MiB (`~/Library/Application Support/Postman`, in use) | 1.3 MiB (fresh, after 5 launches; 4 folders) | — |
| Idle processes | 6 (main, GPU, network, renderer, crashpad, ShipIt) | 6 (app + WebKit GPU, Networking, WebContent×3) | server 1 (+ npm launcher node 1) |
| Idle memory — sum of RSS (`ps`) | **835 MiB** (3 samples: 835, 834, 862) | **269.5 MiB** (median of 5) | server **5.6 MiB** (+ launcher node 34.7 MiB) |
| Idle memory — sum of footprint (`footprint -p`) | **≈856 MB** (1 sample) | **107.1 MiB** (median of 5) | server 2.8 MiB, 15.4 MiB with launcher |
| What draws the UI | inside the app (Electron), included above | inside the app (WebKit), included above | a browser tab: headless Chromium tab renderer footprint 50.4 MiB (RSS 140.4 MiB) |

What was measured — the conditions differ:

- **Postman desktop**: the user's own running copy (Lightweight API Client, not signed in, one empty Untitled Request tab, idle) was only
  *read* — not launched, quit or touched. RSS of its 6 processes summed, 3 samples 3 s apart; `footprint -p` per process once, summed
  (main 127 + GPU 475 + renderer 232 + network 17 + crashpad 2.4 + ShipIt 3.0 MB; footprint's MB is 1024²). Uptime and what had
  accumulated in its data folder were not controlled — it is not a fresh install.
- **postq desktop app**: the `.app` from `npm run app:build -- --bundles app`, copied to a temp folder, launched with `open -g -n`
  (not brought to front), measured 10 s later, then only that app's PID was sent SIGTERM; 5 runs, median. Empty database, start screen.
  WebKit helper processes are launched by launchd, so they are matched by macOS's *responsible process*
  (`responsibility_get_pid_responsible_for_pid`, what Activity Monitor uses) rather than by parent PID; other WebKit apps' helpers do not mix in.
- **postq CLI**: two locally built npm packages installed into a temp prefix (not from the registry), started with
  `--no-open --port <free> --data-dir <temp>`, measured 10 s later (median of 5). The UI is drawn by a browser tab; the tab figure is one
  Playwright headless Chromium tab (bundled with Playwright 1.61.1) 10 s after opening the UI. All 4 headless Chromium processes summed to
  338.2 MiB RSS, but an everyday browser is usually already running, so the added cost is closer to one tab. Chrome/Safari tabs were not measured.
- Summed RSS counts shared pages more than once; footprint is closer to what each process really owns. Both apps were summed the same way.
- Postman and postq were not measured at the same moment, and Postman was not relaunched to match postq's conditions.

Reproduce: `node scripts/bench-desktop.mjs --app <postq.app>`, `--cli <prefix>/bin/postq --npm-prefix <prefix>`, and
`--running <some.app>` (read-only, same method as the Postman numbers; those were taken by hand with `ps`, `footprint -p` and `du -sk`).

### Postman CLI vs postq

Measured with `scripts/bench-postman.mjs`: the same 4-request collection against a local echo server, 5 runs each, **median**.
Node.js v22.22.0, postman-cli 1.84.0, postq 0.1.0 release build, 2026-11-03.

They are different kinds of tools: Postman CLI is a collection runner (`postman collection run`, no login, nothing uploaded);
postq is a server (API + static UI + SQLite + scheduler + MCP), measured while running the imported collection through
`scripts/run-collection.mjs`. Browser memory for the UI is not included (see the desktop table above).

| | Postman CLI | postq |
|---|---:|---:|
| Install size on disk (`npm install -g`) | **366.2 MiB** | **5.6 MiB** (`postq` 0.02 + `postq-darwin-arm64` 5.6) |
| Download | — | npm tarballs 2.9 MiB · release archive 2.9 MiB tar.gz |
| Idle RSS | — (not resident) | **5.4 MiB** |
| Peak RSS running the collection (process tree) | **606.1 MiB** | **server 7.3 MiB** + Node runner script 45.1 MiB |
| Peak RSS, `/usr/bin/time -l` | 568.5 MiB | runner script 47.4 MiB |
| Start → first response | 656 ms (`postman --version`) | 14 ms (server start → `/api/health`) |
| Collection run wall time | 1,725 ms | 142 ms |

The current npm install command is `npm install -g @postq/postq`. The 0.1.0 npm sizes above were measured from locally built tarballs before the launcher was renamed; they were not registry installs. The platform package names are unchanged.
postq's npm size comes from installing the two locally built packages (`package-release.mjs --main` + `npm pack`)
into a temporary prefix (`node scripts/bench-postman.mjs --sizes-only`).
Homebrew install size was not measured for this table. This table predates the UI redesign; the npm install size re-measured after it is 5.7 MiB (5.67).

Not measured on Windows or Linux.
