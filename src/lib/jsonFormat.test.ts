import { describe, expect, it } from 'vitest'
import { findJsonProblem, formatJson, looksLikeJson, reindentJson } from './jsonFormat'

describe('looksLikeJson — 선언된 타입이 아니라 내용으로 본다', () => {
  it('Raw 로 저장돼 있어도 { 나 [ 로 시작하면 JSON 으로 본다', () => {
    expect(looksLikeJson('{"a":1}')).toBe(true)
    expect(looksLikeJson('  [1,2]  ')).toBe(true)
    expect(looksLikeJson('name=kim&age=3')).toBe(false)
    expect(looksLikeJson('')).toBe(false)
  })
})

describe('formatJson — {{변수}} 를 지키면서 들여쓴다', () => {
  it('문자열 안의 변수는 그대로 남는다', () => {
    const { text, problem } = formatJson('{"site":{"siteId":"{{siteId}}"}}')
    expect(problem).toBeNull()
    expect(text).toBe('{\n  "site": {\n    "siteId": "{{siteId}}"\n  }\n}')
  })

  it('값 자리에 맨몸으로 있는 변수도 살아남는다 — 예전엔 여기서 파싱이 터졌다', () => {
    const { text, problem } = formatJson('{"customerId": {{prevBody|json}}, "n": 1}')
    expect(problem).toBeNull()
    expect(text).toContain('"customerId": {{prevBody|json}}')
    expect(text).toContain('"n": 1')
  })

  it('문법이 틀리면 고치지 않고 문제를 알려준다', () => {
    const { text, problem } = formatJson('{"a": 1 "b": 2}')   // 쉼표 자체가 빠짐
    expect(text).toBe('{"a": 1 "b": 2}')   // 멋대로 고치지 않는다
    expect(problem).not.toBeNull()
  })

  it('끝에 남은 쉼표는 봐준다 — ⌘/ 로 마지막 줄을 빼면 늘 생기는 모양이다', () => {
    const { text, problem } = formatJson('{"a": 1,}')
    expect(problem).toBeNull()
    expect(text).toBe('{\n  "a": 1\n}')
  })

  it('JSON 이 아니면 건드리지 않는다', () => {
    expect(formatJson('a=1&b=2').text).toBe('a=1&b=2')
  })
})

describe('findJsonProblem — 틀린 자리를 짚어 준다', () => {
  it('문제가 없으면 null', () => {
    expect(findJsonProblem('{"a":1}')).toBeNull()
    expect(findJsonProblem('{"a":"{{v}}"}')).toBeNull()
  })

  it('줄·칸과 원문 위치를 준다', () => {
    const text = '{\n  "a": 1\n  "b": 2\n}'   // 쉼표 빠짐
    const p = findJsonProblem(text)
    expect(p).not.toBeNull()
    expect(p!.index).not.toBeNull()
    expect(p!.line).toBe(3)               // "b" 가 있는 줄
    expect(text[p!.index!]).toBe('"')     // 가리키는 자리가 그 따옴표
  })

  it('변수가 앞에 있어도 위치가 원문 기준이다', () => {
    // 마스킹하면 글자 수가 달라진다 — 그만큼 되돌려 원문 위치를 가리켜야 한다.
    const text = '{"v": {{x}}, "a": 1 "b": 2}'
    const p = findJsonProblem(text)
    expect(p).not.toBeNull()
    expect(p!.index).not.toBeNull()
    expect(p!.index!).toBeLessThan(text.length)
    expect(text.slice(p!.index!, p!.index! + 3)).toBe('"b"')
  })
})

describe('// 주석 — 줄을 잠시 빼 두는 용도', () => {
  it('주석이 있어도 문법 오류로 보지 않는다', () => {
    const text = '{\n  "a": 1,\n  // "b": 2,\n  "c": 3\n}'
    expect(findJsonProblem(text)).toBeNull()
  })

  it('주석 때문에 홀로 남은 쉼표도 오류가 아니다 — ⌘/ 로 마지막 줄을 뺀 흔한 모양', () => {
    const text = '[\n  "A",\n  // "B",\n  // "C",\n]'
    expect(findJsonProblem(text)).toBeNull()
  })

  it('문자열 안의 // 는 주석이 아니다', () => {
    expect(findJsonProblem('{"u": "http://x.test/a"}')).toBeNull()
    expect(formatJson('{"u":"http://x.test/a"}').text).toContain('http://x.test/a')
  })

  it('정리해도 주석은 그대로 남는다 — 지우면 그건 정리가 아니라 삭제다', () => {
    const { text } = formatJson('{\n  // "b": 2,\n  "c": 3\n}')
    expect(text).toContain('// "b": 2,')
    expect(text).toContain('"c": 3')
  })
})

