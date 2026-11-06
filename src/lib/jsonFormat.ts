/**
 * {{변수}} 가 섞인 JSON 을 다루는 도구.
 *
 * 이 앱의 바디에는 거의 항상 {{baseUrl}} 같은 자리표시자가 들어간다. 그게 문자열 안에 있으면
 * ("a": "{{v}}") 그냥 JSON 이지만, 값 자리에 맨몸으로 있으면 ("a": {{v}}) JSON.parse 가 던진다.
 * 그래서 '정리' 도 '문법 오류 표시' 도 못 하고 손으로 맞춰야 했다.
 *
 * 자리표시자를 잠시 문자열로 바꿔 파싱하고, 결과를 되돌린다.
 */

/** 되돌릴 때 원문과 부딪히지 않도록 일부러 눈에 띄는 모양을 쓴다. */
const token = (i: number) => `__AH_VAR_${i}__`

/**
 * 자리표시자를 JSON 으로 읽을 수 있는 토큰으로 바꾼다.
 *
 * 문자열 안에 있으면("a": "{{v}}") 토큰만 넣는다 — 따옴표는 이미 있다. 여기서 또 감싸면
 * ""토큰"" 이 돼 멀쩡한 JSON 이 깨진다. 값 자리에 맨몸으로 있으면("a": {{v}}) 따옴표까지 붙인다.
 * 그래서 문자열 안인지 밖인지를 직접 훑어서 판단한다(이스케이프된 따옴표도 센다).
 */
function mask(text: string): { masked: string; vars: string[]; quoted: boolean[] } {
  const vars: string[] = []
  // 따옴표까지 우리가 붙였는지 — 되돌릴 때 원문의 따옴표를 같이 걷어내지 않으려면 필요하다.
  const quoted: boolean[] = []
  let out = ''
  let inString = false
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (inString) {
      if (c === '\\') { out += text.slice(i, i + 2); i += 2; continue }
      if (c === '"') { inString = false; out += c; i++; continue }
    } else if (c === '"') {
      inString = true; out += c; i++; continue
    }
    if (c === '{' && text[i + 1] === '{') {
      const close = text.indexOf('}}', i + 2)
      // 안쪽에 중괄호가 없을 때만 자리표시자로 본다 — VAR 정규식과 같은 기준.
      if (close > 0 && !text.slice(i + 2, close).includes('{') && !text.slice(i + 2, close).includes('}')) {
        vars.push(text.slice(i, close + 2))
        quoted.push(!inString)
        out += inString ? token(vars.length - 1) : `"${token(vars.length - 1)}"`
        i = close + 2
        continue
      }
    }
    out += c
    i++
  }
  return { masked: out, vars, quoted }
}

/**
 * mask 가 넣은 토큰을 원래 {{변수}} 로 되돌린다.
 * 우리가 따옴표까지 붙인 것만 따옴표째 되돌린다 — 문자열 안에 있던 것까지 벗기면
 * "{{v}}" 가 {{v}} 로 바뀌어 멀쩡한 JSON 이 깨진다.
 */
function unmask(text: string, vars: string[], quoted: boolean[]): string {
  return vars.reduce((acc, v, i) => quoted[i]
    ? acc.replaceAll(`"${token(i)}"`, v)
    : acc.replaceAll(token(i), v), text)
}

/**
 * `//` 로 시작하는 줄 주석을 걷어낸다. 문자열 안의 `//`(예: "http://...")는 건드리지 않는다.
 *
 * 이 앱은 ⌘/ 로 줄을 잠시 빼 두는 방식을 쓴다(코드 편집기의 습관). 그런데 JSON 표준에는 주석이
 * 없어서, 주석을 달면 '문법 오류' 가 뜨고 그대로 보내면 서버가 400 을 준다 — 결국 주석 기능이
 * 무용지물이었다. 검사할 때도 보낼 때도 주석을 먼저 걷어내서, '잠시 빼 두기' 가 실제로 되게 한다.
 * 글자 수를 유지하려고 지운 자리를 공백으로 채운다 — 오류 위치 계산이 원문과 어긋나지 않는다.
 */
