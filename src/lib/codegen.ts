import { prepareSnippet, restoreReferences, type SnippetContext } from './snippetRequest'
import { jsAuth, pythonAuth } from './snippetAuth'
import { parseBinaryBody } from './binary'
import type { RequestInput, VarMap } from './variables'
import { defaultContentType, gqlWrap, mergeQueryParams } from './variables'

/**
 * 코드 스니펫 생성기 (cURL 외 확장) — fetch / axios / python requests.
 * toCurl 과 동일 정책: 변수는 환경 값으로 치환하되 **secret 은 실값 대신 {{이름}} 참조를 유지**한다
 * (resolveRequest 의 redacted 사용). 생성된 코드가 클립보드/저장소로 새어도 secret 이 노출되지 않는다.
 */

/** JS single-quote 문자열 리터럴 */
function js(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`
}

/** Python double-quote 문자열 리터럴 */
function py(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
}

/** toCurl 과 동일한 URL 조립: 활성 param 을 URL 에 병합, 파싱 불가 시 문자열 조립 */
function buildUrl(redacted: RequestInput): string {
  const enabledParams = redacted.params.filter(p => p.enabled && p.key)
  try {
    const url = new URL(redacted.url)
    mergeQueryParams(url.searchParams, redacted.params)
    return url.toString()
  } catch { /* 변수 미해석 등으로 URL 파싱 불가 */ }
  if (enabledParams.length === 0) return redacted.url
  const qs = enabledParams.map(p => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`).join('&')
  return `${redacted.url}${redacted.url.includes('?') ? '&' : '?'}${qs}`
}

/** 활성 헤더 + (바디가 있고 Content-Type 미지정이면) bodyType 에 맞는 Content-Type 자동 추가 */
function buildHeaders(redacted: RequestInput): { headers: { key: string; value: string }[]; hasBody: boolean } {
  const headers = redacted.headers.filter(h => h.enabled && h.key).map(h => ({ key: h.key, value: h.value }))
  const hasBody = !['GET', 'HEAD'].includes(redacted.method.toUpperCase()) && redacted.bodyType !== 'none' && redacted.body !== ''
  const hasCT = headers.some(h => h.key.toLowerCase() === 'content-type')
  const ct = redacted.bodyType === 'binary' ? parseBinaryBody(redacted.body).contentType : defaultContentType(redacted.bodyType)
  if (hasBody && !hasCT && ct) headers.push({ key: 'Content-Type', value: ct })
  return { headers, hasBody }
}

/** 실제 전송되는 바디(graphql 은 {query} 로 감쌈) — 스니펫이 실 요청과 일치하도록. */
function outgoingBody(redacted: RequestInput): string {
  return gqlWrap(redacted.bodyType, redacted.body)
}

/** json bodyType 이고 파싱 가능하면 파싱 결과, 아니면 undefined (문자열 폴백) */
function tryParseJsonBody(redacted: RequestInput): unknown {
  if (redacted.bodyType !== 'json') return undefined
  try { return JSON.parse(redacted.body) } catch { return undefined }
}

/** JSON.stringify 결과를 주어진 들여쓰기 폭으로 재들여쓰기 */
function indentBlock(text: string, indent: string): string {
  return text.split('\n').map((line, i) => (i === 0 ? line : indent + line)).join('\n')
}

export function toFetch(input: RequestInput, vars: VarMap, context?: SnippetContext): string {
  const { redacted, auth } = prepareSnippet(input, vars, context)
  const urlStr = restoreReferences(buildUrl(redacted))
  const { headers, hasBody } = buildHeaders(redacted)

  const authCode = jsAuth(auth)
  const lines = [`const res = await fetch(${js(urlStr)}, {`]
  lines.push(`  method: ${js(redacted.method.toUpperCase())},`)
  if (headers.length > 0 || authCode.value) {
    lines.push('  headers: {')
    for (const h of headers) lines.push(`    ${js(h.key)}: ${js(h.value)},`)
    if (authCode.value) lines.push(`    'Authorization': ${authCode.value},`)
    lines.push('  },')
  }
  if (hasBody) {
    const parsed = tryParseJsonBody(redacted)
    if (parsed !== undefined) {
      lines.push(`  body: JSON.stringify(${indentBlock(JSON.stringify(parsed, null, 2), '  ')}),`)
    } else {
      lines.push(`  body: ${redacted.bodyType === 'binary' ? 'readFileSync(' + js(parseBinaryBody(redacted.body).filename || 'file.bin') + ')' : js(outgoingBody(redacted))},`)
    }
  }
  if (hasBody && redacted.bodyType === 'binary') lines.unshift("import { readFileSync } from 'node:fs'", '')
  lines.push('})')
  return [...authCode.prefix, ...lines].join('\n')
}

