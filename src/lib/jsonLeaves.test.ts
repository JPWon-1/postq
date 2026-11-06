import { describe, expect, it } from 'vitest'
import { collectLeaves, getByPath } from './jsonLeaves'

const sample = {
  success: true,
  data: {
    accessToken: 'abc123',
    user: { id: 42, name: '원준' },
    items: [{ code: 'C1', price: 1000 }, { code: 'C2' }],
  },
}

describe('collectLeaves', () => {
  it('중첩 객체/배열의 리프 경로를 dot 표기로 수집한다 (배열은 첫 원소)', () => {
    const paths = collectLeaves(sample).map(l => l.path)
    expect(paths).toContain('success')
    expect(paths).toContain('data.accessToken')
    expect(paths).toContain('data.user.id')
    expect(paths).toContain('data.items[0].code')
    expect(paths).not.toContain('data.items[1].code')
  })

  it('값은 문자열로 미리보기된다', () => {
    const leaves = collectLeaves(sample)
    expect(leaves.find(l => l.path === 'data.accessToken')?.value).toBe('abc123')
    expect(leaves.find(l => l.path === 'data.user.id')?.value).toBe('42')
  })

  it('깊이 4 초과는 탐색하지 않는다', () => {
    const deep = { a: { b: { c: { d: { e: 'too-deep' } } } } }
    expect(collectLeaves(deep).map(l => l.path)).not.toContain('a.b.c.d.e')
  })

  it('최대 30개에서 멈춘다', () => {
    const wide = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i]))
    expect(collectLeaves(wide)).toHaveLength(30)
  })

  it('원시값 루트/빈 객체는 빈 결과', () => {
    expect(collectLeaves('just-string')).toEqual([])
    expect(collectLeaves({})).toEqual([])
  })
})

describe('getByPath', () => {
  it('dot/배열 표기로 값을 꺼낸다', () => {
    expect(getByPath(sample, 'data.accessToken')).toBe('abc123')
    expect(getByPath(sample, 'data.items[0].price')).toBe('1000')
    expect(getByPath(sample, 'data.items[1].code')).toBe('C2')
  })

  it('미존재/비리프 경로는 undefined', () => {
    expect(getByPath(sample, 'data.nope')).toBeUndefined()
    expect(getByPath(sample, 'data.user')).toBeUndefined()
  })
})
