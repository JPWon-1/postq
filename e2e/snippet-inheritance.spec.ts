import { test, expect } from '@playwright/test'

test('폴더 인증·헤더 스니펫은 실행 우선순위를 따르고 secret 참조를 보존한다', async ({ page, request }) => {
  const workspace = await (await request.post('/api/workspaces', { data: { name: 'e2e-inherited-code' } })).json()
  try {
    const folder = await (await request.post('/api/folders', { data: { workspaceId: workspace.id, name: '공통 설정' } })).json()
    await request.put('/api/folders/' + folder.id, { data: {
      sharedHeaders: [{ key: 'X-Shared', value: 'folder', enabled: true }, { key: 'X-Version', value: '{{version}}', enabled: true }, { key: 'X-Token', value: '{{token}}', enabled: true }],
      sharedAuth: { type: 'bearer', token: '{{token}}' },
    } })
    const env = await (await request.post('/api/environments', { data: { workspaceId: workspace.id, name: '검증 환경' } })).json()
    await request.put('/api/environments/' + env.id, { data: { name: '검증 환경', variables: [{ key: 'version', value: '3', secret: false }, { key: 'token', value: 'E2E-PRIVATE-TOKEN', secret: true }] } })
    const row = await (await request.post('/api/requests', { data: { folderId: folder.id, name: '상속 요청', method: 'POST', url: `http://127.0.0.1:${process.env.E2E_ECHO_PORT ?? '9999'}/inherited` } })).json()
    await request.put('/api/requests/' + row.id, { data: { auth: { type: 'inherit' }, headers: [{ key: 'x-shared', value: 'request', enabled: true }] } })
    await page.addInitScript(id => localStorage.setItem('ah:workspace', id), workspace.id)
    await page.goto('/?req=' + row.id)
    await page.getByLabel('실행 환경', { exact: true }).selectOption(env.id)
    await page.getByRole('button', { name: '코드 스니펫', exact: true }).click()
    const code = page.getByTestId('live-code-snippet')
    for (const lang of ['curl', 'fetch', 'axios', 'python']) {
      await page.getByLabel('코드 언어').selectOption(lang)
      await expect(code).toContainText('Bearer {{token}}')
      await expect(code).toContainText('X-Version')
      await expect(code).toContainText('request')
      await expect(code).not.toContainText('E2E-PRIVATE-TOKEN')
      await expect(code).not.toContainText('X-Shared')
    }
    await page.screenshot({ path: '/tmp/postq-inherited-code.png' })
    const done = page.waitForResponse(r => r.url().endsWith('/execute'))
    await page.getByTestId('run-request').click()
    const result = await (await done).json()
    const sent = JSON.parse(result.responseBody)
    expect(sent.headers['x-shared']).toBe('request')
    expect(sent.headers['x-version']).toBe('3')
    expect(sent.auth).toBe('Bearer E2E-PRIVATE-TOKEN')
    // 저장된 리터럴 인증은 조회로 드러내지 않으면서 스니펫에서 빠뜨리지 않는다.
    await request.put('/api/folders/' + folder.id, { data: { sharedAuth: { type: 'bearer', token: 'STORED-PRIVATE-TOKEN' } } })
    await page.reload()
    await expect(page.getByTestId('live-code-snippet')).toContainText('Bearer {{bearerToken}}')
    await expect(page.getByTestId('live-code-snippet')).not.toContainText('STORED-PRIVATE-TOKEN')
  } finally { await request.delete('/api/workspaces/' + workspace.id) }
})
