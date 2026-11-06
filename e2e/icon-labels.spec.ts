import { mockSnippetPreview } from './snippet-fixture'
import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'

for (const theme of ['dark', 'light'] as const) {
  test(`이름 있는 도구와 요청별 패널 — ${theme}`, async ({ page }) => {
    test.setTimeout(60_000)
    await page.emulateMedia({ colorScheme: theme })
    await page.addInitScript(() => {
      localStorage.clear()
      // 제거된 패널의 과거 저장값도 빈 패널로 복원하지 않는다.
      localStorage.setItem('postq:right-tab', 'mcp')
    })
    const req = { id: 'icons-request', folderId: 'icons-folder', name: '샘플 조회', method: 'GET', url: 'https://example.test/items', params: [], headers: [], bodyType: 'none', body: '', description: '', origin: 'manual', specState: null }
    await page.route('**/api/folders?*', r => r.fulfill({ json: [] }))
    await page.route('**/api/requests?*', r => r.fulfill({ json: [] }))
    await page.goto('/')
    await expect(page.getByRole('button', { name: '예시 요청 열어 보기' })).toBeVisible()
    await expect(page.getByRole('navigation', { name: '오른쪽 패널', exact: true })).toHaveCount(0)
    const header = page.locator('header').first()
    const settingsButton = header.getByRole('button', { name: '설정', exact: true })
    await expect(settingsButton).toHaveText('')
    await expect(settingsButton).not.toHaveAttribute('title')
    await expect(header.getByRole('button', { name: '단축키 보기' })).toHaveCount(0)
    const themeButton = header.getByRole('button', { name: '테마 바꾸기', exact: true })
    await expect(themeButton).toHaveText('')
    await expect(themeButton).not.toHaveAttribute('title')
    await expect(themeButton.locator('svg')).toHaveCount(1)
    await expect(themeButton.locator('svg')).toHaveAttribute('data-icon', theme === 'dark' ? 'moon' : 'sun')
    await expect(settingsButton.locator('svg')).toHaveAttribute('data-icon', 'settings')
    for (const [button, name] of [[themeButton, '테마 바꾸기'], [settingsButton, '설정']] as const) {
      await button.hover()
      await expect(page.getByRole('tooltip')).toHaveText(name, { timeout: 200 })
      await expect(page.getByRole('tooltip')).toBeVisible({ timeout: 200 })
      await page.mouse.move(0, 0)
      await expect(page.getByRole('tooltip')).toHaveCount(0)
      await button.focus()
      await expect(page.getByRole('tooltip')).toHaveText(name, { timeout: 200 })
      await expect(button).toHaveAttribute('aria-describedby', await page.getByRole('tooltip').getAttribute('id') as string)
      await page.keyboard.press('Escape')
      await expect(page.getByRole('tooltip')).toHaveCount(0)
      await button.evaluate(el => el.blur())
    }
    const capture = process.env.ICON_CAPTURE_DIR
    if (capture) {
      await mkdir(capture, { recursive: true })
      await page.screenshot({ path: `${capture}/empty-${theme}.png` })
    }
    await themeButton.click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme === 'dark' ? 'light' : 'dark')
    await expect(themeButton.locator('svg')).toHaveAttribute('data-icon', theme === 'dark' ? 'sun' : 'moon')
    await themeButton.click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await page.route('**/api/folders?*', r => r.fulfill({ json: [{ id: 'icons-folder', name: '샘플 API', sharedHeaders: [] }] }))
    await page.route('**/api/requests?*', r => r.fulfill({ json: [req] }))
    await page.route('**/api/requests/icons-request', r => r.fulfill({ json: req }))
    await mockSnippetPreview(page)
    await page.goto('/?req=icons-request')
    const nav = page.getByRole('navigation', { name: '오른쪽 패널', exact: true })
    await expect(nav.getByRole('button')).toHaveText(['', ''])
    await nav.getByRole('button', { name: '코드 스니펫' }).click()
    await expect(page.getByTestId('live-code-snippet')).toContainText('https://example.test/items')
    for (const width of [1280, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      const unmarked = await page.locator('button:visible').evaluateAll(buttons => buttons.filter(button => !/[\p{L}\p{N}]/u.test(button.textContent ?? '') && !button.hasAttribute('data-icon-button')).map(button => button.outerHTML))
      expect(unmarked).toEqual([])
      const icons = page.locator('[data-icon-button="true"]:visible')
      expect(await icons.count()).toBeGreaterThan(20)
      // 현재 화면의 모든 보조 아이콘을 검사한다. 이름·툴팁 없이 새 아이콘을 추가할 수 없다.
      for (const button of await icons.all()) {
        const label = await button.getAttribute('aria-label')
        expect(label?.trim()).toBeTruthy()
        await expect(button).toHaveText('')
        await expect(button).not.toHaveAttribute('title')
        await expect(button.locator('svg[aria-hidden="true"]')).toHaveCount(1)
        const box = await button.boundingBox()
        expect(box?.width).toBe(28)
        expect(box?.height).toBe(28)
        const svg = await button.locator('svg').boundingBox()
        expect(svg?.width).toBe(16)
        expect(svg?.height).toBe(16)
        if (await button.isDisabled()) continue
        await button.focus()
        await button.hover()
        await expect(page.getByRole('tooltip')).toContainText(label!, { timeout: 200 })
        await expect(page.getByRole('tooltip')).toBeVisible({ timeout: 200 })
        await page.mouse.move(0, 0)
        await button.evaluate(el => el.blur())
        await button.focus()
        await expect(page.getByRole('tooltip')).toContainText(label!, { timeout: 200 })
        await button.evaluate(el => el.blur())
      }
      if (capture) await page.screenshot({ path: `${capture}/request-${theme}-${width}.png` })
    }
    const display = page.getByRole('group', { name: '요청 표시 방식' })
    await display.getByRole('button', { name: '문서 보기' }).click()
    await expect(display.getByRole('button', { name: '문서 보기' })).toHaveAttribute('aria-pressed', 'true')
    await display.getByRole('button', { name: '요청 편집' }).click()
    await page.getByRole('button', { name: '집중 모드', exact: true }).click()
    await expect(page.getByRole('button', { name: '집중 모드 해제' })).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: '집중 모드 해제' }).click()
    await nav.getByRole('button', { name: '변수', exact: true }).click()
    await page.getByRole('button', { name: '환경 · 변수 관리', exact: true }).last().click()
    await expect(page.getByRole('dialog')).toBeVisible()
    const close = page.getByRole('button', { name: '설정 닫기', exact: true })
    await close.hover()
    await expect(page.getByRole('tooltip')).toHaveText('설정 닫기', { timeout: 200 })
    await expect(close).not.toHaveAttribute('title')
    const tip = await page.getByRole('tooltip').boundingBox()
    const viewport = page.viewportSize()!
    expect(tip!.x).toBeGreaterThanOrEqual(0)
    expect(tip!.x + tip!.width).toBeLessThanOrEqual(viewport.width)
    await close.click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    // 대화상자를 연 버튼으로 포커스가 복원되면 해당 버튼의 툴팁이 즉시 보인다.
    await expect(page.getByRole('tooltip')).toHaveText('환경 · 변수 관리', { timeout: 200 })
    await page.keyboard.press('Escape')
    await expect(page.getByRole('tooltip')).toHaveCount(0)
  })
}

