import { describe, expect, it } from 'vitest'
import { isCredentialHeader, maskCredentialHeaders, scrubHeaders, scrubJson, scrubSecrets, secretValuesOf } from '@/lib/scrub'

describe('maskCredentialHeaders', () => {
  it('리터럴 자격증명 헤더 값은 마스킹, {{var}} 참조는 보존, 비-자격증명은 그대로', () => {
    const out = maskCredentialHeaders([
      { key: 'Authorization', value: 'Bearer abc123literal', enabled: true },
      { key: 'Authorization', value: 'Bearer {{token}}', enabled: true },
      { key: 'X-Api-Key', value: 'sk-live-xyz', enabled: true },
      { key: 'Cookie', value: 'sid=deadbeef', enabled: true },
      { key: 'Content-Type', value: 'application/json', enabled: true },
    ])
    expect(out[0].value).toBe('***')
    expect(out[1].value).toBe('Bearer {{token}}')
    expect(out[2].value).toBe('***')
    expect(out[3].value).toBe('***')
    expect(out[4].value).toBe('application/json')
    expect(out[0].enabled).toBe(true)  // 다른 필드 보존
  })
  it('빈 값은 그대로', () => {
    expect(maskCredentialHeaders([{ key: 'Authorization', value: '' }])[0].value).toBe('')
  })
})

describe('isCredentialHeader', () => {
  it('대소문자 무시 자격증명 헤더 인식', () => {
    expect(isCredentialHeader('AUTHORIZATION')).toBe(true)
    expect(isCredentialHeader('x-api-key')).toBe(true)
    expect(isCredentialHeader('Accept')).toBe(false)
  })
})

describe('scrubSecrets', () => {
  it('알려진 secret 값(echo된)을 마스킹', () => {
    expect(scrubSecrets('{"token":"SECRET-abc-123"}', ['SECRET-abc-123'])).toBe('{"token":"***"}')
  })
  it('여러 secret + 반복 등장 전부', () => {
    expect(scrubSecrets('a=AAAA b=AAAA c=BBBB', ['AAAA', 'BBBB'])).toBe('a=*** b=*** c=***')
  })
  it('4자 미만은 오탐 방지로 제외', () => {
    expect(scrubSecrets('x=ab', ['ab'])).toBe('x=ab')
  })
  it('일치 없으면 원문 유지, null 통과', () => {
    expect(scrubSecrets('nothing here', ['ZZZZ'])).toBe('nothing here')
    expect(scrubSecrets(null, ['x'])).toBeNull()
  })
})

describe('secretValuesOf', () => {
  it('secret=true 값만', () => {
    expect(secretValuesOf({ a: { value: 'X', secret: true }, b: { value: 'Y', secret: false }, c: { value: '', secret: true } }))
      .toEqual(['X'])
  })
})

describe('scrubHeaders', () => {
  it('헤더 값 마스킹, null 통과', () => {
    expect(scrubHeaders({ Authorization: 'Bearer TOKEN-1234' }, ['TOKEN-1234'])).toEqual({ Authorization: 'Bearer ***' })
    expect(scrubHeaders(null, ['x'])).toBeNull()
  })
})

describe('maskCredentialHeaders — {{var|json}} 필터 인식', () => {
  it('{{var}}·{{var|json}} 참조는 마스킹 제외(리터럴 아님), 리터럴은 마스킹', () => {
    expect(maskCredentialHeaders([{ key: 'X-Api-Key', value: '{{apiKey}}' }])[0].value).toBe('{{apiKey}}')
    expect(maskCredentialHeaders([{ key: 'X-Api-Key', value: '{{apiKey|json}}' }])[0].value).toBe('{{apiKey|json}}')
    expect(maskCredentialHeaders([{ key: 'X-Api-Key', value: 'literal-secret' }])[0].value).toBe('***')
  })
})

describe('scrubJson — 직렬화 전에 마스킹한다', () => {
  // JSON.stringify 뒤에 치환하던 시절의 두 가지 실패를 그대로 재현한다.
  it('따옴표·개행이 든 시크릿도 저장분에서 지워진다', () => {
    const secret = 'ABCD\nEF"GH'
    const results = [{ pass: true, actual: secret, message: `실제: ${secret}` }]

    // 예전 방식: 직렬화 후 치환 → JSON 이 \n 과 \" 로 이스케이프해 원문과 글자가 달라 안 지워졌다.
    const oldWay = scrubSecrets(JSON.stringify(results), [secret])!
    expect(JSON.parse(oldWay)[0].actual).toBe(secret)   // 평문이 그대로 남는다(=유출)

    // 지금 방식: 문자열 값을 먼저 마스킹하고 직렬화한다.
    const stored = JSON.stringify(scrubJson(results, [secret]))
    expect(stored).not.toContain('ABCD')
    expect(JSON.parse(stored)[0].actual).toBe('***')
  })

  it("시크릿이 'true' 여도 JSON 구조를 깨뜨리지 않는다", () => {
    // MIN_LEN 이 4 라 'true'(4자)는 치환 대상에 들어간다.
    const results = [{ pass: true, actual: 'ok' }]
    const oldWay = scrubSecrets(JSON.stringify(results), ['true'])!
    expect(() => JSON.parse(oldWay)).toThrow()           // boolean 까지 *** 로 바뀌어 깨졌다

    const stored = JSON.stringify(scrubJson(results, ['true']))
    expect(JSON.parse(stored)[0].pass).toBe(true)        // 구조는 그대로
    expect(JSON.parse(stored)[0].actual).toBe('ok')
  })

  it('중첩 객체·배열의 문자열까지 훑고 키는 건드리지 않는다', () => {
    const out = scrubJson({ assertion: { expected: 'topsecret' }, list: ['topsecret', 1, null] }, ['topsecret'])
    expect(out).toEqual({ assertion: { expected: '***' }, list: ['***', 1, null] })
  })
})
