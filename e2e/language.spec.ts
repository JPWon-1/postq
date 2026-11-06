import { expect, test } from '@playwright/test'

test('switches between English and Korean without reloading', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('rail-settings').click()
  await page.getByTestId('settings-display').click()
  await page.getByRole('combobox', { name: '언어' }).selectOption('en')
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Display · Theme' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Search requests and commands (⌘K)' })).toBeVisible()
  const errorInEnglish = await page.evaluate(async () => {
    const response = await fetch('/api/workspaces', { method: 'POST', body: 'not-json' })
    return (await response.json()).error as string
  })
  expect(errorInEnglish).toBe('Invalid JSON body')
  await page.getByRole('combobox', { name: 'Language' }).selectOption('ko')
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko')
  await expect(page.getByRole('dialog', { name: '설정' })).toBeVisible()
  await expect(page.getByRole('button', { name: '요청·명령 검색 (⌘K)' })).toBeVisible()
  const errorInKorean = await page.evaluate(async () => {
    const response = await fetch('/api/workspaces', { method: 'POST', body: 'not-json' })
    return (await response.json()).error as string
  })
  expect(errorInKorean).toBe('본문이 올바른 JSON 이 아닙니다')
})