export function stripJsonComments(text: string): string {
  let out = ''
  let inString = false
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (inString) {
      if (c === '\\') { out += text.slice(i, i + 2); i += 2; continue }
      if (c === '"') inString = false
      out += c; i++; continue
    }
    if (c === '"') { inString = true; out += c; i++; continue }
    if (c === '/' && text[i + 1] === '/') {
      // 줄 끝까지 공백으로 바꾼다(줄바꿈은 남긴다).
      let j = i
      while (j < text.length && text[j] !== '\n') j++
      out += ' '.repeat(j - i)
      i = j
      continue
    }
    out += c; i++
  }
  return out
}

/**
 * 보낼 때·curl 로 복사할 때 쓰는 주석 제거 — 주석만 있던 줄은 줄째 지우고, 주석이 붙어 있던 줄은 끝 공백을 걷는다.
 *
 * stripJsonComments 는 오류 위치를 원문과 맞추려고 주석 자리를 공백으로 채운다. 검사용으로는 맞지만
 * 그대로 보내거나 복사하면 빈 줄과 긴 공백이 줄줄이 남았다(⌘/ 로 빼 둔 types 항목들 자리).
 * 원래부터 빈 줄은 사용자가 둔 것이라 남긴다.
 */
export function stripJsonCommentsForSend(text: string): string {
  const original = text.split('\n')
  const stripped = stripJsonComments(text).split('\n')
  const out: string[] = []
  stripped.forEach((line, i) => {
    if (line === original[i]) { out.push(line); return }
    const cleaned = line.replace(/\s+$/, '')
    if (cleaned.trim() === '') return
    out.push(cleaned)
  })
  return out.join('\n')
}

/**
 * 주석만 남고 값이 사라진 줄 때문에 생기는 끝 쉼표를 정리한다(예: [1, 2,] → [1, 2]).
 *
 * 문자열 안은 건드리지 않는다. 예전엔 정규식 한 줄이라 "a, }" 같은 **값 안의** 쉼표까지 지웠다.
 * 이 함수는 보내기 직전 바디에 걸리므로(variables.ts gqlWrap), 사용자가 쓴 값이 조용히 바뀐 채
 * 서버로 나갔고 이력에는 원문이 남아 기록과 실제가 어긋났다. 비밀번호에 ',}' 가 있어도 같았다.
 */
export function dropDanglingCommas(text: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === '\\') { out += text[i + 1] ?? ''; i++; continue }
      if (c === '"') inString = false
      continue
    }
    if (c === '"') { inString = true; out += c; continue }
    if (c === ',') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j++
      if (text[j] === '}' || text[j] === ']') continue   // 끝 쉼표 — 버린다(뒤의 공백은 그대로 둔다)
    }
    out += c
  }
  return out
}

/** 이 글이 JSON 으로 보이는가 — 선언된 바디 타입이 Raw 여도 내용이 JSON 이면 도구를 준다. */
export function looksLikeJson(text: string): boolean {
  const raw = text.trim()
  if (!raw) return false
  return raw.startsWith('{') || raw.startsWith('[')
}

export type JsonProblem = {
  message: string
  /** 원문에서 문제가 시작되는 위치(0-based). 못 찾으면 null. */
  index: number | null
  line: number | null
  column: number | null
}

/** 파서가 알려주는 위치는 마스킹된 글 기준이라, 원문 위치로 되돌려 준다. */
function originalIndex(masked: string, vars: string[], maskedIndex: number): number {
  // 마스킹으로 늘어난 길이를 앞에서부터 빼 준다.
  let delta = 0
  let scan = 0
  for (let i = 0; i < vars.length; i++) {
    const at = masked.indexOf(`"${token(i)}"`, scan)
    if (at < 0 || at >= maskedIndex) break
    delta += `"${token(i)}"`.length - vars[i].length
    scan = at + 1
  }
  return Math.max(0, maskedIndex - delta)
}

