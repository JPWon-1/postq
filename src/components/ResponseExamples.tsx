'use client'
import { t as i18nText } from '@/i18n'
import type { ExecutionRow } from '@/lib/ui-types'
import { kstMinute } from '@/lib/datetime'

// 핀(고정)된 실행을 'Swagger 응답 목록'처럼 보여주는 공용 블록.
// 컬렉션 문서 모드(RequestDocView)가 쓴다.

// HTTP 상태 코드 → 표준 텍스트("200 OK" 처럼 보여주기 위함).
const STATUS_TEXT: Record<number, string> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
  301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 409: 'Conflict', 422: 'Unprocessable Entity', 429: 'Too Many Requests',
  500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
}

const kst = kstMinute
export const prettyJson = (s: string | null | undefined) => {
  if (!s) return ''
  try { return JSON.stringify(JSON.parse(s), null, 2) } catch { return s }
}

// 상태코드/에러 → 색 계열. 2xx 성공(초록) · 3xx(중립) · 4xx(호박) · 5xx/전송실패(빨강).
export function statusStyle(status: number | null, error: string | null): { badge: string; bar: string; label: string } {
  if (error || status == null) return { badge: 'border-method-delete/40 bg-method-delete/10 text-method-delete', bar: 'border-l-method-delete/60', label: '전송 실패' }
  const text = STATUS_TEXT[status] ? `${status} ${STATUS_TEXT[status]}` : String(status)
  if (status < 300) return { badge: 'border-badge-new-fg/40 bg-badge-new-bg text-badge-new-fg', bar: 'border-l-badge-new-fg/60', label: text }
  if (status < 400) return { badge: 'border-border bg-surface-2 text-muted-foreground', bar: 'border-l-border', label: text }
  if (status < 500) return { badge: 'border-method-put/40 bg-method-put/10 text-method-put', bar: 'border-l-method-put/60', label: text }
  return { badge: 'border-method-delete/40 bg-method-delete/10 text-method-delete', bar: 'border-l-method-delete/60', label: text }
}

export function ResponseExamples({ examples, emptyHint }: {
  examples: ExecutionRow[] | null
  emptyHint?: string
}) {
  if (examples === null) return <p className="text-ui-md text-faint-foreground">{i18nText('uiLoading')}</p>
  if (examples.length === 0) {
    return <p className="text-ui-md leading-relaxed text-faint-foreground">{emptyHint ?? i18nText('jsxThereAreNoPinnedExamplesIfYouPinA')}</p>
  }
  // 상태코드 오름차순 — 성공이 먼저(Swagger 응답 목록 느낌).
  const sorted = [...examples].sort((a, b) => (a.responseStatus ?? 999) - (b.responseStatus ?? 999))
  return (
    <div className="flex flex-col gap-2">
      {sorted.map(e => {
        const st = statusStyle(e.responseStatus, e.error)
        return (
          <div key={e.id} className={`rounded-[var(--radius-sm)] border border-border border-l-[3px] bg-surface p-2.5 ${st.bar}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-[var(--radius-sm)] border px-1.5 py-0.5 font-mono text-ui-sm font-bold ${st.badge}`}>{st.label}</span>
              <span className="font-mono text-ui-sm text-faint-foreground">{e.resolved.method} {e.resolved.url}</span>
              <span className="ml-auto text-ui-meta text-faint-foreground">{kst(e.executedAt)}</span>
            </div>
            {e.error && <p className="mt-1.5 rounded-[var(--radius-sm)] border border-method-delete/30 bg-method-delete/5 px-2 py-1.5 text-ui-sm leading-relaxed text-method-delete">{e.error}</p>}
            {e.resolved.body?.trim() && (
              <details className="mt-1.5">
                <summary className="cursor-pointer select-none text-ui-sm font-semibold text-faint-foreground">{i18nText('uiRequestBody')}</summary>
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-[var(--radius-sm)] border border-border bg-surface-2 p-2 font-mono text-ui-sm text-muted-foreground">{prettyJson(e.resolved.body)}</pre>
              </details>
            )}
            {e.responseBody != null && (
              <div className="mt-1.5">
                <p className="pb-1 text-ui-sm font-semibold text-faint-foreground">{i18nText('uiResponseBody')}</p>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-[var(--radius-sm)] border border-border bg-surface-2 p-2 font-mono text-ui-sm text-muted-foreground">{prettyJson(e.responseBody)}</pre>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
