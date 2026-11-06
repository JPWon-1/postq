import { afterAll, beforeAll, expect, test } from 'vitest'
import { createServer, type Server } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
let server: Server, base: string, dir: string, calls = 0, passed = true
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'scenario-cli-'))
  server = createServer((_, res) => { calls++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ stoppedAt: passed ? null : 0, runtimeVariables: { secret: 'NEVER-EXPORT' }, steps: [{ name: 'check', execution: { id: 'e', responseStatus: 200, responseBody: 'NEVER-EXPORT', checkPassed: passed } }] })) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => { server.close(); await rm(dir, { recursive: true, force: true }) })
const run = () => promisify(execFile)(process.execPath, ['scripts/run-scenario.mjs', 'scenario', 'stage', join(dir, 'result.json')], { env: { ...process.env, POSTQ_URL: base } })
test('CI scenario runs once and excludes runtime secrets and responses', async () => {
  await run(); expect(calls).toBe(1)
  const artifact = await readFile(join(dir, 'result.json'), 'utf8')
  expect(artifact).not.toContain('NEVER-EXPORT'); expect(JSON.parse(artifact).passed).toBe(true)
})
test('business failure fails CI despite HTTP 200', async () => { passed = false; await expect(run()).rejects.toMatchObject({ code: 1 }) })
