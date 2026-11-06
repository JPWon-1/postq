# 배포하기

`npm install -g postq` 와 `brew install JPWon-1/tap/postq` 로 깔리게 하는 절차입니다.
실제 빌드·업로드는 `.github/workflows/release.yml` 이 `v*` 태그를 받으면 합니다. 버전 파일 목록·증가 규칙은 [VERSIONING.md](VERSIONING.md), 검증은 [HARNESS.md](HARNESS.md)를 봅니다.

## 무엇이 어디로 가나

| 대상 | 러너 | 결과 |
|---|---|---|
| macOS arm64 | macos-14 | `postq-<버전>-darwin-arm64.tar.gz`, npm `postq-darwin-arm64` |
| macOS x64 | macos-14(교차 빌드) | `postq-<버전>-darwin-x64.tar.gz`, npm `postq-darwin-x64` |
| Linux x64 (glibc 2.35+) | ubuntu-22.04 | `postq-<버전>-linux-x64.tar.gz`, npm `postq-linux-x64` |
| Linux arm64 (glibc 2.35+) | ubuntu-22.04-arm | `postq-<버전>-linux-arm64.tar.gz`, npm `postq-linux-arm64` |
| Windows x64 | windows-latest | `postq-<버전>-win32-x64.zip`, npm `postq-win32-x64` |

- 묶음 안: `postq`(윈도우는 `.exe`), `ui/`(정적 화면), `drizzle/`(마이그레이션), `LICENSE`, `README.md`.
- npm 메인 패키지 `postq` 는 런처(`bin/postq.js`)뿐이고, 위 5개를 `optionalDependencies` 로 둡니다.
  npm 이 `os`·`cpu` 를 보고 맞는 하나만 받습니다(설치 때 따로 내려받는 단계 없음).
- Homebrew formula 는 macOS·Linux 묶음 4개를 가리킵니다(윈도우 제외).

## 처음 한 번

1. **GitHub 저장소** `JPWon-1/postq` 를 만들고 이 저장소를 올립니다.
   ```bash
   git remote add origin https://github.com/JPWon-1/postq.git
   git push -u origin main
   ```
   push 하면 `ci.yml` 이 돌고, 그 안의 `install-smoke` 가 ubuntu·macos·windows 에서
   "패키지 만들기 → `npm install -g` → `postq --version` → 띄워서 `/api/health`·`/` 200 → 종료" 를 확인합니다.
   종료는 유닉스에서 SIGINT(런처 종료 코드 0 확인), 윈도우에서 **실제 콘솔 Ctrl+C·Ctrl+Break**
   (`scripts/win-ctrl-smoke.ps1` — 새 콘솔로 띄운 뒤 `GenerateConsoleCtrlEvent`)를 보내 런처가 0 으로 끝나는지 봅니다.
   **윈도우에서 실제로 도는지는 여기서만 확인됩니다.** 이 스크립트는 아직 윈도우에서 돌려 보지 않았습니다 —
   첫 CI 실행에서 초록불인지 꼭 봅니다(빨간불이면 로그의 `launcher exit code` 와 `----- log -----` 를 봅니다).
2. **npm 인증** — 둘 중 하나. `postq`·`postq-darwin-arm64` 등 6개 이름이 모두 비어 있어야 합니다
   (`npm view <이름>` 이 404). 첫 배포 전까지 플랫폼 이름 5개는 남이 먼저 가져갈 수 있으니, 오래 미루지 않습니다.
   - **권장: Trusted Publishing(OIDC).** npmjs.com 의 각 패키지 Settings → Trusted Publisher 에서 GitHub Actions,
     저장소 `JPWon-1/postq`, 워크플로 `release.yml` 을 등록합니다(6개 패키지 모두). 그러면 비밀값 없이
     `id-token: write` 권한으로 배포되고 provenance 가 붙습니다. npm CLI 11.5.1 이상이 필요해 워크플로가 먼저 npm 을 올립니다.
     Trusted Publisher 는 이미 있는 패키지에만 걸 수 있으므로 **첫 배포(이름 만들기)는 아래 토큰으로** 하고,
     6개를 모두 등록한 뒤 `NPM_TOKEN` 을 지우고 토큰도 폐기합니다. 패키지 Settings 의 Publishing access 를
     "Require two-factor authentication and disallow tokens" 로 두면 토큰 경로가 막혀 더 안전합니다.
   - **토큰:** npmjs.com 에서 Granular Access Token 을 만듭니다 — Packages and scopes 는 Read and write,
     **"Bypass two-factor authentication (2FA)" 를 켭니다**(켜지 않으면 계정에 2FA 가 있을 때 CI 의 publish 가
     OTP 를 요구하며 `EOTP` 로 실패합니다). 첫 배포 땐 아직 패키지가 없으니 범위를 "All packages" 로 둡니다.
     저장소 Settings → Secrets and variables → Actions 에 `NPM_TOKEN` 으로 넣습니다. 토큰은 만료가 있으니 날짜를 적어 둡니다.
   - `NPM_TOKEN` 이 있으면 토큰으로, 없으면 OIDC 로 시도합니다. 둘 다 준비 안 됐으면 npm 단계가 실패합니다 —
     npm 배포를 일부러 건너뛰려면 저장소 Variables 에 `NPM_PUBLISH` = `false` 를 둡니다.
