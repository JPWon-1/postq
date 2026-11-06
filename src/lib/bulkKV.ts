import type { KV } from './variables'

// Postman "Bulk Edit" 대응: KV 테이블 ↔ 텍스트 상호 변환.
// 형식: 한 줄에 `key: value`. 줄 앞 `//` 는 비활성(disabled) 항목.

export function kvToText(items: KV[]): string {
  return items
    .filter(i => i.key.trim() !== '')
    .map(i => `${i.enabled ? '' : '//'}${i.key}: ${i.value}`)
    .join('\n')
}

/**
 * 텍스트 → KV. 이 형식에 담기지 않는 설명은 이전 목록에서 이름으로 되찾아 붙인다.
 *
 * Bulk 편집은 `key: value` 만 다루므로 설명을 표현할 자리가 없다. 그래서 돌아올 때
 * 설명이 통째로 사라졌다 — 스펙에서 가져온 파라미터 설명은 손으로 쓴 게 아니라
 * 다시 채울 방법도 마땅치 않다. 헤더 몇 줄 붙여넣으려고 Bulk 를 열었다가 나가기만 해도
 * 그렇게 됐다. 형식을 늘려 설명을 싣는 것(`// 는 이미 비활성 표시다)보다,
 * 안 건드린 것을 그대로 두는 쪽이 놀라움이 적다.
 *
 * 이름이 같은 항목끼리 잇는다. 이름을 바꿨다면 그건 다른 항목으로 보는 게 맞다.
 */
export function textToKV(text: string, prev: KV[] = []): KV[] {
  const descByKey = new Map<string, string>()
  for (const p of prev) if (p?.description) descByKey.set(p.key, p.description)

  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .map(line => {
      const enabled = !line.startsWith('//')
      const body = enabled ? line : line.slice(2).trim()
      const i = body.indexOf(':')
      const kv: KV = i === -1
        ? { key: body.trim(), value: '', enabled }
        : { key: body.slice(0, i).trim(), value: body.slice(i + 1).trim(), enabled }
      const desc = descByKey.get(kv.key)
      if (desc) kv.description = desc
      return kv
    })
    .filter(kv => kv.key !== '')
}
