// GraphQL 바디 = 쿼리 + Variables(JSON) 를 {query, variables} 봉투로 합치고 되분리한다.
// variables 에 {{변수}} 가 있으면 JSON.parse 가 실패하므로 raw 임베드/구조적 추출로 유실을 막는다.

export function splitGqlBody(body: string): { query: string; variables: string } {
  try {
    const p = JSON.parse(body)
    if (p && typeof p === 'object' && 'query' in p) {
      return { query: String(p.query ?? ''), variables: p.variables != null ? JSON.stringify(p.variables, null, 2) : '' }
    }
  } catch { /* {{변수}} 포함 등으로 파싱 불가 → 구조적 추출 */ }
  // combineGqlBody 가 만든 봉투 {"query":<jsonstr>,"variables":<raw>} 를 정규식으로 분해(마지막 } 까지).
  const m = body.match(/^\s*\{\s*"query"\s*:\s*("(?:[^"\\]|\\.)*")\s*,\s*"variables"\s*:\s*([\s\S]*)\}\s*$/)
  if (m) {
    try { return { query: JSON.parse(m[1]), variables: m[2].trim() } } catch { /* 폴백 */ }
  }
  return { query: body, variables: '' }
}

export function combineGqlBody(query: string, variables: string): string {
  if (!variables.trim()) return query
  // 유효 JSON 이면 정규화, {{변수}} 등으로 무효면 raw 임베드(서버가 치환 후 유효 JSON 으로 전송).
  try { return JSON.stringify({ query, variables: JSON.parse(variables) }) }
  catch { return `{"query":${JSON.stringify(query)},"variables":${variables}}` }
}
