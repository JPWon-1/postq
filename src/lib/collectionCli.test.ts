import { afterAll, beforeAll, expect, test } from 'vitest'
import { createServer, type Server } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
let server: Server, base: string, dir: string, calls = 0, status = 200, failed = 0, auth = ''
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'postq-cli-'))
  server = createServer((req, res) => {
    calls++; auth = req.headers.authorization ?? ''
    res.statusCode = status; res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ summary: { total: 1, failed }, junit: '<testsuites />' }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as {port: number}).port}`
})
afterAll(async () => { server.close(); await rm(dir, { recursive: true, force: true }) })
async function run() {
  calls = 0
  return promisify(execFile)(process.execPath, ['scripts/run-collection.mjs', 'folder', 'stage', join(dir, 'result.xml')], { env: { ...process.env, POSTQ_URL: base } })
}
test('CI executes once and exports the same run without exposing an MCP bearer token', async () => {
  await run()
  expect(calls).toBe(1)
  expect(auth).toBe('')
  expect(await readFile(join(dir, 'result.xml'), 'utf8')).toBe('<testsuites />')
})
test('failed checks fail the pipeline', async () => {
  failed = 1
  await expect(run()).rejects.toMatchObject({ code: 1 })
  expect(calls).toBe(1)
})
test('HTTP failure cannot be interpreted as zero failed checks', async () => {
  status = 500
  await expect(run()).rejects.toMatchObject({ code: 2 })
  expect(calls).toBe(1)
})
