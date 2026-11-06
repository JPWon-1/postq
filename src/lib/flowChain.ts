import { getByPath } from './jsonLeaves'
import type { VarMap } from './variables'

// 시나리오(플로우) 체인 — 스텝 정의와 응답값 추출/전달의 순수 로직.

/**
 * 응답에서 값을 뽑아 다음 단계로 넘기는 규칙.
 *
 * secret: 뽑은 값을 이력에서 가린다. post-step 추출에는 원래 있던 개념인데 여기엔
 * 없어서, 로그인 응답의 토큰을 뽑아 다음 단계에 쓰면 그 값이 팀이 보는 이력에
 * 평문으로 남았다. Authorization 헤더에 넣을 때만 헤더 이름 덕에 우연히 가려졌고,
 * URL 쿼리(?access_token=)나 바디에 넣으면 그대로 보였다(실측).
 */
export type ExtractRule = { path: string; variable: string; secret?: boolean }
// 스텝 요청 바디의 출처:
// - 'template'(기본/미지정): 저장된 요청 템플릿의 바디 그대로
// - 'prev': 직전 스텝의 응답 바디를 통짜로({{prevBody}}) — "응답 → 다음 요청 바디"
// - 'custom': bodyOverride 를 바디로(변수 참조 가능) — 직접 작성
export type StepBodySource = 'template' | 'prev' | 'custom'
// vars = 이 단계 전용 입력값(pre). 공통값·앞 단계 추출값보다 우선하며 그 단계에만 적용된다
// (같은 요청을 단계마다 다른 값으로 돌리기 위함 — 다음 단계로 전파되지 않는다).
export type FlowStep = {
  requestId: string; extracts: ExtractRule[]
  /** 이 시나리오에서만 쓰는 단계 이름. 요청 템플릿 이름은 바꾸지 않는다. */
  name?: string
  bodySource?: StepBodySource; bodyOverride?: string
  vars?: { key: string; value: string }[]
  // 스텝별 요청값 오버라이드 — 같은 템플릿을 단계마다 다른 파라미터/헤더/URL 로 보내기 위함.
  // undefined 면 템플릿 값을 그대로 쓴다(오버라이드 없음).
  params?: { key: string; value: string; enabled: boolean; description?: string }[]
  headers?: { key: string; value: string; enabled: boolean; description?: string }[]
  url?: string
}

/**
 * 스텝 응답 바디에서 추출 규칙을 적용해 다음 스텝에 넘길 변수 오버레이를 만든다.
 * 추출값은 환경에 저장하지 않는다 — 이 실행 안에서만 유효한 런타임 값.
 */
export function applyExtracts(responseBody: string | null, rules: ExtractRule[]): {
  extracted: Record<string, string>
  missing: string[]
} {
  const extracted: Record<string, string> = {}
  const missing: string[] = []
  if (rules.length === 0) return { extracted, missing }
  let parsed: unknown = null
  try { parsed = responseBody ? JSON.parse(responseBody) : null } catch { /* JSON 아님 */ }
  for (const r of rules) {
    if (!r.path || !r.variable) continue
    const v = parsed !== null ? getByPath(parsed, r.path) : undefined
    if (v === undefined) missing.push(r.path)
    else extracted[r.variable] = v
  }
  return { extracted, missing }
}

/** 환경 변수 위에 런타임 추출값을 겹친다 (추출값이 우선). */
export function overlayVars(base: VarMap, overlay: Record<string, string>): VarMap {
  const out: VarMap = { ...base }
  for (const [k, v] of Object.entries(overlay)) out[k] = { value: v, secret: false }
  return out
}

/**
 * 스텝 실행 후 자동 등록되는 내장 런타임 변수 — 추출 규칙 없이도 통짜 응답을 다음 스텝에 실을 수 있다.
 * - {{prevBody}} / {{prevStatus}}: 직전 스텝의 응답 바디/상태 (매 스텝 갱신)
 * - {{step1Body}}, {{step2Body}} …: 각 스텝(1-base)의 응답 바디 (계속 유지 — 3차에서 1차 바디 참조 가능)
 * JSON 바디를 `"data": {{prevBody}}` 처럼 JSON 템플릿에 그대로 끼워 넣을 수 있다.
 */
export function autoStepVars(stepIndex: number, responseBody: string | null, status: number | null): Record<string, string> {
  const body = responseBody ?? ''
  return {
    prevBody: body,
    prevStatus: status != null ? String(status) : '',
    [`step${stepIndex + 1}Body`]: body,
  }
}