/** JSON 문법 오류를 위치까지 찾아 준다. 문제가 없으면 null. */
export function findJsonProblem(text: string): JsonProblem | null {
  if (!looksLikeJson(text)) return null
  const { masked, vars } = mask(dropDanglingCommas(stripJsonComments(text)))
  try {
    JSON.parse(masked)
    return null
  } catch (e) {
    const message = e instanceof Error ? e.message : '올바른 JSON 이 아닙니다'
    // 엔진마다 문구가 달라 둘 다 본다: "at position 12" / "line 3 column 5"
    const byPos = /position (\d+)/.exec(message)
    let index: number | null = null
    if (byPos) index = originalIndex(masked, vars, Number(byPos[1]))
    else {
      const byLine = /line (\d+) column (\d+)/.exec(message)
      if (byLine) {
        const lines = text.split('\n')
        const ln = Number(byLine[1]) - 1
        if (lines[ln] !== undefined) {
          index = lines.slice(0, ln).reduce((n, l) => n + l.length + 1, 0) + (Number(byLine[2]) - 1)
        }
      }
    }
    if (index === null) return { message, index: null, line: null, column: null }
    const before = text.slice(0, index)
    const line = before.split('\n').length
    const column = index - before.lastIndexOf('\n')
    return { message, index, line, column }
  }
}

/**
 * 들여쓰기해서 돌려준다. {{변수}} 는 있던 자리에 그대로 남는다.
 * 문법이 틀렸으면 고치지 않고 문제를 알려준다 — 멋대로 고치면 무엇이 바뀌었는지 알 수 없다.
 */
export function formatJson(text: string): { text: string; problem: JsonProblem | null } {
  const problem = findJsonProblem(text)
  if (problem) return { text, problem }
  if (!looksLikeJson(text)) return { text, problem: null }
  // 주석이 있으면 다시 찍지 않는다 — 파싱해서 찍는 순간 주석이 사라진다.
  // ⌘/ 로 잠시 빼 둔 줄이 [정리] 한 번에 없어지면 그건 정리가 아니라 삭제다.
  // 이때는 줄·들여쓰기만 맞춘다(사용자가 원한 것도 그 정도다).
  if (stripJsonComments(text) !== text) return { text: reindentJson(text), problem: null }
  // 정리하면 주석은 사라진다 — 들여쓰기를 다시 매기는 이상 주석 자리를 지킬 수 없다.
  const { masked, vars, quoted } = mask(dropDanglingCommas(stripJsonComments(text)))
  try {
    return { text: unmask(JSON.stringify(JSON.parse(masked), null, 2), vars, quoted), problem: null }
  } catch {
    return { text, problem: null }
  }
}

/**
 * 줄바꿈·들여쓰기만 맞춘다. 내용은 한 글자도 바꾸지 않는다.
 *
 * 왜 따로 두는가: formatJson 은 파싱해서 다시 찍는 방식이라 주석이 사라진다. ⌘/ 로 잠시
 * 빼 둔 줄이 [정리] 한 번에 없어지면, 그건 정리가 아니라 삭제다(되돌리기도 안 되면 더 그렇다).
 * 그래서 주석이 있는 글은 이쪽으로 처리한다 — 괄호 깊이만 세어 각 줄 앞의 공백을 다시 매긴다.
 *
 * 문자열 안의 괄호와 // 는 세지 않는다. 빈 줄은 그대로 둔다(일부러 띄운 자리다).
 */
export function reindentJson(text: string, indent = '  '): string {
  const lines = text.split('\n')
  const out: string[] = []
  let depth = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') { out.push(''); continue }
    // 닫는 괄호로 시작하면 그 줄부터 한 단계 당긴다.
    const closesFirst = /^[}\]]/.test(trimmed)
    const here = Math.max(0, closesFirst ? depth - 1 : depth)
    out.push(indent.repeat(here) + trimmed)
    // 이 줄이 깊이를 얼마나 바꾸는지 센다(문자열·주석 제외).
    let inString = false
    let delta = 0
    for (let i = 0; i < trimmed.length; i++) {
      const c = trimmed[i]
      if (inString) {
        if (c === '\\') { i++; continue }
        if (c === '"') inString = false
        continue
      }
      if (c === '"') { inString = true; continue }
      if (c === '/' && trimmed[i + 1] === '/') break   // 줄 주석 — 여기부터는 안 센다
      if (c === '{' || c === '[') delta++
      else if (c === '}' || c === ']') delta--
    }
    depth = Math.max(0, depth + delta)
  }
  return out.join('\n')
}