export function toAxios(input: RequestInput, vars: VarMap, context?: SnippetContext): string {
  const { redacted, auth } = prepareSnippet(input, vars, context)
  const urlStr = restoreReferences(buildUrl(redacted))
  const { headers, hasBody } = buildHeaders(redacted)

  const authCode = jsAuth(auth)
  const lines = ['const res = await axios({']
  lines.push(`  method: ${js(redacted.method.toLowerCase())},`)
  lines.push(`  url: ${js(urlStr)},`)
  if (headers.length > 0 || authCode.value) {
    lines.push('  headers: {')
    for (const h of headers) lines.push(`    ${js(h.key)}: ${js(h.value)},`)
    if (authCode.value) lines.push(`    'Authorization': ${authCode.value},`)
    lines.push('  },')
  }
  if (hasBody) {
    const parsed = tryParseJsonBody(redacted)
    if (parsed !== undefined) {
      lines.push(`  data: ${indentBlock(JSON.stringify(parsed, null, 2), '  ')},`)
    } else {
      lines.push(`  data: ${redacted.bodyType === 'binary' ? 'readFileSync(' + js(parseBinaryBody(redacted.body).filename || 'file.bin') + ')' : js(outgoingBody(redacted))},`)
    }
  }
  if (hasBody && redacted.bodyType === 'binary') lines.unshift("import { readFileSync } from 'node:fs'", '')
  lines.push('})')
  return [...authCode.prefix, ...lines].join('\n')
}

/** JSON 값을 Python 리터럴로 (true→True, false→False, null→None) */
function pyLiteral(v: unknown, indent: string): string {
  if (v === null) return 'None'
  if (v === true) return 'True'
  if (v === false) return 'False'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') return JSON.stringify(v) // JSON 문자열 리터럴은 Python 에서도 유효
  const inner = indent + '    '
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]'
    return `[\n${v.map(x => `${inner}${pyLiteral(x, inner)},`).join('\n')}\n${indent}]`
  }
  const entries = Object.entries(v as Record<string, unknown>)
  if (entries.length === 0) return '{}'
  return `{\n${entries.map(([k, x]) => `${inner}${JSON.stringify(k)}: ${pyLiteral(x, inner)},`).join('\n')}\n${indent}}`
}

export function toPythonRequests(input: RequestInput, vars: VarMap, context?: SnippetContext): string {
  const { redacted, auth } = prepareSnippet(input, vars, context)
  const urlStr = restoreReferences(buildUrl(redacted))
  const { headers, hasBody } = buildHeaders(redacted)

  const authCode = pythonAuth(auth)
  const lines = ['import requests', '', 'response = requests.request(']
  lines.push(`    ${py(redacted.method.toUpperCase())},`)
  lines.push(`    ${py(urlStr)},`)
  if (headers.length > 0 || authCode.value) {
    lines.push('    headers={')
    for (const h of headers) lines.push(`        ${py(h.key)}: ${py(h.value)},`)
    if (authCode.value) lines.push(`        "Authorization": ${authCode.value},`)
    lines.push('    },')
  }
  if (hasBody) {
    const parsed = tryParseJsonBody(redacted)
    if (parsed !== undefined) {
      lines.push(`    json=${pyLiteral(parsed, '    ')},`)
    } else {
      lines.push(`    data=${redacted.bodyType === 'binary' ? 'Path(' + py(parseBinaryBody(redacted.body).filename || 'file.bin') + ').read_bytes()' : py(outgoingBody(redacted))},`)
    }
  }
  if (hasBody && redacted.bodyType === 'binary') lines.unshift('from pathlib import Path')
  lines.push(')')
  return [...authCode.prefix, ...lines].join('\n')
}
