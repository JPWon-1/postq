import { describe, expect, it } from 'vitest'
import { filterActions, filterEntries, tokenize, type PaletteAction, type PaletteEntry } from '@/lib/paletteFilter'
import type { RequestRow } from '@/lib/ui-types'

const act = (o: Partial<PaletteAction>): PaletteAction =>
  ({ id: o.id ?? 'x', label: o.label ?? '', badge: o.badge ?? '뷰', keywords: o.keywords, hint: o.hint, run: () => {} })

const entry = (name: string, method = 'GET', url = '/x', folderName = 'f'): PaletteEntry =>
  ({ request: { id: name, name, method, url } as RequestRow, folderName })

describe('tokenize', () => {
  it('소문자·공백분리·빈토큰 제거', () => {
    expect(tokenize('  Get  User ')).toEqual(['get', 'user'])
    expect(tokenize('')).toEqual([])
  })
})

describe('filterActions', () => {
  const actions = [
    act({ id: 'v:mon', label: '스케줄', badge: '뷰', keywords: 'schedule' }),
    act({ id: 'e:stg', label: 'staging', badge: '환경', keywords: 'env 전환' }),
    act({ id: 't:dark', label: '다크 테마', badge: '테마', keywords: 'dark' }),
  ]
  it('토큰 없으면 전부', () => {
    expect(filterActions(actions, tokenize(''))).toHaveLength(3)
  })
  it('label 로 매칭', () => {
    expect(filterActions(actions, tokenize('스케줄')).map(a => a.id)).toEqual(['v:mon'])
  })
  it('keywords(영문 alias)로 매칭', () => {
    expect(filterActions(actions, tokenize('schedule')).map(a => a.id)).toEqual(['v:mon'])
  })
  it('badge 로 매칭', () => {
    expect(filterActions(actions, tokenize('환경')).map(a => a.id)).toEqual(['e:stg'])
  })
  it('여러 토큰은 AND', () => {
    expect(filterActions(actions, tokenize('env 전환')).map(a => a.id)).toEqual(['e:stg'])
    expect(filterActions(actions, tokenize('dark 스케줄'))).toHaveLength(0)
  })
})

describe('filterEntries', () => {
  it('method·name·url·폴더명으로 AND 매칭', () => {
    const es = [entry('목록', 'GET', '/users', '유저'), entry('생성', 'POST', '/users', '유저')]
    expect(filterEntries(es, tokenize('post')).map(e => e.request.name)).toEqual(['생성'])
    expect(filterEntries(es, tokenize('유저 목록')).map(e => e.request.name)).toEqual(['목록'])
  })
  it('검색어 없으면 8개까지만', () => {
    const es = Array.from({ length: 20 }, (_, i) => entry(`r${i}`))
    expect(filterEntries(es, tokenize(''))).toHaveLength(8)
  })
  it('검색어 있으면 20개까지', () => {
    const es = Array.from({ length: 30 }, (_, i) => entry(`get-${i}`))
    expect(filterEntries(es, tokenize('get'))).toHaveLength(20)
  })
})