test('늦게 끝난 이전 프로젝트 조회가 새 프로젝트 트리를 덮어쓰지 않는다', async ({ page }) => {
  let release!: () => void
  let oldFinished!: () => void
  const delayed = new Promise<void>(resolve => { release = resolve })
  const finished = new Promise<void>(resolve => { oldFinished = resolve })
  await page.addInitScript(() => { localStorage.clear(); localStorage.setItem('ah:workspace', 'race-ws') })
  await page.route('**/api/workspaces', r => r.fulfill({ json: [{ id: 'default', name: '기본' }, { id: 'race-ws', name: '새 프로젝트' }] }))
  await page.route('**/api/folders?*', r => r.fulfill({ json: [{ id: new URL(r.request().url()).searchParams.get('workspaceId') === 'race-ws' ? 'new-folder' : 'old-folder', name: '조회 폴더', sharedHeaders: [] }] }))
  await page.route('**/api/requests?*', async r => {
    const current = new URL(r.request().url()).searchParams.get('workspaceId') === 'race-ws'
    if (!current) await delayed
    await r.fulfill({ json: [{ id: current ? 'new-request' : 'old-request', folderId: current ? 'new-folder' : 'old-folder', name: current ? '현재 요청' : '이전 요청', method: 'GET', url: 'https://example.test', params: [], headers: [], body: '', bodyType: 'none' }] })
    if (!current) oldFinished()
  })
  await page.goto('/')
  await expect(page.locator('[data-req-id="new-request"]')).toBeVisible()
  release()
  await finished
  await expect(page.locator('[data-req-id="new-request"]')).toBeVisible()
  await expect(page.locator('[data-req-id="old-request"]')).toHaveCount(0)
})
