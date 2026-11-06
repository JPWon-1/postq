import { describe, expect, it } from 'vitest'
import { findTextMatches, nextTextMatch, MAX_TEXT_MATCHES } from './textSearch'

describe('body text finding', () => {
  it('finds every literal case-insensitive position, preserving source offsets', () => {
    expect(findTextMatches('İ before\nAlpha ALPHA alpha after', 'alpha').matches).toEqual([
      { start: 9, end: 14 }, { start: 15, end: 20 }, { start: 21, end: 26 },
    ])
    expect(findTextMatches('a.* a.*', '.*').matches).toEqual([{ start: 1, end: 3 }, { start: 5, end: 7 }])
    expect(findTextMatches('a\nb', 'a\nb').matches).toEqual([{ start: 0, end: 3 }])
  })
  it('handles empty, missing, and non-overlapping matches', () => {
    expect(findTextMatches('aaa', '').matches).toEqual([])
    expect(findTextMatches('aaa', 'b').matches).toEqual([])
    expect(findTextMatches('aaa', 'aa').matches).toEqual([{ start: 0, end: 2 }])
  })
  it('wraps in both directions and handles no matches', () => {
    expect(nextTextMatch(2, 1, 3)).toBe(0)
    expect(nextTextMatch(0, -1, 3)).toBe(2)
    expect(nextTextMatch(0, 1, 3)).toBe(1)
    expect(nextTextMatch(-1, -1, 3)).toBe(2)
    expect(nextTextMatch(-1, 1, 0)).toBe(-1)
  })
  it('bounds highlights in very large bodies without truncating the source', () => {
    const text = 'x'.repeat(700_000)
    expect(findTextMatches(text, 'x').matches).toHaveLength(MAX_TEXT_MATCHES)
    expect(findTextMatches(text, 'x').capped).toBe(true)
    expect(findTextMatches('xxx', 'x', 3).capped).toBe(false)
    expect(findTextMatches('xxxx', 'x', 3).capped).toBe(true)
  })
})
