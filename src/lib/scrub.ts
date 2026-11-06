import { VAR_NAME_CHARS } from './variables'
// 실행 이력 저장 시 응답에서 '알려진 secret 값'을 마스킹한다.
// 목적: 요청이 보낸 secret(토큰 등)을 API 가 응답에 echo 하면, 그 평문이 팀 공유 이력·MCP 로
// 새는 것을 막는다. (실행한 본인에게 돌려주는 즉시 응답은 실값 그대로 — 저장분만 마스킹.)
// 한계: API 가 새로 발급한 값(로그인 응답의 새 토큰)은 secret 인지 알 수 없어 마스킹 못 함.

const MASK = '***'
const MIN_LEN = 4  // 너무 짧은 값은 오탐(우연 일치) 방지로 제외

/** text 안 secretValues 각각을 리터럴 치환으로 마스킹. */
export function scrubSecrets(text: string | null, secretValues: string[]): string | null {
  if (text == null) return text
  let out = text
  for (const v of secretValues) {
    if (!v || v.length < MIN_LEN) continue
    if (out.includes(v)) out = out.split(v).join(MASK)
  }
  return out
}

/**
 * 구조 안의 모든 문자열 값에 scrubSecrets 적용. **직렬화하기 전에** 쓴다.
 *
 * JSON.stringify 한 뒤에 치환하면 두 가지가 깨진다:
 *  - 시크릿에 " \ 개행 같은 글자가 있으면 JSON 이 이스케이프해서 원본과 글자가 달라진다 →
 *    치환이 안 되고 평문이 저장분에 그대로 남는다(마스킹을 뚫는다).
 *  - 시크릿 값이 "true"/"null" 이면 JSON 구조의 boolean·null 까지 *** 로 바뀌어 문서가
 *    깨진다 → 이력을 다시 읽을 때 파싱 실패로 '검증 없음' 처럼 보인다.
 * 값만 바꾸고 키는 그대로 둔다 — 키는 우리가 만든 필드명이라 시크릿이 들어갈 자리가 아니다.
 */
export function scrubJson<T>(value: T, secretValues: string[]): T {
  if (typeof value === 'string') return scrubSecrets(value, secretValues) as unknown as T
  if (Array.isArray(value)) return value.map(v => scrubJson(v, secretValues)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = scrubJson(v, secretValues)
    return out as unknown as T
  }
  return value
}

/** 헤더 맵의 각 값에 scrubSecrets 적용. */
export function scrubHeaders(
  headers: Record<string, string> | null,
  secretValues: string[],
): Record<string, string> | null {
  if (!headers) return headers
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) out[k] = scrubSecrets(v, secretValues) ?? v
  return out
}

/** VarMap 에서 secret 인 값들만 뽑는다(스크럽 대상). */
export function secretValuesOf(vars: Record<string, { value: string; secret: boolean }>): string[] {
  return Object.values(vars).filter(v => v.secret && v.value).map(v => v.value)
}

// 값이 자격증명일 가능성이 큰 헤더 이름(소문자). export/이력 저장 시 리터럴 값 마스킹 대상.
const CREDENTIAL_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie',
  'x-api-key', 'api-key', 'x-auth-token', 'x-access-token', 'x-amz-security-token',
])
export function isCredentialHeader(name: string): boolean {
  return CREDENTIAL_HEADERS.has(name.trim().toLowerCase())
}

// {{var}} 참조를 포함하는 값은 리터럴 비밀이 아니다(실제 값은 환경변수에 있고 그건 별도 처리).
// variables.ts PATTERN 과 동일하게 선택적 |json 필터를 인식해야 {{k|json}} 헤더가 리터럴로 오마스킹되지 않는다.
function hasVarRef(v: string): boolean {
  return new RegExp(`\\{\\{\\s*${VAR_NAME_CHARS}+\\s*(\\|\\s*json)?\\s*\\}\\}`, 'u').test(v)
}

/**
 * 알려진 자격증명 헤더의 '리터럴' 값을 마스킹한다({{var}} 참조는 보존 — 비밀 아님).
 * export 파일·팀 공유 이력에 하드코딩된 토큰/쿠키가 평문으로 새는 것을 막는다.
 */
export function maskCredentialHeaders<T extends { key: string; value: string }>(headers: T[]): T[] {
  return headers.map(h =>
    h.value && isCredentialHeader(h.key) && !hasVarRef(h.value) ? { ...h, value: MASK } : h)
}
