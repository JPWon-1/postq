import { describe, expect, it, test } from 'vitest'
import { extractPathParameters, extractVariables, overlayKVVars, resolveRequest, resolveText, type RequestInput, type VarMap } from '@/lib/variables'

const vars: VarMap = {
  baseUrl: { value: 'https://api.example.com', secret: false },
  token: { value: 'SECRET-123', secret: true },
}
const input: RequestInput = {
  method: 'POST',
  url: '{{baseUrl}}/orders',
  params: [{ key: 'q', value: '{{token}}', enabled: true }],
  headers: [{ key: 'Authorization', value: 'Bearer {{token}}', enabled: true }],
  bodyType: 'json',
  body: '{"base":"{{baseUrl}}","x":"{{nope}}"}',
}

test('real은 전부 실값 치환', () => {
  const { real } = resolveRequest(input, vars)
  expect(real.url).toBe('https://api.example.com/orders')
  expect(real.headers[0].value).toBe('Bearer SECRET-123')
})

test('redacted는 secret만 참조 유지', () => {
  const { redacted } = resolveRequest(input, vars)
  expect(redacted.headers[0].value).toBe('Bearer {{token}}')
  expect(redacted.params[0].value).toBe('{{token}}')
  expect(redacted.body).toContain('https://api.example.com')
})

test('미해석 변수는 missing에 수집되고 원문 유지', () => {
  const { real, missing } = resolveRequest(input, vars)
  expect(missing).toEqual(['nope'])
  expect(real.body).toContain('{{nope}}')
})

describe('extractVariables', () => {
  it('url/params/headers/body 전체에서 변수 이름을 등장 순서대로 중복 없이 추출한다', () => {
    const vars = extractVariables({
      method: 'POST',
      url: '{{baseUrl}}/orders/{{orderId}}',
      params: [{ key: 'q', value: '{{query}}', enabled: true }],
      headers: [{ key: 'Authorization', value: 'Bearer {{token}}', enabled: true }],
      bodyType: 'json',
      body: '{"member": "{{memberCode}}", "again": "{{baseUrl}}"}',
    })
    expect(vars).toEqual(['baseUrl', 'orderId', 'query', 'token', 'memberCode'])
  })

  it('비활성 param/header 값은 무시한다', () => {
    const vars = extractVariables({
      method: 'GET', url: '/x', bodyType: 'none', body: '',
      params: [{ key: 'a', value: '{{off}}', enabled: false }],
      headers: [{ key: 'b', value: '{{on}}', enabled: true }],
    })
    expect(vars).toEqual(['on'])
  })

  it('변수가 없으면 빈 배열', () => {
    expect(extractVariables({ method: 'GET', url: '/plain', params: [], headers: [], bodyType: 'none', body: '' }))
      .toEqual([])
  })
})

import { applyPersonalVars, dynamicVars, DYNAMIC_VARS } from './variables'

describe('동적변수 {{$...}}', () => {
  it('PATTERN이 $ 접두 변수를 매칭하고 vars로 치환', () => {
    const dyn = dynamicVars()
    const { real } = resolveRequest(
      { method: 'GET', url: 'https://h/?t={{$timestamp}}&id={{$uuid}}', params: [], headers: [], bodyType: 'none', body: '' },
      dyn,
    )
    expect(real.url).toMatch(/\?t=\d+&id=[0-9a-f-]{36}$/)
  })

  it('한 vars로 치환하면 real·redacted 동일값(이원화 무결성)', () => {
    const dyn = dynamicVars()
    const inp: RequestInput = { method: 'GET', url: '{{$timestamp}}', params: [], headers: [], bodyType: 'none', body: '{{$timestamp}}' }
    const { real, redacted } = resolveRequest(inp, dyn)
    expect(real.url).toBe(redacted.url)
    expect(real.url).toBe(real.body)  // 같은 실행 내 일관
  })

  it('dynamicVars는 4키를 형식에 맞게 생성', () => {
    const d = dynamicVars()
    expect(d.$timestamp.value).toMatch(/^\d+$/)
    expect(d.$isoTimestamp.value).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(d.$uuid.value).toMatch(/^[0-9a-f-]{36}$/)
    expect(d.$randomInt.value).toMatch(/^\d+$/)
    expect(DYNAMIC_VARS).toContain('$timestamp')
  })

  it('extractVariables는 알려진 동적변수만 제외', () => {
    const names = extractVariables({ method: 'GET', url: '{{baseUrl}}/{{$uuid}}?t={{$timestamp}}', params: [], headers: [], bodyType: 'none', body: '' })
    expect(names).toEqual(['baseUrl'])
  })

  it('오타/미지원 $이름은 경고에 남긴다(리터럴 전송 방지)', () => {
    const names = extractVariables({ method: 'GET', url: '{{$tiemstamp}}/{{$foo}}', params: [], headers: [], bodyType: 'none', body: '' })
    expect(names).toEqual(['$tiemstamp', '$foo'])  // 알려진 4종이 아니므로 미등록 경고 대상
  })
})

