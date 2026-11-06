#!/usr/bin/env node
/**
 * postq 데스크톱 앱(.app)·CLI 의 대기 메모리와 디스크 크기를 잰다 — 결과는 docs/benchmark.md 의 'Postman 데스크톱 vs postq'.
 * macOS 전용(footprint·open·launchd 의 WebKit XPC 프로세스를 쓴다).
 *
 *   npm run app:build -- --bundles app
 *   node scripts/bench-desktop.mjs --app src-tauri/target/release/bundle/macos/postq.app [--runs 3] [--wait 10] [--json out.json]
 *   node scripts/bench-desktop.mjs --cli <prefix>/bin/postq [--npm-prefix <prefix>]     # npm 으로 깐 CLI
 *   node scripts/bench-desktop.mjs --running "/Applications/Some.app"                          # 이미 떠 있는 앱을 읽기만(켜거나 끄지 않는다)
 *
 * 무엇을 재나
 *   --app   .app 을 임시 폴더(--work, 기본 tmpdir)로 ditto 복사한 뒤 `open -g -n <복사본>` 으로 띄운다(-g: 앞으로 가져오지 않는다).
 *           --wait 초(기본 10) 기다렸다가 그 앱에 속한 프로세스 전부의 RSS(ps) 합과 footprint(`footprint -p <pid>`) 합을 잰다.
 *           그다음 그 앱 본체 PID 에만 SIGTERM 을 보내 끄고, 딸린 프로세스가 다 내려갈 때까지 기다린다. --runs 번 반복해 중앙값.
 *           '그 앱에 속한 프로세스' 고르는 법:
 *             1) 본체 — 실행 파일 경로가 복사본의 Contents/MacOS/ 아래인 프로세스(복사본 경로는 이 실행마다 새로 만든 폴더라 다른 앱과 겹치지 않는다).
 *             2) 본체의 자식·자손(ppid 를 따라감).
 *             3) WebKit XPC 서비스(com.apple.WebKit.WebContent·Networking·GPU) — launchd(ppid 1)가 띄우므로 ppid 로는 안 잡힌다.
 *                macOS 의 '책임 프로세스'(responsibility_get_pid_responsible_for_pid, 활동 모니터가 쓰는 값)가 본체 PID 인 것만 고른다.
 *                이 함수는 cc 로 작은 C 도우미를 임시로 컴파일해 부른다. cc 가 없으면 띄우기 전후의 com.apple.WebKit.* PID 차이로 고르고
 *                결과에 method: 'diff' 라고 적는다(그 사이 다른 앱이 WebKit 프로세스를 띄우면 섞일 수 있다).
 *           디스크: 앱 번들 du, 그리고 그 앱의 사용자 데이터 폴더(~/Library/Application Support/<CFBundleIdentifier>,
 *           ~/Library/WebKit·Caches·Logs·HTTPStorages/<id>, Saved Application State) du. 이 스크립트가 띄우기 전에 없던 폴더는 다 잰 뒤 지운다(--keep-data 면 남긴다).
 *   --cli   npm 런처(node)를 `--no-open --port <빈 포트> --data-dir <임시>` 로 띄워 --wait 초 뒤 RSS·footprint 를 잰다
 *           (런처 node + 서버 실행 파일 각각과 합). 그다음 headless Chromium(Playwright) 탭 하나로 그 화면을 열고 --wait 초 뒤
 *           그 탭 렌더러 프로세스의 footprint·RSS 와 Chromium 전체 프로세스 RSS 합을 따로 적는다. 평소 쓰는 브라우저의 값과는 다를 수 있다.
 *   --npm-prefix  `npm install -g --prefix <prefix>` 로 깐 폴더 — lib/node_modules/@rocknzero/postq 와 postq-<platform> 의 du 를 더한다.
 *   --running  이미 떠 있는 다른 앱을 읽기만 한다(켜거나 끄지 않는다). 1)~3) 과 같은 방법으로 프로세스를 골라 3초 간격 --runs 번 잰다.
 *
 * 포트 3000·3001·18765·18767 은 쓰지 않는다. 끄는 것은 이 스크립트가 띄운 PID 뿐이다.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, release, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const argv = process.argv.slice(2)
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d }
const RUNS = Number(opt('--runs', '3'))
const WAIT_S = Number(opt('--wait', '10'))
const JSON_OUT = opt('--json')
const APP = opt('--app')
const CLI = opt('--cli')
const NPM_PREFIX = opt('--npm-prefix')
const RUNNING = opt('--running')
const KEEP_DATA = argv.includes('--keep-data')
const AVOID = new Set([3000, 3001, 18765, 18767])
if (process.platform !== 'darwin') throw new Error('macOS 전용입니다(footprint·open 을 씁니다)')
if (!APP && !CLI && !NPM_PREFIX && !RUNNING) throw new Error('--app, --cli, --npm-prefix, --running 중 하나 이상을 주세요')

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const median = (xs) => { const s = xs.filter(x => x != null).sort((a, b) => a - b); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const mib = (b) => b == null ? 'n/a' : (b / 1024 / 1024).toFixed(1)
const log = (...a) => console.log('[bench-desktop]', ...a)

function du(p) {
  if (!existsSync(p)) return null
  const r = spawnSync('du', ['-sk', p], { encoding: 'utf8' })
  return Number(r.stdout.split(/\s/)[0]) * 1024
}

// ── 프로세스 ─────────────────────────────────────────────────────────
function psAll() {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,comm='], { encoding: 'utf8', maxBuffer: 64 << 20 })
  return r.stdout.trim().split('\n').map(l => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l)
    return m && { pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]) * 1024, comm: m[4] }
  }).filter(Boolean)
}
/** footprint -p <pid> 의 'Footprint: N B' (바이트). 한 PID 씩 따로 불러 더한다(여러 PID 를 한 번에 주면 공유분을 따로 셈한다). */
function footprint(pid) {
  const r = spawnSync('footprint', ['-f', 'bytes', '--noCategories', '-p', String(pid)], { encoding: 'utf8' })
  const m = /Footprint:\s+(\d+)\s+B/.exec(r.stdout)
  return m ? Number(m[1]) : null
}

