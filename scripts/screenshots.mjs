#!/usr/bin/env node
/**
 * README 스크린샷을 다시 찍는다 — docs/screenshots/*.png
 *
 *   npm run build && (cd server && cargo build --release)   # 먼저 한 번
 *   node scripts/screenshots.mjs                 # 전부 찍기
 *   node scripts/screenshots.mjs --empty --out /tmp/postq-first-launch
 *   node scripts/screenshots.mjs --only request,scenario
 *   node scripts/screenshots.mjs --lang en --out docs/screenshots/en
 *   node scripts/screenshots.mjs --lang ko --out docs/screenshots/ko
 *   node scripts/screenshots.mjs --keep          # 다 찍은 뒤 서버를 띄워 둔 채 주소만 알려 준다(Ctrl+C 로 정리)
 *
 * 하는 일
 *   1. 빈 포트(39260 부터)를 찾아 대상 서버를 띄운다 — 저장소의 e2e/echo-server.mjs(HTTP·SSE),
 *      e2e/ws-echo-server.mjs(WebSocket), 그리고 이 파일 안의 작은 Petstore 스타일 OpenAPI 문서 서버.
 *      외부 실제 서비스는 부르지 않는다.
 *   2. 임시 폴더의 빈 DB 로 release 서버(server/target/release/postq-server)를 띄운다 — 내 데이터는 건드리지 않는다.
 *   3. 데모 데이터를 API 로 넣는다(환경·폴더·요청·시나리오·스케줄·쿠키·OpenAPI 폴더, 실행 이력 몇 건).
 *   4. headless Chromium(1440x900, deviceScaleFactor 2 — README 가 레티나에서 흐리지 않게)으로 화면별로 찍는다.
 *   5. 띄운 프로세스를 내리고 임시 폴더를 지운다.
 *
 * macOS·Linux·Windows 에서 같은 명령으로 돈다(경로는 path.join, 실행 파일은 win32 에서 .exe, node 는 process.execPath).
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from '@playwright/test'

const ROOT = resolve(import.meta.dirname, '..')
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }

const OUT_DIR = resolve(ROOT, opt('--out') ?? 'docs/screenshots')
const ONLY = opt('--only')?.split(',').map(s => s.trim()).filter(Boolean)
const KEEP = flag('--keep')
const LANG = opt('--lang') ?? 'ko'
if (!['ko', 'en'].includes(LANG)) throw new Error('--lang must be ko or en')
const demoNames = {
  '로컬': 'Local', '스테이징': 'Staging', '사용자': 'Users', '주문': 'Orders',
  '사용자 목록': 'List users', '사용자 조회': 'Get user', '사용자 생성': 'Create user',
  '주문 생성': 'Create order', '주문 조회': 'Get order', '주문 취소': 'Cancel order',
  '주문 생성 후 조회': 'Create and get order',
  '반려동물 목록': 'List pets', '반려동물 등록': 'Create pet', '반려동물 조회': 'Get pet',
  '반려동물 삭제': 'Delete pet', '재고 조회': 'Get inventory', '스토어 주문 넣기': 'Place order',
  '스토어 주문 확인': 'Get order',
}
const demoName = name => LANG === 'ko' ? name : (demoNames[name] ?? name)
const EXE = process.platform === 'win32' ? '.exe' : ''
const SERVER_BIN = resolve(ROOT, process.env.POSTQ_BIN ?? join('server', 'target', 'release', `postq-server${EXE}`))
const STATIC_DIR = resolve(ROOT, process.env.POSTQ_STATIC_DIR ?? 'out')
// 다른 앱이 쓰는 포트 — 비어 있어도 고르지 않는다.
const AVOID = new Set([3000, 3001, 18765, 18767, 39100])

const log = (...a) => console.log('[screenshots]', ...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

if (!existsSync(SERVER_BIN)) throw new Error(`서버 실행 파일이 없습니다: ${SERVER_BIN}\n  먼저: (cd server && cargo build --release)`)
if (!existsSync(join(STATIC_DIR, 'index.html'))) throw new Error(`정적 화면이 없습니다: ${STATIC_DIR}\n  먼저: npm run build`)

// ── 포트 ────────────────────────────────────────────────────────────────
function portFree(port) {
  return new Promise(res => {
    const s = net.createServer()
    s.once('error', () => res(false))
    s.listen(port, '127.0.0.1', () => s.close(() => res(true)))
  })
}
async function freePorts(n, from = 39260) {
  const got = []
  for (let p = from; got.length < n && p < from + 400; p++) {
    if (!AVOID.has(p) && await portFree(p)) got.push(p)
  }
  if (got.length < n) throw new Error('빈 포트를 찾지 못했습니다')
  return got
}
async function waitHttp(url, ms = 15000) {
  const end = Date.now() + ms
  for (;;) {
    try { const r = await fetch(url); if (r.status < 500) return } catch { /* 아직 */ }
    if (Date.now() > end) throw new Error(`응답 없음: ${url}`)
    await sleep(150)
  }
}