import { referencesSecret } from './variables'

describe('referencesSecret', () => {
  const vm = { s: { value: 'x', secret: true }, p: { value: 'y', secret: false } }
  it('secret 변수 참조 시 true', () => {
    expect(referencesSecret('a{{s}}b', vm)).toBe(true)
    expect(referencesSecret('a{{p}}b', vm)).toBe(false)
    expect(referencesSecret('none', vm)).toBe(false)
    expect(referencesSecret('{{p}}{{s}}', vm)).toBe(true)  // 하나라도 secret 이면
  })
})

describe('applyPersonalVars', () => {
  it('개인 값이 팀 값을 덮고 secret 취급', () => {
    const team = { baseUrl: { value: 'https://team', secret: false }, token: { value: 'TEAM', secret: true } }
    const out = applyPersonalVars(team, { token: 'MINE' })
    expect(out.token).toEqual({ value: 'MINE', secret: true })
    expect(out.baseUrl).toEqual({ value: 'https://team', secret: false }) // 안 건드림
  })
  it('빈 오버라이드는 무시(팀 값 유지)', () => {
    const team = { token: { value: 'TEAM', secret: true } }
    expect(applyPersonalVars(team, { token: '' }).token.value).toBe('TEAM')
  })
  it('팀에 없던 개인 변수도 추가', () => {
    expect(applyPersonalVars({}, { myKey: 'v' }).myKey).toEqual({ value: 'v', secret: true })
  })
  it('personal 미제공이면 원본 그대로', () => {
    const team = { a: { value: '1', secret: false } }
    expect(applyPersonalVars(team, undefined)).toBe(team)
  })
})

describe('{{var|json}} 이스케이프 필터', () => {
  it('raw 는 그대로, |json 은 JSON 문자열 리터럴로 이스케이프', () => {
    const v: VarMap = { prevBody: { value: '{"id":5,"name":"a\"b"}', secret: false } }
    const inp: RequestInput = {
      method: 'POST', url: 'http://x', params: [], headers: [], bodyType: 'json',
      body: '{"raw": {{prevBody}}, "escaped": {{prevBody|json}}}',
    }
    const { real } = resolveRequest(inp, v)
    // raw: 통짜 삽입 → 유효 JSON(응답이 곧 값)
    expect(real.body).toContain('"raw": {"id":5,"name":"a\"b"}')
    // escaped: JSON 문자열 리터럴 → 전체가 유효 JSON 으로 파싱 가능
    const escapedPart = JSON.parse(real.body.replace('{"raw": {"id":5,"name":"a\"b"}, "escaped": ', '{"escaped": '))
    expect(escapedPart.escaped).toBe('{"id":5,"name":"a\"b"}')
  })
  it('|json 은 개행·따옴표를 안전 이스케이프해 JSON 문자열 컨텍스트를 깨지 않는다', () => {
    const v: VarMap = { msg: { value: 'line1\n"quoted"', secret: false } }
    const inp: RequestInput = { method: 'POST', url: 'http://x', params: [], headers: [], bodyType: 'json', body: '{"m": {{msg|json}}}' }
    const { real } = resolveRequest(inp, v)
    expect(() => JSON.parse(real.body)).not.toThrow()
    expect(JSON.parse(real.body).m).toBe('line1\n"quoted"')
  })
  it('공백 허용: {{ msg | json }}', () => {
    const v: VarMap = { msg: { value: 'hi', secret: false } }
    const inp: RequestInput = { method: 'GET', url: 'http://x/{{ msg | json }}', params: [], headers: [], bodyType: 'none', body: '' }
    expect(resolveRequest(inp, v).real.url).toBe('http://x/"hi"')
  })
})

