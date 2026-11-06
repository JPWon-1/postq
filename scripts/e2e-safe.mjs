/**
 * E2E 를 실데이터에 손대지 않고 돌린다.
 *
 * 왜 필요한가
 *   e2e/core-flows.spec.ts 의 afterAll 은 서버에 DELETE 를 날린다(e2e-* 접두사만 지우지만,
 *   어쨌든 진짜 DELETE 다). 게다가 테스트 본문이 요청을 만들고 고치고 실행한다.
 *   그래서 "E2E 를 돌리면 데이터가 위험하다" → "안 돌린다" → "테스트가 낡는다" 가 됐고,
 *   실제로 166개 중 49개가 화면과 어긋난 채 몇 달을 방치돼 회귀를 못 잡았다.
 *
 *   이 스크립트는 그 고리를 끊는다. 실 DB 의 일관 사본을 떠서 그 사본에만 서버를 물리고,
 *   끝나고 원본 지문을 다시 재서 한 글자도 안 바뀐 것을 증명한다.
 *
 * 쓰는 법
 *   node scripts/e2e-safe.mjs                    # 전부
 *   node scripts/e2e-safe.mjs -g "스케줄"          # 뒤의 인자는 playwright 에 그대로 넘어간다
 *   node scripts/e2e-safe.mjs --db data/postq.db
 *   node scripts/e2e-safe.mjs --keep             # 사본·로그를 남겨 두고 본다
 *
 *   서버는 Rust(server/target/release/postq-server) 하나가 API + 정적 화면(out/)을 다 낸다 —
 *   앱·도커가 실제로 싣는 구성이다. 먼저 npm run build 와 (cd server && cargo build --release).
 *
 * 하는 일
 *   1. 원본 지문(sha256)을 잰다
 *   2. VACUUM INTO 로 일관 사본을 뜬다 — 라이브 WAL 을 파일 복사하면 시점이 어긋난다
 *      (scripts/backup.sh 가 같은 이유로 같은 방법을 쓴다)
 *   3. 헬퍼 서버(echo/목스펙/ws-echo)가 없으면 띄운다
 *   4. 빈 포트에 프로덕션 런타임을 사본에 물려 띄운다 (서버가 마이그레이션)
 *   5. 사본 확인 후 테스트 전제를 심는다 (호스트 별칭, 기본 트리, 실행 환경 e2e-echo)
 *   6. playwright 를 돌린다
 *   7. 원본 지문을 다시 재서 대조한다 — 다르면 크게 경고한다
 *   8. 서버를 내리고 사본을 지운다
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync as Database } from 'node:sqlite'
import { contentHash, copyDatabase } from './e2e-db.mjs'

const ROOT = resolve(import.meta.dirname, '..')

// --- 인자 --------------------------------------------------------------
const argv = process.argv.slice(2)
const take = (flag) => {
  const i = argv.indexOf(flag)
  if (i < 0) return null
  const v = argv[i + 1]
  argv.splice(i, v && !v.startsWith('-') ? 2 : 1)
  return v ?? true
}
const keep = !!take('--keep')
// 병렬 작업 사본(worktree)에서 빌드한 서버를 쓸 때는 E2E_RUST_BIN 으로 그 실행 파일을 가리킨다.
const RUST_BIN = process.env.E2E_RUST_BIN || join(ROOT, 'server/target/release/postq-server')
// 원본 DB 가 없으면(새로 받은 v2 저장소 — data/ 가 없다) 빈 DB 에서 시작한다. 테스트 전제는 seed() 가 심는다.
// 주의: 다른 저장소·다른 설치본의 실데이터 DB 를 --db 로 넘기지 않는다 — 사본만 쓰지만 그 데이터로 테스트가 돈다.
const sourceDb = resolve(ROOT, take('--db') || process.env.DB_PATH || 'data/dev-snapshot.db')
const fromEmpty = !existsSync(sourceDb)
const playwrightArgs = argv   // 남은 건 전부 playwright 몫

// 서버가 내줄 화면 — npm run build 의 결과. 앱·도커가 싣는 것과 같은 파일이다.
const STATIC_DIR = process.env.E2E_STATIC_DIR || join(ROOT, 'out')

// 헬퍼 서버 — playwright.config.ts 주석과 같은 목록. 없으면 실행이 필요한 테스트가 통째로 깨진다.
const HELPERS = [
  { port: freePort(39400), key: 'E2E_ECHO_PORT', script: 'e2e/echo-server.mjs', label: 'echo' },
  { port: freePort(39500), key: 'E2E_SPEC_PORT', script: 'e2e/mock-spec-server.mjs', label: '목 스펙' },
  { port: freePort(39600), key: 'E2E_WS_PORT', script: 'e2e/ws-echo-server.mjs', label: 'ws-echo' },
]

const log = (...a) => console.log(...a)

/**
 * 멈춘다 — 단, 띄워 둔 것을 두고 가지 않는다.
 *
 * 처음엔 여기서 바로 process.exit(1) 했는데, 그러면 finally 가 안 돌아 서버와 사본이
 * 그대로 남는다. 다음 실행이 '빈 포트' 를 찾다 그 유령 서버에 붙을 수도 있다.
 * throw 로 바꿔 finally 의 정리를 반드시 거치게 한다.
 */