let rpHelper = null
/** responsibility_get_pid_responsible_for_pid 를 부르는 작은 C 도우미. cc 가 없으면 null. */
function responsibleHelper() {
  if (rpHelper !== null) return rpHelper || null
  const dir = mkdtempSync(join(tmpdir(), 'postq-bench-rp-'))
  const src = join(dir, 'rp.c')
  writeFileSync(src, [
    '#include <stdio.h>', '#include <stdlib.h>', '#include <sys/types.h>',
    'extern pid_t responsibility_get_pid_responsible_for_pid(pid_t);',
    'int main(int c, char **v) { for (int i = 1; i < c; i++) { pid_t p = atoi(v[i]); printf("%d %d\\n", p, responsibility_get_pid_responsible_for_pid(p)); } return 0; }',
  ].join('\n'))
  const bin = join(dir, 'rp')
  const r = spawnSync('cc', ['-o', bin, src], { encoding: 'utf8' })
  rpHelper = r.status === 0 ? bin : false
  return rpHelper || null
}
function responsibleOf(pids) {
  const bin = responsibleHelper()
  if (!bin || !pids.length) return null
  const r = spawnSync(bin, pids.map(String), { encoding: 'utf8' })
  return new Map(r.stdout.trim().split('\n').filter(Boolean).map(l => l.split(' ').map(Number)))
}
/** 지금 맨 앞 앱의 PID — `open -g` 로 띄운 앱이 앞으로 나왔는지 적어 둔다. */
function frontmostPid() {
  const asn = spawnSync('lsappinfo', ['front'], { encoding: 'utf8' }).stdout.trim()
  const r = spawnSync('lsappinfo', ['info', '-only', 'pid', asn], { encoding: 'utf8' }).stdout
  return Number(/"pid"=(\d+)/.exec(r)?.[1]) || null
}
const isWebKit = (p) => p.comm.includes('com.apple.WebKit.')

/** 본체(exe 경로가 macosDir 아래) + 자손 + 책임 프로세스가 본체인 WebKit XPC. */
function appProcesses(macosDir, webkitBefore) {
  const rows = psAll()
  const mains = rows.filter(p => p.comm.startsWith(macosDir))
  if (!mains.length) return null
  const ids = new Set(mains.map(p => p.pid))
  const kids = new Map()
  for (const p of rows) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p.pid) }
  const stack = [...ids]
  while (stack.length) { const q = stack.pop(); for (const k of kids.get(q) ?? []) if (!ids.has(k)) { ids.add(k); stack.push(k) } }
  const wk = rows.filter(isWebKit)
  const resp = responsibleOf(wk.map(p => p.pid))
  let method
  if (resp) {
    method = 'responsible-pid'
    for (const p of wk) if (ids.has(resp.get(p.pid))) ids.add(p.pid)
  } else {
    method = 'diff'
    for (const p of wk) if (webkitBefore && !webkitBefore.has(p.pid)) ids.add(p.pid)
  }
  const procs = rows.filter(p => ids.has(p.pid))
  return { mains: mains.map(p => p.pid), procs, method }
}
function snapshot(found) {
  const procs = found.procs.map(p => ({ pid: p.pid, name: p.comm.split('/').pop(), rss: p.rss, footprint: footprint(p.pid) }))
  return {
    procs,
    count: procs.length,
    rss: procs.reduce((a, p) => a + p.rss, 0),
    footprint: procs.reduce((a, p) => a + (p.footprint ?? 0), 0),
    method: found.method,
  }
}
function plist(app, key) {
  const r = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' })
  return r.stdout.trim() || null
}
function dataDirs(id) {
  const lib = join(homedir(), 'Library')
  return {
    appSupport: join(lib, 'Application Support', id), webkit: join(lib, 'WebKit', id), caches: join(lib, 'Caches', id),
    logs: join(lib, 'Logs', id), httpStorages: join(lib, 'HTTPStorages', id), savedState: join(lib, 'Saved Application State', `${id}.savedState`),
  }
}

