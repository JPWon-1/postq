'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { readStringArray, writeJson } from './localStore'

/**
 * 즐겨찾기 — 자주 쓰는 항목을 목록 맨 위로 올린다.
 *
 * 목록이 길어지면(요청 2000개) 매번 찾는 비용이 실제 작업보다
 * 커진다. 검색이 있어도 '내가 늘 쓰는 그거' 는 치는 것 자체가 낭비다.
 *
 * Set 이 아니라 배열로 둔다 — 등록한 순서가 곧 사용자가 정한 우선순위다.
 * (Set 으로 두면 순서가 삽입순에 묶여 재정렬이 불가능하고, 화면에 정렬 근거도 안 남는다)
 *
 * 개인 취향이라 브라우저에만 둔다.
 */
export function useFavorites(storageKey: string) {
  const [favorites, setFavorites] = useState<string[]>([])
  const current = useRef(favorites)
  current.current = favorites

  // 첫 렌더는 서버와 같아야 하므로(하이드레이션) 마운트 후에 읽는다.
  useEffect(() => {
    const load = () => setFavorites(readStringArray(storageKey))
    const onStorage = (event: StorageEvent) => { if (event.key === storageKey || event.key === null) load() }
    const onLocal = (event: Event) => {
      const detail = (event as CustomEvent<{ key: string; favorites: string[] }>).detail
      if (detail.key === storageKey) { current.current = detail.favorites; setFavorites(detail.favorites) }
    }
    load()
    window.addEventListener('storage', onStorage)
    window.addEventListener('ah:favorites-changed', onLocal)
    return () => { window.removeEventListener('storage', onStorage); window.removeEventListener('ah:favorites-changed', onLocal) }
  }, [storageKey])

  const persist = useCallback((next: string[]) => {
    writeJson(storageKey, next)
    window.dispatchEvent(new CustomEvent('ah:favorites-changed', { detail: { key: storageKey, favorites: next } }))
    return next
  }, [storageKey])

  const toggle = useCallback((id: string) => {
    const prev = current.current
    const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    current.current = next
    setFavorites(next)
    persist(next)
  }, [persist])

  const isFavorite = useCallback((id: string) => favorites.includes(id), [favorites])

  /**
   * 즐겨찾기를 등록 순서대로 앞에 놓고, 나머지는 원래 순서를 지킨다.
   * 정렬을 새로 하지 않는 이유: 원래 순서(트리 구조·이름순)도 의미가 있어서
   * 즐겨찾기만 떼어 올리고 나머지는 건드리지 않는 게 덜 놀랍다.
   */
  const sortFavoritesFirst = useCallback(<T,>(items: T[], idOf: (item: T) => string): T[] => {
    const rank = new Map(favorites.map((id, i) => [id, i]))
    const pinned: T[] = []
    const rest: T[] = []
    for (const item of items) (rank.has(idOf(item)) ? pinned : rest).push(item)
    pinned.sort((a, b) => (rank.get(idOf(a)) ?? 0) - (rank.get(idOf(b)) ?? 0))
    return [...pinned, ...rest]
  }, [favorites])

  return { favorites, isFavorite, toggle, sortFavoritesFirst }
}