class Abort extends Error {}
const die = (msg) => { throw new Abort(msg) }

// --- 준비물 확인 -------------------------------------------------------
if (!existsSync(join(STATIC_DIR, 'index.html'))) die(`정적 화면이 없습니다: ${STATIC_DIR}\n  먼저: npm run build`)
if (!existsSync(RUST_BIN)) die(`Rust 서버가 빌드돼 있지 않습니다 — (cd server && cargo build --release)`)

/** 이 파일을 지금 열고 있는 다른 프로세스 — 있으면 실행 중 원본이 바뀌어도 우리 탓이 아닐 수 있다. */
function otherWriters(file) {
  const out = spawnSync('lsof', ['-t', file, `${file}-wal`], { encoding: 'utf8' }).stdout.trim()
  return [...new Set(out.split('\n').filter(Boolean))].filter(p => Number(p) !== process.pid)
}

function portBusy(port) {
  return !!spawnSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' }).stdout.trim()
}

/**
 * 비어 있는 TCP 포트 하나.
 *
 * 앱(:39100)·도커(:3000)와 멀찍이 떨어진 대역을 쓴다 — 실수로 진짜 서버에 테스트를
 * 붙이는 일이 없게. 고정 포트를 쓰면 앞 실행이 덜 죽었을 때 그 서버에 붙어 버린다.
 */
function freePort(from = 39300) {
  for (let p = from; p < from + 60; p++) if (!portBusy(p)) return p
  throw new Error('빈 포트를 못 찾았습니다')
}

async function waitHealthy(url, seconds = 40) {
  for (let i = 0; i < seconds * 2; i++) {
    try {
      const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) })
      if (r.ok) return await r.json()
    } catch { /* 아직 안 떴다 */ }
    await new Promise(r => setTimeout(r, 500))
  }
  return null
}

/**
 * 사본에만 테스트 전제를 심는다. 이 함수는 원본을 열지 않는다.
 *
 * 왜 심어야 하나: 테스트는 '도커로 띄웠을 때' 를 전제로 쓰였다. 그 환경의 DB 에는
 * baseUrl 이 host.docker.internal 로 들어 있다.
 * 호스트에서 돌리면 그 이름이 안 풀려(ENOTFOUND) 실행 테스트가 무더기로 깨지는데,
 * 화면상으로는 코드가 망가진 것처럼 보인다 — 실제로 그렇게 한참 헤맸다.
 */