describe('보낼 때 실제로 나가는 내용', () => {
  it('주석 단 줄은 빠지고 나머지는 올바른 JSON 으로 나간다', async () => {
    const { gqlWrap } = await import('./variables')
    const body = '[\n  {\n    "variantCode": "BRSDX25352WHX",\n    "types": [\n      // "BASIC",\n      // "PRICE",\n      "PURCHASELIMIT"\n    ]\n  }\n]'
    const sent = gqlWrap('json', body)
    expect(() => JSON.parse(sent)).not.toThrow()
    expect(JSON.parse(sent)[0].types).toEqual(['PURCHASELIMIT'])
  })

  it('마지막 줄을 주석 처리해 끝 쉼표가 남아도 보낼 수 있다', async () => {
    const { gqlWrap } = await import('./variables')
    const sent = gqlWrap('json', '{\n  "a": 1,\n  // "b": 2\n}')
    expect(JSON.parse(sent)).toEqual({ a: 1 })
  })

  it('평문 바디의 // 는 내용이므로 건드리지 않는다', async () => {
    const { gqlWrap } = await import('./variables')
    expect(gqlWrap('raw', 'see http://x.test // and more')).toBe('see http://x.test // and more')
  })
})

describe('reindentJson — 줄·들여쓰기만 맞춘다', () => {
  it('주석을 지우지 않는다 — [정리]가 삭제가 되면 안 된다', () => {
    const text = '{\n"codes": [\n// "OLD01",\n"K176"\n]\n}'
    const out = reindentJson(text)
    expect(out).toContain('// "OLD01",')
    expect(out).toBe('{\n  "codes": [\n    // "OLD01",\n    "K176"\n  ]\n}')
  })

  it('내용은 한 글자도 안 바꾼다 — 공백만 다시 매긴다', () => {
    const text = '{\n      "a":1,\n  "b" :  2\n}'
    const out = reindentJson(text)
    expect(out).toBe('{\n  "a":1,\n  "b" :  2\n}')   // 콜론 주변 공백은 그대로
  })

  it('문자열 안의 괄호와 //는 깊이로 세지 않는다', () => {
    const text = '{\n"u": "http://x.test/{a}",\n"b": 1\n}'
    expect(reindentJson(text)).toBe('{\n  "u": "http://x.test/{a}",\n  "b": 1\n}')
  })

  it('일부러 띄운 빈 줄은 남긴다', () => {
    expect(reindentJson('{\n"a": 1,\n\n"b": 2\n}')).toBe('{\n  "a": 1,\n\n  "b": 2\n}')
  })
})

describe('formatJson — 주석이 있으면 지우지 않는다', () => {
  it('[정리]를 눌러도 주석 줄이 살아남는다', () => {
    const { text } = formatJson('{\n"codes": [\n// "OLD01",\n"K176"\n]\n}')
    expect(text).toContain('// "OLD01",')
    expect(text).toBe('{\n  "codes": [\n    // "OLD01",\n    "K176"\n  ]\n}')
  })

  it('주석이 없으면 기존처럼 다시 찍어 한 줄짜리도 펼친다', () => {
    expect(formatJson('{"a":1,"b":[2,3]}').text).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}')
  })
})

describe('dropDanglingCommas — 문자열 안은 건드리지 않는다', () => {
  it('값 안의 ", }" 와 ",]" 는 그대로 둔다 — 보내기 직전에 사용자의 값을 바꾸면 안 된다', async () => {
    const { dropDanglingCommas } = await import('./jsonFormat')
    const body = '{"pattern":"^[a-z,]+$","memo":"a, }","pw":"x,]"}'
    expect(dropDanglingCommas(body)).toBe(body)
  })
  it('진짜 끝 쉼표는 지운다', async () => {
    const { dropDanglingCommas } = await import('./jsonFormat')
    expect(dropDanglingCommas('{"a": 1,\n}')).toBe('{"a": 1\n}')
    expect(dropDanglingCommas('[1, 2 , ]')).toBe('[1, 2  ]')
  })
  it('이스케이프된 따옴표 뒤에서도 문자열 경계를 잃지 않는다', async () => {
    const { dropDanglingCommas } = await import('./jsonFormat')
    expect(dropDanglingCommas('{"q":"say \\"hi,}\\"",}')).toBe('{"q":"say \\"hi,}\\""}')
  })
  it('보낼 때 실제로 나가는 바디도 값이 그대로다', async () => {
    const { gqlWrap } = await import('./variables')
    expect(JSON.parse(gqlWrap('json', '{"memo":"a, }",}'))).toEqual({ memo: 'a, }' })
  })
})

it('보낼 때 주석 제거는 주석만 있던 줄을 지우고 공백을 남기지 않는다', async () => {
  const { stripJsonCommentsForSend, dropDanglingCommas } = await import('./jsonFormat')
  const body = '[\n  {\n    "types": [\n      "BASIC",\n      // "PRICE",\n      "STOCK",\n      // "IMAGE",\n    ]\n  }\n]'
  const out = dropDanglingCommas(stripJsonCommentsForSend(body))
  expect(JSON.parse(out)).toEqual([{ types: ['BASIC', 'STOCK'] }])
  expect(out).not.toMatch(/^\s+$/m)        // 공백만 남은 줄 없음
  expect(out).not.toMatch(/[ \t]+$/m)      // 줄 끝 공백 없음
  expect(stripJsonCommentsForSend('{\n\n  "a": 1 // 메모\n}')).toBe('{\n\n  "a": 1\n}')   // 원래 빈 줄은 유지
})
