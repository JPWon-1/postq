import { mockSnippetPreview } from './snippet-fixture'
import { test, expect, type Page } from '@playwright/test'

const longUrl = 'https://api.example.com/v1/very/long/path?x=1'
async function boot(page: Page) {
  let row = { id: 'editing-r', workspaceId: 'default', folderId: 'editing-f', name: '편집 테스트', method: 'GET', url: '{{baseUrl}}/orders', params: [], headers: [], bodyType: 'none', body: '', description: '', origin: 'manual', specState: null, updatedAt: 1 }
  let env = { id: 'editing-env', name: '테스트 환경', updatedAt: 1, variables: [{ id: 'base', key: 'baseUrl', value: longUrl, secret: false }] }
  const globals: Record<string, unknown[]> = {}
  await page.addInitScript(() => { localStorage.clear(); localStorage.setItem('ah:workspace', 'default'); localStorage.setItem('ah:mode', 'collection'); window.confirm = () => false })
  await page.route('**/api/workspaces', r => r.fulfill({ json: [{ id: 'default', name: '기본' }, { id: 'other', name: '다른 프로젝트' }] }))
  await page.route('**/api/folders?*', r => r.fulfill({ json: [{ id: 'editing-f', name: '샘플', specSourceType: 'none', sharedHeaders: [] }] }))
  await page.route('**/api/requests?*', r => r.fulfill({ json: [row] }))
  await page.route('**/api/requests/editing-r', r => {
    if (r.request().method() === 'PUT') row = { ...row, ...r.request().postDataJSON(), updatedAt: row.updatedAt + 1 }
    return r.fulfill({ json: row })
  })
  await page.route('**/api/environments?*', r => r.fulfill({ json: [env] }))
  await page.route('**/api/environments/editing-env', r => { env = { ...env, ...r.request().postDataJSON(), updatedAt: env.updatedAt + 1 }; return r.fulfill({ json: env }) })
  await page.route('**/api/global-vars**', r => {
    if (r.request().method() === 'PUT') { const data = r.request().postDataJSON(); globals[data.workspaceId] = data.variables; return r.fulfill({ json: {} }) }
    return r.fulfill({ json: globals[new URL(r.request().url()).searchParams.get('workspaceId') ?? '*'] ?? [] })
  })
  await mockSnippetPreview(page, id => Object.fromEntries([
    ...(globals['*'] ?? []), ...(globals.default ?? []), ...(id === env.id ? env.variables : []),
  ].map(v => { const item = v as { key: string; value: string; secret: boolean }; return [item.key, { value: item.value, secret: item.secret }] })))
  await page.goto('/?req=editing-r')
  await expect(page.getByLabel('요청 URL', { exact: true })).toBeVisible()
  await page.getByRole('combobox', { name: '실행 환경', exact: true }).selectOption('editing-env')
  return { row: () => row, env: () => env, globals }
}
const confirmation = (page: Page) => page.getByRole('dialog', { name: '저장하지 않은 변경', exact: true })

test('project switch offers cancel, save and discard even when native confirm is unavailable', async ({ page }) => {
  const state = await boot(page)
  const url = page.getByLabel('요청 URL', { exact: true })
  await url.fill('https://example.test/changed')
  await page.getByLabel('프로젝트', { exact: true }).selectOption('other')
  await confirmation(page).getByRole('button', { name: '취소', exact: true }).click()
  await expect(url).toHaveValue('https://example.test/changed')
  await expect(page.getByLabel('프로젝트', { exact: true })).toHaveValue('default')
  await page.keyboard.press('ControlOrMeta+]')
  await confirmation(page).getByRole('button', { name: '저장', exact: true }).click()
  await expect(page.getByLabel('프로젝트', { exact: true })).toHaveValue('other')
  expect(state.row().url).toBe('https://example.test/changed')
})

test('failed save keeps edited request and original project', async ({ page }) => {
  await boot(page)
  await page.route('**/api/requests/editing-r', r => r.request().method() === 'PUT' ? r.fulfill({ status: 500, json: { error: 'test' } }) : r.fallback())
  await page.getByLabel('요청 URL', { exact: true }).fill('https://example.test/unsaved')
  await page.getByLabel('프로젝트', { exact: true }).selectOption('other')
  await confirmation(page).getByRole('button', { name: '저장', exact: true }).click()
  await expect(page.getByLabel('프로젝트', { exact: true })).toHaveValue('default')
  await expect(page.getByLabel('요청 URL', { exact: true })).toHaveValue('https://example.test/unsaved')
})

