import { describe, expect, it } from 'vitest'
import { diffLines, diffStats } from './lineDiff'

describe('diffLines', () => {
  it('동일 텍스트는 모두 same', () => {
    const d = diffLines('a\nb\nc', 'a\nb\nc')
    expect(d.every(l => l.type === 'same')).toBe(true)
    expect(diffStats(d)).toEqual({ added: 0, removed: 0 })
  })
  it('한 줄 변경 = del + add', () => {
    const d = diffLines('a\nb\nc', 'a\nX\nc')
    expect(d.map(l => `${l.type}:${l.text}`)).toEqual(['same:a', 'del:b', 'add:X', 'same:c'])
    expect(diffStats(d)).toEqual({ added: 1, removed: 1 })
  })
  it('추가된 줄', () => {
    const d = diffLines('a\nc', 'a\nb\nc')
    expect(diffStats(d)).toEqual({ added: 1, removed: 0 })
    expect(d.find(l => l.type === 'add')?.text).toBe('b')
  })
  it('삭제된 줄', () => {
    const d = diffLines('a\nb\nc', 'a\nc')
    expect(diffStats(d)).toEqual({ added: 0, removed: 1 })
    expect(d.find(l => l.type === 'del')?.text).toBe('b')
  })
  it('공통 순서 보존(LCS)', () => {
    const d = diffLines('1\n2\n3\n4', '1\n3\n4\n5')
    // 2 삭제, 5 추가, 1/3/4 공통
    expect(diffStats(d)).toEqual({ added: 1, removed: 1 })
    expect(d.filter(l => l.type === 'same').map(l => l.text)).toEqual(['1', '3', '4'])
  })
})
