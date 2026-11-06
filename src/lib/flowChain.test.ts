import { describe, expect, it } from 'vitest'
import { applyExtracts, overlayVars } from './flowChain'

describe('applyExtracts', () => {
  it('응답 JSON 에서 규칙대로 변수를 추출한다', () => {
    const { extracted, missing } = applyExtracts(
      '{"data":{"accessToken":"abc","user":{"id":42}}}',
      [{ path: 'data.accessToken', variable: 'token' }, { path: 'data.user.id', variable: 'userId' }],
    )
    expect(extracted).toEqual({ token: 'abc', userId: '42' })
    expect(missing).toEqual([])
  })

  it('없는 경로는 missing 으로, 나머지는 추출', () => {
    const { extracted, missing } = applyExtracts('{"a":1}', [
      { path: 'a', variable: 'a' }, { path: 'nope.x', variable: 'x' },
    ])
    expect(extracted).toEqual({ a: '1' })
    expect(missing).toEqual(['nope.x'])
  })

  it('JSON 아님/빈 바디는 전부 missing', () => {
    expect(applyExtracts('not-json', [{ path: 'a', variable: 'a' }]).missing).toEqual(['a'])
    expect(applyExtracts(null, [{ path: 'a', variable: 'a' }]).missing).toEqual(['a'])
  })
})

describe('overlayVars', () => {
  it('추출값이 환경 변수를 덮되 원본은 불변', () => {
    const base = { token: { value: 'env-token', secret: true } }
    const out = overlayVars(base, { token: 'runtime-token', extra: 'x' })
    expect(out.token).toEqual({ value: 'runtime-token', secret: false })
    expect(out.extra.value).toBe('x')
    expect(base.token.value).toBe('env-token')
  })
})
