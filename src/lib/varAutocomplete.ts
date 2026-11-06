import { VAR_NAME_CHARS } from './variables'
// {{변수}} 자동완성 판단 로직 — 입력창에서 커서 위치 기준으로 제안 여부/후보를 계산한다.
// UI 와 분리된 순수 함수라 커서·텍스트 조합을 테스트로 못박을 수 있다 (varAutocomplete.test.ts).

export type VarSuggestion = {
  open: boolean
  /** {{ 뒤에 입력 중인 접두어 (매칭 기준) */
  query: string
  /** 여는 {{ 의 시작 인덱스 — 완성 시 이 위치부터 커서까지를 치환한다 */
  start: number
  matches: string[]
}

export const SUGGEST_CLOSED: VarSuggestion = { open: false, query: '', start: -1, matches: [] }

/**
 * 커서 앞에서 가장 가까운 여는 {{ 를 찾아 그 뒤 문자열을 query 로 삼고,
 * prefix 가 일치하는(대소문자 무시) 변수명 후보를 돌려준다.
 * 이미 }} 로 닫혔거나, 변수명이 될 수 없는 문자가 섞였거나, 후보가 없으면 open:false.
 */
export function suggestVariables(text: string, caret: number, varNames: string[]): VarSuggestion {
  const before = text.slice(0, caret)
  const start = before.lastIndexOf('{{')
  if (start === -1) return SUGGEST_CLOSED

  const segment = before.slice(start + 2)
  if (segment.includes('}}')) return SUGGEST_CLOSED

  // lib/variables.ts 의 PATTERN 과 같은 문자 집합만 변수명으로 인정(한글 이름 포함)
  const m = segment.match(new RegExp(`^\\s*(${VAR_NAME_CHARS}*)$`, 'u'))
  if (!m) return SUGGEST_CLOSED

  const query = m[1]
  const q = query.toLowerCase()
  const matches = varNames.filter(name => name.toLowerCase().startsWith(q))
  if (matches.length === 0) return SUGGEST_CLOSED

  return { open: true, query, start, matches }
}

/**
 * 제안을 확정한다: text 의 [start, caret) 구간을 {{name}} 으로 치환.
 * 커서 뒤에 기존 변수의 나머지 조각(예: 'se}}')이 붙어 있으면 흡수해서 }} 중복을 막는다.
 */
export function applyVariable(text: string, caret: number, start: number, name: string): { text: string; caret: number } {
  const after = text.slice(caret).replace(new RegExp(`^${VAR_NAME_CHARS}*\\s*\\}\\}`, 'u'), '')
  const inserted = `{{${name}}}`
  return { text: text.slice(0, start) + inserted + after, caret: start + inserted.length }
}
