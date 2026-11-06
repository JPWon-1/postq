import type { KV } from './variables'

// URL 의 쿼리스트링(?a=1&b=2)과 Params 테이블을 양방향 동기화한다(Postman 동작).
// 값은 '리터럴'로 다룬다({{var}}·한글 그대로) — 실제 인코딩은 실행 시 mergeQueryParams/URL 이 담당.
// path 변수({detailId} 같은 경로 세그먼트)는 쿼리가 아니므로 여기서 다루지 않는다.

/** URL 을 쿼리 앞부분(base, path+호스트)과 쿼리 파라미터(KV[])로 분리. 쿼리 없으면 query: []. */
export function splitQuery(url: string): { base: string; query: KV[] } {
  const qi = url.indexOf('?')
  if (qi < 0) return { base: url, query: [] }
  const base = url.slice(0, qi)
  const query: KV[] = []
  for (const pair of url.slice(qi + 1).split('&')) {
    if (pair === '') continue
    const eq = pair.indexOf('=')
    query.push(eq < 0
      ? { key: pair, value: '', enabled: true }
      : { key: pair.slice(0, eq), value: pair.slice(eq + 1), enabled: true })
  }
  return { base, query }
}

/** base 뒤에 '활성 + 키 있는' params 를 쿼리스트링으로 붙인다(리터럴). 없으면 base 만. */
export function buildUrl(base: string, params: KV[]): string {
  const qs = params.filter(p => p.enabled && p.key.trim() !== '').map(p => `${p.key}=${p.value}`).join('&')
  return qs ? `${base}?${qs}` : base
}

/**
 * URL 편집 → Params: URL 쿼리(활성)로 테이블을 갱신하되, 사용자가 꺼둔(비활성) 기존 행과
 * 같은 키의 설명은 보존한다(체크 해제한 파라미터가 URL 편집으로 사라지지 않게).
 */
export function paramsFromUrl(url: string, prev: KV[]): KV[] {
  const { query } = splitQuery(url)
  const descByKey = new Map(prev.filter(p => p.key.trim() !== '').map(p => [p.key, p.description]))
  const fromUrl = query.map(q => (descByKey.has(q.key) ? { ...q, description: descByKey.get(q.key) } : q))
  const disabled = prev.filter(p => !p.enabled && p.key.trim() !== '')
  return [...fromUrl, ...disabled]
}

/** Params 편집 → URL: 현재 URL 의 path(base)는 유지하고 쿼리만 활성 params 로 다시 쓴다. */
export function urlFromParams(url: string, params: KV[]): string {
  return buildUrl(splitQuery(url).base, params)
}

/**
 * 로드 시 정합화 — 저장된 URL 쿼리와 Params 테이블을 합쳐 서로 일치시킨다(레거시 데이터 호환).
 * 같은 키는 Params 우선(실행 시 mergeQueryParams 가 params 로 URL 쿼리를 덮는 규칙과 일치),
 * URL 에만 있던 키는 테이블에 추가. 결과 URL 은 활성 params 를 쿼리로 반영한다.
 */
export function reconcile(url: string, params: KV[]): { url: string; params: KV[] } {
  const { base, query } = splitQuery(url)
  const paramKeys = new Set(params.filter(p => p.key.trim() !== '').map(p => p.key))
  const urlOnly = query.filter(q => !paramKeys.has(q.key))
  const merged = [...params, ...urlOnly]
  // 이미 표와 같은 내용이면 친 그대로 둔다. 매번 다시 만들면 치는 중인 끝의 '?'·'&'·'?a'
  // 가 그 자리에서 지워지거나 'a=' 로 바뀌어, 주소창에서 쿼리를 칠 수가 없었다.
  const enabled = merged.filter(p => p.enabled && p.key.trim() !== '')
  const same = query.length === enabled.length && query.every((q, i) => q.key === enabled[i].key && q.value === enabled[i].value)
  return { url: same ? url : buildUrl(base, merged), params: merged }
}

/**
 * 경로 끝(쿼리 앞)에 /{name} 을 붙인다. 이름이 비었거나 이미 있으면 그대로.
 * 주소창에 '{이름}' 을 직접 치는 방법만 있으면, 경로 파라미터를 어떻게 만드는지 알기 어렵다.
 */
export function addPathParam(url: string, name: string): string {
  const n = name.trim().replace(/^\{+|\}+$/g, '')
  if (!n || url.includes(`{${n}}`)) return url
  const qi = url.indexOf('?')
  const path = qi < 0 ? url : url.slice(0, qi)
  const rest = qi < 0 ? '' : url.slice(qi)
  return `${path.replace(/\/+$/, '')}/{${n}}${rest}`
}
