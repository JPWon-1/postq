import { extractPathParameters, extractVariables } from './variables'
import type { FlowStep } from './flowChain'

/**
 * 시나리오를 실행하기 전에, 값이 어디서 와서 어디로 가는지 보여준다.
 *
 * 지금은 돌려 봐야 안다. 3단계짜리 시나리오에서 2단계가 터지면 로그를 뒤져
 * "아, 1단계가 뽑기로 한 token 이 실제로는 다른 이름이었네" 를 알아낸다. 그런데 그건
 * 실행 전에 알 수 있는 것들이다 — 어떤 변수를 쓰는지, 그게 앞 단계가 만드는 것인지,
 * 아무도 안 만드는 것인지, 순서가 뒤집혔는지.
 *
 * 여기서 하는 건 정적 분석이다. 실제 값은 응답을 받아야 알지만, '연결이 이어져 있는가'
 * 는 값 없이도 판정할 수 있고 실수는 대개 연결에서 난다.
 */

export type VarOrigin =
  /** 이 스텝의 vars (단계 전용 입력) */
  | { kind: 'stepVar' }
  /** 앞 스텝이 응답에서 뽑아 넘겨준 값 */
  | { kind: 'extract'; step: number; path: string }
  /** prevBody/prevStatus/stepNBody — 추출 규칙 없이 자동으로 생기는 것 */
  | { kind: 'auto'; step: number }
  /** 환경·전역·요청 변수 */
  | { kind: 'env' }
  /** 어디에도 없음 — 실행하면 {{이름}} 그대로 전송된다 */
  | { kind: 'missing' }
  /** 뒤 스텝이 만드는 값을 앞에서 참조 — 순서가 뒤집혔다 */
  | { kind: 'later'; step: number }

export type StepPreview = {
  index: number
  name: string
  method: string
  /** 이 스텝이 실제로 보낼 URL(템플릿). 스텝 오버라이드가 있으면 그것. */
  url: string
  bodySource: 'template' | 'prev' | 'custom'
  /** 이 스텝이 쓰는 변수와 그 출처 */
  consumes: { name: string; origin: VarOrigin }[]
  /** 이 스텝이 응답에서 뽑아 다음으로 넘기는 값 */
  produces: { variable: string; path: string; usedBy: number[] }[]
  /** 자동으로 생기는 것 — 규칙 없이도 다음 스텝이 쓸 수 있다 */
  autoProduces: string[]
  problems: string[]
}

export type FlowPreview = {
  steps: StepPreview[]
  /** 실행 전에 고쳐야 할 것 — 하나라도 있으면 돌려도 십중팔구 실패한다 */
  problems: { step: number; message: string }[]
}

/** 요청 템플릿에서 이 미리보기가 필요로 하는 것만. */
export type PreviewRequest = {
  id: string; name: string; method: string; url: string
  params: { key: string; value: string; enabled: boolean }[]
  headers: { key: string; value: string; enabled: boolean }[]
  body: string
}

const AUTO_PREV = ['prevBody', 'prevStatus']
const stepBodyVar = (i: number) => `step${i + 1}Body`

/** 스텝 하나가 실제로 보낼 내용 — 오버라이드가 있으면 템플릿 대신 그것을 본다. */
function effective(step: FlowStep, req: PreviewRequest) {
  const body = step.bodySource === 'prev' ? '{{prevBody}}'
    : step.bodySource === 'custom' ? (step.bodyOverride ?? '')
      : req.body
  return {
    url: step.url ?? req.url,
    params: step.params ?? req.params,
    headers: step.headers ?? req.headers,
    body,
  }
}

