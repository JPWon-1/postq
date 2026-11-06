import { describe, expect, it } from 'vitest'
import { splitQuery, buildUrl, paramsFromUrl, urlFromParams, reconcile, addPathParam } from './urlParams'
import type { KV } from './variables'

describe('splitQuery', () => {
  it('쿼리 없는 URL', () => {
    expect(splitQuery('{{baseUrl}}/a/b')).toEqual({ base: '{{baseUrl}}/a/b', query: [] })
  })
  it('쿼리 파싱(리터럴·{{var}} 보존)', () => {
    expect(splitQuery('{{baseUrl}}/x?abc=1&t={{token}}')).toEqual({
      base: '{{baseUrl}}/x',
      query: [{ key: 'abc', value: '1', enabled: true }, { key: 't', value: '{{token}}', enabled: true }],
    })
  })
  it('값에 = 포함(첫 = 로만 분리)', () => {
    expect(splitQuery('http://x?a=b=c').query).toEqual([{ key: 'a', value: 'b=c', enabled: true }])
  })
})

describe('buildUrl / urlFromParams', () => {
  it('활성·키 있는 것만 쿼리로', () => {
    const p: KV[] = [{ key: 'a', value: '1', enabled: true }, { key: 'b', value: '2', enabled: false }, { key: '', value: 'x', enabled: true }]
    expect(buildUrl('http://x', p)).toBe('http://x?a=1')
  })
  it('params 편집 → URL 은 path 유지 + 쿼리 재작성', () => {
    expect(urlFromParams('http://x/p?old=9', [{ key: 'abc', value: '1', enabled: true }])).toBe('http://x/p?abc=1')
  })
  it('활성 params 없으면 쿼리 제거', () => {
    expect(urlFromParams('http://x?a=1', [{ key: 'a', value: '1', enabled: false }])).toBe('http://x')
  })
})

describe('paramsFromUrl (URL 편집 → Params)', () => {
  it('?abc=1 추가 시 테이블에 반영', () => {
    expect(paramsFromUrl('http://x?abc=1', [])).toEqual([{ key: 'abc', value: '1', enabled: true }])
  })
  it('비활성 기존 파라미터 보존(URL 에 없어도)', () => {
    const prev: KV[] = [{ key: 'off', value: 'z', enabled: false }]
    expect(paramsFromUrl('http://x?a=1', prev)).toEqual([
      { key: 'a', value: '1', enabled: true },
      { key: 'off', value: 'z', enabled: false },
    ])
  })
  it('같은 키 설명 계승', () => {
    const prev: KV[] = [{ key: 'a', value: 'old', enabled: true, description: '설명' }]
    expect(paramsFromUrl('http://x?a=new', prev)).toEqual([{ key: 'a', value: 'new', enabled: true, description: '설명' }])
  })
})

describe('reconcile (로드 정합화)', () => {
  it('params 만 있고 URL 엔 없던 레거시 → URL 에 쿼리로 노출', () => {
    const { url, params } = reconcile('{{baseUrl}}/x/5336', [{ key: 'detailId', value: '53368644', enabled: true }])
    expect(url).toBe('{{baseUrl}}/x/5336?detailId=53368644')
    expect(params).toEqual([{ key: 'detailId', value: '53368644', enabled: true }])
  })
  it('URL 에만 있던 쿼리 키는 테이블에 추가(params 우선)', () => {
    const { url, params } = reconcile('http://x?fromUrl=1', [{ key: 'fromParam', value: '2', enabled: true }])
    expect(params).toEqual([{ key: 'fromParam', value: '2', enabled: true }, { key: 'fromUrl', value: '1', enabled: true }])
    expect(url).toBe('http://x?fromParam=2&fromUrl=1')
  })
  it('치는 중인 쿼리는 그대로 둔다 — 끝의 ? · & · 값 없는 키', () => {
    for (const typed of ['http://x/a?', 'http://x/a?b', 'http://x/a?b=1&']) {
      expect(reconcile(typed, paramsFromUrl(typed, [])).url).toBe(typed)
    }
  })
})

describe('addPathParam', () => {
  it('쿼리 앞 경로 끝에 /{이름}', () => {
    expect(addPathParam('{{baseUrl}}/members/', 'id')).toBe('{{baseUrl}}/members/{id}')
    expect(addPathParam('http://x/a?b=1', '{c}')).toBe('http://x/a/{c}?b=1')
  })
  it('비었거나 이미 있으면 그대로', () => {
    expect(addPathParam('http://x/{id}', 'id')).toBe('http://x/{id}')
    expect(addPathParam('http://x', ' ')).toBe('http://x')
  })
})
