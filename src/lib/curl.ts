import { prepareSnippet, restoreReferences, type SnippetContext } from './snippetRequest'
import { curlAuth } from './snippetAuth'
import { parseBinaryBody } from './binary'
import type { RequestInput, VarMap } from './variables'
import { defaultContentType, gqlWrap, mergeQueryParams } from './variables'
import { VAR_NAME_CHARS } from './variables'

/** 셸 안전 single-quote 이스케이프: ' → '\'' */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * draft 를 cURL 명령으로 변환한다 (Postman "Copy as cURL" 대응).
 * 변수는 주어진 환경 값으로 치환하되 **secret 은 실값 대신 {{이름}} 참조를 유지**한다 —
 * 클립보드/터미널 히스토리로 secret 이 새는 것을 막는 의도적 선택.
 */
export function toCurl(input: RequestInput, vars: VarMap, context?: SnippetContext): { command: string; hasSecretRef: boolean } {
  const { redacted, auth } = prepareSnippet(input, vars, context)
  const authCode = curlAuth(auth)

  let url: URL | null = null
  try {
    url = new URL(redacted.url)
  } catch { /* 변수 미해석 등으로 URL 파싱 불가 — 문자열 그대로 조립 */ }

  const enabledParams = redacted.params.filter(p => p.enabled && p.key)
  let urlStr = redacted.url
  if (url) {
    mergeQueryParams(url.searchParams, redacted.params)
    urlStr = url.toString()
  } else if (enabledParams.length > 0) {
    const qs = enabledParams.map(p => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`).join('&')
    urlStr = `${redacted.url}${redacted.url.includes('?') ? '&' : '?'}${qs}`
  }

  const lines = [`curl -X ${redacted.method.toUpperCase()} ${sq(restoreReferences(urlStr))}`]
  const headers = redacted.headers.filter(h => h.enabled && h.key)
  const hasBody = !['GET', 'HEAD'].includes(redacted.method.toUpperCase()) && redacted.bodyType !== 'none' && redacted.body !== ''
  const hasCT = headers.some(h => h.key.toLowerCase() === 'content-type')
  for (const h of headers) lines.push(`  -H ${sq(`${h.key}: ${h.value}`)}`)
  const ct = redacted.bodyType === 'binary' ? parseBinaryBody(redacted.body).contentType : defaultContentType(redacted.bodyType)
  if (hasBody && !hasCT && ct) lines.push(`  -H ${sq(`Content-Type: ${ct}`)}`)
  // graphql 은 {query} 로 감싸 보내므로 -d 도 실제 전송 바디에 맞춘다.
  if (hasBody && redacted.bodyType === 'binary') lines.push(`  --data-binary ${sq('@' + (parseBinaryBody(redacted.body).filename || 'file.bin'))}`)
  else if (hasBody) lines.push(`  -d ${sq(gqlWrap(redacted.bodyType, redacted.body))}`)

  lines.push(...authCode.args)
  const command = authCode.prefix.join('\n') + lines.join(' \\\n')
  return { command, hasSecretRef: new RegExp(`\\{\\{${VAR_NAME_CHARS}+\\}\\}`, 'u').test(command) }
}
