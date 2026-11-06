import { test, expect, type APIRequestContext } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { parseCurl } from '../src/lib/curlParse'
import { formatSnippet } from '../src/lib/preparedSnippet'

let echo: Server
let origin: string
let grants = 0

test.beforeAll(async () => {
  echo = createServer((req, res) => {
    let body = ''
    req.on('data', data => { body += data })
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/token') { grants++; res.end(JSON.stringify({ access_token: 'OAUTH-PRIVATE', token_type: 'Bearer', expires_in: 3600 })) }
      else res.end(JSON.stringify({ headers: req.headers, body, path: req.url }))
    })
  })
  await new Promise<void>(resolve => echo.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(echo.address() as { port: number }).port}`
})
test.afterAll(async () => { await new Promise<void>(resolve => echo.close(() => resolve())) })

async function seed(request: APIRequestContext) {
  const ws = await (await request.post('/api/workspaces', { data: { name: 'e2e-curl-copy' } })).json()
  const folder = await (await request.post('/api/folders', { data: { workspaceId: ws.id, name: '복사 검증' } })).json()
  const env = await (await request.post('/api/environments', { data: { workspaceId: ws.id, name: '복사 환경' } })).json()
  await request.put(`/api/environments/${env.id}`, { data: { name: env.name, variables: [
    { key: 'baseUrl', value: origin, secret: false }, { key: 'version', value: '2026', secret: false }, { key: 'token', value: 'PRIVATE-TOKEN', secret: true },
  ] } })
  await request.put(`/api/folders/${folder.id}`, { data: { sharedHeaders: [
    { key: 'X-Inherited', value: '{{version}}', enabled: true }, { key: 'X-Override', value: 'folder', enabled: true }, { key: 'X-Folder-Off', value: 'excluded', enabled: false },
  ], sharedAuth: { type: 'bearer', token: '{{token}}' } } })
  const row = await (await request.post('/api/requests', { data: { folderId: folder.id, name: '복사 대상', method: 'POST', url: '{{baseUrl}}/echo' } })).json()
  await request.put(`/api/requests/${row.id}`, { data: { auth: { type: 'inherit' }, bodyType: 'json', body: '{"ok":true}', headers: [
    { key: 'X-Own', value: 'own', enabled: true }, { key: 'x-override', value: 'request', enabled: true }, { key: 'X-Off', value: 'excluded', enabled: false },
    { key: 'X-Private', value: '{{token}}', enabled: true }, { key: 'X-Inherited', value: 'ignored', enabled: false }, { key: 'Cookie', value: 'ignored', enabled: false },
  ] } })
  const cookieSaved = await request.post('/api/cookies', { data: { workspaceId: ws.id, environmentId: env.id, domain: new URL(origin).host, cookieString: 'session=COOKIE-PRIVATE' } })
  expect(cookieSaved.status(), await cookieSaved.text()).toBe(201)
  return { ws, env, row, folder }
}

test('서버 미리보기·모든 코드 언어가 실행 헤더와 일치한다: 상속, 인증 4종, 쿠키, Content-Type, 비활성', async ({ request }) => {
  const { ws, env, row } = await seed(request)
  try {
    const variants = [
      { type: 'inherit' }, { type: 'bearer', token: 'LITERAL-PRIVATE' }, { type: 'basic', username: 'demo', password: 'BASIC-PRIVATE' },
      { type: 'apikey', key: 'X-Custom-Key', value: 'API-PRIVATE', in: 'header' },
      { type: 'oauth2cc', tokenUrl: origin + '/token', clientId: 'demo', clientSecret: 'CLIENT-PRIVATE' },
    ]
    for (const auth of variants) {
      await request.put(`/api/requests/${row.id}`, { data: { auth } })
      const saved = await (await request.get(`/api/requests/${row.id}`)).json()
      const payload = { environmentId: env.id, input: saved, auth: saved.auth }
      const grantsBefore = grants
      const safe = await (await request.post(`/api/requests/${row.id}/preview`, { data: { ...payload, purpose: 'snippet' } })).json()
      expect(safe.authError).toBeNull()
      expect(grants).toBe(grantsBefore)
      expect(JSON.stringify(safe)).not.toContain('PRIVATE')
      expect(safe.hasSecrets).toBe(true)
      const preview = await (await request.post(`/api/requests/${row.id}/preview`, { data: { ...payload, purpose: 'snippet', revealSecrets: true } })).json()
      expect(preview.authError).toBeNull()
      const ordinary = await (await request.post(`/api/requests/${row.id}/preview`, { data: payload })).json()
      expect(ordinary.preview.headers.map((h: { key: string }) => h.key.toLowerCase()).sort()).toEqual(preview.snippet.headers.map((h: { key: string }) => h.key.toLowerCase()).sort())
      expect(JSON.stringify(ordinary.preview)).not.toContain('PRIVATE')
      const execution = await (await request.post(`/api/requests/${row.id}/execute`, { data: payload })).json()
      expect(execution.error).toBeNull()
      const sent = JSON.parse(execution.responseBody).headers
      const headers = Object.fromEntries(preview.snippet.headers.map((h: { key: string; value: string }) => [h.key.toLowerCase(), h.value]))
      for (const [key, value] of Object.entries(headers)) expect(sent[key], key).toBe(value)
      // Transport derives these from the URL/body; every application header must be present in both directions.
      const applicationHeaders = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).filter(([key]) => !['host', 'connection', 'content-length'].includes(key)))
      expect(applicationHeaders(headers)).toEqual(applicationHeaders(sent))
      expect(headers).toMatchObject({ 'x-own': 'own', 'x-inherited': '2026', 'x-override': 'request', cookie: 'session=COOKIE-PRIVATE', 'content-type': 'application/json' })
      expect(headers).not.toHaveProperty('x-off')
      expect(headers).not.toHaveProperty('x-folder-off')
      for (const language of ['curl', 'fetch', 'axios', 'python'] as const) {
        const code = formatSnippet(language, preview.snippet)
        for (const header of preview.snippet.headers) { expect(code).toContain(header.key); expect(code).toContain(header.value) }
      }
      const curl = parseCurl(formatSnippet('curl', preview.snippet))!
      expect(Object.fromEntries(curl.input.headers.map(h => [h.key.toLowerCase(), h.value]))).toEqual(headers)
    }
    const savedWithSecretUrl = await (await request.get(`/api/requests/${row.id}`)).json()
    const secretUrlPreview = await (await request.post(`/api/requests/${row.id}/preview`, { data: {
      input: savedWithSecretUrl, environmentId: env.id, auth: { type: 'none' }, personalVars: { baseUrl: origin }, purpose: 'snippet',
    } })).json()
    expect(secretUrlPreview.snippet.url).toContain('{{baseUrl}}')
    expect(secretUrlPreview.snippet.headers.some((h: { key: string }) => h.key.toLowerCase() === 'cookie')).toBe(true)
    expect(JSON.stringify(secretUrlPreview)).not.toContain('COOKIE-PRIVATE')
    // A manually supplied Cookie and Content-Type override the defaults, across body types.
    for (const bodyType of ['json', 'form', 'raw', 'graphql', 'binary', 'none']) for (const customType of [false, true]) {
      const saved = await (await request.get(`/api/requests/${row.id}`)).json()
      const body = bodyType === 'binary' ? JSON.stringify({ filename: 'data.bin', contentType: 'application/octet-stream', dataBase64: 'eA==' }) : bodyType === 'graphql' ? '{ ping }' : 'x=1'
      const input = { ...saved, bodyType, body, headers: [{ key: 'Cookie', value: 'manual=MANUAL-PRIVATE', enabled: true }, { key: 'Content-Type', value: 'custom/type', enabled: customType }] }
      const payload = { input, environmentId: env.id, auth: { type: 'none' } }
      const preview = await (await request.post(`/api/requests/${row.id}/preview`, { data: { ...payload, purpose: 'snippet', revealSecrets: true } })).json()
      const execution = await (await request.post(`/api/requests/${row.id}/execute`, { data: payload })).json()
      const sent = JSON.parse(execution.responseBody)
      for (const h of preview.snippet.headers) expect(sent.headers[h.key.toLowerCase()]).toBe(h.value)
      expect(sent.headers.cookie).toBe('manual=MANUAL-PRIVATE')
      if (customType) expect(sent.headers['content-type']).toBe('custom/type')
    }
  } finally { await request.delete(`/api/workspaces/${ws.id}`) }
})

test('cURL 복사: 머리 버튼·트리·팔레트·단축키, 비밀값 선택, 편집 중 기본 동작', async ({ page, request }) => {
  page.setDefaultTimeout(5000)
  const { ws, env, row } = await seed(request)
  try {
    const other = await (await request.post('/api/requests', { data: { folderId: row.folderId, name: '다른 복사 대상', method: 'GET', url: origin + '/other' } })).json()
    await page.addInitScript(id => {
      localStorage.clear(); localStorage.setItem('ah:workspace', id)
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => { (window as unknown as { copied: string }).copied = text } } })
    }, ws.id)
    await page.goto(`/?req=${row.id}`)
    await page.getByLabel('실행 환경', { exact: true }).selectOption(env.id)
    const copied = () => page.evaluate(() => (window as unknown as { copied?: string }).copied ?? '')
    const dialog = page.getByRole('dialog', { name: '비밀값 복사 확인' })
    await expect(page.getByRole('button', { name: 'cURL 복사', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'cURL 복사', exact: true }).click()
    await expect(dialog).toBeVisible()
    expect(await copied()).toBe('')
    await dialog.getByRole('button', { name: '취소', exact: true }).click()
    expect(await copied()).toBe('')
    await page.getByRole('button', { name: 'cURL 복사', exact: true }).click()
    await dialog.getByRole('button', { name: '변수 참조로 복사' }).click()
    await expect.poll(copied).toContain('Bearer {{token}}')
    expect(await copied()).toContain('Cookie: {{header_Cookie}}')
    expect(await copied()).not.toContain('PRIVATE')
    await expect(page.getByText('cURL 복사됨', { exact: true })).toBeVisible()
    await page.getByLabel('요청 URL', { exact: true }).fill('{{baseUrl}}/draft')
    await page.getByRole('button', { name: '코드 스니펫', exact: true }).click()
    for (const language of ['curl', 'fetch', 'axios', 'python']) {
      await page.getByLabel('코드 언어').selectOption(language)
      await expect(page.getByTestId('live-code-snippet')).toContainText('/draft')
      await expect(page.getByTestId('live-code-snippet')).toContainText('Cookie')
      await expect(page.getByTestId('live-code-snippet')).toContainText('X-Inherited')
    }
    const url = page.getByLabel('요청 URL', { exact: true })
    await url.focus()
    expect(await url.evaluate(el => {
      const e = new KeyboardEvent('keydown', { key: 'C', code: 'KeyC', metaKey: true, shiftKey: true, bubbles: true, cancelable: true }); el.dispatchEvent(e); return e.defaultPrevented
    })).toBe(false)
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
    await page.keyboard.press('ControlOrMeta+Shift+c')
    await dialog.getByRole('button', { name: '실제 값으로 복사' }).click()
    await expect.poll(copied).toContain('session=COOKIE-PRIVATE')
    expect(await copied()).toContain(origin + '/draft')
    expect(await copied()).toContain('Bearer PRIVATE-TOKEN')
    await page.keyboard.press('ControlOrMeta+k')
    const palette = page.getByRole('dialog', { name: '커맨드 팔레트' })
    await palette.getByRole('textbox', { name: '명령·요청 검색' }).fill('cURL 복사')
    await palette.getByRole('button').filter({ hasText: 'cURL 복사' }).click()
    await dialog.getByRole('button', { name: '변수 참조로 복사' }).click()
    await expect.poll(copied).not.toContain('PRIVATE')
    for (const width of [1280, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      const copyButton = page.getByRole('button', { name: 'cURL 복사', exact: true })
      await expect(copyButton).toBeInViewport()
      const bounds = (await copyButton.boundingBox())!
      expect(Math.abs(bounds.y - (await page.getByRole('button', { name: '링크 복사', exact: true }).boundingBox())!.y)).toBeLessThan(3)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width)
      await page.screenshot({ path: `/tmp/postq-curl-${width}.png` })
    }
    // Unopened tree row resolves full input from the server, rather than its slim list data.
    await page.locator(`[data-req-id="${other.id}"]`).hover()
    await page.getByRole('button', { name: '다른 복사 대상 요청 작업', exact: true }).click()
    await page.getByRole('menuitem', { name: 'cURL 복사', exact: true }).click()
    await dialog.getByRole('button', { name: '변수 참조로 복사' }).click()
    await expect.poll(copied).toContain('/other')
    expect(other.id).toBeTruthy()
    await page.screenshot({ path: '/tmp/postq-curl-copy.png' })
  } finally { await request.delete(`/api/workspaces/${ws.id}`) }
})

test('비밀값 없는 요청은 바로 복사하며 미리보기 실패 시 이전 코드를 복사하지 않는다', async ({ page, request }) => {
  const ws = await (await request.post('/api/workspaces', { data: { name: 'e2e-curl-no-secret' } })).json()
  try {
    const folder = await (await request.post('/api/folders', { data: { workspaceId: ws.id, name: '간단한 요청' } })).json()
    const row = await (await request.post('/api/requests', { data: { folderId: folder.id, name: '일반 복사', method: 'GET', url: origin + '/plain' } })).json()
    await page.addInitScript(id => {
      localStorage.clear(); localStorage.setItem('ah:workspace', id)
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => { (window as unknown as { copied: string }).copied = text } } })
    }, ws.id)
    await page.goto(`/?req=${row.id}`)
    await page.getByRole('button', { name: 'cURL 복사', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (window as unknown as { copied?: string }).copied)).toContain('/plain')
    await expect(page.getByRole('dialog', { name: '비밀값 복사 확인' })).toHaveCount(0)
    await page.evaluate(() => { (window as unknown as { copied: string }).copied = 'keep clipboard' })
    await page.route('**/api/requests/*/preview', route => route.fulfill({ status: 503, json: { error: 'preview unavailable' } }))
    await page.getByRole('button', { name: 'cURL 복사', exact: true }).click()
    await expect(page.getByText('코드 복사 실패 — preview unavailable', { exact: true })).toBeVisible()
    expect(await page.evaluate(() => (window as unknown as { copied: string }).copied)).toBe('keep clipboard')
  } finally { await request.delete(`/api/workspaces/${ws.id}`) }
})