// ── Petstore 스타일 OpenAPI 문서(이 파일 안) ─────────────────────────────
// v1 → (동기화) → v2 로 바꿔서 NEW / CHANGED / DEPRECATED 표시가 화면에 나오게 한다.
const op = (summary, tag, extra = {}) => ({ summary, tags: [tag], responses: { 200: { description: 'OK' } }, ...extra })
const specV1 = {
  openapi: '3.0.3',
  info: { title: 'Petstore', version: '1.0.0' },
  paths: {
    '/pets': { get: op(demoName('반려동물 목록'), 'pet'), post: op(demoName('반려동물 등록'), 'pet') },
    '/pets/{petId}': { get: op(demoName('반려동물 조회'), 'pet'), delete: op(demoName('반려동물 삭제'), 'pet') },
    '/store/inventory': { get: op(demoName('재고 조회'), 'store') },
  },
}
const specV2 = structuredClone(specV1)
specV2.info.version = '1.1.0'
specV2.paths['/pets'].get = op(demoName('반려동물 목록'), 'pet', {
  parameters: [{ name: 'status', in: 'query', schema: { type: 'string', enum: ['available', 'sold'] } }],
})
delete specV2.paths['/store/inventory']
specV2.paths['/store/orders'] = { post: op(demoName('스토어 주문 넣기'), 'store') }
specV2.paths['/store/orders/{orderId}'] = { get: op(demoName('스토어 주문 확인'), 'store') }
let specVersion = 1
function startSpecServer(port) {
  const srv = createServer((req, res) => {
    if (req.url?.startsWith('/openapi.json')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(specVersion === 1 ? specV1 : specV2))
      return
    }
    res.writeHead(404); res.end()
  })
  return new Promise(r => srv.listen(port, '127.0.0.1', () => r(srv)))
}

