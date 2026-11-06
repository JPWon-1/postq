import type { ExecutionRow } from './ui-types'

/**
 * 두 실행을 항목별로 비교한다.
 *
 * 예전엔 응답 바디만 비교했다. 그런데 "왜 저번엔 됐는데 지금은 안 되지" 를 풀 때
 * 정작 필요한 건 바디가 아닌 경우가 많다 — 헤더 하나가 빠졌거나, 환경이 달랐거나,
 * URL 의 쿼리 한 글자가 다르거나. 바디만 보여주면 그 차이는 화면에 아예 안 나오고,
 * 사용자는 '바디가 다르네' 까지만 알고 원인은 계속 못 찾는다.
 *
 * 기본은 다른 것만 보여준다. 전부 늘어놓으면 같은 값 수십 줄 사이에서 다른 줄을
 * 눈으로 찾아야 하고, 그건 비교 도구가 할 일을 사람에게 떠넘기는 것이다.
 */

export type FieldDiff = {
  key: string
  a: string
  b: string
  same: boolean
  /** 한쪽에만 있는 항목 — '값이 다르다' 와 '없다' 는 다른 문제다 */
  onlyIn?: 'a' | 'b'
}

export type DiffSection = {
  id: string
  title: string
  fields: FieldDiff[]
  /** 줄 단위로 봐야 하는 긴 텍스트(바디) — 있으면 화면이 diff 뷰로 그린다 */
  text?: { a: string; b: string }
  changed: number
}

/** 규칙을 사람이 읽는 한 줄로 — 'status eq 200' 처럼. 비교의 키로도 쓴다. */
export function assertLabel(a: { target: string; path?: string; op: string; expected?: string }): string {
  return [a.target, a.path, a.op, a.expected].filter(Boolean).join(' ')
}

function assertMap(e: ExecutionRow): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of e.assertionResults ?? []) {
    out[assertLabel(r.assertion)] = `${r.pass ? '통과' : '실패'}${r.actual ? ` (실제: ${r.actual})` : ''}`
  }
  return out
}

/** JSON 이면 정렬해서 보기 좋게. 아니면 원문 그대로 — 파싱 실패로 내용을 잃지 않는다. */
export function pretty(body: string | null | undefined): string {
  if (!body) return ''
  try { return JSON.stringify(JSON.parse(body), null, 2) } catch { return body }
}

/** 키-값 목록을 비교. 한쪽에만 있는 키도 빠뜨리지 않는다. */
export function compareEntries(
  a: Record<string, string>,
  b: Record<string, string>,
): FieldDiff[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
  return keys.map(key => {
    const inA = key in a, inB = key in b
    return {
      key,
      a: inA ? a[key] : '',
      b: inB ? b[key] : '',
      same: inA && inB && a[key] === b[key],
      onlyIn: inA && !inB ? 'a' as const : !inA && inB ? 'b' as const : undefined,
    }
  })
}

/** KV[] → 객체. 같은 키가 여러 번이면 쉼표로 잇는다(둘째 값이 사라지면 비교가 거짓말이 된다). */
export function kvToMap(list: { key: string; value: string; enabled?: boolean }[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const kv of list ?? []) {
    if (!kv.key) continue
    if (kv.enabled === false) continue
    out[kv.key] = kv.key in out ? `${out[kv.key]}, ${kv.value}` : kv.value
  }
  return out
}

/** 헤더 키는 대소문자를 안 가린다 — Content-Type 과 content-type 을 다르다고 하면 안 된다. */
export function headersToMap(h: Record<string, string> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(h ?? {})) out[k.toLowerCase()] = v
  return out
}

const bytes = (s: string | null | undefined): string => {
  if (!s) return '0 B'
  const n = new TextEncoder().encode(s).length
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`
}

const field = (key: string, a: string, b: string): FieldDiff => ({ key, a, b, same: a === b })

export function compareExecutions(a: ExecutionRow, b: ExecutionRow): {
  sections: DiffSection[]
  changed: number
} {
  const ra = a.resolved ?? { method: '', url: '', params: [], headers: [], bodyType: '', body: '' }
  const rb = b.resolved ?? { method: '', url: '', params: [], headers: [], bodyType: '', body: '' }

  const withCount = (s: Omit<DiffSection, 'changed'>): DiffSection => ({
    ...s,
    changed: s.fields.filter(f => !f.same).length + (s.text && s.text.a !== s.text.b ? 1 : 0),
  })

  const sections: DiffSection[] = [
    withCount({
      id: 'meta',
      title: '실행',
      fields: [
        field('시각', new Date(a.executedAt).toLocaleString('ko-KR'), new Date(b.executedAt).toLocaleString('ko-KR')),
        // 환경이 달랐다는 것 하나로 설명되는 차이가 많다 — 그런데 예전엔 어디에도 안 보였다.
        field('환경', a.environmentId ?? '(없음)', b.environmentId ?? '(없음)'),
        field('소요', a.durationMs != null ? `${a.durationMs}ms` : '—', b.durationMs != null ? `${b.durationMs}ms` : '—'),
        field('미해석 변수', (a.missingVariables ?? []).join(', ') || '없음', (b.missingVariables ?? []).join(', ') || '없음'),
      ],
    }),
    withCount({
      id: 'request',
      title: '요청',
      fields: [
        field('메서드', ra.method, rb.method),
        field('URL', ra.url, rb.url),
        field('바디 타입', ra.bodyType, rb.bodyType),
        ...compareEntries(kvToMap(ra.params), kvToMap(rb.params)).map(f => ({ ...f, key: `param: ${f.key}` })),
        ...compareEntries(kvToMap(ra.headers), kvToMap(rb.headers)).map(f => ({ ...f, key: `header: ${f.key}` })),
      ],
      text: { a: pretty(ra.body), b: pretty(rb.body) },
    }),
    withCount({
      id: 'response',
      title: '응답',
      fields: [
        field('상태', a.error ? 'ERR' : String(a.responseStatus ?? '—'), b.error ? 'ERR' : String(b.responseStatus ?? '—')),
        field('크기', bytes(a.responseBody), bytes(b.responseBody)),
        field('오류', a.error ?? '없음', b.error ?? '없음'),
        ...compareEntries(headersToMap(a.responseHeaders), headersToMap(b.responseHeaders))
          .map(f => ({ ...f, key: `header: ${f.key}` })),
      ],
      text: { a: pretty(a.responseBody), b: pretty(b.responseBody) },
    }),
    withCount({
      id: 'assertions',
      title: '검증',
      // 규칙 자체를 키로 삼는다 — 순서가 바뀌어도 같은 규칙끼리 마주 보게 된다.
      fields: compareEntries(assertMap(a), assertMap(b)),
    }),
  ]

  return { sections, changed: sections.reduce((n, s) => n + s.changed, 0) }
}
