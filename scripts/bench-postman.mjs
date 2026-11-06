#!/usr/bin/env node
/**
 * postq 와 Postman CLI 의 설치 크기·메모리·시작 시간을 같은 조건에서 잰다 — 결과는 docs/benchmark.md.
 *
 *   npm run build && (cd server && cargo build --release)
 *   npm install --prefix /tmp/pm postman-cli          # 또는 npm install -g postman-cli
 *   node scripts/bench-postman.mjs --postman-dir /tmp/pm/node_modules [--runs 5] [--json out.json]
 *   node scripts/bench-postman.mjs --sizes-only      # 설치 크기만(postman-cli 없어도 된다)
 *
 * 무엇을 재나
 *   1. 설치 크기 — postman-cli: npm 패키지 + 플랫폼 실행 파일 패키지(@postman/pm-bin-*)의 디스크 사용량(du).
 *      postq: release 서버 실행 파일 + 정적 화면(out/) + 마이그레이션(drizzle/), 그리고 그 셋을 tar.gz 로 묶은 크기.
 *      그리고 실제 npm 설치 — scripts/package-release.mjs --main 으로 메인·이 플랫폼 패키지를 만들어 npm pack 한 뒤
 *      임시 prefix 에 `npm install -g --prefix` 로 깔고(인터넷의 npm 레지스트리에는 올리지 않는다) 두 패키지 폴더의 du 를 더한다.
 *      릴리스 압축 묶음(postq-<버전>-<플랫폼>.tar.gz)과 npm tarball 크기도 같이 적는다.
 *      --no-npm 이면 npm 설치 측정을 건너뛴다.
 *   2. 메모리 — 같은 컬렉션(요청 4개, 로컬 echo 서버 대상)을 실행할 때의 최대 RSS.
 *      - postman: `postman collection run <collection.json>` 한 번(로그인 없이 — 결과를 클라우드에 올리지 않는다).
 *      - postq: 서버 대기 상태 RSS, 그리고 같은 컬렉션을 /api/import/postman 으로 가져와
 *        scripts/run-collection.mjs(→ POST /api/folders/{id}/run)로 실행할 때의 서버 최대 RSS + 실행 스크립트(node) 최대 RSS.
 *      재는 법 두 가지를 같이 적는다:
 *        a) 프로세스 트리 합계 — `ps` 를 20ms 마다 찍어 루트와 모든 자손의 RSS 를 더한 값의 최댓값(macOS·Linux).
 *        b) /usr/bin/time -l(macOS) · -v(Linux) 의 maximum resident set size — 자식 중 가장 큰 프로세스 하나의 값.
 *   3. 시작 시간 — 명령을 띄운 순간부터 첫 응답까지.
 *      postman: `postman --version` 이 끝날 때까지. postq: 서버를 띄운 순간부터 /api/health 가 200 을 줄 때까지.
 *
 * 각 항목을 --runs 번(기본 5) 재고 중앙값을 낸다. Windows 는 ps 표본 대신 'n/a' 로 둔다(크기·시간은 잰다).
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { cpus, platform, release, tmpdir, totalmem } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const argv = process.argv.slice(2)
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d }
const RUNS = Number(opt('--runs', '5'))
const JSON_OUT = opt('--json')
const IS_WIN = process.platform === 'win32'
const SIZES_ONLY = argv.includes('--sizes-only')
const NO_NPM = argv.includes('--no-npm')
const EXE = IS_WIN ? '.exe' : ''
const SERVER_BIN = resolve(ROOT, process.env.POSTQ_BIN ?? join('server', 'target', 'release', `postq-server${EXE}`))
const STATIC_DIR = resolve(ROOT, 'out')
const AVOID = new Set([3000, 3001, 18765, 18767])

function npmGlobalRoot() {
  const r = spawnSync(IS_WIN ? 'npm.cmd' : 'npm', ['root', '-g'], { encoding: 'utf8', shell: IS_WIN })
  return r.stdout.trim()
}
const PM_MODULES = resolve(opt('--postman-dir', npmGlobalRoot()))
const PM_PKG = join(PM_MODULES, 'postman-cli')
const PM_BIN = join(PM_PKG, 'bin', 'postman.js')
if (!SIZES_ONLY && !existsSync(PM_BIN)) throw new Error(`postman-cli 가 없습니다: ${PM_PKG}\n  npm install -g postman-cli 또는 --postman-dir <node_modules>`)
if (!existsSync(SERVER_BIN)) throw new Error(`서버 실행 파일이 없습니다: ${SERVER_BIN}`)

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const median = (xs) => { const s = [...xs].filter(x => x != null).sort((a, b) => a - b); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const mb = (bytes) => bytes == null ? 'n/a' : (bytes / 1024 / 1024).toFixed(1)

// ── 크기 ─────────────────────────────────────────────────────────────
/** 디스크 사용량(블록 기준, du 와 같은 뜻). Windows 는 파일 크기 합. */
function diskUsage(p) {
  if (!existsSync(p)) return 0
  if (!IS_WIN) {
    const r = spawnSync('du', ['-sk', p], { encoding: 'utf8' })
    return Number(r.stdout.split(/\s/)[0]) * 1024
  }
  const st = statSync(p)
  if (!st.isDirectory()) return st.size
  return readdirSync(p).reduce((a, n) => a + diskUsage(join(p, n)), 0)
}
/**
 * 실제 npm 설치 크기. 이 컴퓨터용 플랫폼 패키지 + 메인 패키지를 만들어 pack 하고, 임시 prefix 에 전역 설치한 뒤 du.
 * 레지스트리에 올리지 않는다 — 로컬 tarball 두 개만 설치한다(다른 플랫폼 optionalDependencies 는 npm 이 건너뛴다).
 */