export function previewFlow(
  steps: FlowStep[],
  requestById: Map<string, PreviewRequest>,
  /** 환경·전역·공유 변수 이름 — 값은 필요 없다. 연결만 본다. */
  knownVars: Set<string>,
): FlowPreview {
  // 어떤 변수를 몇 번째 스텝이 만드는지 먼저 모은다. 뒤에서 만드는 걸 앞에서 쓰는
  // 경우를 잡으려면 전체를 한 번 훑고 나서 판정해야 한다.
  const producedAt = new Map<string, { step: number; path: string }>()
  steps.forEach((s, i) => {
    for (const e of s.extracts ?? []) {
      if (!e.variable || !e.path) continue
      // 같은 이름을 여러 스텝이 만들면 마지막이 이긴다 — 실행도 그렇게 동작한다.
      producedAt.set(e.variable, { step: i, path: e.path })
    }
  })

  const problems: { step: number; message: string }[] = []
  const consumedBy = new Map<string, number[]>()

  const out: StepPreview[] = steps.map((s, i) => {
    const req = requestById.get(s.requestId)
    if (!req) {
      problems.push({ step: i, message: '요청 템플릿을 찾을 수 없습니다 — 삭제된 요청입니다' })
      return {
        index: i, name: '(삭제된 요청)', method: '—', url: '', bodySource: s.bodySource ?? 'template',
        consumes: [], produces: [], autoProduces: [], problems: ['요청 템플릿을 찾을 수 없습니다'],
      }
    }
    const eff = effective(s, req)
    // method/bodyType 은 변수 스캔과 무관하지만 타입이 요구한다 — 실제 값을 넘긴다.
    const names = extractVariables({
      method: req.method, bodyType: 'json',
      url: eff.url, params: eff.params, headers: eff.headers, body: eff.body,
    })
    names.push(...extractPathParameters(eff.url).filter(name => !names.includes(name)))
    const stepVarNames = new Set((s.vars ?? []).filter(v => v.key).map(v => v.key))
    const stepProblems: string[] = []

    const consumes = names.map(name => {
      let origin: VarOrigin
      if (stepVarNames.has(name)) origin = { kind: 'stepVar' }
      else if (AUTO_PREV.includes(name)) {
        if (i === 0) {
          origin = { kind: 'missing' }
          stepProblems.push(`{{${name}}} 는 직전 스텝의 응답인데, 이게 1번째 스텝입니다 — 직전이 없습니다`)
        } else origin = { kind: 'auto', step: i - 1 }
      } else if (/^step(\d+)Body$/.test(name)) {
        const n = Number(/^step(\d+)Body$/.exec(name)![1]) - 1
        if (n >= i) {
          origin = { kind: 'later', step: n }
          stepProblems.push(`{{${name}}} 는 ${n + 1}번째 스텝의 응답인데 여기는 ${i + 1}번째입니다 — 아직 실행되지 않았습니다`)
        } else if (n < 0 || n >= steps.length) {
          origin = { kind: 'missing' }
          stepProblems.push(`{{${name}}} 가 가리키는 스텝이 없습니다`)
        } else origin = { kind: 'auto', step: n }
      } else {
        const p = producedAt.get(name)
        if (p && p.step < i) origin = { kind: 'extract', step: p.step, path: p.path }
        else if (p && p.step >= i) {
          origin = { kind: 'later', step: p.step }
          stepProblems.push(`{{${name}}} 는 ${p.step + 1}번째 스텝이 만드는 값인데 여기는 ${i + 1}번째입니다 — 순서가 뒤집혔습니다`)
        } else if (knownVars.has(name)) origin = { kind: 'env' }
        else {
          origin = { kind: 'missing' }
          stepProblems.push(`{{${name}}} 는 환경에도 없고 앞 스텝도 만들지 않습니다 — 그대로(리터럴) 전송됩니다`)
        }
      }
      if (origin.kind === 'extract' || origin.kind === 'auto') {
        const list = consumedBy.get(name) ?? []
        list.push(i)
        consumedBy.set(name, list)
      }
      return { name, origin }
    })

    for (const p of stepProblems) problems.push({ step: i, message: p })

    return {
      index: i,
      name: s.name || req.name,
      method: req.method,
      url: eff.url,
      bodySource: s.bodySource ?? 'template',
      consumes,
      produces: (s.extracts ?? []).filter(e => e.variable && e.path).map(e => ({ variable: e.variable, path: e.path, usedBy: [] })),
      autoProduces: [...AUTO_PREV, stepBodyVar(i)],
      problems: stepProblems,
    }
  })

  // 누가 쓰는지 되돌려 채운다. 아무도 안 쓰는 추출은 대개 오타다 —
  // 실행하면 조용히 성공하고, 정작 필요한 스텝에는 값이 안 간다.
  for (const sp of out) {
    for (const p of sp.produces) {
      p.usedBy = consumedBy.get(p.variable) ?? []
      if (p.usedBy.length === 0) {
        const msg = `'${p.variable}' 를 뽑지만 뒤에서 아무도 쓰지 않습니다 — 변수 이름이 다를 수 있습니다`
        sp.problems.push(msg)
        problems.push({ step: sp.index, message: msg })
      }
    }
  }

  return { steps: out, problems }
}
