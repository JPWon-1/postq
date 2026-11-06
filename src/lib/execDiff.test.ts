import { describe, expect, it } from 'vitest'
import { assertLabel, compareEntries, compareExecutions, headersToMap, kvToMap, pretty } from './execDiff'
import type { ExecutionRow } from './ui-types'

const exec = (over: Partial<ExecutionRow> = {}): ExecutionRow => ({
  id: 'x', requestId: 'r', executedBy: 'me', executedAt: 1_700_000_000_000,
  environmentId: 'stage',
  resolved: { method: 'GET', url: 'https://a/x', params: [], headers: [], bodyType: 'none', body: '' },
  responseStatus: 200, responseHeaders: { 'Content-Type': 'application/json' },
  responseBody: '{"ok":true}', durationMs: 100, error: null, missingVariables: [],
  ...over,
})

describe('compareEntries', () => {
  it('한쪽에만 있는 키도 빠뜨리지 않는다', () => {
    const d = compareEntries({ a: '1' }, { b: '2' })
    expect(d.map(f => [f.key, f.onlyIn])).toEqual([['a', 'a'], ['b', 'b']])
    expect(d.every(f => !f.same)).toBe(true)
  })

  it('없는 것과 값이 다른 것을 구분한다', () => {
    const [only] = compareEntries({ k: 'v' }, {})
    expect(only.onlyIn).toBe('a')
    const [diff] = compareEntries({ k: 'v' }, { k: 'w' })
    expect(diff.onlyIn).toBeUndefined()
    expect(diff.same).toBe(false)
  })

  it('같으면 same', () => {
    expect(compareEntries({ k: 'v' }, { k: 'v' })[0].same).toBe(true)
  })
})

describe('kvToMap / headersToMap', () => {
  it('꺼둔 항목은 보내지 않으므로 비교에서도 뺀다', () => {
    expect(kvToMap([{ key: 'a', value: '1', enabled: false }, { key: 'b', value: '2' }])).toEqual({ b: '2' })
  })

  // 하나만 남기면 '값이 같다' 는 거짓말이 된다 — 실제로는 둘 다 전송된다.
  it('같은 키가 여러 번이면 이어 붙인다', () => {
    expect(kvToMap([{ key: 'id', value: '1' }, { key: 'id', value: '2' }])).toEqual({ id: '1, 2' })
  })

  it('빈 키는 버린다 — 편집 중인 빈 줄이 차이로 잡히면 안 된다', () => {
    expect(kvToMap([{ key: '', value: 'x' }])).toEqual({})
  })

  // Content-Type 과 content-type 을 다르다고 하면 매번 가짜 차이가 뜬다.
  it('응답 헤더는 대소문자를 안 가린다', () => {
    expect(headersToMap({ 'Content-Type': 'a' })).toEqual({ 'content-type': 'a' })
    const d = compareEntries(headersToMap({ 'Content-Type': 'a' }), headersToMap({ 'content-type': 'a' }))
    expect(d[0].same).toBe(true)
  })
})

describe('pretty', () => {
  it('JSON 은 들여쓴다', () => {
    expect(pretty('{"a":1}')).toBe('{\n  "a": 1\n}')
  })
  // 파싱 실패로 내용을 잃으면 비교 자체가 불가능해진다.
  it('JSON 이 아니면 원문 그대로', () => {
    expect(pretty('<html>')).toBe('<html>')
    expect(pretty(null)).toBe('')
  })
})

describe('compareExecutions', () => {
  it('완전히 같으면 변경 0', () => {
    const a = exec(), b = exec({ id: 'y' })
    expect(compareExecutions(a, b).changed).toBe(0)
  })

  // 이게 예전 화면이 못 잡던 것들이다 — 바디만 비교했다.
  it('환경이 다르면 잡는다', () => {
    const { sections } = compareExecutions(exec(), exec({ environmentId: 'prod' }))
    const meta = sections.find(s => s.id === 'meta')!
    expect(meta.fields.find(f => f.key === '환경')!.same).toBe(false)
    expect(meta.changed).toBeGreaterThan(0)
  })

  it('요청 헤더가 하나 빠진 것을 잡는다', () => {
    const withAuth = exec({ resolved: { ...exec().resolved, headers: [{ key: 'Authorization', value: 'Bearer x', enabled: true }] } })
    const { sections } = compareExecutions(withAuth, exec())
    const req = sections.find(s => s.id === 'request')!
    const f = req.fields.find(x => x.key === 'header: Authorization')!
    expect(f.onlyIn).toBe('a')
    expect(f.same).toBe(false)
  })

  it('URL 쿼리 한 글자 차이도 잡는다', () => {
    const { sections } = compareExecutions(exec(), exec({ resolved: { ...exec().resolved, url: 'https://a/y' } }))
    expect(sections.find(s => s.id === 'request')!.fields.find(f => f.key === 'URL')!.same).toBe(false)
  })

  it('응답 헤더 차이를 잡는다', () => {
    const { sections } = compareExecutions(exec(), exec({ responseHeaders: { 'Content-Type': 'text/html' } }))
    expect(sections.find(s => s.id === 'response')!.changed).toBeGreaterThan(0)
  })

  it('상태 코드와 바디를 함께 잡는다', () => {
    const { sections, changed } = compareExecutions(exec(), exec({ responseStatus: 401, responseBody: '{"code":"E"}' }))
    const res = sections.find(s => s.id === 'response')!
    expect(res.fields.find(f => f.key === '상태')!.same).toBe(false)
    expect(res.text!.a).not.toBe(res.text!.b)
    expect(changed).toBeGreaterThanOrEqual(2)
  })

  it('에러 실행은 상태가 ERR 로 마주 본다', () => {
    const { sections } = compareExecutions(exec(), exec({ error: 'ENOTFOUND', responseStatus: null }))
    expect(sections.find(s => s.id === 'response')!.fields.find(f => f.key === '상태')!.b).toBe('ERR')
  })

  it('검증 규칙은 순서가 달라도 같은 것끼리 마주 본다', () => {
    const mk = (pass: boolean) => ({ assertion: { target: 'status' as const, op: 'eq' as const, expected: '200' }, pass, actual: '200', message: '' })
    const other = { assertion: { target: 'responseTime' as const, op: 'lt' as const, expected: '500' }, pass: true, actual: '10', message: '' }
    const a = exec({ assertionResults: [mk(true), other] })
    const b = exec({ assertionResults: [other, mk(false)] })
    const sec = compareExecutions(a, b).sections.find(s => s.id === 'assertions')!
    expect(sec.fields).toHaveLength(2)
    expect(sec.fields.find(f => f.key === 'status eq 200')!.same).toBe(false)
    expect(sec.fields.find(f => f.key === 'responseTime lt 500')!.same).toBe(true)
  })

  it('resolved 가 없는 옛 기록도 죽지 않는다', () => {
    const broken = { ...exec(), resolved: undefined } as unknown as ExecutionRow
    expect(() => compareExecutions(broken, exec())).not.toThrow()
  })

  it('assertLabel 은 사람이 읽는 한 줄', () => {
    expect(assertLabel({ target: 'jsonPath', path: 'data.id', op: 'eq', expected: '5' })).toBe('jsonPath data.id eq 5')
    expect(assertLabel({ target: 'status', op: 'exists' })).toBe('status exists')
  })
})