test('discard switches project without saving', async ({ page }) => {
  const state = await boot(page)
  await page.getByLabel('요청 URL', { exact: true }).fill('https://example.test/discard')
  await page.getByLabel('프로젝트', { exact: true }).selectOption('other')
  await confirmation(page).getByRole('button', { name: '버리기', exact: true }).click()
  await expect(page.getByLabel('프로젝트', { exact: true })).toHaveValue('other')
  expect(state.row().url).toBe('{{baseUrl}}/orders')
})

test('desktop menu closes request tab, asks once for unsaved changes and does nothing with no tabs', async ({ page }) => {
  const state = await boot(page)
  await page.getByLabel('요청 URL', { exact: true }).fill('https://example.test/close')
  const close = () => page.evaluate(() => window.dispatchEvent(new Event('postq:close-request-tab')))
  await close(); await close()
  await expect(confirmation(page)).toHaveCount(1)
  await confirmation(page).getByRole('button', { name: '취소', exact: true }).click()
  await expect(page.getByLabel('요청 URL', { exact: true })).toBeVisible()
  await close()
  await confirmation(page).getByRole('button', { name: '저장', exact: true }).click()
  await expect(page.getByRole('tablist', { name: '열린 요청', exact: true })).toHaveCount(0)
  expect(state.row().url).toBe('https://example.test/close')
  await close()
  await expect(page.getByRole('heading', { name: '이어서 하기' })).toBeVisible()
})

test('Option Shift Left selects text without automatic shortcut hints', async ({ page }) => {
  await boot(page)
  const input = page.getByLabel('요청 URL', { exact: true })
  await input.fill('https://example.test/alpha beta')
  await input.press('End')
  await page.keyboard.down('Alt'); await page.keyboard.down('Shift')
  await page.keyboard.press('ArrowLeft')
  await page.waitForTimeout(250)
  expect(await input.evaluate(el => (el as HTMLInputElement).selectionEnd! > (el as HTMLInputElement).selectionStart!)).toBe(true)
  await expect(page.getByText('요청 퀵오픈 (전체 검색)', { exact: true })).toHaveCount(0)
  await page.keyboard.up('Shift'); await page.keyboard.up('Alt')
})

