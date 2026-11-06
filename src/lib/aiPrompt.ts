import type { RequestInput } from './variables'

// 실행 결과/에러를 LLM(Claude 등)에 바로 붙여넣어 물어볼 수 있는 마크다운 프롬프트로 만든다.
// secret 값은 draft 에 {{변수}} 참조로 남아 있으므로 그대로 안전하게 포함된다.

export type AiPromptResult = {
  status?: number | null
  error?: string | null
  durationMs?: number | null
  responseBody?: string | null
  responseHeaders?: Record<string, string> | null
}


export function buildAiPrompt(name: string, input: RequestInput, result: AiPromptResult): string {
  const params = input.params.filter(p => p.enabled && p.key)
  const headers = input.headers.filter(h => h.enabled && h.key)
  const lines: string[] = []
  lines.push('아래 API 요청과 응답을 분석하고, 문제가 있다면 원인과 해결 방법을 알려주세요.')
  lines.push('')
  lines.push('## 요청: ' + name)
  lines.push('```http')
  lines.push(`${input.method} ${input.url}`)
  for (const h of headers) lines.push(`${h.key}: ${h.value}`)
  lines.push('```')
  if (params.length > 0) {
    lines.push('쿼리 파라미터: ' + params.map(p => `${p.key}=${p.value}`).join(', '))
  }
  if (input.bodyType !== 'none' && input.body.trim()) {
    lines.push('요청 바디:')
    lines.push('```json')
    lines.push(input.body)
    lines.push('```')
  }
  lines.push('')
  lines.push('## 결과')
  if (result.status == null && !result.error) lines.push('아직 실행하지 않았습니다.')
  if (result.responseHeaders && Object.keys(result.responseHeaders).length) {
    lines.push('응답 헤더:', '```http')
    for (const [key, value] of Object.entries(result.responseHeaders)) {
      lines.push(`${key}: ${/^(set-cookie|authorization|proxy-authorization|x-api-key|x-api-token)$/i.test(key) ? '[가림]' : value}`)
    }
    lines.push('```')
  }
  if (result.error) {
    lines.push(`전송 실패: \`${result.error}\``)
  } else if (result.status != null) {
    lines.push(`상태: **${result.status ?? '?'}**` + (result.durationMs != null ? ` · ${result.durationMs}ms` : ''))
    if (result.responseBody) {
      lines.push('응답 바디:')
      lines.push('```json')
      lines.push(result.responseBody)
      lines.push('```')
    }
  }
  return lines.join('\n')
}
