import { describe, it, expect } from 'vitest'
import { appendCapped, LOG_MAX, capLine } from './logBuffer'

describe('흘러가는 로그 상한', () => {
  it('상한 아래면 그대로 붙인다', () => {
    const { next, dropped } = appendCapped([1, 2], [3], 10)
    expect(next).toEqual([1, 2, 3])
    expect(dropped).toBe(0)
  })

  it('넘치면 오래된 쪽을 버리고, 버린 수를 알려준다', () => {
    const { next, dropped } = appendCapped([1, 2, 3], [4, 5], 3)
    expect(next).toEqual([3, 4, 5])   // 최근 3줄
    expect(dropped).toBe(2)
  })

  it('한 번에 상한보다 많이 들어와도 최근 것만 남는다', () => {
    // 청크 하나에 수천 줄이 들어오는 스트림이 있다 — 이때도 상한을 넘기면 안 된다.
    const { next, dropped } = appendCapped([], Array.from({ length: 100 }, (_, i) => i), 10)
    expect(next).toEqual([90, 91, 92, 93, 94, 95, 96, 97, 98, 99])
    expect(dropped).toBe(90)
  })

  it('빈 입력이면 같은 배열을 그대로 준다 — 헛 렌더를 만들지 않는다', () => {
    const prev = [1, 2]
    const { next, dropped } = appendCapped(prev, [], 10)
    expect(next).toBe(prev)
    expect(dropped).toBe(0)
  })

  it('기본 상한이 있다', () => {
    expect(LOG_MAX).toBeGreaterThan(0)
    expect(appendCapped([], Array.from({ length: LOG_MAX + 5 }, (_, i) => i)).next).toHaveLength(LOG_MAX)
  })
})

describe('capLine', () => {
  it('상한 이하는 그대로, 넘으면 자르고 버린 글자 수를 적는다', () => {
    expect(capLine('abc', 5)).toBe('abc')
    const out = capLine('a'.repeat(12), 5)
    expect(out.startsWith('aaaaa …')).toBe(true)
    expect(out).toContain('7자 잘림')
  })
})