for (const width of [1280, 1440]) test(`variable values show whole URLs at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 })
  await boot(page)
  await page.getByTestId('rail-settings').click()
  await page.getByTestId('settings-env').click()
  await page.getByLabel('환경 선택', { exact: true }).selectOption('editing-env')
  const value = page.getByLabel('변수 값', { exact: true }).first()
  await expect(value).toHaveValue(longUrl)
  const personal = page.getByLabel('내 값 (개인 오버라이드)', { exact: true }).first()
  await personal.fill(longUrl)
  await personal.locator('..').getByRole('button', { name: '보기', exact: true }).click()
  for (const field of [value, personal]) expect(await field.evaluate(el => el.scrollHeight <= el.clientHeight + 2 && el.scrollWidth <= el.clientWidth + 2)).toBe(true)
  await page.screenshot({ path: `/tmp/postq-variable-${width}.png` })
  await page.getByLabel('환경 선택', { exact: true }).selectOption('__GLOBAL_ALL__')
  await page.getByRole('button', { name: '+ 변수', exact: true }).click()
  await page.getByLabel('변수 키', { exact: true }).last().fill('globalUrl')
  const globalValue = page.getByLabel('변수 값', { exact: true }).last()
  await globalValue.fill(longUrl)
  expect(await globalValue.evaluate(el => el.scrollHeight <= el.clientHeight + 2 && el.scrollWidth <= el.clientWidth + 2)).toBe(true)
  await page.screenshot({ path: `/tmp/postq-global-variable-${width}.png` })
})

test('shared variable popover saves environment and global values, updates snippets, supports cancel and undefined variables', async ({ page }) => {
  const state = await boot(page)
  await page.getByLabel('baseUrl 변수 값', { exact: true }).hover()
  let popover = page.getByRole('dialog', { name: 'baseUrl 변수 편집' })
  await popover.getByLabel('변수 편집 값').fill('https://changed.example.test')
  await popover.getByLabel('변수 편집 값').press('Enter')
  await expect(popover).toHaveCount(0)
  expect(state.env().variables[0].value).toBe('https://changed.example.test')
  await page.getByRole('button', { name: '코드 스니펫', exact: true }).click()
  await expect(page.getByTestId('live-code-snippet')).toContainText('https://changed.example.test/orders')
  await page.getByRole('button', { name: '변수', exact: true }).click()
  const panel = page.getByRole('complementary', { name: '요청 보조 패널' })
  await panel.getByRole('button', { name: 'baseUrl 값 편집', exact: true }).click()
  await panel.getByLabel('baseUrl 값', { exact: true }).fill('cancelled')
  await panel.getByLabel('baseUrl 값', { exact: true }).press('Escape')
  expect(state.env().variables[0].value).toBe('https://changed.example.test')
  await page.getByLabel('요청 URL', { exact: true }).fill('{{newHost}}/orders')
  await page.getByLabel('newHost 변수 값', { exact: true }).click()
  popover = page.getByRole('dialog', { name: 'newHost 변수 편집' })
  await popover.getByLabel('변수 저장 범위').selectOption('all')
  await popover.getByLabel('변수 편집 값').fill('https://global.example.test')
  await popover.getByRole('button', { name: '저장', exact: true }).click()
  await expect(page.getByLabel('newHost 변수 값', { exact: true }).first()).toContainText('전역')
  expect(state.globals['*']).toEqual([expect.objectContaining({ key: 'newHost', value: 'https://global.example.test' })])
})

test('personal variable edits remain masked, can be revealed and use the same URL badge editor', async ({ page }) => {
  await boot(page)
  const url = page.getByLabel('요청 URL', { exact: true })
  await url.evaluate(el => { (el as HTMLInputElement).setSelectionRange(3, 3); el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  const popover = page.getByRole('dialog', { name: 'baseUrl 변수 편집' })
  await expect(popover).toBeVisible()
  await popover.getByLabel('변수 저장 범위').selectOption('personal')
  const input = popover.getByLabel('변수 편집 값')
  await input.fill('https://personal.example.test')
  expect(await input.evaluate(el => getComputedStyle(el).getPropertyValue('-webkit-text-security'))).toBe('disc')
  await popover.getByRole('button', { name: '보기', exact: true }).click()
  expect(await input.evaluate(el => getComputedStyle(el).getPropertyValue('-webkit-text-security'))).not.toBe('disc')
  await input.press('Enter')
  await expect(page.getByLabel('baseUrl 변수 값', { exact: true })).toContainText('개인')
  await page.getByLabel('baseUrl 변수 값', { exact: true }).click()
  await expect(popover.getByLabel('변수 편집 값')).toHaveValue('https://personal.example.test')
})

test('variable save failure keeps the editor and draft available', async ({ page }) => {
  await boot(page)
  await page.route('**/api/environments/editing-env', r => r.fulfill({ status: 409, json: { error: 'conflict' } }))
  await page.getByLabel('baseUrl 변수 값', { exact: true }).click()
  const popover = page.getByRole('dialog', { name: 'baseUrl 변수 편집' })
  await popover.getByLabel('변수 편집 값').fill('https://unsaved.example.test')
  await popover.getByRole('button', { name: '저장', exact: true }).click()
  await expect(popover.getByRole('alert')).toContainText('다른 변경')
  await expect(popover.getByLabel('변수 편집 값')).toHaveValue('https://unsaved.example.test')
})

test('undefined variable is added to the current environment without removing existing keys', async ({ page }) => {
  const state = await boot(page)
  await page.getByLabel('요청 URL', { exact: true }).fill('{{missingHost}}/orders')
  await page.getByLabel('missingHost 변수 값', { exact: true }).click()
  const popover = page.getByRole('dialog', { name: 'missingHost 변수 편집' })
  await expect(popover.getByLabel('변수 저장 범위')).toHaveValue('env')
  await popover.getByLabel('변수 편집 값').fill('https://new.example.test')
  await popover.getByLabel('변수 편집 값').press('Enter')
  await expect(popover).toHaveCount(0)
  expect(state.env().variables).toEqual(expect.arrayContaining([
    expect.objectContaining({ key: 'baseUrl', value: longUrl }),
    expect.objectContaining({ key: 'missingHost', value: 'https://new.example.test' }),
  ]))
  await page.getByRole('button', { name: '코드 스니펫', exact: true }).click()
  await expect(page.getByTestId('live-code-snippet')).toContainText('https://new.example.test/orders')
})
