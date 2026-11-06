'use client'
import { t as i18nText } from '@/i18n'
import { ToolButton } from './ToolButton'
import { sourceLabels } from '@/lib/executionPolicy'
import { useCallback, useEffect, useRef, useState } from 'react'
import { isFailedExecution } from '@/lib/executionOutcome'
import { KEYS } from '@/lib/localStore'
import { useStickyState } from '@/lib/useStickyState'
import type { ExecutionRow } from '@/lib/ui-types'
import { BodyInspector } from './BodyInspector'
import { useFocusTrap } from '@/lib/useFocusTrap'
import { CopyButton } from './CopyButton'
import { LoadFailed } from './LoadFailed'
import { kstFull } from '@/lib/datetime'
import { errorText, fetchArray } from '@/lib/fetchJson'
import { SkeletonRows } from './Skeleton'

type Row = { execution: ExecutionRow; requestName: string | null; folderName: string | null }

const kst = kstFull
const pretty = (s: string | null) => {
  if (s == null) return ''
  try { return JSON.stringify(JSON.parse(s), null, 2) } catch { return s }
}

// API 이력 — 요청 무관 최근 실행 전체 + 사람/상태/기간 필터.
// 행 클릭 → 상세(보낸 요청·응답 전체) 모달. 상세에서 그 API 명세(요청 템플릿)로 이동 가능.
export function GlobalHistory({ onOpenRequest, workspaceId, environmentId }: {
  environmentId?: string | null
  onOpenRequest?: (requestId: string) => void
  /** 현재 프로젝트 — 다른 프로젝트의 실행이 섞이지 않게 */
  workspaceId: string
}) {
  const [rows, setRows] = useState<Row[]>([])
  const [query, setQuery] = useState('')
  const sequence = useRef(0)
  // 직접 친 필터가 남는다 — 다른 화면 한 번 갔다 오면 지워지던 값들이다.
  const [status, setStatus] = useStickyState<string>(KEYS.historyFilterStatus, '')
  const [since, setSince] = useStickyState<string>(KEYS.historyFilterSince, '')
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [detail, setDetail] = useState<Row | null>(null)

  const load = useCallback(async () => {
    const seq = ++sequence.current
    setLoading(true); setRows([]); setLoadError(null)
    try {
      const qs = new URLSearchParams({ limit: '200', workspaceId })
      // 환경을 안 골랐으면 전체 환경을 본다(응답 화면 정리 때 결정,
      // 요청 옆 이력(HistoryPanel)과 같은 규칙). 예전엔 null 을 '' 로 보내 '환경 없는 실행만' 이 됐다 —
      // 프로젝트를 바꾸면 환경이 비워지므로, 스테이지·운영 실행 수백 건이 사라지고 빈 이력으로 보였다.
      if (environmentId) qs.set('environmentId', environmentId)
      if (status) qs.set('status', status)
      if (since) qs.set('since', String(new Date(since).getTime()))
      const data = await fetchArray<Row>(`/api/executions?${qs}`)
      if (seq !== sequence.current) return
      setRows(data)
      setLoadError(null)
    } catch (e) {
      // catch 가 아예 없어서, 실패하면 rows 가 그대로 남아 '이력이 없습니다' 로 보였다
      // (게다가 처리되지 않은 rejection 이 났다).
      if (seq !== sequence.current) return
      setLoadError(errorText(e))
      setRows([])
    } finally {
      if (seq === sequence.current) setLoading(false)
    }
  }, [status, since, workspaceId, environmentId])
  useEffect(() => {
    setLoading(true)
    const timer = setTimeout(load, 0)
    return () => { clearTimeout(timer); sequence.current++ }
  }, [load])
  const visibleRows = rows.filter(row => `${row.requestName ?? ''} ${row.folderName ?? ''} ${row.execution.resolved.method} ${row.execution.resolved.url}`.toLowerCase().includes(query.trim().toLowerCase()))
  const filtered = !!(query || status || since)
  const resetFilters = () => { setQuery(''); setStatus(''); setSince('') }


  return (
    <div className="ah-view" data-testid="global-history">
      <div className="ah-toolbar">
        <label className="flex items-center gap-1.5 ah-label">{i18nText('uiStatus2')}
          <select aria-label={i18nText('uiStatus2')} className="ah-input text-ui-lg font-normal" value={status} onChange={e => setStatus(e.target.value)}>
            <option value="">{i18nText('uiAll')}</option>
            <option value="failed">{i18nText('uiFailureAll')}</option>
            <option value="ok">{i18nText('uiSuccessFull')}</option>
            <option value="4xx">4xx</option>
            <option value="5xx">5xx</option>
            <option value="error">{i18nText('uiTransmissionError2')}</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 ah-label">{i18nText('uiAfter')}
          <input type="datetime-local" className="ah-input text-ui-lg font-normal" value={since} onChange={e => setSince(e.target.value)} />
        </label>
        <ToolButton icon="refresh" aria-label={i18nText('uiRefresh')} type="button" className="h-8 shrink-0 rounded-[var(--radius-sm)] bg-transparent px-3 text-ui-md font-medium text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" onClick={load} />
        {filtered && <ToolButton icon="undo" aria-label={i18nText('uiFilterReset')} type="button" className="rounded-[var(--radius-sm)] border border-border px-2.5 py-1 text-ui-sm text-accent" onClick={resetFilters} />}
        <span className="ml-auto text-ui-sm text-faint-foreground">{loading ? i18nText('jsxLoading') : i18nText('dynamicCases', { v0: String(visibleRows.length), v1: String(rows.length) })}</span>
      </div>

      <div className="flex items-center gap-3 border-b border-border/70 px-4 py-2">
        <input aria-label={i18nText('uiHistorySearch')} className="ah-input min-w-0 flex-1" placeholder={i18nText('uiSearchRequestNamesFoldersAndURLsFromTheLast')} value={query} onChange={e => setQuery(e.target.value)} />
        <ToolButton icon="alert" aria-label={i18nText('uiSeeOnlyFailures')} type="button" aria-pressed={status === 'failed'} className={`shrink-0 rounded-full border px-3 py-1 text-ui-sm ${status === 'failed' ? 'border-method-delete/40 bg-method-delete/10 text-method-delete' : 'border-border text-muted-foreground'}`} onClick={() => setStatus(status === 'failed' ? '' : 'failed')} />
      </div>
      <div className="ah-view-body">
        {loadError && <LoadFailed what={i18nText('uiExecutionHistory')} detail={loadError} onRetry={load} />}
        {/* 채워지는 동안 본문이 통째로 비었다 — 표시가 우측 구석 작은 글씨뿐이라 안 보인다. */}
        {loading && rows.length === 0 && !loadError && <SkeletonRows rows={10} />}
        {!loadError && visibleRows.length === 0 && !loading && <p className="px-4 py-8 text-center text-ui-lg text-faint-foreground">{i18nText('uiThereIsNoCorrespondingExecutionHistory')}{filtered && <ToolButton icon="clear" aria-label={i18nText('uiClearFilter')} type="button" className="ml-2 text-accent" onClick={resetFilters} />}</p>}
        {visibleRows.map(row => {
          const e = row.execution
          const ok = !isFailedExecution(e) && (e.checkPassed != null || e.responseStatus != null)
          return (
            // 행 전체가 <button> 이고 그 안에 복사 <button> 이 들어 있었다 — 버튼 중첩은
            // 유효하지 않은 HTML 이라 클릭이 어느 쪽으로 갈지 보장되지 않는다.
            // 게다가 group/hrow 를 선언한 요소가 없어서 group-hover/hrow 가 영영 안 걸렸고,
            // 복사 버튼은 opacity-0 인 채로 화면에 존재만 했다(눌러도 아무 반응이 없어 보임).
            // 감싸는 div 가 group, 안쪽 button 이 본 동작.
            <div
              key={e.id}
              className="group/hrow flex items-center gap-3 border-b border-border/70 text-ui-md leading-tight transition-colors last:border-b-0 hover:bg-surface-2"
            >
              <button
                type="button"
                title={i18nText('uiClickToSeeDetails')}
                className="flex min-w-0 flex-1 items-center gap-3 py-1.5 pl-4 text-left focus-visible:outline focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-accent"
                onClick={() => setDetail(row)}
              >
                <span className={`w-11 shrink-0 font-mono text-ui-sm font-bold ${ok ? 'text-badge-new-fg' : 'text-method-delete'}`}>{e.denialReason ? i18nText('jsxRejection') : e.error ? 'ERR' : e.responseStatus}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-foreground">{row.requestName ?? i18nText('jsxRequestRemoved')}</span>
                  <span className="block truncate font-mono text-ui-sm text-faint-foreground" title={`${e.resolved.method} ${e.resolved.url}`}>
                    {row.folderName ?? '—'} · {e.resolved.method} {e.resolved.url}
                  </span>
                </span>
              </button>
              <CopyButton
                value={e.resolved.url}
                title={i18nText('uiCopyRequestAddress')}
                className="opacity-0 transition-opacity group-hover/hrow:opacity-100 group-focus-within/hrow:opacity-100"
              />
              <span className="shrink-0 text-ui-sm text-muted-foreground">{sourceLabels[e.executionSource ?? 'ui']}</span>
              <span className="shrink-0 pr-4 font-mono text-ui-sm text-faint-foreground">{kst(e.executedAt).slice(5, 16)}</span>
            </div>
          )
        })}
      </div>

      {detail && (
        <HistoryDetailModal row={detail} onClose={() => setDetail(null)} onOpenRequest={onOpenRequest} />
      )}
    </div>
  )
}

