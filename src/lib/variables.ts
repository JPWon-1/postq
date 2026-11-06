import { dropDanglingCommas, looksLikeJson, stripJsonCommentsForSend } from './jsonFormat'
export type KV = { key: string; value: string; enabled: boolean; description?: string }
export type BodyType = 'none' | 'json' | 'form' | 'raw' | 'graphql' | 'multipart' | 'binary'
export type RequestInput = {
  method: string; url: string; params: KV[]; headers: KV[]
  bodyType: BodyType; body: string
}
export type VarMap = Record<string, { value: string; secret: boolean }>

/** 요청별 실행 설정 — 미설정 필드는 executor 기본값(리다이렉트 미추종, 30s). */
export type RequestSettings = {
  followRedirects?: boolean  // true: 리다이렉트 추종(각 홉 SSRF 재검사)
  timeoutMs?: number
}

/**
 * bodyType 에 대응하는 기본 Content-Type. Content-Type 헤더가 없을 때만 붙인다.
 * 실행(executor)·copy as cURL·코드생성이 이 한 곳을 공유해 스니펫이 실제 전송과 일치하게 한다.
 * (graphql 은 {query} JSON 으로 감싸 보내므로 application/json)
 */
export function defaultContentType(bodyType: BodyType): string | null {
  if (bodyType === 'json' || bodyType === 'graphql') return 'application/json'
  if (bodyType === 'form') return 'application/x-www-form-urlencoded'
  return null
}

/**
 * URL 쿼리스트링에 Params 테이블을 병합한다. URL 에 이미 같은 키가 있으면 테이블이 이겨
 * `foo=1&foo=1` 이중 전송을 막는다(같은 키의 URL 쪽 값은 지우고 테이블 값으로 대체, 다중값 보존).
 * search 를 제자리에서 수정한다.
 */
export function mergeQueryParams(search: URLSearchParams, params: KV[]): void {
  const enabled = params.filter(p => p.enabled && p.key)
  for (const k of new Set(enabled.map(p => p.key))) search.delete(k)
  for (const p of enabled) search.append(p.key, p.value)
}

/** GraphQL 바디 정규화: 이미 {query:...} JSON 이면 그대로, 원시 쿼리 문자열이면 {query} 로 감싼다. */
export function gqlWrap(bodyType: string, body: string): string {
  if (bodyType !== 'graphql') {
    // 보내기 직전에 // 주석을 걷어낸다. 이 앱은 ⌘/ 로 줄을 잠시 빼 두는 방식을 쓰는데,
    // JSON 에는 주석이 없어서 그대로 보내면 서버가 400 을 준다 — 주석 기능이 무용지물이었다.
    // 주석을 빼면 남는 끝 쉼표도 함께 정리한다(마지막 줄을 빼면 늘 생기는 모양이다).
    // JSON 처럼 보일 때만 손댄다 — 평문 바디의 '//' 는 주석이 아니라 내용일 수 있다.
    return looksLikeJson(body) ? dropDanglingCommas(stripJsonCommentsForSend(body)) : body
  }
  const trimmed = body.trim()
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && 'query' in parsed) return trimmed
  } catch { /* JSON 아님 → 원시 쿼리 */ }
  return JSON.stringify({ query: body })
}

// 문자집합에 '$' 포함 — 동적변수 {{$timestamp}} 등을 매칭하기 위함.
// (varAutocomplete.ts 의 세그먼트 정규식도 같은 집합을 유지해야 UI/해석이 일치한다.)
// 선택적 `|json` 필터 — 값을 JSON 문자열 리터럴로 이스케이프해 JSON 바디에 안전 삽입한다
// (예: {"note": {{prevBody|json}}} → 값의 따옴표/개행이 이스케이프돼 유효 JSON 유지).
/**
 * 변수 이름에 쓸 수 있는 글자.
 *
 * 예전엔 \w(=[A-Za-z0-9_])만 허용했다. 그런데 환경 화면은 한글 이름을 아무 말 없이
 * 저장하고 목록에도 보여준다 — 그래 놓고 {{토큰}} 은 변수로 인식조차 안 돼서, 치환도
 * 안 되고 '미해석 변수' 경고도 안 뜬 채 `{{토큰}}` 이 문자 그대로 요청에 실려 나갔다.
 * 만들 수 있게 해 놓고 쓰면 조용히 틀리는 것이 제일 나쁘다.
 *
 * 유니코드 글자·숫자를 허용한다(u 플래그). 여전히 {{ }} 로 감싼 것만 변수다.
 */
export const VAR_NAME_CHARS = '[\\p{L}\\p{N}_.$-]'
const PATTERN = new RegExp(`\\{\\{\\s*(${VAR_NAME_CHARS}+)\\s*(\\|\\s*json)?\\s*\\}\\}`, 'gu')

/** 내장 동적변수 이름 목록 — 자동완성 후보/필터에 공유. */
export const DYNAMIC_VARS = ['$timestamp', '$isoTimestamp', '$uuid', '$randomInt'] as const

/**
 * 실행 1회당 한 번만 생성하는 동적변수. sub() 는 real·redacted 두 번 호출되므로
 * 치환 시점에 즉석 생성하면 두 값이 달라진다 — 실행 진입 시 미리 vars 에 구워넣어야
 * 한 실행 안에서 {{$timestamp}} 등이 일관된다. 모두 비밀 아님.
 */
export function dynamicVars(): VarMap {
  return {
    $timestamp: { value: String(Date.now()), secret: false },
    $isoTimestamp: { value: new Date().toISOString(), secret: false },
    $uuid: { value: crypto.randomUUID(), secret: false },
    $randomInt: { value: String(Math.floor(Math.random() * 1_000_000)), secret: false },
  }
}