// ── 데스크톱 앱 ─────────────────────────────────────────────────────
async function measureApp(src) {
  const srcApp = resolve(src)
  if (!existsSync(join(srcApp, 'Contents', 'Info.plist'))) throw new Error(`.app 이 아닙니다: ${srcApp}`)
  const work = resolve(opt('--work') ?? mkdtempSync(join(tmpdir(), 'postq-bench-app-')))
  mkdirSync(work, { recursive: true })
  const runDir = mkdtempSync(join(work, 'run-'))
  const app = join(runDir, srcApp.split('/').pop())
  if (spawnSync('ditto', [srcApp, app]).status !== 0) throw new Error('ditto 복사 실패')
  const id = plist(app, 'CFBundleIdentifier')
  const version = plist(app, 'CFBundleShortVersionString')
  const macosDir = join(app, 'Contents', 'MacOS') + '/'
  const dirs = dataDirs(id)
  const existedBefore = Object.fromEntries(Object.entries(dirs).map(([k, p]) => [k, existsSync(p)]))
  log(`앱 ${app} (${id} ${version}) — ${RUNS}회, 띄우고 ${WAIT_S}초 뒤`)
  const runs = []
  try {
    for (let i = 0; i < RUNS; i++) {
      if (appProcesses(macosDir)) throw new Error('이 복사본이 이미 떠 있습니다')
      const webkitBefore = new Set(psAll().filter(isWebKit).map(p => p.pid))
      const o = spawnSync('open', ['-g', '-n', app], { encoding: 'utf8' })
      if (o.status !== 0) throw new Error(`open 실패: ${o.stderr}`)
      await sleep(WAIT_S * 1000)
      const found = appProcesses(macosDir, webkitBefore)
      if (!found) throw new Error('앱 본체 프로세스를 찾지 못했습니다')
      const s = snapshot(found)
      s.frontmost = frontmostPid()
      s.cameToFront = found.mains.includes(s.frontmost)
      runs.push(s)
      log(`  ${i + 1}회: 프로세스 ${s.count}개 (${s.procs.map(p => p.name).join(', ')}) · RSS 합 ${mib(s.rss)} MiB · footprint 합 ${mib(s.footprint)} MiB [${s.method}]${s.cameToFront ? ' · 앞으로 나옴' : ''}`)
      // 이 앱 본체만 끈다 — WebKit XPC 프로세스는 클라이언트가 사라지면 launchd 가 내린다.
      for (const pid of found.mains) { try { process.kill(pid, 'SIGTERM') } catch { /* 이미 끝남 */ } }
      const all = new Set(found.procs.map(p => p.pid))
      const end = Date.now() + 15000
      while (Date.now() < end && psAll().some(p => all.has(p.pid))) await sleep(250)
      const left = psAll().filter(p => all.has(p.pid))
      if (left.length) log(`  경고: 끈 뒤에도 남은 프로세스 ${left.map(p => `${p.pid}:${p.comm.split('/').pop()}`).join(', ')}`)
      await sleep(1500)
    }
    const data = Object.fromEntries(Object.entries(dirs).map(([k, p]) => [k, { path: p.replace(homedir(), '~'), bytes: du(p) }]))
    return {
      bundle: { name: srcApp.split('/').pop(), id, version, bytes: du(app) },
      data,
      runs: runs.map(r => ({ count: r.count, rss: r.rss, footprint: r.footprint, method: r.method, cameToFront: r.cameToFront, procs: r.procs.map(({ name, rss, footprint }) => ({ name, rss, footprint })) })),
      median: { rss: median(runs.map(r => r.rss)), footprint: median(runs.map(r => r.footprint)) },
    }
  } finally {
    const still = appProcesses(macosDir)
    if (still) for (const pid of still.mains) { try { process.kill(pid, 'SIGKILL') } catch { /* 끝남 */ } }
    rmSync(runDir, { recursive: true, force: true })
    if (!KEEP_DATA) for (const [k, p] of Object.entries(dirs)) if (!existedBefore[k]) rmSync(p, { recursive: true, force: true })
  }
}

