import type { Page } from '@playwright/test'
import { resolveRequest, type VarMap } from '../src/lib/variables'

// UI-only fixtures have no corresponding server rows. Real server parity is covered in curl-copy.spec.ts.
export async function mockSnippetPreview(page: Page, variables: (environmentId: string | null) => VarMap = () => ({})) {
  await page.route('**/api/requests/*/preview', route => {
    const body = route.request().postDataJSON()
    if (body.purpose !== 'snippet') return route.fallback()
    const vars = { ...variables(body.environmentId), ...Object.fromEntries((body.vars ?? []).map((v: { key: string; value: string }) => [v.key, { value: v.value, secret: false }])) }
    const snippet = resolveRequest(body.input, vars).redacted
    return route.fulfill({ json: { snippet, hasSecrets: JSON.stringify(snippet).includes('{{'), authError: null } })
  })
}