3. **Homebrew 탭** — 빈 저장소 `JPWon-1/homebrew-tap` 을 만듭니다(이름이 `homebrew-` 로 시작해야
   `JPWon-1/tap` 으로 불립니다). 그 저장소에만 Contents: Read and write 권한이 있는 fine-grained 토큰을 만들어
   이 저장소 Secrets 에 `HOMEBREW_TAP_TOKEN` 으로 넣습니다.

토큰이 없으면 해당 단계는 건너뜁니다 — npm 은 배포하지 않고, Homebrew 는 만든 formula 를 로그에 찍기만 합니다
(그 내용을 탭 저장소의 `Formula/postq.rb` 로 직접 올리면 됩니다).

## 릴리스마다

1. `npm run version:bump -- 0.1.1`처럼 새 버전을 지정하고 `npm run version:check`를 실행합니다. npm·Rust·Tauri·MCP·Homebrew 견본과 lockfile이 함께 바뀝니다. 전체 목록과 호환 규칙은 [버전 가이드](VERSIONING.md)에 있습니다. `CHANGELOG.md`도 갱신합니다.
   - **첫 릴리스(v0.1.0)만:** README.md·README.ko.md 의 '아직 배포 전입니다 / Not published yet' 안내 블록을 지우고,
     지원 OS 표의 'CI 에서 확인 예정' 을 실제 CI 결과로 바꿉니다. npm 페이지 README 는 이 파일을 그대로 복사합니다.
2. 커밋하고 태그를 푸시합니다.
   ```bash
   git add -A
   git commit -m "chore: release v0.1.1" -m "Co-Authored-By: Codex <noreply@openai.com>"
   git tag v0.1.1
   git push origin main v0.1.1
   ```
3. Actions 의 **Release** 실행을 봅니다: `ui` → `build`(5개) → `release` → `npm`·`homebrew`.
   - `release`: GitHub Release 가 없으면 만들고, 이미 있으면(다시 돌린 경우) 묶음만 `gh release upload --clobber` 로 바꿉니다.
     프리릴리스는 `--prerelease` 로, 현재 Latest 보다 낮은 버전은 `--latest=false` 로 만들어 Latest 표시를 되돌리지 않습니다.
   - `npm`: 묶음 → tgz(`scripts/npm-release.mjs pack`, 실행 비트 확인) → 레지스트리 확인(`verify`) →
     linux x64 tgz 를 실제로 설치해 `postq --version` → 플랫폼 패키지 5개를 먼저, 메인 패키지를 마지막에 publish.
   - 버전이 현재 npm `latest` 보다 낮으면(옛 태그를 뒤늦게 돌린 경우) `--tag previous` 로 올려 latest 를 되돌리지 않습니다.
     프리릴리스(`1.2.0-beta.1`)는 `--tag next` 이고 Homebrew 탭은 건드리지 않습니다. 탭도 이미 더 높은 버전이면 갱신하지 않습니다.
   - 릴리스는 버전과 상관없이 한 번에 하나만 돕니다(concurrency `release`). 대기 중일 때 또 태그가 들어오면
     GitHub 가 대기 중이던 실행을 취소합니다 — 그 태그는 Actions 에서 다시 돌립니다.

   **실패한 뒤 다시 돌리기(Re-run failed jobs):** 같은 실행 안에서 다시 돌리면 빌드 산출물이 그대로라 tgz 도 같은 바이트가 나오고
   (npm pack 은 같은 내용이면 같은 shasum), 이미 올라간 패키지는 내용이 같음을 확인하고 건너뜁니다. Release 도 자산만 다시 올립니다.
   **태그를 지웠다 다시 붙이거나 새 실행으로 돌리면** 실행 파일이 새로 빌드돼 바이트가 달라질 수 있고, 그 경우 이미 올라간 패키지와
   달라 `verify` 가 멈춥니다(npm 은 같은 버전을 다시 올릴 수 없습니다). 그때는 버전을 올려 새 태그를 붙입니다.

