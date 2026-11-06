import { describe, expect, it } from 'vitest'
import { evaluateAssertions, describeAssertion, type AssertContext, type Assertion } from './assertions'

const ctx = {
  status: 200, durationMs: 42,
  body: '{"data":{"id":7,"status":"ACTIVE"},"items":[1,2]}',
  headers: { 'content-type': 'application/json', 'x-total': '5' },
}

describe('evaluateAssertions', () => {
  it('상태 코드 eq', () => {
    expect(evaluateAssertions([{ target: 'status', op: 'eq', expected: '200' }], ctx)[0].pass).toBe(true)
    expect(evaluateAssertions([{ target: 'status', op: 'eq', expected: '201' }], ctx)[0].pass).toBe(false)
  })
  it('응답 시간 lt', () => {
    expect(evaluateAssertions([{ target: 'responseTime', op: 'lt', expected: '100' }], ctx)[0].pass).toBe(true)
    expect(evaluateAssertions([{ target: 'responseTime', op: 'lt', expected: '10' }], ctx)[0].pass).toBe(false)
  })
  it('jsonPath 값/존재', () => {
    expect(evaluateAssertions([{ target: 'jsonPath', path: 'data.status', op: 'eq', expected: 'ACTIVE' }], ctx)[0].pass).toBe(true)
    expect(evaluateAssertions([{ target: 'jsonPath', path: 'data.id', op: 'exists' }], ctx)[0].pass).toBe(true)
    expect(evaluateAssertions([{ target: 'jsonPath', path: 'data.nope', op: 'notExists' }], ctx)[0].pass).toBe(true)
  })
  it('body contains / matches', () => {
    expect(evaluateAssertions([{ target: 'body', op: 'contains', expected: 'ACTIVE' }], ctx)[0].pass).toBe(true)
    expect(evaluateAssertions([{ target: 'body', op: 'matches', expected: '"id":\\d+' }], ctx)[0].pass).toBe(true)
  })
  it('header eq (대소문자 무시)', () => {
    expect(evaluateAssertions([{ target: 'header', path: 'Content-Type', op: 'contains', expected: 'json' }], ctx)[0].pass).toBe(true)
    expect(evaluateAssertions([{ target: 'header', path: 'X-Total', op: 'eq', expected: '5' }], ctx)[0].pass).toBe(true)
  })
  it('actual + message 포함', () => {
    const r = evaluateAssertions([{ target: 'status', op: 'eq', expected: '500' }], ctx)[0]
    expect(r.actual).toBe('200')
    expect(r.message).toContain('실패')
  })
  it('body가 JSON 아니어도 jsonPath는 실패로(크래시 안 함)', () => {
    const r = evaluateAssertions([{ target: 'jsonPath', path: 'a', op: 'exists' }], { ...ctx, body: 'plain' })
    expect(r[0].pass).toBe(false)
  })
})

describe('describeAssertion', () => {
  it('사람이 읽는 요약', () => {
    expect(describeAssertion({ target: 'status', op: 'eq', expected: '200' })).toBe('상태 코드 = 200')
    expect(describeAssertion({ target: 'jsonPath', path: 'data.id', op: 'exists' })).toBe('JSON data.id 존재')
  })
})

describe('손상 저장값 방어 (비문자열 path / 무효 요소)', () => {
  const c = { status: 200, durationMs: 10, body: '{"a":1}', headers: { 'X-Trace': 'abc' } }
  it('header 타깃 path 가 비문자열이어도 크래시하지 않는다', () => {
    // 손편집/레거시로 path 가 숫자면 과거엔 a.path.toLowerCase() 로 500
    const rules = [{ target: 'header', op: 'exists', path: 123 } as unknown as Assertion]
    expect(() => evaluateAssertions(rules, c)).not.toThrow()
    expect(evaluateAssertions(rules, c)[0].pass).toBe(false)  // '123' 헤더는 없음
  })
  it('null·비객체 요소는 건너뛴다', () => {
    const rules = [null, 42, { target: 'status', op: 'eq', expected: '200' }] as unknown as Assertion[]
    const res = evaluateAssertions(rules, c)
    expect(res).toHaveLength(1)
    expect(res[0].pass).toBe(true)
  })
})

describe('크기 비교 — 숫자로 볼 수 없으면 통과시키지 않는다', () => {
  const withBody = (body: string): AssertContext =>
    ({ status: 200, durationMs: 50, body, headers: {} })

  it('빈 값에 < 는 통과가 아니다', () => {
    // Number('') 는 0 이라 예전엔 0 < 100 으로 통과했다. 테스트 도구의 거짓 통과다.
    const r = evaluateAssertions(
      [{ target: 'jsonPath', path: 'count', op: 'lt', expected: '100' }],
      withBody('{"count":""}'))[0]
    expect(r.pass).toBe(false)
    expect(r.message).toContain('숫자가 아니라')
  })

  it('공백만 있는 값도 마찬가지', () => {
    expect(evaluateAssertions(
      [{ target: 'jsonPath', path: 'count', op: 'lt', expected: '100' }],
      withBody('{"count":"  "}'))[0].pass).toBe(false)
  })

  it('기댓값이 숫자가 아니면 이유를 말한다', () => {
    const r = evaluateAssertions(
      [{ target: 'responseTime', op: 'gt', expected: '빠름' }],
      withBody('{}'))[0]
    expect(r.pass).toBe(false)
    expect(r.message).toContain('기댓값이 숫자가 아니라')
  })

  it('숫자 문자열은 그대로 비교된다', () => {
    expect(evaluateAssertions(
      [{ target: 'jsonPath', path: 'n', op: 'lt', expected: '100' }],
      withBody('{"n":"42"}'))[0].pass).toBe(true)
    expect(evaluateAssertions(
      [{ target: 'jsonPath', path: 'n', op: 'gt', expected: '100' }],
      withBody('{"n":"42"}'))[0].pass).toBe(false)
  })
})

describe('실패 메시지', () => {
  const ctx2: AssertContext = { status: 200, durationMs: 5, body: '{}', headers: {} }

  it('기댓값도 같이 보여준다 — 공백 차이를 눈으로 찾을 수 있게', () => {
    const r = evaluateAssertions([{ target: 'status', op: 'eq', expected: '200 ' }], ctx2)[0]
    expect(r.pass).toBe(false)
    expect(r.message).toContain('기대: "200 "')
    expect(r.message).toContain('실제: "200"')
  })

  it('존재 검사에는 기댓값을 안 붙인다', () => {
    const r = evaluateAssertions([{ target: 'header', path: 'x-none', op: 'exists' }], ctx2)[0]
    expect(r.message).not.toContain('기대:')
  })

  it('깨진 정규식은 데이터 실패가 아니라 패턴 문제라고 말한다', () => {
    const r = evaluateAssertions([{ target: 'body', op: 'matches', expected: '([' }], ctx2)[0]
    expect(r.pass).toBe(false)
    expect(r.message).toContain('정규식이 올바르지 않습니다')
  })
})
