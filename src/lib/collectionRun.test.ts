import { expect, test } from 'vitest'
import { collectRunInputs, planRunRows } from './collectionRun'
import { isWriteMethod } from './executionPolicy'
import type { RequestInput } from './variables'
const input: RequestInput = { method: 'GET', url: 'https://test/{customerNumber}/{{orderCode}}/{{generated}}', params: [], headers: [], bodyType: 'none', body: '' }
test('collect missing path/template inputs once, reuse environment defaults, conceal secrets and omit generated/request defaults', () => {
  const team = { orderCode: { value: 'env-order', secret: false }, customerNumber: { value: 'private-value', secret: true } }
  expect(collectRunInputs([{ input, vars: team, generated: ['generated'] }, { input, vars: team, generated: ['generated'] }], team)).toEqual([
    { name: 'orderCode', value: 'env-order', secret: false, supplied: true },
    { name: 'customerNumber', value: '', secret: true, supplied: true },
  ])
  const missing = collectRunInputs([{ input, vars: { orderCode: { value: 'request-default', secret: false } }, generated: ['generated'] }], {})
  expect(missing.map(i => i.name)).toEqual(['customerNumber'])
})
test('writes are counted by shared policy and excluded by default; policy denial takes precedence', () => {
  const rows = ['GET', 'HEAD', 'POST', 'DELETE'].map((method, i) => ({ id: String(i), name: method, method }))
  expect(rows.filter(r => isWriteMethod(r.method))).toHaveLength(2)
  expect(planRunRows(rows).map(r => r.state)).toEqual(['waiting', 'waiting', 'skipped', 'skipped'])
  expect(planRunRows(rows, 'open', true).every(r => r.state === 'waiting')).toBe(true)
  expect(planRunRows(rows, 'read-only', true)[2].denialReason).toContain('읽기 전용')
})
