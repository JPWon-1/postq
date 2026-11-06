# 검증 하네스

처음 실행할 때는 저장소 루트에서 `npm ci`를 실행한다. CI는 Node 22와 stable Rust를 쓴다. 아래 명령의 Rust 부분은 개발 환경의 `HOSTNAME` 영향을 피하고 증분 빌드를 끄는 형태다. UI와 서버를 함께 고쳤다면 `npm run build`와 서버 release 빌드 후 `node scripts/e2e-safe.mjs`를 실행한다.

| 검사 | 막는 문제 | 언제 실행 | 실패하면 볼 곳 |
| --- | --- | --- | --- |
| `(cd server && env -u HOSTNAME CARGO_INCREMENTAL=0 cargo test --locked)` | API·DB·CLI 동작 회귀, lockfile 불일치 | 서버·스키마 변경 시 | `server/src/`의 실패 테스트, `server/Cargo.lock` |
| `(cd server && env -u HOSTNAME CARGO_INCREMENTAL=0 cargo fmt --check)` | Rust 서식 불일치 | Rust 수정 후; CI의 필수 단계는 아님 | `cargo fmt --check`가 출력한 파일; 현재 저장소 전체에 기존 서식 차이가 있어 실패함 |
| `(cd server && env -u HOSTNAME CARGO_INCREMENTAL=0 cargo clippy --locked --all-targets)` | Rust 정적 경고 | Rust 수정 후; CI의 필수 단계는 아님 | 경고의 파일·행; 현재 기존 경고가 있으나 종료 코드는 0 |
| `npx tsc --noEmit` | TypeScript 타입 오류 | UI·스크립트 타입 수정 후 | 출력한 `src/`·`e2e/` 파일 |
| `npx vitest run` | UI·공유 로직 단위 회귀 | UI 변경 후 | 실패한 테스트와 인접 구현 |
| `node scripts/check-i18n.mjs` | JSX에 남은 한국어 하드코딩 | UI 문구 변경 후 | 출력한 JSX 위치, `src/i18n/{en,ko}.ts` |
| `npm run version:check` | npm·Rust·Tauri·MCP·Homebrew 견본 버전 불일치 | 버전 변경 후와 CI web job | 출력한 파일; [버전 가이드](VERSIONING.md) |
| `npm run build` | Next 정적 export 실패 | UI 변경 후, E2E 전에 | Next 빌드 로그와 `out/` |
| `(cd server && env -u HOSTNAME CARGO_INCREMENTAL=0 cargo build --release --locked)` | 배포용 서버 빌드 실패 | 서버 변경 후, E2E 전에 | Cargo 빌드 로그 |
| `node scripts/e2e-safe.mjs` | 실제 서버+정적 화면 통합 회귀 | UI·API·DB 변경 후 | Playwright 실패, `test-results/`; `--keep`으로 사본·로그 보존 |
| CI `install-smoke` | 패키지 설치·기동·정지 실패 | 릴리스 전 CI에서 | `.github/workflows/ci.yml`의 OS별 job 로그, `scripts/package-release.mjs` |
| CI Windows `win-ctrl-smoke` | Ctrl+C·Ctrl+Break 종료 코드 오류 | Windows CI에서 | `scripts/win-ctrl-smoke.ps1`, 해당 job 로그 |
| CI 행렬 | Ubuntu/macOS/Windows 설치 및 5개 릴리스 대상 빌드 실패 | PR·main CI와 태그 릴리스 | `.github/workflows/{ci,release}.yml`의 실패한 OS·대상 job |

`e2e-safe`는 원본 DB의 일관된 사본을 임시 위치에 만들고, 테스트 뒤 원본 지문을 비교한다. 데이터가 없어도 빈 테스트 DB로 시작한다. 회사 DB를 `--db`에 지정하지 않는다. `install-smoke`는 CI에서 `@postq/postq`와 이름을 유지한 플랫폼 패키지의 tarball을 `npm install -g`로 설치해 `postq --version`, `/api/health`, 화면, 종료를 확인한다. Windows 콘솔 이벤트 검사는 Windows 러너에서만 실행할 수 있다.

## 변경 종류별 최소 검증 체크리스트

| 변경 | 최소 검증 |
| --- | --- |
| UI만 | `node scripts/check-i18n.mjs`, `npx tsc --noEmit`, `npx vitest run`, `npm run build`, `node scripts/e2e-safe.mjs`(서버 release 빌드 선행) |
| 서버만 | `cargo fmt --check`와 `cargo clippy --locked --all-targets`의 변경 파일 진단 확인, `cargo test --locked`, `cargo build --release --locked`, `node scripts/e2e-safe.mjs`(정적 UI 빌드 선행) |
| DB 스키마 | 서버 검사 전부, 이전 DB의 임시 사본으로 마이그레이션 테스트, `e2e-safe` |
| 릴리스 | `npm run version:check`, UI·서버 검사, `e2e-safe`, CI `install-smoke` 및 Release 행렬 결과 확인; [배포 절차](RELEASING.md) |

## 짧은 용어집

| 용어 | 뜻 |
| --- | --- |
| cargo | Rust 의존성·빌드·테스트 명령 도구 |
| crate | Rust 패키지/컴파일 단위. 여기서는 `postq-server`, `postq-desktop` |
| npm | Node 패키지 설치·스크립트 실행 도구 |
| `node_modules` | `npm ci`가 내려받는 로컬 의존성 폴더; 커밋하지 않음 |
| Next 정적 export | `npm run build`가 서버용 Node 없이 `out/`의 HTML·JS·CSS를 만드는 방식 |
| Tauri | 정적 UI를 데스크톱 창에 넣고 Rust 서버를 같은 앱에서 실행하는 틀 |
| SQLite WAL | DB 본 파일 옆의 변경 기록 파일. 라이브 DB를 파일 복사하지 않고 백업 명령을 사용해야 함 |
| 마이그레이션 | 이전 DB 구조를 새 구조로 올리는 순서 있는 SQL 변경. `drizzle/`과 기록 테이블이 적용 여부를 결정 |