function sub(text: string, vars: VarMap, mode: 'real' | 'redacted', missing: Set<string>): string {
  return text.replace(PATTERN, (raw, key: string, filter: string | undefined) => {
    const v = vars[key]
    if (!v) { missing.add(key); return raw }
    if (mode === 'redacted' && v.secret) return raw   // 마스킹 유지(필터 포함 원문 그대로)
    // |json: 값을 JSON 문자열 리터럴로(따옴표·개행·유니코드 이스케이프). raw 는 그대로 삽입.
    return filter ? JSON.stringify(v.value) : v.value
  })
}

/** 요청 draft 전체(url/params/headers/body)에서 {{변수}} 참조 이름을 등장 순서대로 추출한다(중복 제거). */
export function extractVariables(input: RequestInput): string[] {
  const acc = new Set<string>()
  const scan = (text: string) => {
    for (const m of text.matchAll(PATTERN)) acc.add(m[1])
  }
  scan(input.url)
  for (const p of input.params) if (p.enabled) scan(p.value)
  for (const h of input.headers) if (h.enabled) scan(h.value)
  scan(input.body)
  // 알려진 동적변수만 '미등록' 경고에서 제외 — 오타/미지원 $이름(예: $tiemstamp)은 그대로 경고에 남긴다.
  return [...acc].filter(name => !(DYNAMIC_VARS as readonly string[]).includes(name))
}

/**
 * {key,value} 배열을 VarMap 위에 오버레이한다(비-secret). 빈 값·빈 키는 무시 —
 * 동명 상위 스코프 변수(secret 포함)를 빈 문자열로 덮지 않게(applyPersonalVars 와 동일 규약).
 * 요청별 변수·시나리오 공유변수 적용에 재사용.
 */
export function overlayKVVars(base: VarMap, kv: { key?: unknown; value?: unknown }[]): VarMap {
  const out: VarMap = { ...base }
  for (const v of kv) {
    if (typeof v?.key !== 'string' || !v.key) continue
    const val = typeof v.value === 'string' ? v.value : v.value == null ? '' : String(v.value)
    if (val !== '') out[v.key] = { value: val, secret: false }
  }
  return out
}

/**
 * 단일 문자열의 {{var}}/{{$..}} 를 real 모드로 치환한다(미해석은 원문 유지).
 * pre-step 인자 치환에 재사용.
 *
 * missing 을 주면 못 채운 이름을 거기에 담는다. 예전엔 새 Set 을 만들어 버렸다 —
 * 그래서 pre-step 인자 안의 미해석 변수는 아무도 몰랐고, 앱의 '미해석 변수' 확인창도
 * 그 경우엔 뜨지 않았다.
 */
export function resolveText(text: string, vars: VarMap, missing?: Set<string>): string {
  return sub(text, vars, 'real', missing ?? new Set())
}

/**
 * text 안 {{var}} 참조 중 secret 변수가 하나라도 있으면 true.
 * pre-step 이 secret 값을 소비해 만든 파생 변수(setValue/base64)에 secret 오염을 전파해,
 * 실 secret 이 이력/cURL 에 평문으로 새지 않게 하는 데 쓴다.
 */
export function referencesSecret(text: string, vars: VarMap): boolean {
  for (const m of text.matchAll(PATTERN)) {
    if (vars[m[1]]?.secret) return true
  }
  return false
}

/**
 * 팀 공유 환경 변수 위에 개인 오버라이드를 덮는다(개인 값이 우선).
 * 개인 값은 항상 secret 취급 — 이력/응답에 실값이 남지 않고 {{이름}} 참조로 마스킹된다.
 * 빈 문자열 오버라이드는 무시(지운 것 ≠ 빈 값으로 덮기).
 */
export function applyPersonalVars(teamVars: VarMap, personal: Record<string, string> | undefined): VarMap {
  if (!personal) return teamVars
  const out: VarMap = { ...teamVars }
  for (const [k, v] of Object.entries(personal)) {
    if (v !== '') out[k] = { value: v, secret: true }
  }
  return out
}

// OpenAPI 경로 자리표시자만 인식한다. {{환경변수}} 및 쿼리/fragment는 제외한다.
const PATH_PATTERN = /(?<!\{)\{([\p{L}\p{N}_.$-]+)\}(?!\})/gu
export function extractPathParameters(url: string): string[] {
  return [...new Set([...url.split(/[?#]/, 1)[0].matchAll(PATH_PATTERN)].map(m => m[1]))]
}
function resolvePath(url: string, vars: VarMap, mode: 'real' | 'redacted', missing: Set<string>): string {
  const end = url.search(/[?#]/)
  const path = end < 0 ? url : url.slice(0, end)
  return path.replace(PATH_PATTERN, (raw, key: string) => {
    const variable = vars[key]
    if (!variable || variable.value === '') { missing.add(key); return raw }
    if (mode === 'redacted' && variable.secret) return raw
    return encodeURIComponent(variable.value)
  }) + (end < 0 ? '' : url.slice(end))
}

export function resolveRequest(input: RequestInput, vars: VarMap) {
  const missing = new Set<string>()
  const map = (mode: 'real' | 'redacted'): RequestInput => ({
    method: input.method,
    bodyType: input.bodyType,
    url: sub(resolvePath(input.url, vars, mode, missing), vars, mode, missing),
    body: input.bodyType === 'binary' ? input.body : sub(input.body, vars, mode, missing),
    params: input.params.map(p => ({ ...p, value: sub(p.value, vars, mode, missing) })),
    headers: input.headers.map(h => ({ ...h, value: sub(h.value, vars, mode, missing) })),
  })
  const real = map('real')
  const redacted = map('redacted')
  return { real, redacted, missing: [...missing].sort() }
}
