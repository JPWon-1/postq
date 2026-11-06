import type { KV, RequestInput } from './variables'

// "cURL 붙여넣기" — 슬랙/문서에 돌아다니는 curl 명령을 요청 draft 로 변환한다.
// 지원: -X/--request, -H/--header, -d/--data/--data-raw/--data-binary/--data-urlencode,
// -F(form 은 urlencoded 로 강등), --url, 위치 인자 URL, 백슬래시 줄바꿈, '따옴표'/"따옴표".
// 지원하지 않는 플래그는 조용히 무시한다(--compressed, -s 등).

/** 셸 유사 토크나이저 — 따옴표/이스케이프/줄끝 백슬래시 처리. */
function tokenize(cmd: string): string[] {
  const src = cmd.replace(/\\\r?\n/g, ' ') // 줄바꿈 이어붙임
  const tokens: string[] = []
  let cur = ''
  let quote: "'" | '"' | null = null
  let has = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quote === "'") {
      // POSIX single-quote: '\'' 패턴만 탈출로 처리
      if (ch === "'") { quote = null } else { cur += ch }
      continue
    }
    if (quote === '"') {
      if (ch === '"') { quote = null }
      else if (ch === '\\' && (src[i + 1] === '"' || src[i + 1] === '\\')) { cur += src[++i] }
      else { cur += ch }
      continue
    }
    if (ch === "'") { quote = "'"; has = true; continue }
    if (ch === '"') { quote = '"'; has = true; continue }
    if (ch === '\\' && i + 1 < src.length) { cur += src[++i]; has = true; continue }
    if (/\s/.test(ch)) {
      if (cur !== '' || has) { tokens.push(cur); cur = ''; has = false }
      continue
    }
    cur += ch
  }
  if (cur !== '' || has) tokens.push(cur)
  return tokens
}

export function parseCurl(command: string): { input: RequestInput; warnings: string[] } | null {
  const tokens = tokenize(command.trim())
  if (tokens.length === 0 || !/^curl$/i.test(tokens[0])) return null

  let method: string | null = null
  let url = ''
  const headers: KV[] = []
  const dataParts: string[] = []
  const warnings: string[] = []
  let isForm = false

  const next = (i: number): string | undefined => tokens[i + 1]

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '-X' || t === '--request') { method = (next(i) ?? '').toUpperCase(); i++ }
    else if (t === '-H' || t === '--header') {
      const h = next(i) ?? ''; i++
      const ci = h.indexOf(':')
      if (ci > 0) headers.push({ key: h.slice(0, ci).trim(), value: h.slice(ci + 1).trim(), enabled: true })
    }
    else if (['-d', '--data', '--data-raw', '--data-binary', '--data-urlencode'].includes(t)) {
      dataParts.push(next(i) ?? ''); i++
    }
    else if (t === '-F' || t === '--form') {
      isForm = true; dataParts.push(next(i) ?? ''); i++
      warnings.push('multipart(-F)는 지원하지 않아 urlencoded 로 변환했습니다')
    }
    else if (t === '--url') { url = next(i) ?? ''; i++ }
    else if (t === '-u' || t === '--user') {
      const cred = next(i) ?? ''; i++
      headers.push({ key: 'Authorization', value: `Basic ${Buffer.from(cred).toString('base64')}`, enabled: true })
    }
    else if (t === '-b' || t === '--cookie') {
      headers.push({ key: 'Cookie', value: next(i) ?? '', enabled: true }); i++
    }
    else if (t.startsWith('-')) {
      // 값을 받는 알려진 플래그는 값을 건너뛴다
      if (['-o', '--output', '-A', '--user-agent', '-e', '--referer', '--max-time', '--connect-timeout', '-w'].includes(t)) i++
    }
    else if (!url) { url = t }
  }

  if (!url) return null
  const body = dataParts.join(isForm || dataParts.length > 1 ? '&' : '')
  const looksJson = /^\s*[[{]/.test(body)
  const bodyType: RequestInput['bodyType'] = body === '' ? 'none' : looksJson ? 'json' : isForm ? 'form' : 'raw'
  if (!method) method = body !== '' ? 'POST' : 'GET'

  // URL 쿼리는 Params 로 분리해 편집 가능하게 한다 (변수 포함 URL 은 그대로 둔다)
  const params: KV[] = []
  try {
    if (!url.includes('{{')) {
      const u = new URL(url)
      u.searchParams.forEach((value, key) => params.push({ key, value, enabled: true }))
      if (params.length > 0) { u.search = ''; url = u.toString() }
    }
  } catch { /* 상대/비표준 URL 은 그대로 */ }

  return { input: { method, url, params, headers, bodyType, body }, warnings }
}
