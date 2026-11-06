// 요청 이름의 "그룹 / 이름" 프리픽스를 파싱해 폴더 안 서브그룹을 만든다.
// Postman import(하위 폴더 경로)와 스펙 sync(태그 프리픽스)가 만든 이름 규칙을 UI 계층으로 복원 —
// 데이터 모델 변경 없이 Postman 식 접이식 그룹을 얻는다.

export type Grouped<T> = { group: string | null; items: T[] }

const SEP = ' / '

/** "A / B / 이름" → 그룹 "A / B". 구분자가 없으면 null(그룹 없음). */
export function groupOf(name: string): string | null {
  const i = name.lastIndexOf(SEP)
  return i === -1 ? null : name.slice(0, i)
}

/** "A / B / 이름" → "이름". 그룹 없으면 원본 그대로. */
export function displayName(name: string): string {
  const i = name.lastIndexOf(SEP)
  return i === -1 ? name : name.slice(i + SEP.length)
}

/**
 * 요청 목록을 그룹 등장 순서대로 묶는다. 그룹 없는 항목은 group:null 버킷.
 * 입력 순서를 버킷 안에서 유지한다.
 */
export function groupRequests<T extends { name: string }>(items: T[]): Grouped<T>[] {
  const buckets = new Map<string | null, T[]>()
  for (const item of items) {
    const g = groupOf(item.name)
    const list = buckets.get(g)
    if (list) list.push(item)
    else buckets.set(g, [item])
  }
  return [...buckets.entries()].map(([group, list]) => ({ group, items: list }))
}
