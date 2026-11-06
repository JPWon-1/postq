'use client'
import { t as i18nText } from '@/i18n'
import { ToolButton } from './ToolButton'
import { sourceLabels } from '@/lib/executionPolicy'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { isFailedExecution } from '@/lib/executionOutcome'
import type { ExecutionRow, EnvironmentRow } from '@/lib/ui-types'
import { ExecDiffModal } from './ExecDiffModal'
import { useToast } from './Toast'
import { fetchArray } from '@/lib/fetchJson'
import { copyText } from '@/lib/clipboard'
import { CopyButton } from './CopyButton'
import { JsonView } from './JsonView'
import { BodyInspector } from './BodyInspector'
import { ModalFrame, ModalHeader } from './ModalFrame'

import { kstFull } from '@/lib/datetime'

function IconChevron({ open }: { open: boolean }) {
  return (
    <svg
      width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden
      className={`shrink-0 text-faint-foreground transition-transform ${open ? 'rotate-90' : ''}`}
    >
      <path d="M3 1.5 7 5l-4 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function IconStar({ filled }: { filled: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill={filled ? 'currentColor' : 'none'} aria-hidden>
      <path d="M6 1l1.5 3.1 3.4.5-2.5 2.4.6 3.4L6 8.9 2.9 10.4l.6-3.4L1 4.6l3.4-.5z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
    </svg>
  )
}

/** 이력에서 미리 볼 글자 수. 넘으면 [크게 보기] 에서 전부 본다. */
const PREVIEW_CHARS = 4000

/**
 * 이력 속 요청·응답 본문.
 *
 * 예전엔 한 줄로 뭉친 JSON 을 높이 96px 칸에 글자 단위로 끊어 넣었다 — 키와 값이 어디서
 * 갈리는지 읽을 수 없었고, 2000자에서 말없이 잘렸고, 복사하려면 칸 안을 드래그해야 했다.
 * 그래서 JSON 이면 들여쓰기해 보여주고, 원문 전체 복사와 넓은 창(검색·원문·줄바꿈)을 붙인다.
 */
function HistoryBody({ label, text }: { label: string; text: string }) {
  const [big, setBig] = useState(false)
  const pretty = useMemo(() => {
    try { return JSON.stringify(JSON.parse(text), null, 2) } catch { return text }
  }, [text])
  const cut = pretty.length > PREVIEW_CHARS
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <span className="text-ui-meta font-bold uppercase tracking-wide text-faint-foreground">{label}</span>
        <span className="text-ui-meta text-faint-foreground">{text.length.toLocaleString()}{i18nText('uiNow')}</span>
        <span className="ml-auto flex items-center gap-1">
          <CopyButton compact value={text} title={i18nText('dynamicCopyAll', { v0: String(label) })} />
          <ToolButton icon="expand" aria-label={i18nText('uiViewLarger')}
            type="button"
            className="shrink-0 rounded-[var(--radius-sm)] border border-border px-1.5 py-0.5 text-ui-meta font-medium text-muted-foreground transition-colors hover:border-accent hover:text-accent"
            onClick={() => setBig(true)}
           />
        </span>
      </div>
      <JsonView
        text={cut ? pretty.slice(0, PREVIEW_CHARS) : pretty}
        className="max-h-60 overflow-auto whitespace-pre-wrap rounded-[var(--radius-sm)] border border-border bg-surface-2 p-2 font-mono text-ui-sm leading-relaxed text-foreground [overflow-wrap:anywhere]"
      />
      {cut && (
        <p className="text-ui-meta text-faint-foreground">
          {i18nText('uiFront')} {PREVIEW_CHARS.toLocaleString()}{i18nText('uiOnlyTheRulerIsVisibleTheWholeThingIs')}
        </p>
      )}
      {big && createPortal(
        <ModalFrame label={label} onClose={() => setBig(false)}>
          <ModalHeader title={label} onClose={() => setBig(false)}>
            <CopyButton value={text} title={i18nText('dynamicCopyAll', { v0: String(label) })} className="ml-2" />
          </ModalHeader>
          <div className="min-h-0 flex-1 overflow-auto p-4 [&_pre]:!max-h-[64vh]">
            <BodyInspector text={text} label={label.replace(/ 본문$/, '')} />
          </div>
        </ModalFrame>,
        document.body,
      )}
    </div>
  )
}

