# postq contributor guide

postq is a local API client with a Rust API server, a statically exported Next.js UI, and a Tauri desktop app.

## Repository map

| Path | Purpose |
| --- | --- |
| `server/` | Rust axum API, CLI, SQLite access, migrations at startup |
| `src/` | React/Next.js UI; `src/i18n/` holds the English and Korean dictionaries |
| `src-tauri/` | Tauri desktop shell and embedded server |
| `scripts/` | Development, packaging, screenshots, safe E2E, version tools |
| `e2e/` | Playwright tests and local test servers |
| `packaging/` | Homebrew formula example |
| `docs/` | UI rules, test harness, versioning, release procedure, benchmarks |
| `drizzle/` | SQLite migrations and journal |

## Required commands

Run at the repository root unless the command changes directory. CI uses Node 22 and stable Rust. Use a scratch database for development; never point tests at a real user database.

| Task | Command |
| --- | --- |
| Install Node dependencies | `npm ci` |
| Develop (loopback UI/API) | `API_PORT=39261 PORT=39260 DB_PATH=/tmp/postq-dev-guide.db npm run dev` |
| Build static UI into `out/` | `npm run build` |
| Typecheck | `npx tsc --noEmit` |
| UI unit tests | `npx vitest run` |
| Server tests | `(cd server && env -u HOSTNAME CARGO_INCREMENTAL=0 cargo test --locked)` |
| Server release binary for E2E | `(cd server && env -u HOSTNAME CARGO_INCREMENTAL=0 cargo build --release --locked)` |
| Full safe E2E (after both builds) | `node scripts/e2e-safe.mjs` |
| i18n audit | `node scripts/check-i18n.mjs` |
| Version consistency | `npm run version:check` |
| Desktop app build on macOS | `npm run app:build -- --bundles app` |

## Rules

- Before completion, run the checks appropriate to the changed area in [the harness guide](docs/HARNESS.md). For a broad change, run typecheck, Vitest, static build, server tests and release build, then safe E2E. Use `scripts/e2e-safe.mjs`, not bare Playwright: E2E writes and deletes records in a copied database.
- Add UI text to both `src/i18n/en.ts` and `src/i18n/ko.ts`; run `node scripts/check-i18n.mjs`. Preserve dictionary key equality and check the rendered language.
- Add DB schema changes as a new migration and journal entry in `drizzle/`; never edit an already applied migration. A newer version must open an older database. Startup backs up an existing database and its key just before pending migrations. Test upgrade from a copy of an older database.
- Never commit secrets, `.env*`, databases, key files, personal or company data. Use generated local demo data for screenshots and tests.
- Follow [UI guidelines](docs/ui-guidelines.md), including icon buttons, labels, focus and layout.
- Keep release versions in sync with `npm run version:bump -- <version>` and `npm run version:check`; see [versioning](docs/VERSIONING.md).
- Use a short imperative commit subject with a scope when useful, such as `docs: explain release checks`. End the commit body with `Co-Authored-By: Codex <noreply@openai.com>` when Codex authors the change. Do not push unless asked.
