import { beforeEach, describe, expect, it, vi } from 'vitest'
import { KEYS, LAYOUT_KEYS, read, readFlag, readJson, readStringArray, remove, scoped, write, writeFlag, writeJson } from './localStore'

const store = new Map<string, string>()
beforeEach(() => {
  store.clear()
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) },
    },
  })
})

describe('읽고 쓰기', () => {
  it('쓴 것을 읽는다', () => {
    write('k', 'v')
    expect(read('k')).toBe('v')
  })

  it('없으면 null', () => {
    expect(read('없음')).toBeNull()
  })

  // 저장 실패로 화면 전체가 죽는 일이 없어야 한다 — 저장은 부가 기능이다.
  it('프라이빗 모드에서 setItem 이 던져도 안 죽는다', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => null,
        setItem: () => { throw new DOMException('QuotaExceededError') },
        removeItem: () => { throw new Error('nope') },
      },
    })
    expect(() => write('k', 'v')).not.toThrow()
    expect(() => remove('k')).not.toThrow()
    expect(() => writeJson('k', { a: 1 })).not.toThrow()
  })

  it('getItem 이 던져도 null 로 떨어진다', () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => { throw new Error('보안 정책') } } })
    expect(read('k')).toBeNull()
  })

  // SSR 에서 불리면 window 가 없다. 확인 안 하면 첫 렌더가 통째로 죽는다.
  it('서버(window 없음)에서도 안 죽는다', () => {
    vi.stubGlobal('window', undefined)
    expect(read('k')).toBeNull()
    expect(() => write('k', 'v')).not.toThrow()
    expect(readFlag('k', true)).toBe(true)
    expect(readStringArray('k')).toEqual([])
  })
})

describe('flag', () => {
  it('저장 전에는 호출자가 정한 기본값', () => {
    expect(readFlag(KEYS.sidebarOpen, true)).toBe(true)
    expect(readFlag(KEYS.historyOpen, false)).toBe(false)
  })

  it("'0' 은 꺼짐, '1' 은 켜짐", () => {
    writeFlag('k', false); expect(readFlag('k', true)).toBe(false)
    writeFlag('k', true); expect(readFlag('k', false)).toBe(true)
  })

  // 예전 코드가 남긴 이상한 값도 있을 수 있다.
  it("'1' 이 아닌 값은 전부 꺼짐으로 본다", () => {
    write('k', 'yes')
    expect(readFlag('k', true)).toBe(false)
  })
})

describe('JSON', () => {
  it('배열/객체를 왕복시킨다', () => {
    writeJson('k', ['a', 'b'])
    expect(readJson('k', [])).toEqual(['a', 'b'])
  })

  // 손상된 값 하나가 그 화면을 통째로 죽이던 자리들이 있었다.
  it('깨진 JSON 은 기본값으로 떨어진다', () => {
    write('k', '{{{')
    expect(readJson('k', { safe: true })).toEqual({ safe: true })
  })

  it("저장된 'null' 도 기본값으로 — null 을 받아 .map 하면 죽는다", () => {
    write('k', 'null')
    expect(readJson('k', [])).toEqual([])
  })

  it('문자열 배열은 요소 타입까지 지킨다', () => {
    write('k', JSON.stringify(['a', 3, null, 'b']))
    expect(readStringArray('k')).toEqual(['a', 'b'])
  })

  it('배열이 아니면 빈 배열', () => {
    write('k', JSON.stringify({ a: 1 }))
    expect(readStringArray('k')).toEqual([])
  })
})

describe('키 목록', () => {
  it('키가 서로 겹치지 않는다 — 겹치면 한쪽이 다른 쪽을 덮어쓴다', () => {
    const all = Object.values(KEYS)
    expect(new Set(all).size).toBe(all.length)
  })

  // '초기화' 목록이 실제 키와 어긋나면 조용히 일부만 지운다.
  it('초기화 목록은 전부 실제 키다', () => {
    const known = new Set<string>(Object.values(KEYS))
    for (const k of LAYOUT_KEYS) expect(known.has(k), `${k} 가 KEYS 에 없다`).toBe(true)
  })

  // 배치를 되돌리려다 고른 것까지 날아가면 그게 더 나쁘다.
  it('초기화는 고른 프로젝트를 건드리지 않는다', () => {
    expect(LAYOUT_KEYS).not.toContain(KEYS.workspace)
  })

  it('프로젝트별 키는 프로젝트마다 다르다', () => {
    expect(scoped.favRequests('a')).not.toBe(scoped.favRequests('b'))
    expect(scoped.favRequests('a')).toContain('a')
  })
})