// ── 이미 떠 있는 앱(읽기만) ──────────────────────────────────────────
async function measureRunning(appPath) {
  const app = resolve(appPath)
  const macosDir = join(app, 'Contents', 'MacOS') + '/'
  const runs = []
  for (let i = 0; i < RUNS; i++) {
    const found = appProcesses(macosDir)
    if (!found) throw new Error(`떠 있지 않습니다: ${app}`)
    runs.push(snapshot(found))
    if (i < RUNS - 1) await sleep(3000)
  }
  return {
    bundle: { name: app.split('/').pop(), id: plist(app, 'CFBundleIdentifier'), version: plist(app, 'CFBundleShortVersionString'), bytes: du(app) },
    runs: runs.map(r => ({ count: r.count, rss: r.rss, footprint: r.footprint, method: r.method, procs: r.procs.map(({ name, rss, footprint }) => ({ name, rss, footprint })) })),
    median: { rss: median(runs.map(r => r.rss)), footprint: median(runs.map(r => r.footprint)) },
  }
}

// ── CLI + headless Chromium 탭 ──────────────────────────────────────
function portFree(port) {
  return new Promise(res => { const s = createServer(); s.once('error', () => res(false)); s.listen(port, '127.0.0.1', () => s.close(() => res(true))) })
}
async function freePort(from) { for (let p = from; p < from + 400; p++) if (!AVOID.has(p) && await portFree(p)) return p; throw new Error('빈 포트 없음') }
async function waitOk(url, ms = 15000) {
  const end = Date.now() + ms
  for (;;) {
    try { const r = await fetch(url); if (r.ok) return } catch { /* 아직 */ }
    if (Date.now() > end) throw new Error(`응답 없음: ${url}`)
    await sleep(50)
  }
}
function descendants(rootPid) {
  const rows = psAll()
  const kids = new Map()
  for (const p of rows) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p) }
  const out = []
  const stack = [rootPid]
  while (stack.length) { const q = stack.pop(); for (const k of kids.get(q) ?? []) { out.push(k); stack.push(k.pid) } }
  return { root: rows.find(p => p.pid === rootPid), kids: out }
}
async function measureCli(cli) {
  const { chromium } = await import('@playwright/test')
  const runs = []
  for (let i = 0; i < RUNS; i++) {
    const port = await freePort(39300)
    const data = mkdtempSync(join(tmpdir(), 'postq-bench-cli-'))
    const { HOSTNAME: _h, ...env } = process.env
    const c = spawn(cli, ['--no-open', '--port', String(port), '--data-dir', data], { env: { ...env, POSTQ_HOST: '127.0.0.1' }, stdio: 'ignore' })
    let browser
    try {
      const base = `http://127.0.0.1:${port}`
      await waitOk(`${base}/api/health`)
      await sleep(WAIT_S * 1000)
      const t = descendants(c.pid)
      const procs = [t.root, ...t.kids].filter(Boolean).map(p => ({ pid: p.pid, name: p.comm.split('/').pop(), rss: p.rss, footprint: footprint(p.pid) }))
      const server = procs.find(p => p.name.startsWith('postq')) ?? null
      const launcher = procs.find(p => p.pid === c.pid) ?? null

      browser = await chromium.launch({ headless: true })
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
      const page = await ctx.newPage()
      await page.goto(base + '/')
      await page.getByText('연결됨').first().waitFor({ timeout: 15000 })
      await sleep(WAIT_S * 1000)
      // 이 탭의 렌더러 — 브라우저의 SystemInfo 로 렌더러 PID 를 받는다. 탭이 하나라 렌더러도 보통 하나다.
      const cdp = await browser.newBrowserCDPSession()
      const info = await cdp.send('SystemInfo.getProcessInfo')
      const rendererPids = info.processInfo.filter(p => p.type === 'renderer').map(p => p.id)
      const rows = psAll()
      const renderers = rendererPids.map(pid => ({ pid, rss: rows.find(r => r.pid === pid)?.rss ?? null, footprint: footprint(pid) }))
      const browserTotalRss = info.processInfo.reduce((a, p) => a + (rows.find(r => r.pid === p.id)?.rss ?? 0), 0)
      runs.push({
        launcher: launcher && { rss: launcher.rss, footprint: launcher.footprint },
        server: server && { rss: server.rss, footprint: server.footprint },
        treeRss: procs.reduce((a, p) => a + p.rss, 0),
        treeFootprint: procs.reduce((a, p) => a + (p.footprint ?? 0), 0),
        renderers,
        rendererFootprint: renderers.reduce((a, r) => a + (r.footprint ?? 0), 0),
        rendererRss: renderers.reduce((a, r) => a + (r.rss ?? 0), 0),
        browserProcesses: info.processInfo.length,
        browserTotalRss,
      })
      const r = runs.at(-1)
      log(`  CLI ${i + 1}회: 서버 RSS ${mib(r.server?.rss)} · 런처 node RSS ${mib(r.launcher?.rss)} · 합 ${mib(r.treeRss)} MiB / footprint 합 ${mib(r.treeFootprint)} · 탭 렌더러 ${renderers.length}개 footprint ${mib(r.rendererFootprint)} RSS ${mib(r.rendererRss)} · Chromium 전체 ${r.browserProcesses}개 RSS ${mib(browserTotalRss)}`)
    } finally {
      await browser?.close().catch(() => {})
      try { c.kill('SIGTERM') } catch { /* 끝남 */ }
      await new Promise(r => (c.exitCode !== null || c.signalCode !== null) ? r() : c.once('exit', r))
      rmSync(data, { recursive: true, force: true })
    }
  }
  const m = (f) => median(runs.map(f))
  return {
    runs,
    median: {
      serverRss: m(r => r.server?.rss), serverFootprint: m(r => r.server?.footprint),
      launcherRss: m(r => r.launcher?.rss), treeRss: m(r => r.treeRss), treeFootprint: m(r => r.treeFootprint),
      rendererFootprint: m(r => r.rendererFootprint), rendererRss: m(r => r.rendererRss), browserTotalRss: m(r => r.browserTotalRss),
    },
  }
}

