import { blockPrivateNetworks, isBlockedHost, schemeProblem } from './ssrfGuard'
import { resolveText, type VarMap } from './variables'
import { errorText } from '@/lib/fetchJson'
import { VAR_NAME_CHARS } from './variables'

// 요청 인증 — Authorization 헤더를 서버가 계산한다.
// none/bearer/basic 은 순수 계산, oauth2cc(client-credentials)는 토큰 URL 로 fetch + 캐시.
// 모든 필드는 {{변수}} 를 지원(clientSecret 을 {{secret}} 로).

// 'inherit' 은 요청에서만 쓴다 — 폴더의 공통 인증(sharedAuth)을 상속. 폴더 자체는 inherit 불가.
export type AuthType = 'none' | 'inherit' | 'bearer' | 'basic' | 'apikey' | 'oauth2cc'

export type AuthConfig = (
  | { type: 'none' }
  | { type: 'inherit' }
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'apikey'; key: string; value: string; in: 'header' | 'query' }
  | { type: 'oauth2cc'; tokenUrl: string; clientId: string; clientSecret: string; scope?: string; clientAuth?: 'body' | 'basic' }
) & { hasStoredSecret?: boolean }

export const AUTH_LABEL: Record<AuthType, string> = {
  none: '없음', inherit: '상속 (폴더 공통)', bearer: 'Bearer 토큰', basic: 'Basic', apikey: 'API Key', oauth2cc: 'OAuth2 (Client Credentials)',
}

/**
 * 요청 인증이 'inherit' 이면 폴더 공통 인증으로 해소한다(Postman 의 "Inherit auth from parent").
 * - 요청이 inherit 이 아니면 요청 인증을 그대로 사용(요청이 폴더보다 우선).
 * - 폴더가 없거나 폴더도 none/inherit 이면 인증 없음.
 */
export function resolveEffectiveAuth(
  requestAuth: AuthConfig | null | undefined,
  folderAuth: AuthConfig | null | undefined,
): AuthConfig {
  const req = requestAuth ?? { type: 'none' }
  if (req.type !== 'inherit') return req
  if (folderAuth && folderAuth.type !== 'none' && folderAuth.type !== 'inherit') return folderAuth
  return { type: 'none' }
}

/**
 * 폴더 공통 인증 입력 정규화 — 유효한 타입만 허용(폴더는 inherit 불가), 필드도 타입별로 추린다.
 * 무효/미지정이면 { type: 'none' }. 클라가 보낸 임의 JSON 을 그대로 저장하지 않기 위함.
 */
export function sanitizeFolderAuth(input: unknown): AuthConfig {
  if (!input || typeof input !== 'object') return { type: 'none' }
  const o = input as Record<string, unknown>
  const s = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : '')
  switch (o.type) {
    case 'bearer': return { type: 'bearer', token: s('token') }
    case 'basic': return { type: 'basic', username: s('username'), password: s('password') }
    case 'apikey': return { type: 'apikey', key: s('key'), value: s('value'), in: o.in === 'query' ? 'query' : 'header' }
    case 'oauth2cc': return {
      type: 'oauth2cc', tokenUrl: s('tokenUrl'), clientId: s('clientId'), clientSecret: s('clientSecret'),
      scope: s('scope'), clientAuth: o.clientAuth === 'basic' ? 'basic' : 'body',
    }
    default: return { type: 'none' }
  }
}

/**
 * AuthConfig 의 secret 필드(token/password/clientSecret) 중 '리터럴' 값을 공란화한다
 * ({{var}} 참조는 보존 — 실제 값은 환경변수에 있음). export 파일에 자격증명이 새는 것을 막는다.
 * tokenUrl/clientId/username/scope 같은 비-secret 구성은 유지해 재입력 부담을 줄인다.
 */
export function maskAuthSecrets(auth: AuthConfig): AuthConfig {
  const blank = (v: string | undefined) =>
    (v && new RegExp(`\\{\\{\\s*${VAR_NAME_CHARS}+\\s*\\}\\}`, 'u').test(v) ? v : '')
  switch (auth.type) {
    case 'bearer': return { ...auth, token: blank(auth.token) }
    case 'basic': return { ...auth, password: blank(auth.password) }
    case 'apikey': return { ...auth, value: blank(auth.value) }
    case 'oauth2cc': return { ...auth, clientSecret: blank(auth.clientSecret) }
    default: return auth
  }
}

/** 요청 인증 입력 정규화 — 폴더와 달리 'inherit' 허용. 그 외는 sanitizeFolderAuth 와 동일. */
export function sanitizeRequestAuth(input: unknown): AuthConfig {
  if (input && typeof input === 'object' && (input as { type?: unknown }).type === 'inherit') return { type: 'inherit' }
  return sanitizeFolderAuth(input)
}

export type AuthResult = { authorization?: string; error?: string }

function b64(s: string): string {
  try { return typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(s))) : Buffer.from(s, 'utf8').toString('base64') }
  catch { return Buffer.from(s, 'utf8').toString('base64') }
}

