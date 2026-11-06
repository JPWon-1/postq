import { test, expect } from '@playwright/test'

test('binary 파일은 원본 바이트와 MIME으로 실행되고 저장·내보내기·가져오기 후 유지된다', async ({ page, request }) => {
  const workspace = await (await request.post('/api/workspaces', { data: { name: 'e2e-binary' } })).json()
  let destination: { id: string } | undefined
  try {
    const folder = await (await request.post('/api/folders', { data: { workspaceId: workspace.id, name: '파일 API' } })).json()
    const row = await (await request.post('/api/requests', { data: { folderId: folder.id, name: '파일 보내기', method: 'POST', url: `http://127.0.0.1:${process.env.E2E_ECHO_PORT ?? '9999'}/binary` } })).json()
    await page.addInitScript(id => localStorage.setItem('ah:workspace', id), workspace.id)
    await page.goto('/?req=' + row.id)
    await page.getByRole('button', { name: /^Body/ }).click()
    await page.getByLabel('바디 타입', { exact: true }).selectOption('binary')
    const bytes = Buffer.from([0, 255, 128, 1, 13, 10, 123, 125])
    await page.getByLabel('바이너리 본문 파일').setInputFiles({ name: 'payload.bin', mimeType: 'application/x-binary-test', buffer: bytes })
    await expect(page.getByText('payload.bin · application/x-binary-test', { exact: false })).toBeVisible()
    const saved = page.waitForResponse(r => r.url().endsWith('/api/requests/' + row.id) && r.request().method() === 'PUT')
    await page.keyboard.press('ControlOrMeta+s')
    expect((await saved).ok()).toBe(true)
    const result = page.waitForResponse(r => r.url().endsWith('/execute') && r.request().method() === 'POST')
    await page.getByTestId('run-request').click()
    const execution = await (await result).json()
    const echo = JSON.parse(execution.responseBody)
    expect(echo.bodyBase64).toBe(bytes.toString('base64'))
    expect(echo.headers['content-type']).toBe('application/x-binary-test')
    await page.getByRole('button', { name: '코드 스니펫', exact: true }).click()
    await expect(page.getByTestId('live-code-snippet')).toContainText("--data-binary '@payload.bin'")
    await expect(page.getByTestId('live-code-snippet')).not.toContainText(bytes.toString('base64'))
    await page.screenshot({ path: '/tmp/postq-binary.png' })
    await page.reload()
    await page.getByRole('button', { name: /^Body/ }).click()
    await expect(page.getByLabel('바디 타입', { exact: true })).toHaveValue('binary')
    await expect(page.getByText('payload.bin · application/x-binary-test', { exact: false })).toBeVisible()

    const exported = await (await request.get('/api/export')).json()
    const own = { ...exported, folders: exported.folders.filter((f: { id: string }) => f.id === folder.id), requests: exported.requests.filter((r: { id: string }) => r.id === row.id), environments: [], flows: [], globalVars: [] }
    destination = await (await request.post('/api/workspaces', { data: { name: 'e2e-binary-import' } })).json()
    expect((await request.post('/api/import/postq', { data: { ...own, workspaceId: destination!.id } })).status()).toBe(201)
    const imported = await (await request.get('/api/requests?workspaceId=' + destination!.id)).json()
    const full = await (await request.get('/api/requests/' + imported[0].id)).json()
    expect(full.bodyType).toBe('binary')
    expect(JSON.parse(full.body).dataBase64).toContain(bytes.toString('base64'))
  } finally {
    await request.delete('/api/workspaces/' + workspace.id)
    if (destination) await request.delete('/api/workspaces/' + destination.id)
  }
})

test('Postman file 모드는 파일 경로를 읽지 않고 재첨부를 요구한다', async ({ request }) => {
  const workspace = await (await request.post('/api/workspaces', { data: { name: 'e2e-file-import' } })).json()
  try {
    const response = await request.post('/api/import/postman', { data: { workspaceId: workspace.id, collection: {
      info: { name: '파일 예제' }, item: [{ name: '파일', request: { method: 'POST', url: `http://127.0.0.1:${process.env.E2E_ECHO_PORT ?? '9999'}/binary`, body: { mode: 'file', file: { src: '/private/example/payload.bin' } } } }],
    } } })
    expect(response.status()).toBe(201)
    const rows = await (await request.get('/api/requests?workspaceId=' + workspace.id)).json()
    const row = await (await request.get('/api/requests/' + rows[0].id)).json()
    expect(row.bodyType).toBe('binary')
    expect(JSON.parse(row.body)).toMatchObject({ filename: 'payload.bin', dataBase64: null })
    const result = await (await request.post('/api/requests/' + row.id + '/execute', { data: { input: row } })).json()
    expect(result.error).toContain('다시 첨부')
  } finally { await request.delete('/api/workspaces/' + workspace.id) }
})