describe('overlayKVVars — 요청별/공유 변수 오버레이', () => {
  it('빈 값·빈 키는 무시(상위 secret 보존), 값 있으면 덮고 없으면 추가', () => {
    const base: VarMap = { a: { value: 'A', secret: true }, b: { value: 'B', secret: false } }
    const out = overlayKVVars(base, [{ key: 'a', value: '' }, { key: 'b', value: 'B2' }, { key: '', value: 'x' }, { key: 'c', value: 'C' }])
    expect(out.a).toEqual({ value: 'A', secret: true })    // 빈 값 → 기존 secret 유지
    expect(out.b).toEqual({ value: 'B2', secret: false })  // 덮음(비-secret)
    expect(out.c).toEqual({ value: 'C', secret: false })   // 추가
    expect('' in out).toBe(false)                          // 빈 키 무시
  })
})

describe('한글 변수 이름', () => {
  // 환경 화면은 한글 이름을 아무 말 없이 저장하고 목록에도 보여준다. 그런데 예전 패턴은
  // \w(=[A-Za-z0-9_])만 변수로 봤다 — {{토큰}} 은 치환도 안 되고 미해석 경고도 안 뜬 채
  // 문자 그대로 요청에 실려 나갔다. 만들 수 있게 해 놓고 쓰면 조용히 틀리는 게 제일 나쁘다.
  const vars = { 토큰: { value: 'T-1', secret: false }, baseUrl: { value: 'https://x', secret: false } }

  it('치환된다', () => {
    expect(resolveText('{{baseUrl}}/u/{{토큰}}', vars)).toBe('https://x/u/T-1')
  })

  it('없으면 미해석으로 잡힌다 — 예전엔 아예 안 보였다', () => {
    const missing = new Set<string>()
    resolveText('{{없는한글}}', vars, missing)
    expect([...missing]).toEqual(['없는한글'])
  })

  it('요청 전체에서도 잡힌다', () => {
    const { real, missing } = resolveRequest(
      { method: 'GET', url: 'https://x/{{토큰}}', params: [], headers: [], bodyType: 'json', body: '{"k":"{{없는것}}"}' },
      vars,
    )
    expect(real.url).toBe('https://x/T-1')
    expect(missing).toEqual(['없는것'])
  })

  it('중괄호가 없으면 여전히 변수가 아니다', () => {
    expect(resolveText('토큰', vars)).toBe('토큰')
  })
})


test('경로 파라미터는 환경 변수·쿼리와 구분하고 단일 경로 값으로 인코딩한다', () => {
  const url = '{{baseUrl}}/orders/{serialCode}/{serialCode}?q={query}#{{fragment}}'
  expect(extractPathParameters(url)).toEqual(['serialCode'])
  const resolved = resolveRequest({ ...input, url }, { ...vars, serialCode: { value: '한 글/A?x=1#%', secret: false } })
  expect(resolved.real.url).toBe('https://api.example.com/orders/%ED%95%9C%20%EA%B8%80%2FA%3Fx%3D1%23%25/%ED%95%9C%20%EA%B8%80%2FA%3Fx%3D1%23%25?q={query}#{{fragment}}')
  expect(resolveRequest({ ...input, url }, vars).missing).toContain('serialCode')
  const hidden = resolveRequest({ ...input, url: '{{baseUrl}}/{serialCode}' }, { ...vars, serialCode: { value: 'PRIVATE', secret: true } })
  expect(hidden.real.url).toBe('https://api.example.com/PRIVATE')
  expect(hidden.redacted.url).toBe('https://api.example.com/{serialCode}')
})