function seed(dbPath) {
  const db = new Database(dbPath)
  const done = []
  try {
    // ① 호스트 별칭 — 앱이 호스트의 헬퍼 서버를 부를 수 있게
    const r = db.prepare(
      "update variables set value = replace(value, 'host.docker.internal', 'localhost') where value like '%host.docker.internal%'"
    ).run()
    if (r.changes) done.push(`host.docker.internal → localhost (${r.changes}개 변수)`)

    // ⓪ 기본 트리 — 테스트가 이름으로 찾는 폴더·요청. 실데이터에 기대지 않고 여기서 심는다(빈 DB 에서도 돈다).
    //    이미 같은 이름이 있으면 건드리지 않는다.
    db.prepare("insert or ignore into workspaces (id, name) values ('default', '기본')").run()
    const now = Date.now()
    const folder = db.prepare(`insert or ignore into folders (id, workspace_id, name, sort_order, shared_headers)
      select ?, 'default', ?, ?, ? where not exists (select 1 from folders where workspace_id = 'default' and name = ?)`)
    folder.run('e2e-folder-manual', '수동 테스트', 1024, JSON.stringify([{ key: 'X-Team', value: 'e2e', enabled: true }]), '수동 테스트')
    folder.run('e2e-folder-sample', 'Sample API', 2048, '[]', 'Sample API')
    const manualId = db.prepare("select id from folders where workspace_id = 'default' and name = '수동 테스트' order by sort_order limit 1").get().id
    const req = db.prepare(`insert or ignore into requests (id, folder_id, name, method, url, body_type, body, sort_order, updated_at)
      select ?, ?, ?, 'POST', ?, 'json', ?, ?, ? where not exists (select 1 from requests where folder_id = ? and name = ?)`)
    req.run('e2e-req-issue', manualId, '펫 등록', '{{baseUrl}}/pets/register', '{"name":"{{petName}}"}', 1024, now, manualId, '펫 등록')
    req.run('e2e-req-bulk', manualId, '펫 일괄 등록', '{{baseUrl}}/pets/bulk-register', '{"quantity":1}', 2048, now, manualId, '펫 일괄 등록')
    // 여러 요청을 한꺼번에 고르는 테스트(일괄 삭제 토스트)가 6개 이상을 고른다.
    const sampleId = db.prepare("select id from folders where workspace_id = 'default' and name = 'Sample API' order by sort_order limit 1").get().id
    ;[['e2e-req-s1', '주문 조회', 'GET', '{{baseUrl}}/orders/1'], ['e2e-req-s2', '주문 목록', 'GET', '{{baseUrl}}/orders'],
      ['e2e-req-s3', '회원 조회', 'GET', '{{baseUrl}}/users/1'], ['e2e-req-s4', '상품 조회', 'GET', '{{baseUrl}}/products/1']]
      .forEach(([id, name, method, url], i) => db.prepare(`insert or ignore into requests (id, folder_id, name, method, url, sort_order, updated_at)
        select ?, ?, ?, ?, ?, ?, ? where not exists (select 1 from requests where folder_id = ? and name = ?)`).run(id, sampleId, name, method, url, (i + 1) * 1024, now, sampleId, name))
    // 값 흐름 미리보기 테스트가 '스텝이 있는 시나리오' 를 고른다 — 앞 단계가 뽑은 값을 다음 단계가 받는다.
    const issueId = db.prepare("select id from requests where folder_id = ? and name = '펫 등록'").get(manualId).id
    const bulkId = db.prepare("select id from requests where folder_id = ? and name = '펫 일괄 등록'").get(manualId).id
    db.prepare(`insert or ignore into flows (id, workspace_id, name, steps, shared_vars, updated_at)
      select 'e2e-flow-sample', 'default', '등록 후 일괄 등록', ?, '[{"key":"petName","value":"Momo"}]', ? where not exists (select 1 from flows where id = 'e2e-flow-sample')`).run(JSON.stringify([
      { requestId: issueId, extracts: [{ path: 'success', variable: 'registered' }] },
      { requestId: bulkId, extracts: [], bodySource: 'custom', bodyOverride: '{"registered":"{{registered}}"}' },
    ]), now)
    done.push("기본 트리 ('수동 테스트' 요청 2개, 'Sample API' 요청 4개, 시나리오 1개)")

    // ③ 실행 테스트용 환경 — baseUrl 이 echo 서버(:9999)를 가리킨다.
    //    예전엔 실데이터의 '도커' 환경을 그대로 빌려 썼다. 그 환경이 지워지자 실행 테스트 10개가
    //    한꺼번에 깨졌는데, 코드는 멀쩡했다. 테스트의 전제는 테스트가 심는다.
    const envId = 'e2e-echo-env'
    //    테스트는 이름으로 고르므로 같은 이름이 둘이면 엉뚱한 쪽을 잡는다 — 같은 이름·같은 ID 를 먼저 걷어낸다.
    const stale = db.prepare("select id from environments where id = ? or (workspace_id = 'default' and name = 'e2e-echo')").all(envId)
    for (const { id } of stale) {
      db.prepare('delete from variables where environment_id = ?').run(id)
      db.prepare('delete from environments where id = ?').run(id)
    }
    db.prepare("delete from variables where id = 'e2e-echo-baseurl'").run()
    db.prepare(`insert into environments (id, name, workspace_id, updated_at, execution_policy)
      values (?, 'e2e-echo', 'default', ?, 'open')`).run(envId, Date.now())
    db.prepare(`insert into variables (id, environment_id, key, value, secret)
      values ('e2e-echo-baseurl', ?, 'baseUrl', 'http://localhost:${HELPERS[0].port}', 0)`).run(envId)
    done.push("실행 환경 'e2e-echo' (baseUrl → echo :9999)")

    // ④ '스테이지' 환경 — 환경 화면 테스트가 이름으로 고른다. 없을 때만 만든다.
    if (!db.prepare("select 1 from environments where workspace_id = 'default' and name = '스테이지'").get()) {
      db.prepare(`insert into environments (id, name, workspace_id, updated_at, execution_policy)
        values ('e2e-stage-env', '스테이지', 'default', ?, 'open')`).run(Date.now())
      db.prepare(`insert or replace into variables (id, environment_id, key, value, secret)
        values ('e2e-stage-baseurl', 'e2e-stage-env', 'baseUrl', 'http://localhost:${HELPERS[0].port}', 0)`).run()
      done.push("환경 '스테이지'")
    }
  } finally { db.close() }
  return done
}

