import type { RequestRow } from '@/lib/ui-types'

/** ⌘K 팔레트에서 바로 실행할 명령(뷰 이동·환경 전환·테마 등). */
export type PaletteAction = {
  id: string
  label: string
  /** 좌측 태그(뷰/환경/설정/테마 …) */
  badge: string
  /** 우측 보조 텍스트(현재 상태 표시 등) */
  hint?: string
  /** 검색 보강 alias(영문·약어) */
  keywords?: string
  run: () => void
}

export type PaletteEntry = { request: RequestRow; folderName: string }

/** 공백 구분 토큰(소문자). 빈 토큰은 버린다. */
export function tokenize(q: string): string[] {
  return q.toLowerCase().split(/\s+/).filter(Boolean)
}

const matchesAll = (corpus: string, tokens: string[]) =>
  tokens.every(t => corpus.includes(t))

/** 명령을 label·badge·hint·keywords 로 AND 필터. 토큰이 없으면 전부. */
export function filterActions(actions: PaletteAction[], tokens: string[]): PaletteAction[] {
  if (tokens.length === 0) return actions
  return actions.filter(a =>
    matchesAll(`${a.label} ${a.badge} ${a.hint ?? ''} ${a.keywords ?? ''}`.toLowerCase(), tokens))
}

/**
 * 요청을 method·name·url·폴더명으로 AND 필터.
 * 검색어가 없을 땐 8개만(명령이 안 가려지게), 있을 땐 20개까지.
 */
export function filterEntries(entries: PaletteEntry[], tokens: string[]): PaletteEntry[] {
  const hit = tokens.length === 0
    ? entries
    : entries.filter(({ request: r, folderName }) =>
        matchesAll(`${r.method} ${r.name} ${r.url} ${folderName} ${(r.tags ?? []).join(' ')}`.toLowerCase(), tokens))
  return hit.slice(0, tokens.length === 0 ? 8 : 20)
}