function npmInstallSizes() {
  if (NO_NPM) return null
  const npm = IS_WIN ? 'npm.cmd' : 'npm'
  const tmp = mkdtempSync(join(tmpdir(), 'postq-bench-npm-'))
  try {
    const dist = join(tmp, 'dist')
    const pr = spawnSync(process.execPath, [join(ROOT, 'scripts', 'package-release.mjs'), '--main', '--out', dist], { cwd: ROOT, encoding: 'utf8' })
    if (pr.status !== 0) throw new Error(`package-release 실패:\n${pr.stdout}${pr.stderr}`)
    const archive = readdirSync(dist).find(n => /^postq-.+\.(tar\.gz|zip)$/.test(n))
    const packs = join(tmp, 'packs')
    mkdirSync(packs)
    const pkgDirs = readdirSync(join(dist, 'npm'))
    const tarballs = {}
    for (const d of pkgDirs) {
      const r = spawnSync(npm, ['pack', join(dist, 'npm', d), '--pack-destination', packs], { encoding: 'utf8', shell: IS_WIN })
      if (r.status !== 0) throw new Error(`npm pack 실패(${d}):\n${r.stderr}`)
    }
    for (const n of readdirSync(packs)) tarballs[n] = statSync(join(packs, n)).size
    const prefix = join(tmp, 'prefix')
    const inst = spawnSync(npm, ['install', '-g', '--prefix', prefix, '--no-audit', '--no-fund', ...readdirSync(packs).map(n => join(packs, n))], { encoding: 'utf8', shell: IS_WIN })
    if (inst.status !== 0) throw new Error(`npm install 실패:\n${inst.stderr}`)
    const modules = IS_WIN ? join(prefix, 'node_modules') : join(prefix, 'lib', 'node_modules')
    const installedNames = readdirSync(modules).flatMap(n => n === '@postq' ? readdirSync(join(modules, n)).map(p => `@postq/${p}`) : n.startsWith('postq-') ? [n] : [])
    const installed = Object.fromEntries(installedNames.map(n => [n, diskUsage(join(modules, n))]))
    return {
      releaseArchive: archive ? { name: archive, bytes: statSync(join(dist, archive)).size } : null,
      tarballs,
      installed,
      installedTotal: Object.values(installed).reduce((a, b) => a + b, 0),
      prefixTotal: diskUsage(prefix),
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

function sizes() {
  const pmPlatformDir = join(PM_MODULES, '@postman')
  const pmPlatform = existsSync(pmPlatformDir) ? readdirSync(pmPlatformDir).filter(n => n.startsWith('pm-bin-')) : []
  const tmp = mkdtempSync(join(tmpdir(), 'postq-bench-tar-'))
  const tgz = join(tmp, 'postq.tar.gz')
  // 서버 실행 파일 + 화면 + 마이그레이션 — 실행에 필요한 전부
  spawnSync('tar', ['-czf', tgz, '-C', join(SERVER_BIN, '..'), `postq-server${EXE}`, '-C', ROOT, 'out', 'drizzle'])
  const tgzSize = existsSync(tgz) ? statSync(tgz).size : null
  rmSync(tmp, { recursive: true, force: true })
  return {
    postman: {
      cliPackage: diskUsage(PM_PKG),
      platformBinaries: Object.fromEntries(pmPlatform.map(n => [`@postman/${n}`, diskUsage(join(pmPlatformDir, n))])),
    },
    postq: {
      serverBinary: diskUsage(SERVER_BIN),
      staticUi: diskUsage(STATIC_DIR),
      migrations: diskUsage(join(ROOT, 'drizzle')),
      tarGz: tgzSize,
      npm: npmInstallSizes(),
    },
  }
}

// ── 메모리 표본 ──────────────────────────────────────────────────────
/** ps 로 루트와 모든 자손의 RSS 합(바이트). Windows 는 null. */
function treeRss(rootPid) {
  if (IS_WIN) return null
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8' })
  const rows = r.stdout.trim().split('\n').map(l => l.trim().split(/\s+/).map(Number))
  const kids = new Map()
  for (const [pid, ppid] of rows) { if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push(pid) }
  const rss = new Map(rows.map(([pid, , kb]) => [pid, kb]))
  let sum = 0
  const stack = [rootPid]
  while (stack.length) { const p = stack.pop(); sum += rss.get(p) ?? 0; stack.push(...(kids.get(p) ?? [])) }
  return sum * 1024
}
function sampler(pid) {
  let peak = 0
  let stopped = false
  const loop = (async () => { while (!stopped) { const v = treeRss(pid); if (v != null && v > peak) peak = v; await sleep(20) } })()
  return { stop: async () => { stopped = true; await loop; return IS_WIN ? null : peak } }
}
/** /usr/bin/time 로 감싼 실행 — maximum resident set size 를 바이트로. */
function timeWrap(cmd, args) {
  if (process.platform === 'darwin' && existsSync('/usr/bin/time')) return { cmd: '/usr/bin/time', args: ['-l', cmd, ...args], parse: (err) => Number(/(\d+)\s+maximum resident set size/.exec(err)?.[1]) || null }
  if (process.platform === 'linux' && existsSync('/usr/bin/time')) return { cmd: '/usr/bin/time', args: ['-v', cmd, ...args], parse: (err) => (Number(/Maximum resident set size \(kbytes\): (\d+)/.exec(err)?.[1]) * 1024) || null }
  return { cmd, args, parse: () => null }
}
async function measured(cmd, args, env = {}) {
  const w = timeWrap(cmd, args)
  const t0 = performance.now()
  const c = spawn(w.cmd, w.args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const s = sampler(c.pid)
  let out = '', err = ''
  c.stdout.on('data', d => { out += d })
  c.stderr.on('data', d => { err += d })
  const code = await new Promise(r => c.on('close', r))
  const ms = performance.now() - t0
  return { code, ms, treePeak: await s.stop(), timeMaxRss: w.parse(err), out, err }
}

// ── 대상 ─────────────────────────────────────────────────────────────
function portFree(port) {
  return new Promise(res => { const s = createServer(); s.once('error', () => res(false)); s.listen(port, '127.0.0.1', () => s.close(() => res(true))) })
}
async function freePort(from) { for (let p = from; p < from + 400; p++) if (!AVOID.has(p) && await portFree(p)) return p; throw new Error('빈 포트 없음') }
async function waitOk(url, ms = 15000) {
  const end = Date.now() + ms
  for (;;) {
    try { const r = await fetch(url); if (r.ok) return } catch { /* 아직 */ }
    if (Date.now() > end) throw new Error(`응답 없음: ${url}`)
    await sleep(5)
  }
}
const collection = (base) => ({
  info: { name: 'bench', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  item: [
    { name: '사용자 목록', request: { method: 'GET', url: `${base}/users?page=1` } },
    { name: '사용자 조회', request: { method: 'GET', url: `${base}/users/42`, header: [{ key: 'Accept', value: 'application/json' }] } },
    { name: '사용자 생성', request: { method: 'POST', url: `${base}/users`, header: [{ key: 'Content-Type', value: 'application/json' }],
      body: { mode: 'raw', raw: JSON.stringify({ name: 'Alex Kim', email: 'alex@example.com' }), options: { raw: { language: 'json' } } } } },
    { name: '주문 조회', request: { method: 'GET', url: `${base}/orders/1001` } },
  ],
})

async function startServer(dataDir, port) {
  const { HOSTNAME: _h, ...env } = process.env
  const t0 = performance.now()
  const c = spawn(SERVER_BIN, [], {
    env: { ...env, PORT: String(port), POSTQ_HOST: '127.0.0.1', DB_PATH: join(dataDir, 'postq.db'),
      MIGRATIONS_DIR: join(ROOT, 'drizzle'), POSTQ_STATIC_DIR: STATIC_DIR },
    stdio: 'ignore',
  })
  await waitOk(`http://127.0.0.1:${port}/api/health`)
  return { c, startMs: performance.now() - t0 }
}

async function main() {
  if (SIZES_ONLY) {
    const s = sizes()
    console.log(JSON.stringify(s, null, 2))
    if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ sizes: s }, null, 2))
    return
  }
  const echoPort = await freePort(39270)
  const echo = spawn(process.execPath, [join(ROOT, 'e2e', 'echo-server.mjs')], { env: { ...process.env, PORT: String(echoPort) }, stdio: 'ignore' })
  const work = mkdtempSync(join(tmpdir(), 'postq-bench-'))
  const target = `http://127.0.0.1:${echoPort}`
  const collFile = join(work, 'collection.json')
  writeFileSync(collFile, JSON.stringify(collection(target), null, 2))
  const result = { runs: RUNS, env: {}, sizes: sizes(), postman: [], postq: [] }
  try {
    await waitOk(`${target}/`)
    const pmVersion = spawnSync(process.execPath, [PM_BIN, '--version'], { encoding: 'utf8' }).stdout.trim()
    result.env = { platform: platform(), release: release(), cpu: cpus()[0]?.model, memGB: Math.round(totalmem() / 2 ** 30), node: process.version, postmanCli: pmVersion, date: new Date().toISOString() }

    for (let i = 0; i < RUNS; i++) {
      const ver = await measured(process.execPath, [PM_BIN, '--version'])
      const run = await measured(process.execPath, [PM_BIN, 'collection', 'run', collFile])
      if (!/requests\s*\|\s*4\s*\|\s*0/.test(run.out)) throw new Error(`postman 실행 결과가 예상과 다릅니다(요청 4 · 실패 0):\n${run.out.slice(-1500)}`)
      result.postman.push({ versionMs: ver.ms, runMs: run.ms, runTreePeak: run.treePeak, runTimeMaxRss: run.timeMaxRss })
      console.log(`[postman ${i + 1}] version ${ver.ms.toFixed(0)}ms · run ${run.ms.toFixed(0)}ms · tree ${mb(run.treePeak)}MB · time -l ${mb(run.timeMaxRss)}MB`)
    }

    for (let i = 0; i < RUNS; i++) {
      const dataDir = mkdtempSync(join(work, 'data-'))
      const port = await freePort(39280)
      const base = `http://127.0.0.1:${port}`
      const { c, startMs } = await startServer(dataDir, port)
      try {
        await sleep(3000)
        const idle = treeRss(c.pid)
        const imp = await (await fetch(`${base}/api/import/postman`, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ collection: collection(target) }) })).json()
        const folders = await (await fetch(`${base}/api/folders`)).json()
        const folder = folders.find(f => f.name === 'bench')
        if (!folder) throw new Error(`가져온 폴더가 없습니다: ${JSON.stringify(imp)}`)
        const srv = sampler(c.pid)
        const out = join(dataDir, 'junit.xml')
        const run = await measured(process.execPath, [join(ROOT, 'scripts', 'run-collection.mjs'), folder.id, '', out, '--include-writes'], { POSTQ_URL: base })
        const serverPeak = await srv.stop()
        if (run.code !== 0 || !/점검 4건 · 실패 0건/.test(run.out)) throw new Error(`postq 실행 결과가 예상과 다릅니다:\n${run.out}${run.err.slice(-800)}`)
        result.postq.push({ startMs, idleRss: idle, runServerPeak: serverPeak, runClientTreePeak: run.treePeak, runClientTimeMaxRss: run.timeMaxRss, runMs: run.ms })
        console.log(`[postq ${i + 1}] start ${startMs.toFixed(0)}ms · idle ${mb(idle)}MB · run server ${mb(serverPeak)}MB + client ${mb(run.treePeak)}MB · ${run.ms.toFixed(0)}ms`)
      } finally {
        c.kill()
        await new Promise(r => c.once('close', r))
      }
    }
  } finally {
    echo.kill()
    await sleep(200)
    rmSync(work, { recursive: true, force: true })
  }

  const med = (arr, k) => median(arr.map(x => x[k]))
  const s = result.sizes
  const pmPlatformTotal = Object.values(s.postman.platformBinaries).reduce((a, b) => a + b, 0)
  result.summary = {
    postman: {
      installBytes: s.postman.cliPackage + pmPlatformTotal,
      versionMs: med(result.postman, 'versionMs'), runMs: med(result.postman, 'runMs'),
      runTreePeak: med(result.postman, 'runTreePeak'), runTimeMaxRss: med(result.postman, 'runTimeMaxRss'),
    },
    postq: {
      installBytes: s.postq.serverBinary + s.postq.staticUi + s.postq.migrations, tarGz: s.postq.tarGz,
      npmInstallBytes: s.postq.npm?.installedTotal ?? null,
      startMs: med(result.postq, 'startMs'), idleRss: med(result.postq, 'idleRss'),
      runServerPeak: med(result.postq, 'runServerPeak'), runClientTreePeak: med(result.postq, 'runClientTreePeak'),
      runClientTimeMaxRss: med(result.postq, 'runClientTimeMaxRss'), runMs: med(result.postq, 'runMs'),
    },
  }
  console.log('\n' + JSON.stringify(result.env))
  console.log(JSON.stringify(result.sizes))
  console.log(JSON.stringify(result.summary, null, 2))
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(result, null, 2))
}

main().catch(e => { console.error(e); process.exitCode = 1 })
