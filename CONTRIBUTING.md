# Contributing to postq

Thanks for helping out. Issues and pull requests are welcome — for larger changes, open an issue first so we can
agree on the direction. (한국어로 써도 괜찮습니다.)

## Setup

Node.js 22.13+ and a stable Rust toolchain.

```bash
npm ci
npm run dev        # Rust API (127.0.0.1:3001) + Next dev UI (127.0.0.1:3000)
```

## Before opening a pull request

Run what CI runs:

```bash
npx tsc --noEmit
npx vitest run
npm run build
(cd server && cargo test)
```

If you touched the desktop shell, also run `(cd src-tauri && cargo check)`.

Browser end-to-end tests use Playwright and need the static UI and the release server:

```bash
npm run build && (cd server && cargo build --release)
npm run e2e:safe                  # all specs
npm run e2e:safe -- -g "schedule" # a subset (extra args go to playwright)
```

`e2e:safe` copies the database (or starts from an empty one), seeds test data, starts its helper servers and checks
afterwards that the source database was not modified. **Do not run `npm run e2e` directly** — it attaches to whatever
`E2E_BASE_URL` points at, and the tests create, edit and delete data there.

## Guidelines

- Keep the default bind address `127.0.0.1`. The app has no login; anything that widens exposure needs a clear reason.
- Never log or return secret variable values. Tests use obviously fake values (`REAL`, `test-key`, `sekret`, …).
- Schema changes go in `src/db/schema.ts`, then `npx drizzle-kit generate` to add a migration under `drizzle/`.
- The UI text is Korean; keep new UI strings consistent with the surrounding screens.
- Add or update tests with your change (Rust unit tests in `server/`, vitest next to the TS module, Playwright specs in
  `e2e/`).

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
