import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getPersonalVars, setPersonalVar } from './personalVars'
import { KEYS } from './localStore'

// 개인 환경 오버라이드 — 브라우저에만 있고 팀에 안 올라간다.
// 여기가 어긋나면 '내 값으로 실행한 줄 알았는데 팀 값으로 나갔다' 가 된다.
// 테스트는 node 환경이라 localStorage 가 없다 — localStore.test 와 같은 방식으로 끼운다.
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

describe('개인 변수', () => {
  it('환경을 안 고르면 빈 값 — 다른 환경 값이 새지 않는다', () => {
    setPersonalVar('env1', 'token', 'mine')
    expect(getPersonalVars(null)).toEqual({})
  })

  it('환경별로 따로 보관된다', () => {
    setPersonalVar('stage', 'token', 'S')
    setPersonalVar('prod', 'token', 'P')
    expect(getPersonalVars('stage')).toEqual({ token: 'S' })
    expect(getPersonalVars('prod')).toEqual({ token: 'P' })
  })

  it('빈 문자열은 저장이 아니라 삭제다 — 지웠는데 남아 있으면 계속 그 값으로 나간다', () => {
    setPersonalVar('stage', 'token', 'S')
    setPersonalVar('stage', 'token', '')
    expect(getPersonalVars('stage')).toEqual({})
  })

  it('같은 환경의 다른 키는 건드리지 않는다', () => {
    setPersonalVar('stage', 'a', '1')
    setPersonalVar('stage', 'b', '2')
    setPersonalVar('stage', 'a', '')
    expect(getPersonalVars('stage')).toEqual({ b: '2' })
  })

  it('저장된 값이 깨져 있어도 화면을 죽이지 않는다', () => {
    store.set(KEYS.personalVars, '{not json')
    expect(getPersonalVars('stage')).toEqual({})
    expect(() => setPersonalVar('stage', 'a', '1')).not.toThrow()
    expect(getPersonalVars('stage')).toEqual({ a: '1' })
  })

  it('없는 환경을 물으면 빈 객체', () => {
    expect(getPersonalVars('처음보는환경')).toEqual({})
  })
})