// --- 본문 --------------------------------------------------------------
const children = []
let copyDir = null
let failed = false

function cleanup() {
  for (const c of children) { try { process.kill(-c.pid, 'SIGTERM') } catch { /* 이미 죽음 */ } }
  if (copyDir && !keep) { try { rmSync(copyDir, { recursive: true, force: true }) } catch { /* 무시 */ } }
}
process.on('SIGINT', () => { cleanup(); process.exit(130) })
process.on('SIGTERM', () => { cleanup(); process.exit(143) })

try {
  log(fromEmpty ? `원본  없음 — 빈 DB 에서 시작 (${sourceDb.replace(ROOT + '/', '')})` : `원본  ${sourceDb.replace(ROOT + '/', '')}`)
  const before = fromEmpty ? null : contentHash(sourceDb)
  if (before) log(`지문  ${before.slice(0, 16)} (내용 기준 — WAL 포함)`)
  const writers = fromEmpty ? [] : otherWriters(sourceDb)
  if (writers.length) {
    log(`      주의: 원본을 다른 프로세스가 열고 있다(pid ${writers.join(', ')}) — 데스크톱 앱일 가능성이 크다.`)
    log('      그 앱을 쓰면 원본이 바뀌어 끝의 대조가 어긋날 수 있다. 그건 이 스크립트 탓이 아니다.')
  }
  log('')

  // 1. 일관 사본
  copyDir = join(tmpdir(), `postq-e2e-${process.pid}`)
  mkdirSync(copyDir, { recursive: true })
  const copy = join(copyDir, 'e2e.db')
  if (!fromEmpty) {
    copyDatabase(sourceDb, copy)
  }
  log(`사본  ${copy}`)

  // 3. 헬퍼 서버
  log('')
  for (const h of HELPERS) {
    if (portBusy(h.port)) die(`검증용 포트를 다른 프로세스가 사용 중입니다: ${h.port}`)
    const c = spawn(process.execPath, [join(ROOT, h.script)], {
      cwd: ROOT, detached: true, stdio: 'ignore', env: { ...process.env, PORT: String(h.port) },
    })
    children.push(c)
    log(`헬퍼  :${h.port} ${h.label} — 띄움`)
  }
  await new Promise(r => setTimeout(r, 1200))

  // 4. 사본에 물린 서버
  const port = freePort()
  const base = `http://localhost:${port}`
  // 바깥 환경의 POSTQ_STATIC_DIR 은 물려주지 않는다 — 어느 화면을 재는지가 흐려진다.
  // 배경 작업은 끈다 — 사본에도 스케줄·수집 연결이 그대로 있어, 켜면 원래 서버와 같은 외부 호출을
  // 한 번 더 한다(대상 API 에 요청이 두 번, 알림이 두 번).
  const { POSTQ_STATIC_DIR: _s, ...inherited } = process.env
  const r = spawn(RUST_BIN, [], {
    cwd: ROOT, detached: true,
    stdio: keep ? ['ignore', 'pipe', 'pipe'] : 'ignore',
    env: { ...inherited, PORT: String(port), POSTQ_HOST: '127.0.0.1', DB_PATH: copy, POSTQ_NO_BACKGROUND: '1',
      MIGRATIONS_DIR: join(ROOT, 'drizzle'), POSTQ_STATIC_DIR: STATIC_DIR },
  })
  children.push(r)
  log(`Rust  :${port} — API + 정적 화면(${STATIC_DIR.replace(ROOT + '/', '')})`)

  const health = await waitHealthy(base)
  if (!health) die(`서버가 안 떴습니다 (${base})`)
  if (health.db !== 'e2e.db') {
    // 사본이 아닌 곳을 보고 있으면 즉시 멈춘다 — 이 검사가 이 스크립트의 존재 이유다.
    die(`서버가 사본이 아니라 '${health.db}' 를 보고 있습니다. 중단합니다.`)
  }
  log(`서버  ${base} — 사본(${health.db}) 확인\n`)

  // 5. 서버가 실제 배포와 같은 마이그레이션을 마친 뒤, 확인한 사본에만 테스트 전제를 심는다.
  for (const what of seed(copy)) log(`      심음 — ${what}`)

  // 6. playwright
  const pw = spawnSync('npx', ['playwright', 'test', ...playwrightArgs], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, E2E_BASE_URL: base, E2E_HOST_ALIAS: 'localhost', ...Object.fromEntries(HELPERS.map(h => [h.key, String(h.port)])) },
  })
  failed = pw.status !== 0

  // 7. 원본이 안 바뀌었는지 — 통과했든 깨졌든 무조건 확인한다(빈 DB 에서 시작했으면 원본이 없다)
  if (fromEmpty && existsSync(sourceDb)) {
    console.error(`\n✗✗ 없던 원본이 생겼습니다: ${sourceDb} — 서버가 사본이 아닌 곳을 봤을 수 있다.`)
    failed = true
  } else if (!fromEmpty) {
    const after = contentHash(sourceDb)
    log('')
    if (after === before) {
      log(`✓ 원본 그대로 (${after.slice(0, 16)}, 내용 기준)`)
    } else {
      console.error(`\n✗✗ 원본의 내용이 바뀌었습니다!\n   전: ${before}\n   후: ${after}\n` +
        (writers.length
          ? `   원본을 연 다른 프로세스(pid ${writers.join(', ')})가 있었다 — 그 앱에서 한 편집일 수 있다. 확인하세요.`
          : '   원본을 연 다른 프로세스는 없었다 — 서버가 사본이 아닌 곳을 봤을 수 있다. 백업에서 확인하세요.'))
      failed = true
    }
  }
  if (keep) log(`사본 보존: ${copyDir}`)
} catch (e) {
  console.error(e instanceof Abort ? `\n✗ ${e.message}` : e)
  failed = true
} finally {
  cleanup()
}

process.exit(failed ? 1 : 0)
