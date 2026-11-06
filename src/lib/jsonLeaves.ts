// 응답 JSON → 변수 추출용 리프 경로 수집기.
// dot 표기 경로(배열은 [i])로 리프(문자열/숫자/불리언) 후보를 나열하고, 경로로 값을 꺼낸다.

export type Leaf = { path: string; value: string }

const MAX_DEPTH = 4
const MAX_LEAVES = 30

/** JSON 값에서 리프 경로 후보를 수집한다 (depth ≤ 4, 최대 30개, 배열은 첫 원소만 탐색). */
export function collectLeaves(root: unknown): Leaf[] {
  const acc: Leaf[] = []
  const walk = (node: unknown, path: string, depth: number) => {
    if (acc.length >= MAX_LEAVES) return
    if (node === null || node === undefined) return
    const t = typeof node
    if (t === 'string' || t === 'number' || t === 'boolean') {
      if (path) acc.push({ path, value: String(node) })
      return
    }
    if (depth >= MAX_DEPTH) return
    if (Array.isArray(node)) {
      if (node.length > 0) walk(node[0], `${path}[0]`, depth + 1)
      return
    }
    if (t === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        walk(v, path ? `${path}.${k}` : k, depth + 1)
        if (acc.length >= MAX_LEAVES) return
      }
    }
  }
  walk(root, '', 0)
  return acc
}

/** dot 표기 경로(`a.b[0].c`)로 값을 꺼낸다. 리프가 아니거나 미존재면 undefined. */
export function getByPath(root: unknown, path: string): string | undefined {
  const segments = path.split('.').flatMap(seg => {
    const parts: (string | number)[] = []
    const re = /([^[\]]+)|\[(\d+)\]/g
    for (const m of seg.matchAll(re)) {
      if (m[1] !== undefined) parts.push(m[1])
      else parts.push(Number(m[2]))
    }
    return parts
  })
  let cur: unknown = root
  for (const s of segments) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string | number, unknown>)[s]
  }
  const t = typeof cur
  return t === 'string' || t === 'number' || t === 'boolean' ? String(cur) : undefined
}