// ── 프로세스 ────────────────────────────────────────────────────────────
const children = []
function startNode(script, port) {
  const c = spawn(process.execPath, [join(ROOT, script)], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' })
  children.push(c)
  return c
}
function startServer(port, dataDir) {
  // 셸에 HOSTNAME 이 있으면 바인딩 주소로 오해할 수 있어 지운다(바인딩 변수는 POSTQ_HOST).
  const { HOSTNAME: _h, POSTQ_STATIC_DIR: _s, ...env } = process.env
  const c = spawn(SERVER_BIN, [], {
    env: {
      ...env, PORT: String(port), POSTQ_HOST: '127.0.0.1', DB_PATH: join(dataDir, 'postq.db'),
      MIGRATIONS_DIR: join(ROOT, 'drizzle'), POSTQ_STATIC_DIR: STATIC_DIR,
      // 배경 작업(스케줄러)은 켜 둔다 — 끄면 스케줄 화면에 '꺼져 있음' 안내가 뜬다.
      // 넣는 스케줄은 30분 주기이고 넣자마자 한 번 돌려 두므로, 찍는 몇 분 사이에 다시 돌지 않는다.
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  c.stderr.on('data', d => { const t = String(d).trim(); if (t) log('server:', t) })
  children.push(c)
  return c
}
function stopAll() {
  for (const c of children) { try { c.kill() } catch { /* 이미 끝남 */ } }
}

// ── 데모 데이터 ────────────────────────────────────────────────────────
async function seed(base, ports) {
  const api = async (method, path, body) => {
    const r = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await r.text()
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${text}`)
    return text ? JSON.parse(text) : null
  }
  const target = `http://127.0.0.1:${ports.echo}`

  if (LANG === 'en') await api('PUT', '/api/workspaces/default', { name: 'Default' })

  const local = await api('POST', '/api/environments', { name: demoName('로컬') })
  await api('PUT', `/api/environments/${local.id}`, { variables: [
    { key: 'baseUrl', value: target },
    { key: 'userId', value: '42' },
    { key: 'apiToken', value: 'demo-token-not-real', secret: true },
  ] })
  const staging = await api('POST', '/api/environments', { name: demoName('스테이징'), executionPolicy: 'confirm-writes' })
  await api('PUT', `/api/environments/${staging.id}`, { variables: [
    { key: 'baseUrl', value: target },
    { key: 'userId', value: '7' },
    { key: 'apiToken', value: 'demo-staging-token', secret: true },
  ] })
  await api('PUT', '/api/global-vars', { variables: [{ key: 'appVersion', value: '1.4.0' }] }).catch(() => {})

  const users = await api('POST', '/api/folders', { name: demoName('사용자') })
  const orders = await api('POST', '/api/folders', { name: demoName('주문') })
  const bearer = { type: 'bearer', token: '{{apiToken}}' }
  const json = (o) => JSON.stringify(o, null, 2)
  const req = (folder, name, method, url, more = {}) =>
    api('POST', '/api/requests', { folderId: folder.id, name, method, url, auth: bearer, ...more })

  const listUsers = await req(users, demoName('사용자 목록'), 'GET', '{{baseUrl}}/users', {
    params: [{ key: 'page', value: '1', enabled: true }, { key: 'size', value: '20', enabled: true }],
  })
  const getUser = await req(users, demoName('사용자 조회'), 'GET', '{{baseUrl}}/users/{{userId}}', {
    headers: [{ key: 'Accept', value: 'application/json', enabled: true }, { key: 'X-App-Version', value: '{{appVersion}}', enabled: true }],
    assertions: [
      { target: 'status', op: 'eq', expected: '200' },
      { target: 'jsonPath', path: 'success', op: 'eq', expected: 'true' },
      { target: 'responseTime', op: 'lt', expected: '500' },
    ],
    description: LANG === 'ko' ? '사용자 한 명을 id 로 조회합니다.' : 'Get a user by ID.',
  })
  const createUser = await req(users, demoName('사용자 생성'), 'POST', '{{baseUrl}}/users', {
    bodyType: 'json', body: json({ name: 'Alex Kim', email: 'alex@example.com', role: 'member' }),
  })
  const createOrder = await req(orders, demoName('주문 생성'), 'POST', '{{baseUrl}}/orders', {
    bodyType: 'json',
    body: json({ userId: '{{userId}}', items: [{ sku: 'BOOK-001', qty: 2 }, { sku: 'PEN-010', qty: 1 }], requestId: '{{$uuid}}' }),
    // echo 서버가 받은 헤더를 되돌려주므로, 시나리오가 응답의 headers.x-order-id 를 뽑아 다음 단계에 넘긴다.
    headers: [{ key: 'Idempotency-Key', value: '{{$uuid}}', enabled: true }, { key: 'X-Order-Id', value: '1001', enabled: true }],
    assertions: [{ target: 'status', op: 'eq', expected: '200' }],
  })
  const getOrder = await req(orders, demoName('주문 조회'), 'GET', '{{baseUrl}}/orders/{{orderId}}', {
    assertions: [{ target: 'status', op: 'eq', expected: '200' }],
  })
  await req(orders, demoName('주문 취소'), 'DELETE', '{{baseUrl}}/orders/1001')

  // 실행 이력 — 화면의 [실행]과 같은 API 로 몇 건 남긴다.
  const run = (r, overrides = {}) => api('POST', `/api/requests/${r.id}/execute`, {
    environmentId: local.id,
    input: { method: r.method, url: r.url, params: r.params, headers: r.headers, bodyType: r.bodyType, body: r.body, ...overrides },
  })
  await run(listUsers)
  await run(getUser)
  await run(createUser)
  await run(getUser, { url: '{{baseUrl}}/users/7' })
  await run(createOrder)
  await run(getUser)
  // 닿지 않는 주소 한 건 — 이력 화면의 '실패' 표시가 보이게(포트 9 는 discard, 보통 닫혀 있다).
  await run(listUsers, { url: 'http://127.0.0.1:9/users' })

  // 시나리오: 주문 생성 → 응답의 path 를 뽑아 → 주문 조회에 넘긴다.
  const flow = await api('POST', '/api/flows', {
    name: demoName('주문 생성 후 조회'),
    steps: [
      { requestId: createOrder.id, extracts: [{ path: 'headers.x-order-id', variable: 'orderId' }] },
      { requestId: getOrder.id, extracts: [] },
      { requestId: getUser.id, extracts: [] },
    ],
  })
  const schedule = await api('POST', '/api/schedules', {
    flowId: flow.id, environmentId: local.id, intervalMinutes: 30, notifyOn: 'failure', enabled: true,
  })
  await api('POST', `/api/schedules/${schedule.id}`)   // 지금 실행 한 번 — 결과 칸이 비지 않게
  await api('POST', '/api/schedules', { flowId: flow.id, environmentId: staging.id, intervalMinutes: 1440, enabled: false })

  await api('POST', '/api/cookies', { domain: 'api.example.com', cookieString: 'session_id=3f9c2a7e; theme=light; locale=ko-KR' })
  await api('POST', '/api/cookies', { domain: 'shop.example.com', cookieString: 'cart_id=c-20931; currency=KRW' })

  const pet = await api('POST', '/api/folders', {
    name: 'Petstore', specSourceType: 'url', specSourceUrl: `http://127.0.0.1:${ports.spec}/openapi.json`,
  })
  await api('POST', `/api/folders/${pet.id}/sync`)
  // 두 번째 동기화(v2)는 'openapi' 화면에서 [스펙 동기화] 버튼으로 한다 — 결과 알림과 NEW/CHANGED/DEPRECATED 표시를 같이 찍는다.

  return { local, staging, users, orders, pet, flow, schedule, listUsers, getUser, createUser, createOrder, getOrder }
}

// ── 찍기 ───────────────────────────────────────────────────────────────
async function main() {
  const [appPort, echoPort, wsPort, specPort] = await freePorts(4)
  const ports = { app: appPort, echo: echoPort, ws: wsPort, spec: specPort }
  const dataDir = mkdtempSync(join(tmpdir(), 'postq-shots-'))
  const base = `http://127.0.0.1:${appPort}`
  let specSrv
  try {
    startNode(join('e2e', 'echo-server.mjs'), echoPort)
    startNode(join('e2e', 'ws-echo-server.mjs'), wsPort)
    specSrv = await startSpecServer(specPort)
    startServer(appPort, dataDir)
    await waitHttp(`http://127.0.0.1:${echoPort}/`)
    await waitHttp(`${base}/api/health`)
    log(`서버 ${base} · echo :${echoPort} · ws :${wsPort} · spec :${specPort}`)
    const demo = flag('--empty') ? {} : await seed(base, ports)
    log(flag('--empty') ? '빈 데이터 첫 실행' : '데모 데이터 넣음')

    if (KEEP && flag('--no-shots')) {
      log('--keep: Ctrl+C 로 정리합니다', JSON.stringify({ base, ports, demo: Object.fromEntries(Object.entries(demo).map(([k, v]) => [k, v?.id ?? v])) }))
      await new Promise(r => process.once('SIGINT', r))
      return
    }

    mkdirSync(OUT_DIR, { recursive: true })
    if (flag('--audit')) {
      const { audit } = await import('./ui-audit.mjs')
      await audit({ base, ports, demo, out: OUT_DIR, setSpecVersion: v => { specVersion = v } })
      return
    }
    const browser = await chromium.launch({ headless: true })
    try {
      const shots = flag('--empty') ? [{ name: 'first-launch', theme: 'dark', run: async page => {
        await page.goto(base + '/')
        await page.getByTestId('start-guide').waitFor()
        await page.getByTestId('rail-settings').waitFor()
        await page.getByText(LANG === 'ko' ? '연결됨' : 'Connected', { exact: false }).first().waitFor()
        if (await page.locator('#nickname-input').count()) throw new Error('이름 입력 화면이 남아 있습니다')
      } }] : buildShots(base, ports, demo)
      for (const s of shots) {
        if (ONLY && !ONLY.includes(s.name)) continue
        const ctx = await browser.newContext({
          viewport: s.viewport ?? { width: Number(opt('--width') ?? 1440), height: Number(opt('--height') ?? 900) }, deviceScaleFactor: s.scale ?? Number(opt('--scale') ?? 2), colorScheme: s.theme ?? 'light', locale: LANG === 'ko' ? 'ko-KR' : 'en-US',
        })
        // 테마·패널 크기는 localStorage 로 미리 정한다.
        await ctx.addInitScript(({ theme, sidebar, response, lang }) => {
          localStorage.setItem('postq:language', lang)
          localStorage.setItem('ah:workspace', 'default')
          localStorage.setItem('theme', theme)
          localStorage.setItem('ah:sidebarWidth', String(sidebar))
          if (response) localStorage.setItem('ah:responseHeight', String(response))
        }, { theme: s.theme ?? 'light', sidebar: s.sidebar ?? 300, response: s.response ?? 0, lang: LANG })
        const page = await ctx.newPage()
        const pageErrors = []
        page.on('pageerror', error => pageErrors.push(error.message))
        try {
          await page.addStyleTag({ content: '*, *::before, *::after { caret-color: transparent !important; }' })
          await s.run(page)
          await page.waitForTimeout(500)
          // 오류 알림(✗)이 떠 있으면 실패로 본다 — 깨진 화면을 README 에 넣지 않는다.
          const toasts = await page.locator('[role="status"]').allInnerTexts().catch(() => [])
          const bad = toasts.filter(t => t.includes('✗'))
          if (bad.length) throw new Error(`오류 알림이 떠 있음: ${bad.join(' | ')}`)
          // 아직 로딩 중이면 기다린다(스켈레톤·'불러오는 중').
          await page.getByText(/불러오는 중/).first().waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
          if (pageErrors.length) throw new Error(`화면 오류: ${pageErrors.join(' | ')}`)
          if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('화면이 가로로 넘칩니다')
          if (await page.locator('img[src*="postq-mark"], img[src*="postq-icon"]').count()) throw new Error('앱 화면에 쿼카 이미지가 남아 있습니다')
          await page.locator('header').getByText('postq', { exact: true }).waitFor()
          const file = join(OUT_DIR, `${s.name}.png`)
          await page.screenshot({ path: file, clip: s.clip })
          log(`${s.name}.png ${(statSync(file).size / 1024).toFixed(0)} KB`)
        } finally {
          await ctx.close()
        }
      }
    } finally {
      await browser.close()
    }
    if (KEEP) {
      log(`--keep: ${base} 를 띄워 둡니다. Ctrl+C 로 정리합니다.`)
      await new Promise(r => process.once('SIGINT', r))
    }
  } finally {
    stopAll()
    specSrv?.close()
    await sleep(300)
    rmSync(dataDir, { recursive: true, force: true })
  }
}

/** 화면별 찍기 — name 이 파일 이름이 된다. */
function buildShots(base, ports, demo) {
  void demo
  const open = async (page) => {
    await page.goto(base + '/')
    await page.getByText(LANG === 'ko' ? '연결됨' : 'Connected').first().waitFor()
    await page.getByLabel(LANG === 'ko' ? '실행 환경' : 'Execution environment').first().selectOption({ label: demoName('로컬') })
  }
  const rail = (page, mode) => page.getByTestId(`rail-${mode}`).click()
  const settings = async (page, tab) => {
    await page.getByTestId('rail-settings').click()
    await page.getByTestId(`settings-${tab}`).click()
    await page.waitForTimeout(400)
  }
  const runRequest = async (page, name) => {
    await page.getByText(name, { exact: true }).first().click()
    await Promise.all([
      page.waitForResponse(response => response.url().includes('/execute') && response.status() < 500),
      page.getByTestId('run-request').click(),
    ])
  }
  const requestShot = async (page) => {
    await open(page)
    await runRequest(page, demoName('사용자 조회'))
    await page.getByRole('button', { name: /^Headers/ }).first().click()
  }
  // README 에 필요한 대표 화면 네 장만 유지한다.
  const withCode = async page => {
    await requestShot(page)
    await page.getByRole('button', { name: '코드 스니펫', exact: true }).click()
    await page.getByTestId('live-code-snippet').waitFor()
  }
  const extras = flag('--round3') ? [
    { name: 'sections', theme: 'dark', run: async page => {
      await open(page)
        await runRequest(page, demoName('사용자 조회'))
      for (const name of ['환경', '시나리오', '스케줄', '쿠키'])
        await page.getByRole('button', { name, exact: true }).click()
    } },
    { name: 'environment-tab', theme: 'dark', run: async page => {
      await open(page)
      await page.getByRole('button', { name: '환경', exact: true }).click()
      await page.getByRole('button', { name: demoName('로컬'), exact: true }).click()
    } },
  ] : []
  return [
    ...extras,
    { name: 'request', theme: 'dark', response: 430, run: withCode },
    { name: 'request-light', theme: 'light', response: 430, run: withCode },
    { name: 'settings', theme: 'dark', run: async page => { await open(page); await settings(page, 'env') } },
    { name: 'scenario', theme: 'dark', run: async page => {
      await open(page)
      await rail(page, 'scenario')
      await page.getByText(demoName('주문 생성 후 조회')).first().click()
      await page.getByRole('button', { name: LANG === 'ko' ? '▶ 시나리오 실행' : '▶ Run scenario' }).click()
      await page.getByText(LANG === 'ko' ? /시나리오 완료/ : /Scenario completed/).first().waitFor()
    } },
  ]
}

main().catch(e => { console.error(e); stopAll(); process.exitCode = 1 })
