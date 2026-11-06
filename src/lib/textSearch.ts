export type TextMatch = { start: number; end: number }
export const MAX_TEXT_MATCHES = 2000

/** Literal, case-insensitive matches with original UTF-16 offsets (including İ). */
export function findTextMatches(text: string, query: string, limit = MAX_TEXT_MATCHES) {
  const matches: TextMatch[] = []
  if (!query) return { matches, capped: false }
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    if (matches.length >= limit) return { matches, capped: true }
    matches.push({ start: m.index, end: m.index + m[0].length })
  }
  return { matches, capped: false }
}

export function nextTextMatch(current: number, direction: number, count: number) {
  if (!count) return -1
  if (current < 0) return direction > 0 ? 0 : count - 1
  return (current + direction + count) % count
}