## 이름 선점 주의

첫 publish 전에는 `postq-darwin-arm64` 같은 플랫폼 패키지 이름이 비어 있습니다. 남이 먼저 같은 이름을 올리면
`npm install -g postq` 가 그 패키지를 받아 올 수 있습니다. 저장소를 공개하기 전후로 빨리 첫 릴리스를 내거나,
`npm view postq-darwin-arm64` 등으로 이름이 아직 비어 있는지 확인한 뒤 태그를 붙입니다.
워크플로는 같은 이름·버전이 이미 있으면 그 `dist.shasum`·`dist.integrity` 가 이번에 만든 tgz 와 같은지 보고, 다르면 publish 전에
멈춥니다(`npm-release.mjs verify`). 이름만 먼저 가져가고 다른 버전을 올려 둔 경우는 막지 못하니 — 우리 publish 가
권한 오류(E403)로 실패합니다 — `npm view <이름> maintainers` 로 주인을 확인합니다.

## 확인

```bash
npm view postq version                 # 새 버전
npm install -g postq && postq --version
brew update && brew install JPWon-1/tap/postq && postq --version
postq                                  # 브라우저가 http://127.0.0.1:39200 으로 열린다
```

GitHub Release 페이지에 묶음 5개와 `SHA256SUMS.txt` 가 있어야 합니다.

## 로컬에서 미리 만들어 보기

```bash
npm run build                                             # 화면 → out/
(cd server && cargo build --release --bin postq)     # 이 컴퓨터용 실행 파일
node scripts/package-release.mjs --main --out dist        # dist/ 에 묶음 + npm 패키지 디렉터리
node scripts/npm-release.mjs pack --npm-dir dist/npm --out dist/tgz   # tgz + 실행 비트 검사
node scripts/npm-release.mjs verify --packs dist/tgz/packs.json        # 레지스트리와 비교(읽기만)
npm install -g --prefix /tmp/pq-prefix ./dist/tgz/*.tgz   # 전역을 더럽히지 않게 prefix 로. './' 가 없으면 GitHub 줄임말로 읽는다
/tmp/pq-prefix/bin/postq --no-open
node scripts/update-formula.mjs --dist dist --url-base file://$PWD/dist --allow-missing --out /tmp/postq.rb
```

`dist/` 와 `*.tgz` 는 커밋하지 않습니다(.gitignore).
`packaging/homebrew/postq.rb` 는 형식을 보여 주는 견본이고(sha256 이 0), 실제 formula 는 릴리스 때 만듭니다.

## 실행 파일이 쓰는 규칙(요약)

- 바인딩 `127.0.0.1`(`POSTQ_HOST` 로 바꿀 수 있으나 로그인이 없으니 루프백 밖에 열지 않습니다).
- 포트: `--port` 를 주면 그 포트만, 아니면 39200~39299 중 첫 빈 포트.
- 데이터: `--data-dir`, 기본은 OS 사용자 데이터 폴더의 `postq/`(`postq.db`, `secret.key`).
- `SECRET_ENCRYPTION_KEY` 가 없으면 `secret.key` 를 읽고, 없으면 만듭니다(유닉스 권한 0600).
- 유닉스에서 데이터 폴더는 0700, 키 파일은 0600 으로 맞춥니다 — 이미 있던 것도 그룹·다른 사용자 권한이 열려 있으면
  (내 소유일 때) 닫고 알립니다. 남의 소유이거나 못 바꾸면 경고만 하고 계속 돕니다.
- 화면·마이그레이션: `POSTQ_STATIC_DIR`·`MIGRATIONS_DIR` → 실행 파일 옆 `ui/`·`drizzle/` →
  `<실행 파일>/../share/postq/`(Homebrew).
- `PORT`·`DB_PATH` 는 읽지 않습니다(도커·개발용 `postq-server` 만 읽습니다).
