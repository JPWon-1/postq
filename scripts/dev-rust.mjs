/**
 * 개발 실행 — Rust 백엔드 + next dev(화면 핫리로드)를 함께 띄운다.
 *
 *   npm run dev                    # 화면 :3000, Rust API :3001, DB 는 data/dev-snapshot.db
 *   DB_PATH=/tmp/x.db npm run dev  # 다른 DB 로
 *   API_PORT=3101 PORT=3100 npm run dev
 *
 * 앱·도커는 Rust 서버가 정적 화면(out/)까지 내준다. 개발 중엔 화면을 고칠 때마다 정적 빌드를 다시 할 수 없으니
 * next dev 가 화면을 그리고, /api/* 만 Rust 로 넘긴다(next.config.ts 의 POSTQ_DEV_API rewrites).
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

// .env 파일 — 띄우기 전에 여기서 읽어 두 자식(Rust API·next dev)에게 같이 물려준다. 안 그러면 .env.local 의 SECRET_ENCRYPTION_KEY(비밀값)·MCP_TOKEN 같은 값이
// 조용히 빠져 비밀값이 안 풀린다. Next 의 우선순위대로 높은 것부터 읽는다 — loadEnvFile 은 이미 있는
// 이름을 덮지 않으므로, 셸에서 준 값이 가장 앞서고 그다음 .env.development.local → .env.local → .env.development → .env.
for (const f of ['.env.development.local', '.env.local', '.env.development', '.env']) {
  if (existsSync(resolve(ROOT, f))) process.loadEnvFile(resolve(ROOT, f))
}
const apiPort = process.env.API_PORT || '3001'
const uiPort = process.env.PORT || '3000'
const dbPath = process.env.DB_PATH || 'data/dev-snapshot.db'
const children = []
const stop = code => {
  for (const c of children) { try { c.kill('SIGTERM') } catch { /* 이미 끝남 */ } }
  process.exit(code)
}
process.on('SIGINT', () => stop(130))
process.on('SIGTERM', () => stop(143))

const rust = spawn('cargo', ['run', '--manifest-path', 'server/Cargo.toml', '--bin', 'postq-server'], {
  cwd: ROOT, stdio: 'inherit',
  // 화면은 next dev 가 낸다 — Rust 에 정적 폴더를 물리지 않는다(지난 빌드의 out/ 이 dev 화면을 가리지 않게).
  env: { ...process.env, PORT: apiPort, POSTQ_HOST: '127.0.0.1', DB_PATH: dbPath, MIGRATIONS_DIR: 'drizzle', POSTQ_STATIC_DIR: '' },
})
children.push(rust)
// next dev 는 기본으로 모든 주소에 열고 /api 를 Rust 로 넘긴다 — 로그인이 없는 앱이 같은 망에 그대로 열린다.
// 이 컴퓨터 안에서만 받는다(서버의 기본 바인딩과 같다).
const next = spawn(process.execPath, [resolve(ROOT, 'node_modules/next/dist/bin/next'), 'dev', '-p', uiPort, '-H', '127.0.0.1'], {
  cwd: ROOT, stdio: 'inherit',
  env: { ...process.env, POSTQ_DEV_API: `http://127.0.0.1:${apiPort}`, DB_PATH: dbPath },
})
children.push(next)
for (const c of children) c.on('exit', code => stop(code ?? 1))
