import { getByPath } from './jsonLeaves'

// 응답 assertion — 스크립트 없이 규칙으로 status/필드값/응답시간/헤더를 단언한다.
// Postman의 test 스크립트가 하는 일의 90%를 UI 규칙으로 대체(도구 철학: 쉬움).

export type AssertOp = 'eq' | 'ne' | 'contains' | 'exists' | 'notExists' | 'lt' | 'gt' | 'matches'
export type AssertTarget = 'status' | 'responseTime' | 'body' | 'jsonPath' | 'header'
export type Assertion = {
  target: AssertTarget
  path?: string   // jsonPath: dot 경로, header: 헤더명
  op: AssertOp
  expected?: string
}

export type AssertContext = {
  status: number | null
  durationMs: number | null
  body: string | null
  headers: Record<string, string> | null
}

export type AssertResult = { assertion: Assertion; pass: boolean; actual: string; message: string }

function actualValue(a: Assertion, ctx: AssertContext): string | undefined {
  switch (a.target) {
    case 'status': return ctx.status != null ? String(ctx.status) : undefined
    case 'responseTime': return ctx.durationMs != null ? String(ctx.durationMs) : undefined
    case 'body': return ctx.body ?? undefined
    case 'header': {
      if (!ctx.headers || !a.path) return undefined
      // path 가 비문자열(손편집/레거시 저장)이어도 .toLowerCase() 크래시 없이 안전하게.
      const want = String(a.path).toLowerCase()
      const key = Object.keys(ctx.headers).find(k => k.toLowerCase() === want)
      return key ? ctx.headers[key] : undefined
    }
    case 'jsonPath': {
      if (ctx.body == null || !a.path) return undefined
      try { return getByPath(JSON.parse(ctx.body), a.path) } catch { return undefined }
    }
  }
}

/**
 * 숫자로 읽는다. 숫자로 볼 수 없으면 null.
 *
 * Number('') 와 Number(' ') 는 0 이다. 그래서 값이 빈 필드에 `< 100` 을 걸면
 * 0 < 100 이 되어 **통과**했다. 테스트 도구에서 거짓 통과는 가장 나쁜 결과다 —
 * 실패를 놓치는 것보다, 실패를 성공이라 말하는 쪽이 사람을 더 멀리 보낸다.
 */
function asNumber(v: string | undefined): number | null {
  if (v === undefined) return null
  if (v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 비교 결과와, 비교 자체를 못 한 이유(있으면). 이유는 실패 메시지에 그대로 실린다. */
type OpOutcome = { pass: boolean; problem?: string }

function applyOp(op: AssertOp, actual: string | undefined, expected: string | undefined): OpOutcome {
  switch (op) {
    case 'exists': return { pass: actual !== undefined }
    case 'notExists': return { pass: actual === undefined }
    case 'eq': return { pass: actual === expected }
    case 'ne': return { pass: actual !== expected }
    case 'contains': return { pass: actual !== undefined && expected !== undefined && actual.includes(expected) }
    case 'matches': {
      if (actual === undefined || expected === undefined) return { pass: false }
      let re: RegExp
      // 정규식이 틀렸으면 그냥 '실패' 로 넘기고 있었다. 데이터가 안 맞은 건지 내가 쓴
      // 패턴이 깨진 건지 화면에서 구분할 수 없었다 — 둘은 고치는 방법이 전혀 다르다.
      try { re = new RegExp(expected) }
      catch (e) { return { pass: false, problem: `정규식이 올바르지 않습니다 — ${e instanceof Error ? e.message : String(e)}` } }
      return { pass: re.test(actual) }
    }
    case 'lt':
    case 'gt': {
      const a = asNumber(actual)
      const b = asNumber(expected)
      if (a === null || b === null) {
        const which = a === null ? '실제값' : '기댓값'
        return { pass: false, problem: `${which}이 숫자가 아니라 크기를 비교할 수 없습니다` }
      }
      return { pass: op === 'lt' ? a < b : a > b }
    }
    default: return { pass: false }
  }
}

const TARGET_LABEL: Record<AssertTarget, string> = {
  status: '상태 코드', responseTime: '응답 시간(ms)', body: '응답 바디', jsonPath: 'JSON', header: '헤더',
}
const OP_LABEL: Record<AssertOp, string> = {
  eq: '=', ne: '≠', contains: '포함', exists: '존재', notExists: '없음', lt: '<', gt: '>', matches: '정규식',
}

export function describeAssertion(a: Assertion): string {
  const t = a.target === 'jsonPath' || a.target === 'header' ? `${TARGET_LABEL[a.target]} ${a.path ?? ''}` : TARGET_LABEL[a.target]
  const rhs = a.op === 'exists' || a.op === 'notExists' ? '' : ` ${a.expected ?? ''}`
  return `${t} ${OP_LABEL[a.op]}${rhs}`.trim()
}

/** exists/notExists 는 기댓값을 쓰지 않는다 — 메시지에 '기대: ' 를 붙이면 헷갈린다. */
function needsExpected(op: AssertOp): boolean {
  return op !== 'exists' && op !== 'notExists'
}

/** 값을 따옴표로 감싼다 — 앞뒤 공백이 눈에 보여야 '같아 보이는데 왜 실패하지' 가 풀린다. */
function quote(v: string | undefined): string {
  return v === undefined ? '없음' : `"${v}"`
}

/** 응답에 assertion 목록을 평가한다. */
export function evaluateAssertions(assertions: Assertion[], ctx: AssertContext): AssertResult[] {
  // 손상 저장/드래프트로 배열에 null·비객체 요소가 섞여도 그 항목만 건너뛰고 실행이 안 깨지게 한다.
  return assertions.filter(a => a && typeof a === 'object').map(a => {
    const actual = actualValue(a, ctx)
    const { pass, problem } = applyOp(a.op, actual, a.expected)
    // 실패 메시지에 실제값만 있었다. 기댓값이 안 보이니 '실패 (실제: 200)' 을 보고도
    // 뭐가 다른지 알 수 없다 — 기댓값 끝에 공백이 붙은 경우가 특히 그랬다.
    const detail = problem ?? (needsExpected(a.op) ? `기대: ${quote(a.expected)} · 실제: ${quote(actual)}` : `실제: ${quote(actual)}`)
    return {
      assertion: a, pass,
      actual: actual ?? '(없음)',
      message: `${describeAssertion(a)} — ${pass ? '통과' : `실패 (${detail})`}`,
    }
  })
}
