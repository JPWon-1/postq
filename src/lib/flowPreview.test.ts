import { describe, expect, it } from 'vitest'
import { previewFlow, type PreviewRequest } from './flowPreview'
import type { FlowStep } from './flowChain'

const req = (over: Partial<PreviewRequest> = {}): PreviewRequest => ({
  id: 'r1', name: '로그인', method: 'POST', url: 'https://a/login',
  params: [], headers: [], body: '', ...over,
})

const reqs = (...list: PreviewRequest[]) => new Map(list.map(r => [r.id, r]))
const step = (requestId: string, over: Partial<FlowStep> = {}): FlowStep =>
  ({ requestId, extracts: [], ...over })

describe('previewFlow — 값이 어디서 와서 어디로 가는가', () => {
  it('1차가 뽑은 값을 2차가 쓰면 연결로 잡는다', () => {
    const r1 = req({ id: 'a', name: '로그인' })
    const r2 = req({ id: 'b', name: '내 정보', url: 'https://a/me', headers: [{ key: 'Authorization', value: 'Bearer {{token}}', enabled: true }] })
    const { steps, problems } = previewFlow(
      [step('a', { extracts: [{ path: 'data.token', variable: 'token' }] }), step('b')],
      reqs(r1, r2), new Set(),
    )
    expect(problems).toEqual([])
    expect(steps[0].produces[0]).toMatchObject({ variable: 'token', path: 'data.token', usedBy: [1] })
    expect(steps[1].consumes).toEqual([{ name: 'token', origin: { kind: 'extract', step: 0, path: 'data.token' } }])
  })

  // 이게 실행해 봐야만 알던 것이다 — 2차가 만드는 걸 1차에서 쓰면 1차는 빈 값으로 나간다.
  it('뒤 스텝이 만드는 값을 앞에서 쓰면 순서가 뒤집혔다고 말한다', () => {
    const r1 = req({ id: 'a', url: 'https://a/x?t={{token}}' })
    const r2 = req({ id: 'b' })
    const { steps, problems } = previewFlow(
      [step('a'), step('b', { extracts: [{ path: 'data.token', variable: 'token' }] })],
      reqs(r1, r2), new Set(),
    )
    expect(steps[0].consumes[0].origin).toEqual({ kind: 'later', step: 1 })
    expect(problems[0].message).toContain('순서가 뒤집혔습니다')
  })

  it('어디에도 없는 변수는 리터럴로 나간다고 말한다', () => {
    const { steps, problems } = previewFlow(
      [step('a')], reqs(req({ id: 'a', url: 'https://a/{{userId}}' })), new Set(),
    )
    expect(steps[0].consumes[0].origin).toEqual({ kind: 'missing' })
    expect(problems[0].message).toContain('리터럴')
  })

  it('환경에 있는 변수는 문제가 아니다', () => {
    const { steps, problems } = previewFlow(
      [step('a')], reqs(req({ id: 'a', url: '{{baseUrl}}/x' })), new Set(['baseUrl']),
    )
    expect(steps[0].consumes[0].origin).toEqual({ kind: 'env' })
    expect(problems).toEqual([])
  })

  it('스텝 전용 vars 가 있으면 그게 출처다', () => {
    const { steps, problems } = previewFlow(
      [step('a', { vars: [{ key: 'id', value: '7' }] })],
      reqs(req({ id: 'a', url: 'https://a/{{id}}' })), new Set(),
    )
    expect(steps[0].consumes[0].origin).toEqual({ kind: 'stepVar' })
    expect(problems).toEqual([])
  })

  // 조용히 성공하고 정작 필요한 곳엔 값이 안 가는 유형 — 대개 이름 오타다.
  it('아무도 안 쓰는 추출은 짚어 준다', () => {
    const { problems } = previewFlow(
      [step('a', { extracts: [{ path: 'data.token', variable: 'tokne' }] }), step('b')],
      reqs(req({ id: 'a' }), req({ id: 'b' })), new Set(),
    )
    expect(problems.some(p => p.message.includes("'tokne'") && p.message.includes('아무도 쓰지 않습니다'))).toBe(true)
  })

  describe('자동 변수', () => {
    it('prevBody 는 직전 스텝에서 온다', () => {
      const { steps, problems } = previewFlow(
        [step('a'), step('b', { bodySource: 'prev' })],
        reqs(req({ id: 'a' }), req({ id: 'b' })), new Set(),
      )
      expect(steps[1].consumes[0]).toEqual({ name: 'prevBody', origin: { kind: 'auto', step: 0 } })
      expect(problems).toEqual([])
    })

    it('1번째 스텝의 prevBody 는 직전이 없다고 말한다', () => {
      const { problems } = previewFlow([step('a', { bodySource: 'prev' })], reqs(req({ id: 'a' })), new Set())
      expect(problems[0].message).toContain('직전이 없습니다')
    })

    it('stepNBody 로 두 단계 앞의 응답도 참조할 수 있다', () => {
      const { steps, problems } = previewFlow(
        [step('a'), step('b'), step('c', { bodySource: 'custom', bodyOverride: '{"prev": {{step1Body}}}' })],
        reqs(req({ id: 'a' }), req({ id: 'b' }), req({ id: 'c' })), new Set(),
      )
      expect(steps[2].consumes[0].origin).toEqual({ kind: 'auto', step: 0 })
      expect(problems).toEqual([])
    })

    it('아직 실행되지 않은 스텝의 응답을 참조하면 잡는다', () => {
      const { problems } = previewFlow(
        [step('a', { bodySource: 'custom', bodyOverride: '{{step2Body}}' }), step('b')],
        reqs(req({ id: 'a' }), req({ id: 'b' })), new Set(),
      )
      expect(problems[0].message).toContain('아직 실행되지 않았습니다')
    })
  })

  it('스텝 오버라이드가 있으면 템플릿이 아니라 그것을 본다', () => {
    const { steps } = previewFlow(
      [step('a', { url: 'https://a/{{override}}' })],
      reqs(req({ id: 'a', url: 'https://a/{{template}}' })), new Set(['override', 'template']),
    )
    expect(steps[0].url).toBe('https://a/{{override}}')
    expect(steps[0].consumes.map(c => c.name)).toEqual(['override'])
  })

  it('삭제된 요청을 가리키는 스텝도 죽지 않는다', () => {
    const { steps, problems } = previewFlow([step('없는id')], reqs(), new Set())
    expect(steps[0].name).toBe('(삭제된 요청)')
    expect(problems[0].message).toContain('찾을 수 없습니다')
  })

  it('같은 이름을 여러 스텝이 만들면 마지막이 이긴다 — 실행과 같은 규칙', () => {
    const r = (id: string) => req({ id })
    const { steps } = previewFlow(
      [
        step('a', { extracts: [{ path: 'p1', variable: 't' }] }),
        step('b', { extracts: [{ path: 'p2', variable: 't' }] }),
        step('c'),
      ],
      reqs(r('a'), r('b'), req({ id: 'c', url: 'https://a/{{t}}' })), new Set(),
    )
    expect(steps[2].consumes[0].origin).toEqual({ kind: 'extract', step: 1, path: 'p2' })
  })

  it('빈 시나리오도 죽지 않는다', () => {
    expect(previewFlow([], reqs(), new Set())).toEqual({ steps: [], problems: [] })
  })

  it('꺼둔 파라미터는 전송되지 않으므로 분석에서도 뺀다', () => {
    const { problems } = previewFlow(
      [step('a')],
      reqs(req({ id: 'a', params: [{ key: 'x', value: '{{nope}}', enabled: false }] })),
      new Set(),
    )
    expect(problems).toEqual([])
  })
})

it('tracks extracted values used by OpenAPI path parameters, including URL overrides', () => {
  const result = previewFlow([
    step('a', { extracts: [{ path: 'data.orders.0.id', variable: 'usageId' }] }),
    step('b', { url: 'https://example.test/usages/{usageId}' }),
  ], reqs(req({ id: 'a' }), req({ id: 'b' })), new Set())
  expect(result.steps[0].produces[0].usedBy).toEqual([1])
  expect(result.steps[1].consumes).toContainEqual({ name: 'usageId', origin: { kind: 'extract', step: 0, path: 'data.orders.0.id' } })
  expect(result.problems).toEqual([])
})
