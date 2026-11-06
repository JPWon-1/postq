#!/usr/bin/env node
/** Headless large-workspace benchmark. All data and servers live in a temporary directory. */
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { chromium } from '@playwright/test'

const root = resolve(import.meta.dirname, '..')
const bin = resolve(root, process.env.POSTQ_BIN ?? 'server/target/release/postq-server')
const temp = mkdtempSync(join(tmpdir(), 'postq-bench-large-'))
const dbPath = join(temp, 'postq.db')
const runsFlag = process.argv.indexOf('--runs')
const runs = runsFlag < 0 ? 3 : Number(process.argv[runsFlag + 1])
if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const samples = { startup: [], firstScreen: [], tree: [], open: [], history: [], search: [], foldersApi: [], treeApi: [], requestApi: [], historyApi: [], flagsApi: [], paletteApi: [] }
let server
let browser

async function freePort() {
  for (let p = 39700; p < 39800; p++) {
    const ok = await new Promise(done => {
      const s = net.createServer()
      s.once('error', () => done(false))
      s.listen(p, '127.0.0.1', () => s.close(() => done(true)))
    })
    if (ok) return p
  }
  throw new Error('no benchmark port available')
}

async function start(port) {
  const { HOSTNAME: _unused, ...env } = process.env
  server = spawn(bin, [], { cwd: root, env: { ...env, POSTQ_HOST: '127.0.0.1', PORT: String(port), DB_PATH: dbPath,
    MIGRATIONS_DIR: join(root, 'drizzle'), POSTQ_STATIC_DIR: process.env.POSTQ_STATIC_DIR ?? join(root, 'out'), POSTQ_NO_BACKGROUND: '1' }, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  server.stderr.on('data', chunk => { stderr += chunk.toString() })
  const base = `http://127.0.0.1:${port}`
  const began = performance.now()
  for (let n = 0; n < 200; n++) {
    if (server.exitCode !== null) throw new Error(`server exited: ${stderr}`)
    try {
      const r = await fetch(`${base}/api/health`)
      if (r.ok) return { base, elapsed: performance.now() - began }
    } catch { /* starting */ }
    await sleep(25)
  }
  throw new Error(`server did not start: ${stderr}`)
}

async function stop() {
  if (!server) return
  const child = server
  server = null
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([new Promise(done => child.once('exit', done)), sleep(3000)])
  if (child.exitCode === null) child.kill('SIGKILL')
}

function seed() {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('BEGIN')
    const folder = db.prepare('INSERT INTO folders (id, workspace_id, name, sort_order) VALUES (?, ?, ?, ?)')
    const request = db.prepare('INSERT INTO requests (id, folder_id, name, method, url, sort_order, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    const execution = db.prepare('INSERT INTO executions (id, request_id, executed_by, executed_at, resolved, response_status, response_headers, response_body, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    for (let f = 0; f < 10; f++) folder.run(`bench-folder-${f}`, 'default', `Bench Folder ${String(f).padStart(2, '0')}`, f)
    const now = Date.now()
    for (let i = 0; i < 1000; i++) {
      const id = `bench-request-${String(i).padStart(4, '0')}`
      request.run(id, `bench-folder-${Math.floor(i / 100)}`, `Bench Request ${String(i).padStart(4, '0')}`, 'GET', `https://example.invalid/api/${i}`, i, now)
      for (let j = 0; j < 10; j++) execution.run(`bench-execution-${String(i * 10 + j).padStart(5, '0')}`, id, 'human', now + i * 10 + j, '{}', 200, '{}', '{"ok":true}', 12)
    }
    db.exec('COMMIT')
    console.log(`seed: 1,000 requests · 10,000 executions · ${dbPath}`)
  } catch (error) { db.exec('ROLLBACK'); throw error } finally { db.close() }
}

async function api(base, path, bucket) {
  const t = performance.now()
  const res = await fetch(base + path)
  if (!res.ok) throw new Error(`${path}: ${res.status}`)
  await res.arrayBuffer()
  samples[bucket].push(performance.now() - t)
}

async function screen(page, bucket, action, target, selector, text = '', eventType = null) {
  const watch = async () => page.evaluate(({ selector, text, navigation, eventType }) => new Promise((resolve, reject) => {
    let start = navigation ? 0 : eventType ? null : performance.now()
    if (eventType) document.addEventListener(eventType, () => { start = performance.now() }, { once: true, capture: true })
    const deadline = performance.now() + 15000
    const tick = () => {
      const found = [...document.querySelectorAll(selector)].some(el => {
        const rect = el.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0 && el.textContent?.includes(text)
      })
      if (start !== null && found) resolve(performance.now() - start)
      else if (performance.now() > deadline) reject(new Error(`screen timeout: ${selector} ${text}`))
      else requestAnimationFrame(tick)
    }
    tick()
  }), { selector, text, navigation: bucket === 'firstScreen', eventType })
  const pending = bucket === 'firstScreen' ? null : watch()
  await action()
  const shown = await (pending ?? watch())
  await target.waitFor({ state: 'visible', timeout: 15000 })
  samples[bucket].push(shown)
  if (process.argv.includes('--trace')) console.log('screen', bucket, 'browser-visible', shown.toFixed(1))
}

try {
  const port = await freePort()
  await start(port) // Create the schema in an isolated empty DB.
  await stop()
  seed()
  browser = await chromium.launch({ headless: true })
  for (let i = 0; i < runs; i++) {
    const { base, elapsed } = await start(port)
    samples.startup.push(elapsed)
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await context.addInitScript(() => { localStorage.setItem('postq:language', 'ko') })
    const page = await context.newPage()
    const traceStart = performance.now()
    if (process.argv.includes('--trace')) page.on('response', response => {
      if (response.url().includes('/api/')) console.log('response', (performance.now() - traceStart).toFixed(1), new URL(response.url()).pathname + new URL(response.url()).search, response.status())
    })
    await screen(page, 'firstScreen', () => page.goto(base, { waitUntil: 'domcontentloaded' }), page.locator('[data-testid="sidebar-pane"]'), '[data-testid="sidebar-pane"]')
    await screen(page, 'tree', async () => {}, page.getByText('Bench Folder 00').first(), '[data-testid="sidebar-pane"]', 'Bench Folder 00')
    const firstRequest = page.getByRole('button', { name: /Bench Request 0000/ }).first()
    if (!await firstRequest.isVisible()) await page.getByRole('button', { name: /Bench Folder 00/ }).first().click()
    await firstRequest.waitFor({ state: 'visible' })
    await screen(page, 'open', () => firstRequest.click(), page.getByRole('textbox', { name: '요청 URL' }), 'input[aria-label="요청 URL"]', '', 'click')
    await screen(page, 'history', () => page.getByRole('navigation', { name: '작업 모드' }).getByRole('button', { name: '이력' }).click(), page.getByTestId('global-history').getByText('Bench Request 0999').first(), '[data-testid="global-history"]', 'Bench Request 0999', 'click')
    await page.keyboard.press('ControlOrMeta+KeyK')
    const dialog = page.getByRole('dialog', { name: '커맨드 팔레트' })
    await screen(page, 'search', () => dialog.getByRole('textbox', { name: '요청 검색' }).fill('Bench Request 0999'), dialog.getByText('Bench Request 0999'), '[role="dialog"]', 'Bench Request 0999', 'input')
    await api(base, '/api/folders?workspaceId=default', 'foldersApi')
    await api(base, '/api/requests?workspaceId=default&slim=1', 'treeApi')
    await api(base, '/api/requests/bench-request-0000', 'requestApi')
    await api(base, '/api/executions?workspaceId=default&limit=200', 'historyApi')
    await api(base, '/api/workspaces/default/flags', 'flagsApi')
    await api(base, '/api/requests?workspaceId=default&slim=1', 'paletteApi')
    await context.close()
    await stop()
  }
  for (const [name, values] of Object.entries(samples)) console.log(`${name.padEnd(14)} ${median(values).toFixed(1)} ms  [${values.map(v => v.toFixed(1)).join(', ')}]`)
} finally {
  if (browser) await browser.close()
  await stop()
  rmSync(temp, { recursive: true, force: true })
}
