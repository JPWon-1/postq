import { isCredentialHeader } from './scrub'
import { resolveEffectiveAuth, type AuthConfig } from './requestAuth'
import { resolveRequest, type KV, type RequestInput, type VarMap } from './variables'

export type SnippetContext = { prepared?: boolean; folderHeaders?: KV[]; folderAuth?: AuthConfig; auth?: AuthConfig }
export type SnippetAuth = Extract<AuthConfig, { type: 'basic' | 'oauth2cc' }> | undefined

/** 실행기의 merge_folder_headers → 변수 해석 → apply_authorization 순서를 따른다. 네트워크 호출은 하지 않는다. */
export function prepareSnippet(input: RequestInput, vars: VarMap, context: SnippetContext = {}): { redacted: RequestInput; auth: SnippetAuth } {
  if (context.prepared) return { redacted: input, auth: undefined }
  const active = new Set(input.headers.filter(h => h.enabled && h.key.trim()).map(h => h.key.toLowerCase()))
  const headers = [...input.headers, ...(context.folderHeaders ?? []).filter(h => h.enabled && h.key.trim() && !active.has(h.key.toLowerCase()))]
  const safeHeaders = headers.map(h => {
    if (!isCredentialHeader(h.key) || !h.value || /\{\{[^}]+\}\}/u.test(h.value)) return h
    const prefix = /^(Bearer|Basic)\s+/i.exec(h.value)?.[0] ?? ''
    return { ...h, value: prefix + '{{header_' + h.key.replace(/[^a-zA-Z0-9_]/g, '_') + '}}' }
  })
  const { redacted } = resolveRequest({ ...input, headers: safeHeaders }, vars)
  const text = (value: string) => resolveRequest({ ...input, bodyType: 'raw', body: value }, vars).redacted.body
  // 인증 입력의 리터럴 비밀값도 스니펫으로 유출하지 않는다. 변수 참조는 원래 이름을 유지한다.
  const secret = (value: string, name: string) => value ? /\{\{[^}]+\}\}/u.test(value) ? text(value) : `{{${name}}}` : effective.hasStoredSecret ? `{{${name}}}` : ''
  const effective = resolveEffectiveAuth(context.auth, context.folderAuth)
  if (effective.type === 'apikey') {
    const key = text(effective.key).trim(), value = secret(effective.value, 'apiKey')
    if (key) {
      if (effective.in === 'query') {
        try { const url = new URL(redacted.url); url.searchParams.set(key, value); redacted.url = restoreReferences(url.toString()) }
        catch { redacted.url += (redacted.url.includes('?') ? '&' : '?') + encodeURIComponent(key) + '=' + encodeURIComponent(value) }
      } else redacted.headers.push({ key, value, enabled: true })
    }
    return { redacted, auth: undefined }
  }
  if (redacted.headers.some(h => h.enabled && h.key.toLowerCase() === 'authorization')) return { redacted, auth: undefined }
  if (effective.type === 'bearer' && (effective.token || effective.hasStoredSecret)) redacted.headers.push({ key: 'Authorization', value: 'Bearer ' + secret(effective.token, 'bearerToken'), enabled: true })
  if (effective.type === 'basic') return { redacted, auth: { type: 'basic', username: text(effective.username), password: secret(effective.password, 'password') } }
  if (effective.type === 'oauth2cc') return { redacted, auth: { ...effective, tokenUrl: text(effective.tokenUrl), clientId: text(effective.clientId), clientSecret: secret(effective.clientSecret, 'clientSecret'), scope: text(effective.scope ?? '') } }
  return { redacted, auth: undefined }
}

/** URL 직렬화로 인코딩된 비밀 변수의 참조 이름을 복사할 수 있게 유지한다. */
export function restoreReferences(url: string): string {
  return url.replace(/%7B%7B(.*?)%7D%7D/gi, (_, key: string) => '{{' + decodeURIComponent(key) + '}}')
}
export function oauthFields(auth: Extract<AuthConfig, { type: 'oauth2cc' }>): Record<string, string> {
  return { grant_type: 'client_credentials', ...(auth.scope ? { scope: auth.scope } : {}), ...(auth.clientAuth === 'basic' ? {} : { client_id: auth.clientId, client_secret: auth.clientSecret }) }
}