function npmSize(prefix) {
  const modules = join(resolve(prefix), 'lib', 'node_modules')
  const names = readdirSync(modules).flatMap(n => n === '@rocknzero' ? readdirSync(join(modules, n)).filter(p => p === 'postq').map(p => `@rocknzero/${p}`) : n.startsWith('postq-') ? [n] : [])
  const pkgs = Object.fromEntries(names.map(n => [n, du(join(modules, n))]))
  return { packages: pkgs, total: Object.values(pkgs).reduce((a, b) => a + b, 0) }
}

// ── 실행 ─────────────────────────────────────────────────────────────
const hw = spawnSync('sysctl', ['-n', 'hw.model'], { encoding: 'utf8' }).stdout.trim()
const osv = spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).stdout.trim()
const out = { when: new Date().toISOString(), machine: hw, macos: osv, darwin: release(), runs: RUNS, waitSeconds: WAIT_S }
if (APP) out.app = await measureApp(APP)
if (RUNNING) out.running = await measureRunning(RUNNING)
if (CLI) out.cli = await measureCli(resolve(CLI))
if (NPM_PREFIX) out.npm = npmSize(NPM_PREFIX)

console.log('\n── 결과(중앙값, MiB) ──')
if (out.app) {
  const a = out.app
  console.log(`데스크톱 앱 ${a.bundle.name} ${a.bundle.version}: 번들 ${mib(a.bundle.bytes)} · RSS 합 ${mib(a.median.rss)} · footprint 합 ${mib(a.median.footprint)}`)
  for (const [k, d] of Object.entries(a.data)) console.log(`  데이터 ${k} ${d.path}: ${d.bytes == null ? '없음' : mib(d.bytes)}`)
}
if (out.running) console.log(`떠 있는 앱 ${out.running.bundle.name}: 번들 ${mib(out.running.bundle.bytes)} · RSS 합 ${mib(out.running.median.rss)} · footprint 합 ${mib(out.running.median.footprint)}`)
if (out.cli) {
  const m = out.cli.median
  console.log(`CLI: 서버 RSS ${mib(m.serverRss)} (footprint ${mib(m.serverFootprint)}) · 런처 node RSS ${mib(m.launcherRss)} · 합 RSS ${mib(m.treeRss)} (footprint ${mib(m.treeFootprint)})`)
  console.log(`headless Chromium 탭: 렌더러 footprint ${mib(m.rendererFootprint)} · RSS ${mib(m.rendererRss)} · Chromium 전체 RSS ${mib(m.browserTotalRss)}`)
}
if (out.npm) console.log(`npm 설치: ${mib(out.npm.total)} (${Object.entries(out.npm.packages).map(([k, v]) => `${k} ${mib(v)}`).join(' + ')})`)
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(out, null, 2))
