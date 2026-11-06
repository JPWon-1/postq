import { describe, expect, it } from 'vitest'

/**
 * 즐겨찾기 정렬 규칙.
 *
 * 훅 자체는 localStorage/React 에 묶여 있어, 화면이 실제로 의존하는 순수 규칙만 떼어
 * 같은 구현으로 고정한다. 핵심은 '등록한 순서' 가 유지되는 것 — 알파벳순으로 다시
 * 정렬해 버리면 사용자가 정한 우선순위가 사라진다.
 */
function sortFavoritesFirst<T>(items: T[], idOf: (item: T) => string, favorites: string[]): T[] {
  const rank = new Map(favorites.map((id, i) => [id, i]))
  const pinned: T[] = []
  const rest: T[] = []
  for (const item of items) (rank.has(idOf(item)) ? pinned : rest).push(item)
  pinned.sort((a, b) => (rank.get(idOf(a)) ?? 0) - (rank.get(idOf(b)) ?? 0))
  return [...pinned, ...rest]
}

const id = (s: string) => s
const LIST = ['alloy', 'api-online', 'controller', 'kiwi-api', 'zebra']

describe('즐겨찾기 정렬', () => {
  it('즐겨찾기가 맨 위로 온다', () => {
    expect(sortFavoritesFirst(LIST, id, ['controller'])[0]).toBe('controller')
  })

  // 이게 이 규칙의 핵심이다 — 이름순으로 다시 정렬하면 사용자가 정한 순서가 날아간다.
  it('등록한 순서를 지킨다 (이름순으로 재정렬하지 않는다)', () => {
    expect(sortFavoritesFirst(LIST, id, ['zebra', 'api-online', 'controller']).slice(0, 3))
      .toEqual(['zebra', 'api-online', 'controller'])
  })

  it('즐겨찾기가 아닌 것들은 원래 순서를 유지한다', () => {
    expect(sortFavoritesFirst(LIST, id, ['zebra']))
      .toEqual(['zebra', 'alloy', 'api-online', 'controller', 'kiwi-api'])
  })

  it('즐겨찾기가 없으면 목록이 그대로다', () => {
    expect(sortFavoritesFirst(LIST, id, [])).toEqual(LIST)
  })

  it('목록에 없는 즐겨찾기는 무시된다 — 지워진 항목이 유령으로 남지 않게', () => {
    expect(sortFavoritesFirst(LIST, id, ['사라진것', 'controller'])[0]).toBe('controller')
    expect(sortFavoritesFirst(LIST, id, ['사라진것', 'controller'])).toHaveLength(LIST.length)
  })

  it('전부 즐겨찾기면 등록 순서가 곧 전체 순서', () => {
    const favs = ['zebra', 'kiwi-api', 'controller', 'api-online', 'alloy']
    expect(sortFavoritesFirst(LIST, id, favs)).toEqual(favs)
  })

  it('객체 목록에서도 id 추출로 동작한다', () => {
    const rows = [{ key: 'a' }, { key: 'b' }, { key: 'c' }]
    expect(sortFavoritesFirst(rows, r => r.key, ['c', 'a']).map(r => r.key)).toEqual(['c', 'a', 'b'])
  })
})