function HistoryList({ requestId, version, scope }: {
  scope: string;
  requestId: string; version: number
}) {
  const toast = useToast()
  const [items, setItems] = useState<ExecutionRow[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)
  const [pinnedOnly, setPinnedOnly] = useState(false)
  // 실행 비교 — compareBase 를 기준(A)으로 잡고 다른 실행에서 비교(B)하면 diff 모달.
  const [compareBase, setCompareBase] = useState<ExecutionRow | null>(null)
  const [diffPair, setDiffPair] = useState<{ a: ExecutionRow; b: ExecutionRow } | null>(null)

  // 실행을 "예시 응답"으로 고정/해제 — Postman saved examples. 대표 응답을 이력에서 바로 찾게.
  const togglePin = async (e: ExecutionRow) => {
    const next = !e.pinned
    setItems(prev => prev.map(x => (x.id === e.id ? { ...x, pinned: next } : x)))  // 낙관적
    try {
      const res = await fetch(`/api/executions/${e.id}/pin`, { method: 'POST', body: JSON.stringify({ pinned: next }) })
      if (!res.ok) throw new Error(String(res.status))
      toast('success', next ? i18nText('dynamicFixedWithExampleResponse') : i18nText('dynamicExampleUnpinned'))
    } catch (err) {
      setItems(prev => prev.map(x => (x.id === e.id ? { ...x, pinned: !next } : x)))  // 롤백
      toast('error', i18nText('dynamicFailedToChangeExamplePin', { v0: String(err instanceof Error ? err.message : String(err)) }))
    }
  }

  // 실행 permalink — 슬랙 등에 붙여넣으면 받은 사람이 그때 값 그대로 복원해 볼 수 있다
  const copyLink = async (e: ExecutionRow) => {
    const ok = await copyText(`${window.location.origin}/?exec=${e.id}`)
    toast(ok ? 'success' : 'error', ok
      ? i18nText('dynamicRunLinkCopiedOpeningItWillRestoreTheValues')
      : i18nText('dynamicFailedToCopyPleaseCopyTheValueDirectlyFrom'))
  }

  const [reloadKey, setReloadKey] = useState(0)
  useEffect(() => {
    let cancelled = false
    // requestId/version이 바뀌면 이전 요청의 목록·펼침 상태를 즉시 비워야 한다 — 그렇지 않으면
    // 요청이 바뀌면 이전 요청의 이력을 즉시 비운다.
    setItems([]); setOpenId(null); setLoaded(false); setError(false); setCompareBase(null)
    fetchArray<ExecutionRow>(`/api/requests/${requestId}/executions?limit=100${scope === 'all' ? '' : `&environmentId=${encodeURIComponent(scope === 'none' ? '' : scope)}`}`)
      .then(data => { if (!cancelled) { setItems(data); setLoaded(true) } })
      // 빈 상태와 구분: 실패는 error 로 표시하고 재시도를 제공(조용히 '이력 없음'으로 오인 방지)
      .catch(() => { if (!cancelled) { setError(true); setLoaded(true) } })
    return () => { cancelled = true }
  }, [requestId, version, reloadKey, scope])

  const retry = useCallback(() => setReloadKey(k => k + 1), [])

  if (!loaded) {
    return (
      <p className="px-1 py-4 text-center text-ui-md leading-relaxed text-faint-foreground">
        {i18nText('uiLoading')}
      </p>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-2 px-1 py-4 text-center">
        <p className="text-ui-md leading-relaxed text-method-delete">{i18nText('uiFailedToLoadHistory')}</p>
        <button
          type="button"
          className="rounded-[var(--radius-sm)] bg-transparent px-2.5 py-1 text-ui-md font-medium text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          onClick={retry}
        >
          {i18nText('uiTryAgain')}
        </button>
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <p className="px-1 py-4 text-center text-ui-md leading-relaxed text-faint-foreground">
        {i18nText('uiThereIsNoExecutionHistoryYetWhenYouPress2')}
      </p>
    )
  }

  const pinnedCount = items.filter(e => e.pinned).length
  const shown = pinnedOnly ? items.filter(e => e.pinned) : items

  return (
    <div className="flex flex-col gap-1.5">
      {compareBase && (
        <div className="flex items-center justify-between gap-2 rounded-[var(--radius-sm)] border border-accent/40 bg-accent/10 px-2.5 py-1.5 text-ui-sm text-foreground">
          <span className="truncate">{i18nText('uiComparisonCriteriaSpecifiedFromDifferentRuns')} <b>{i18nText('uiCompareWithThis')}</b></span>
          <ToolButton icon="close" aria-label={i18nText('uiTurnOffComparisonCriteria')} type="button" className="shrink-0 rounded-[var(--radius-sm)] px-1.5 py-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent" onClick={() => setCompareBase(null)} />
        </div>
      )}
      {pinnedCount > 0 && (
        <div className="flex items-center gap-1 pb-0.5">
          {(['all', 'pinned'] as const).map(f => {
            const on = (f === 'pinned') === pinnedOnly
            return (
              <button
                key={f}
                type="button"
                aria-pressed={on}
                className={`rounded-full px-2 py-1 text-ui-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${on ? 'bg-accent/15 text-accent' : 'text-muted-foreground hover:text-foreground'}`}
                onClick={() => setPinnedOnly(f === 'pinned')}
              >
                {f === 'all' ? i18nText('jsxAll') : i18nText('dynamicExample', { v0: String(pinnedCount) })}
              </button>
            )
          })}
        </div>
      )}
      {shown.length === 0 && (
        <p className="px-1 py-3 text-center text-ui-md text-faint-foreground">{i18nText('uiThereAreNoFixedExamples')}</p>
      )}
      {shown.map(e => {
        const open = openId === e.id
        // 응답 확인 조건까지 본다 — 200 인데 조건이 깨진 실행을 여기선 초록, API 이력에선 빨강으로 그렸다
        const ok = e.responseStatus != null && !isFailedExecution(e)
        const statusLabel = e.denialReason ? i18nText('jsxRejection') : e.error ? 'ERR' : e.responseStatus != null ? String(e.responseStatus) : '—'
        return (
          <div
            key={e.id}
            className={`overflow-hidden rounded-[var(--radius-md)] border transition-colors ${open ? 'border-border-strong' : 'border-border'} bg-surface`}
          >
            <button
              type="button"
              className="grid w-full grid-cols-[12px_44px_minmax(0,1fr)] items-center gap-x-2 gap-y-1 px-2.5 py-2 text-left transition-colors hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
              onClick={() => setOpenId(open ? null : e.id)}
              aria-expanded={open}
              aria-label={i18nText('dynamicExecutionHistory', { v0: String(statusLabel), v1: String(kstFull(e.executedAt)) })}
            >
              <IconChevron open={open} />

              <span className={`w-11 shrink-0 font-mono text-ui-sm font-bold ${ok ? 'text-badge-new-fg' : 'text-method-delete'}`}>
                {ok ? '✓' : '✗'} {statusLabel}
              </span>
              <span className="min-w-0 flex-1 truncate text-ui-md font-semibold text-foreground">
                {sourceLabels[e.executionSource ?? 'ui']}
              </span>
              <span className="col-span-2 col-start-2 whitespace-nowrap font-mono text-ui-sm text-faint-foreground">{kstFull(e.executedAt)}</span>
              {e.durationMs != null && (
                <span className="col-span-2 col-start-2 font-mono text-ui-sm text-faint-foreground">{e.durationMs}ms</span>
              )}
            </button>
            {open && (
              <div className="flex flex-col gap-1.5 border-t border-border/70 px-2.5 py-2">
                <p className="break-all font-mono text-ui-md leading-relaxed text-muted-foreground">
                  <span className="font-bold text-foreground">{e.resolved.method}</span> {e.resolved.url}
                </p>
                {/* 실제 송신된 params/headers — "이 API 어떻게 호출해요?"를 이력이 대신 답하는 핵심.
                    secret 값은 서버 저장 시점에 이미 {{이름}}으로 마스킹되어 있다. */}
                {(['params', 'headers'] as const).map(kind => {
                  const rows = e.resolved[kind].filter(kvRow => kvRow.enabled && kvRow.key)
                  if (rows.length === 0) return null
                  return (
                    <div key={kind} className="flex flex-col gap-0.5">
                      <span className="text-ui-meta font-bold uppercase tracking-wide text-faint-foreground">
                        {kind === 'params' ? 'Params' : 'Headers'}
                      </span>
                      {rows.map((kvRow, i) => (
                        <p key={i} className="break-all font-mono text-ui-sm leading-relaxed text-muted-foreground">
                          <span className="text-foreground">{kvRow.key}</span>: {kvRow.value}
                        </p>
                      ))}
                    </div>
                  )
                })}
                {e.resolved.body && <HistoryBody label={i18nText('uiRequestBody2')} text={e.resolved.body} />}
                {e.error && <p className="text-ui-md text-method-delete">{e.error}</p>}
                {e.responseBody != null && <HistoryBody label={i18nText('uiResponseBody2')} text={e.responseBody} />}
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 [&>button]:whitespace-nowrap">

                  <ToolButton icon="link" aria-label={i18nText('uiLink')}
                    type="button"
                    title={i18nText('uiCopyTheSharedLinkForThisRun')}
                    className="rounded-[var(--radius-sm)] bg-transparent px-2.5 py-1 text-ui-md font-medium text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    onClick={() => copyLink(e)}
                   />
                  <ToolButton icon="pin" aria-label={e.pinned ? i18nText('jsxUnpinExample') : i18nText('jsxFixedAsAnExample')}
                    type="button"
                    title={e.pinned ? i18nText('jsxUnpinExample') : i18nText('jsxPinnedWithExampleResponse')}
                    className={`flex items-center gap-1 rounded-[var(--radius-sm)] border px-2.5 py-1 text-ui-md font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                      e.pinned ? 'border-accent/40 text-accent' : 'border-border text-muted-foreground hover:border-border-strong hover:text-foreground'
                    }`}
                    onClick={() => togglePin(e)}
                   />
                  {/* 비교 — 기준(A) 지정 후 다른 실행에서 [이것과 비교] */}
                  {compareBase?.id === e.id ? (
                    <ToolButton icon="close" aria-label={i18nText('uiTurnOffComparisonCriteria')}
                      type="button"
                      className="rounded-[var(--radius-sm)] border border-accent/40 px-2.5 py-1 text-ui-md font-medium text-accent transition-colors hover:bg-accent/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      onClick={() => setCompareBase(null)}
                     />
                  ) : compareBase ? (
                    <ToolButton icon="compare" aria-label={i18nText('uiCompareToThis')}
                      type="button"
                      className="rounded-[var(--radius-sm)] bg-transparent px-2.5 py-1 text-ui-md font-medium text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      onClick={() => setDiffPair({ a: compareBase, b: e })}
                     />
                  ) : (
                    <ToolButton icon="compare" aria-label={i18nText('uiCompare')}
                      type="button"
                      title={i18nText('uiBasedOnThisRunForComparison')}
                      className="rounded-[var(--radius-sm)] bg-transparent px-2.5 py-1 text-ui-md font-medium text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      onClick={() => setCompareBase(e)}
                     />
                  )}
                </div>
              </div>
            )}
          </div>
        )
      })}
      {diffPair && <ExecDiffModal a={diffPair.a} b={diffPair.b} onClose={() => setDiffPair(null)} />}
    </div>
  )
}


export function HistoryPanel(props: { requestId: string; version: number; environmentId: string | null; environments: EnvironmentRow[] }) {
  const [scope, setScope] = useState(props.environmentId ?? 'all')
  return <>
    <select aria-label={i18nText('uiHistoryEnvironment')} value={scope} onChange={e => setScope(e.target.value)} className="mb-3 w-full rounded-[var(--radius-sm)] border border-border bg-surface px-2 py-1.5 text-ui-sm">
      <option value="all">{i18nText('uiEntireEnvironment')}</option>
      {props.environments.map(env => <option key={env.id} value={env.id}>{env.name}</option>)}
      <option value="none">{i18nText('uiRunWithoutEnvironment')}</option>
    </select>
    <HistoryList {...props} scope={scope} />
  </>
}
