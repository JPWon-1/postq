# 버전 관리

postq는 `MAJOR.MINOR.PATCH` SemVer를 쓴다. 0.x에서는 호환되지 않는 사용자 인터페이스·데이터 형식 변경도 MINOR를 올릴 수 있다. 버그 수정과 호환되는 추가는 PATCH를 올린다. 1.0 이후에는 호환을 깨면 MAJOR를 올린다. 태그는 `v`를 앞에 붙인다(예: `v0.1.1`).

## 버전이 있는 곳

| 위치 | 역할 |
| --- | --- |
| `package.json`, `package-lock.json`(루트와 빈 패키지 항목) | 개발·빌드용 npm 프로젝트 |
| `npm/postq/package.json`의 `version`과 5개 `optionalDependencies` | 배포용 npm 런처 및 OS별 패키지 의존성 |
| `server/Cargo.toml`, `server/Cargo.lock`의 `postq-server` | 서버와 `postq --version` |
| `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`의 `postq-desktop`·`postq-server`, `src-tauri/tauri.conf.json` | 데스크톱 앱과 서버 경로 의존성 |
| `server/src/mcp.rs`의 `SERVER_VERSION`과 프로토콜 테스트 기대값 | MCP `serverInfo.version` |
| `packaging/homebrew/postq.rb` | Homebrew formula 견본의 버전과 다운로드 URL; 실제 릴리스 formula는 `scripts/update-formula.mjs`가 생성 |

`scripts/package-release.mjs`가 만드는 `dist/npm/`의 5개 플랫폼 패키지는 생성물이다. `docs/benchmark.md`의 버전은 측정 당시를 가리키는 기록이므로 일괄 변경하지 않는다. README의 첫 배포 전 `v0.1.0` 표기도 배포 상태 설명이다.

## 올리는 순서

1. `npm run version:bump -- 0.1.1`처럼 목표 버전을 지정한다. 이 도구는 위의 기준 파일과 두 Cargo.lock의 프로젝트 항목을 함께 바꾼다. 현재 파일의 버전이 어긋나면 먼저 멈춘다.
2. `npm run version:check`로 모두 같은지 확인한다. CI web job과 태그 Release의 `ui` job도 이 검사를 실행한다.
3. `CHANGELOG.md`의 `[Unreleased]` 변경을 새 버전 항목으로 옮기고 날짜를 적는다. [검증 하네스](HARNESS.md)의 릴리스 검사를 끝내고 커밋한다.
4. 태그와 배포 승인·인증·실제 업로드는 [배포 절차](RELEASING.md)를 따른다. 태그 `v*` 푸시가 `.github/workflows/release.yml`을 시작한다. `ui` → 5개 대상 `build` → GitHub `release` → npm 및 Homebrew 단계 순서다. CI가 태그와 파일 버전도 대조한다.

## DB 호환과 핫픽스

새 버전은 이전 버전 DB를 열 수 있어야 한다. 이미 배포된 `drizzle/` SQL과 journal 항목을 수정하지 말고 새 항목을 추가한다. DB 스키마는 되돌리기 마이그레이션을 제공하지 않는다. 대기 중 마이그레이션이 있는 기존 DB는 시작 직전에 `VACUUM INTO` 스냅샷과 `.key` 사본을 `data-dir/backups`에 만들고 최근 5개를 보존한다. 복원 절차는 [README의 설치·실행 설명](../README.md#install-and-run)을 따른다. 릴리스 전 이전 버전 DB의 임시 사본으로 업그레이드를 시험한다.

핫픽스는 문제가 있는 태그의 코드에서 수정하고 PATCH 버전을 새로 올린 뒤 동일한 검증·릴리스 절차를 따른다. 이미 게시된 npm 버전과 같은 태그를 다시 빌드해 덮어쓰지 않는다. 실패한 같은 실행은 Actions의 **Re-run failed jobs**로 다시 실행할 수 있으며, 자세한 이유는 [배포 절차](RELEASING.md#릴리스마다)에 있다.
