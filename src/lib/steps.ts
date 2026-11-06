// pre/post 비주얼 스텝 — 순수 타입 + 라벨/설명(node 내장 import 없음).
// 클라이언트(RequestPanel)와 서버(stepRunner) 양쪽에서 안전하게 import 한다.
// 실제 실행 로직(node:crypto 사용)은 stepRunner.ts 에 분리 — assertions.ts(순수) ↔ 실행기 분리와 동일 구조.

export type PreStepOp = 'setValue' | 'timestamp' | 'uuid' | 'randomInt' | 'base64' | 'hmacSha256'

/**
 * Pre-request 스텝 — 요청 전에 변수 하나를 계산해 스코프에 누적한다.
 * 화이트리스트 연산만 — 임의 코드 실행 없음.
 * - setValue: value 템플릿({{var}}/{{$uuid}} 치환)을 그대로 변수화
 * - timestamp: 현재 unix ms
 * - uuid: 랜덤 UUID
 * - randomInt: [min, max] 정수 (min/max 는 템플릿 허용)
 * - base64: input 을 base64 인코딩
 * - hmacSha256: key(시크릿) 로 input(메시지)을 HMAC-SHA256(hex). 결과는 기본 secret.
 */
export type PreStep = {
  name: string
  op: PreStepOp
  secret?: boolean
  value?: string  // setValue 템플릿
  input?: string  // base64 입력 / hmac 메시지
  key?: string    // hmac 시크릿(템플릿 허용 — {{secret}})
  min?: string    // randomInt 하한(템플릿 허용)
  max?: string    // randomInt 상한
}

export type PostStepSource = 'jsonPath' | 'header'

/** Post-response 스텝 — 응답에서 값 추출 → 변수. jsonPath(바디) 또는 header(응답 헤더). */
export type PostStep = {
  name: string
  source: PostStepSource
  path: string
  secret?: boolean
}

export const PRE_OP_LABEL: Record<PreStepOp, string> = {
  setValue: '값 설정',
  timestamp: '타임스탬프(ms)',
  uuid: 'UUID',
  randomInt: '랜덤 정수',
  base64: 'Base64 인코딩',
  hmacSha256: 'HMAC-SHA256',
}

/** hmac 결과 등 파생 민감값은 기본 secret — 명시 플래그가 있으면 우선. */
export function preStepSecret(s: PreStep): boolean {
  return s.secret ?? s.op === 'hmacSha256'
}
