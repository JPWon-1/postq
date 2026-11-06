import { expect, test } from '@playwright/test'

test('confirm-writes: banner and two-step human confirmation precede execution', async ({ page, request }) => {
  const folder = await (await request.post('/api/folders', { data: { name: 'e2e-safety' } })).json()
  const env = await (await request.post('/api/environments', { data: { name: `e2e-confirm-${Date.now()}`, executionPolicy: 'confirm-writes' } })).json()
  const saved = await (await request.post('/api/requests', { data: {
    folderId: folder.id, name: 'e2e-safety-write', method: 'POST', url: `http://${process.env.E2E_HOST_ALIAS ?? 'localhost'}:${process.env.E2E_ECHO_PORT ?? '9999'}/echo`, bodyType: 'json', body: '{"test":true}',
  } })).json()
  try {
    await page.addInitScript(() => {
      localStorage.setItem('ah:workspace', 'default')
    })
    await page.goto(`/?req=${saved.id}`)
    await page.getByLabel('실행 환경', { exact: true }).selectOption(env.id)
    await expect(page.getByTestId('execution-policy-banner')).toContainText('사람이 확인한 후')
    let sent = 0
    page.on('request', req => { if (req.url().endsWith(`/api/requests/${saved.id}/execute`)) sent++ })
    await page.getByTestId('run-request').click()
    const dialog = page.getByRole('dialog', { name: '쓰기 요청 실행 확인' })
    await expect(dialog).toBeVisible()
    expect(sent).toBe(0)
    expect(await (await request.get(`/api/requests/${saved.id}/executions`)).json()).toHaveLength(0)
    await dialog.getByRole('button', { name: '취소', exact: true }).click()
    expect(sent).toBe(0)
    await page.getByTestId('run-request').click()
    const response = page.waitForResponse(res => res.url().endsWith(`/api/requests/${saved.id}/execute`))
    await page.getByRole('button', { name: '확인 후 쓰기 실행' }).click()
    const result = await (await response).json()
    expect(result.error).toBeNull()
    expect(result.executionSource).toBe('ui')
    expect(result.responseStatus).toBe(200)
    expect(sent).toBe(1)
    expect(await (await request.get(`/api/requests/${saved.id}/executions`)).json()).toHaveLength(1)
  } finally {
    await request.delete(`/api/folders/${folder.id}`)
    await request.delete(`/api/environments/${env.id}`)
  }
})

for (const mode of ['auto', 'step']) test(`scenario ${mode}: denied write explains reason and next action`, async ({ page, request }) => {
  const folder = await (await request.post('/api/folders', { data: { name: `e2e-safety-flow-${mode}` } })).json()
  const env = await (await request.post('/api/environments', { data: { name: `e2e-flow-confirm-${mode}`, executionPolicy: 'confirm-writes' } })).json()
  const saved = await (await request.post('/api/requests', { data: {
    folderId: folder.id, name: 'e2e-scenario-write', method: 'POST', url: `http://${process.env.E2E_HOST_ALIAS ?? 'localhost'}:${process.env.E2E_ECHO_PORT ?? '9999'}/echo`,
  } })).json()
  const flow = await (await request.post('/api/flows', { data: { name: `e2e-safety-${mode}`, steps: [{ requestId: saved.id, extracts: [] }] } })).json()
  const reason = '쓰기 확인이 필요한 환경이라 시나리오에서는 실행되지 않음 — 요청 화면에서 확인 후 실행'
  try {
    await page.addInitScript(() => {
      localStorage.setItem('ah:workspace', 'default')
    })
    await page.goto(`/?flow=${flow.id}`)
    await page.getByLabel('실행 환경', { exact: true }).selectOption(env.id)
    await expect(page.getByTestId('scenario-policy-notice')).toHaveText(reason)
    await page.getByLabel('실행 모드', { exact: true }).selectOption(mode)
    await page.getByRole('button', { name: mode === 'auto' ? '▶ 시나리오 실행' : '▶ 1단계 실행', exact: true }).click()
    await expect(page.getByTestId('scenario-run-error')).toContainText(reason)
    await page.locator('button.ah-node').first().click()
    await expect(page.getByTestId('scenario-step-error')).toHaveText(reason)
    const history = await (await request.get(`/api/requests/${saved.id}/executions`)).json()
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ denialReason: reason, executionSource: 'flow', responseStatus: null })
    if (mode === 'auto') {
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: '지난 실행', exact: true }).click()
      await expect(page.getByText(`1단계 — ${reason}`, { exact: true })).toBeVisible()
    }
  } finally {
    await request.delete(`/api/flows/${flow.id}`)
    await request.delete(`/api/folders/${folder.id}`)
    await request.delete(`/api/environments/${env.id}`)
  }
})
