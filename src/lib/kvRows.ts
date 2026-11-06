import type { KV } from './variables'

// KVEditor의 자동 trailing 빈 행(phantom row) 로직.
// - 마지막 행이 채워져 있으면(또는 행이 없으면) 입력용 빈 행을 하나 더 보여준다.
// - phantom 행은 "사용자가 그 행에 실제로 타이핑했을 때만" items에 커밋된다 —
//   기존 행 수정 시 phantom이 딸려 들어가면 템플릿에 빈 파라미터가 저장되고
//   스펙 sync diff가 CHANGED 오탐을 내기 때문.

export function shouldShowPhantom(items: KV[]): boolean {
  const last = items[items.length - 1]
  return !last || last.key.trim() !== '' || last.value.trim() !== ''
}

export function applyKVEdit(items: KV[], index: number, patch: Partial<KV>): KV[] {
  if (index < items.length) {
    return items.map((it, idx) => (idx === index ? { ...it, ...patch } : it))
  }
  // phantom 행 편집 → 이 시점에만 새 행으로 커밋
  return [...items, { key: '', value: '', enabled: true, ...patch }]
}