// Web Crypto(동형) — clientSecret 을 캐시 키에 원문 대신 해시로 넣기 위함(node:crypto 미사용, 클라 번들 안전).
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// OAuth2 토큰 캐시 (서버 프로세스 메모리) — key: tokenUrl|clientId|scope|clientAuth.
type Cached = { token: string; exp: number }
const tokenCache = new Map<string, Cached>()
/** 테스트용 — 캐시 초기화. */
export function _clearTokenCache() { tokenCache.clear() }

/** redacted 이력용 — 자격증명 부분만 마스킹 ("Bearer ***"). */
export function maskAuthorization(value: string): string {
  const sp = value.indexOf(' ')
  return sp > 0 ? `${value.slice(0, sp)} ***` : '***'
}

/**
 * Authorization 값을 계산한다. oauth2cc 는 토큰을 fetch(캐시 우선).
 * fetchImpl 은 테스트에서 주입 가능(기본 전역 fetch).
 */
export async function buildAuthorization(
  auth: AuthConfig | null | undefined,
  vars: VarMap,
  fetchImpl: typeof fetch = fetch,
): Promise<AuthResult> {
  // inherit 은 실행 전 resolveEffectiveAuth 로 이미 해소돼야 한다. 남아 있으면 인증 없음 취급.
  // apikey 는 Authorization 헤더가 아니라 커스텀 헤더/쿼리로 주입되므로 여기선 무동작(applyAuthorization 처리).
  if (!auth || auth.type === 'none' || auth.type === 'inherit' || auth.type === 'apikey') return {}
  if (auth.type === 'bearer') {
    const t = resolveText(auth.token ?? '', vars)
    return t ? { authorization: `Bearer ${t}` } : {}
  }
  if (auth.type === 'basic') {
    const u = resolveText(auth.username ?? '', vars)
    const p = resolveText(auth.password ?? '', vars)
    return { authorization: `Basic ${b64(`${u}:${p}`)}` }
  }
  // oauth2cc
  const tokenUrl = resolveText(auth.tokenUrl ?? '', vars)
  const clientId = resolveText(auth.clientId ?? '', vars)
  const clientSecret = resolveText(auth.clientSecret ?? '', vars)
  const scope = resolveText(auth.scope ?? '', vars)
  const clientAuth = auth.clientAuth ?? 'body'
  if (!tokenUrl || !clientId) return { error: 'OAuth2: 토큰 URL 과 Client ID 가 필요합니다' }

  // 캐시 키에 clientSecret 해시 포함 — secret 이 다르거나(없거나) 하면 다른 키가 되어
  // 남의 secret 으로 발급된 토큰을 재사용(탈취)하는 것을 막는다. 원문 secret 은 키에 넣지 않음.
  const key = `${tokenUrl}|${clientId}|${scope}|${clientAuth}|${await sha256Hex(clientSecret)}`
  const now = Date.now()
  const cached = tokenCache.get(key)
  if (cached && cached.exp > now + 5000) return { authorization: `Bearer ${cached.token}` }

  let parsed: URL
  try { parsed = new URL(tokenUrl) } catch { return { error: 'OAuth2: 토큰 URL 이 올바르지 않습니다' } }
  // 다른 egress 와 같은 규칙. 여기는 clientSecret 을 실어 보내는 자리라 특히 스킴을 봐야 한다.
  const badScheme = schemeProblem(parsed.protocol)
  if (badScheme) return { error: `OAuth2: 토큰 URL — ${badScheme}` }
  if (isBlockedHost(parsed.hostname, blockPrivateNetworks())) return { error: 'OAuth2: 토큰 URL 이 차단된 주소입니다(메타데이터/사설망)' }

  const form = new URLSearchParams({ grant_type: 'client_credentials' })
  if (scope) form.set('scope', scope)
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }
  if (clientAuth === 'basic') headers.Authorization = `Basic ${b64(`${clientId}:${clientSecret}`)}`
  else { form.set('client_id', clientId); form.set('client_secret', clientSecret) }

  try {
    // redirect:'manual' — 허용 호스트가 302 로 메타데이터/내부주소로 리다이렉트해 SSRF 가드를 우회하는 것을 차단.
    const res = await fetchImpl(tokenUrl, { method: 'POST', headers, body: form.toString(), redirect: 'manual', signal: AbortSignal.timeout(15_000) })
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      return { error: 'OAuth2: 토큰 URL 이 리다이렉트되었습니다(보안상 차단)' }
    }
    const json = await res.json().catch(() => null) as { access_token?: string; expires_in?: number } | null
    if (!res.ok || !json?.access_token) return { error: `OAuth2: 토큰 발급 실패 (${res.status})` }
    const token = String(json.access_token)
    const ttl = Number(json.expires_in) > 0 ? Number(json.expires_in) : 3600
    tokenCache.set(key, { token, exp: now + ttl * 1000 })
    return { authorization: `Bearer ${token}` }
  } catch (e) {
    return { error: `OAuth2: 토큰 발급 요청 실패 — ${errorText(e)}` }
  }
}