export function HistoryDetailModal({ row, onClose, onOpenRequest }: {
  row: Row; onClose: () => void; onOpenRequest?: (requestId: string) => void
}) {
  const e = row.execution
  const ok = !isFailedExecution(e) && (e.checkPassed != null || e.responseStatus != null)
  const trapRef = useFocusTrap<HTMLDivElement>(true)
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const reqHeaders = e.resolved.headers.filter(h => h.enabled && h.key.trim())
  const reqParams = e.resolved.params.filter(p => p.enabled && p.key.trim())
  const deleted = row.requestName === null

  return (
    <div className="animate-overlay-in fixed inset-0 z-[80] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        ref={trapRef}
        className="animate-dialog-in flex max-h-[85vh] w-[min(1100px,94vw)] flex-col overflow-hidden rounded-[var(--radius-lg)] border border-border/60 bg-surface shadow-[var(--shadow-card)]"
        onClick={ev => ev.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={i18nText('uiExecutionHistoryDetails')}
      >
        {e.assertionResults && e.assertionResults.length > 0 && <div className="border-b border-border p-3 text-ui-sm">
          <b>{i18nText('uiCheckResponse')} {e.assertionResults.filter(r => r.pass).length}/{e.assertionResults.length} {i18nText('uiPassed')}</b>
          {e.assertionResults.filter(r => !r.pass).map((r, i) => <p key={i} className="mt-1 text-method-delete">{r.message}</p>)}
        </div>}
        <div className="flex items-start gap-2 border-b border-border/70 px-4 py-3">
          <span className={`mt-0.5 shrink-0 rounded-[var(--radius-sm)] px-1.5 py-0.5 font-mono text-ui-sm font-bold ${ok ? 'bg-badge-new-bg text-badge-new-fg' : 'bg-method-delete/10 text-method-delete'}`}>{e.denialReason ? i18nText('jsxRejection') : e.error ? 'ERR' : e.responseStatus}</span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-ui-lg font-bold text-foreground">{row.requestName ?? i18nText('jsxRequestRemoved')}</h2>
            <p className="truncate font-mono text-ui-sm text-faint-foreground">{row.folderName ?? '—'} · {e.resolved.method} {e.resolved.url}</p>
            <p className="mt-0.5 text-ui-sm text-faint-foreground">{sourceLabels[e.executionSource ?? 'ui']} · {kst(e.executedAt)}{e.durationMs != null && ` · ${e.durationMs}ms`}</p>
          </div>
          <ToolButton icon="close" type="button" aria-label={i18nText('uiClose')} className="ah-action flex h-6 w-auto px-1.5 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-faint-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" onClick={onClose} />
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 items-start gap-4 overflow-y-auto p-4 lg:grid-cols-2">
          {e.error && (
            <div className="col-span-full rounded-[var(--radius-sm)] border border-method-delete/30 bg-method-delete/5 px-3 py-2 text-ui-md leading-relaxed text-method-delete">{e.error}</div>
          )}
          {e.missingVariables.length > 0 && (
            <div className="col-span-full rounded-[var(--radius-sm)] border border-method-put/30 bg-method-put/10 px-3 py-2 text-ui-md text-foreground">
              {i18nText('uiUninterpretedVariableLiteralTransfer')} {e.missingVariables.map(v => `{{${v}}}`).join(', ')}
            </div>
          )}

          {/* 보낸 요청 */}
          <section className="flex min-w-0 flex-col gap-2">
            {/* 팀에 물어보거나 티켓에 붙일 때 이 화면을 그대로 옮겨야 한다.
                예전엔 눈으로 읽고 손으로 다시 치는 수밖에 없었다. */}
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="ah-label">{i18nText('uiSentRequest')}</h3>
              <CopyButton
                label={i18nText('uiCopyRequest')}
                title={i18nText('uiCopyMethodAddressHeaderAndBodyInOneLump')}
                value={[
                  `${e.resolved.method} ${e.resolved.url}`,
                  ...(reqHeaders.length ? ['', ...reqHeaders.map(h => `${h.key}: ${h.value}`)] : []),
                  ...(e.resolved.body ? ['', pretty(e.resolved.body)] : []),
                ].join('\n')}
              />
            </div>
            <p className="break-all font-mono text-ui-md text-foreground"><span className="font-bold">{e.resolved.method}</span> {e.resolved.url}</p>
            {reqParams.length > 0 && (
              <div className="ah-subpanel">
                <p className="pb-1 text-ui-meta font-semibold text-faint-foreground">{i18nText('uiQueryParameters')}</p>
                {reqParams.map((p, i) => <p key={i} className="break-all font-mono text-ui-sm text-muted-foreground"><span className="text-foreground">{p.key}</span> = {p.value}</p>)}
              </div>
            )}
            {reqHeaders.length > 0 && (
              <div className="ah-subpanel">
                <p className="pb-1 text-ui-meta font-semibold text-faint-foreground">{i18nText('uiHeader')}</p>
                {reqHeaders.map((h, i) => <p key={i} className="break-all font-mono text-ui-sm text-muted-foreground"><span className="text-foreground">{h.key}</span>: {h.value}</p>)}
              </div>
            )}
            {e.resolved.body && (
              <BodyInspector key={`${e.id}:request`} text={e.resolved.body} label={i18nText('uiRequest')} />
            )}
          </section>

          {/* 응답 */}
          <section className="flex min-w-0 flex-col gap-2">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="ah-label">{i18nText('uiResponse')} {e.responseStatus != null && <span className={ok ? 'text-badge-new-fg' : 'text-method-delete'}>· {e.responseStatus}</span>}</h3>
              <span className="flex items-center gap-1">
                {e.responseBody != null && (
                  <CopyButton label={i18nText('uiCopyBody')} title={i18nText('uiCopyOnlyTheResponseBody')} value={pretty(e.responseBody)} />
                )}
                <CopyButton
                  label={i18nText('uiCopyAll')}
                  title={i18nText('uiRequestsAndResponsesInOneLumpSoTheyCan')}
                  value={[
                    `# ${row.requestName ?? i18nText('jsxRequestRemoved')} · $${sourceLabels[e.executionSource ?? 'ui']} · ${kst(e.executedAt)}`,
                    '',
                    i18nText('jsxRequestSent'),
                    `${e.resolved.method} ${e.resolved.url}`,
                    ...(reqHeaders.length ? reqHeaders.map(h => `${h.key}: ${h.value}`) : []),
                    ...(e.resolved.body ? ['', pretty(e.resolved.body)] : []),
                    '',
                    `## 응답 ${e.responseStatus ?? 'ERR'}${e.durationMs != null ? ` · ${e.durationMs}ms` : ''}`,
                    ...(e.responseHeaders ? Object.entries(e.responseHeaders).map(([k, v]) => `${k}: ${v}`) : []),
                    ...(e.responseBody != null ? ['', pretty(e.responseBody)] : [i18nText('jsxNoResponseBody2')]),
                    ...(e.error ? ['', i18nText('jsxError'), e.error] : []),
                  ].join('\n')}
                />
              </span>
            </div>
            {e.responseHeaders && Object.keys(e.responseHeaders).length > 0 && (
              <details className="ah-subpanel">
                <summary className="cursor-pointer select-none text-ui-meta font-semibold text-faint-foreground">{i18nText('uiResponseHeader2')}{Object.keys(e.responseHeaders).length})</summary>
                <div className="pt-1">
                  {Object.entries(e.responseHeaders).map(([k, v]) => <p key={k} className="break-all font-mono text-ui-sm text-muted-foreground"><span className="text-foreground">{k}</span>: {v}</p>)}
                </div>
              </details>
            )}
            {e.responseBody != null ? (
              <BodyInspector key={`${e.id}:response`} text={e.responseBody} label={i18nText('uiResponse')} />
            ) : (
              <p className="text-ui-md text-faint-foreground">{i18nText('uiNoResponseBody')}</p>
            )}
          </section>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border/70 px-4 py-3">
          <button
            type="button"
            disabled={deleted || !onOpenRequest}
            title={deleted ? i18nText('jsxTheRequestHasBeenDeletedAndCannotBeMoved') : i18nText('jsxOpenTheTemplateSpecificationForThisRequestFromThe')}
            className="mr-auto rounded-[var(--radius-sm)] bg-accent-solid px-3.5 py-1.5 text-ui-lg font-semibold text-accent-solid-foreground transition-colors hover:bg-accent-solid-hover disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            onClick={() => onOpenRequest?.(e.requestId)}  // 닫지 않는다 — 뒤로 오면 보던 상세가 그대로 있다
          >
            {i18nText('uiOpenRequestSpecification')}
          </button>
          <button type="button" className="ah-action rounded-[var(--radius-sm)] bg-transparent px-3 py-1.5 text-ui-lg font-medium text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" onClick={onClose}>{i18nText('uiClose')}</button>
        </div>
      </div>
    </div>
  )
}
