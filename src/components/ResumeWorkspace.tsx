'use client'
import { t as i18nText } from '@/i18n'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { fetchArray, fetchJson } from '@/lib/fetchJson'
import { scoped } from '@/lib/localStore'
import { useFavorites } from '@/lib/useFavorites'
import { isFailedExecution } from '@/lib/executionOutcome'
import { kstDayStart, recentRequests, relativeTime, todayFailures, type ResumeExecution } from '@/lib/resumeWorkspace'
import type { EnvironmentRow, RequestRow } from '@/lib/ui-types'
import { StartGuide, type StartActions } from './StartGuide'

type Loaded<T> = { state: 'loading' } | { state: 'error' } | { state: 'ready'; data: T }
function Block<T>({ title, value, empty, children }: { title: string; value: Loaded<T[]>; empty: string; children: (data: T[]) => ReactNode }) {
  return <section aria-label={title} className="space-y-3">
    <h2 className="text-ui-lg font-semibold">{title}{value.state === 'ready' ? ` · ${value.data.length}` : ''}</h2>
    {value.state === 'loading' ? <p role="status" className="text-ui-sm text-muted-foreground">{i18nText('uiLoading')}</p>
      : value.state === 'error' ? <p role="alert" className="text-ui-sm text-method-delete">{i18nText('uiFailedToLoadListPleaseOpenTheScreenAgain')}</p>
      : value.data.length === 0 ? <p className="text-ui-sm text-muted-foreground">{empty}</p> : children(value.data)}
  </section>
}

// 반복 실행이 100건을 넘어도 최근 서로 다른 요청 10개와 오늘의 실패 전체를 놓치지 않는다.
async function executions(workspaceId: string, today: boolean, now: number, signal: AbortSignal) {
  const rows: ResumeExecution[] = []
  for (let offset = 0; ; offset += 100) {
    const query = new URLSearchParams({ workspaceId, limit: '100', offset: String(offset) })
    if (today) { query.set('since', String(kstDayStart(now))); query.set('status', 'failed') }
    const page = await fetchArray<ResumeExecution>(`/api/executions?${query}`, { signal })
    rows.push(...page)
    if (page.length < 100 || (!today && recentRequests(rows).length === 10)) return today ? todayFailures(rows, now) : recentRequests(rows)
  }
}
export function ResumeWorkspace({ workspaceId, version, onOpen, restoreError, start }: {
  workspaceId: string; version: number; onOpen: (id: string) => Promise<void>; restoreError: boolean
  /** 요청이 0개일 때 '이어서 하기' 대신 보여줄 시작 안내의 동작들 */
  start?: StartActions
}) {
  const { favorites } = useFavorites(scoped.favRequests(workspaceId))
  const [recent, setRecent] = useState<Loaded<ResumeExecution[]>>({ state: 'loading' })
  const [failed, setFailed] = useState<Loaded<ResumeExecution[]>>({ state: 'loading' })
  const [requests, setRequests] = useState<Loaded<RequestRow[]>>({ state: 'loading' })
  const lastCount = useRef<number | null>(null)
  const [specs, setSpecs] = useState<Loaded<string[]>>({ state: 'loading' })
  const [envs, setEnvs] = useState<Loaded<EnvironmentRow[]>>({ state: 'loading' })
  const [now, setNow] = useState(Date.now)
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer) }, [])
  const day = kstDayStart(now)
  useEffect(() => {
    const controller = new AbortController(), signal = controller.signal
    const load = <T,>(promise: Promise<T>, set: (value: Loaded<T>) => void) => {
      set({ state: 'loading' })
      promise.then(data => { if (!signal.aborted) set({ state: 'ready', data }) }).catch(() => { if (!signal.aborted) set({ state: 'error' }) })
    }
    load(executions(workspaceId, false, Date.now(), signal), setRecent)
    load(executions(workspaceId, true, Date.now(), signal), setFailed)
    load(fetchArray<RequestRow>(`/api/requests?workspaceId=${encodeURIComponent(workspaceId)}&slim=1`, { signal }), setRequests)
    load(fetchArray<EnvironmentRow>(`/api/environments?workspaceId=${encodeURIComponent(workspaceId)}`, { signal }), setEnvs)
    load(fetchJson<{ spec: Record<string, string> }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/flags`, { signal }).then(flags => {
      if (!flags.spec || typeof flags.spec !== 'object') throw new Error('Invalid flags')
      return Object.keys(flags.spec).filter(id => flags.spec[id] === 'changed')
    }), setSpecs)
    return () => controller.abort()
  }, [workspaceId, version, day])
  const rowClass = 'flex w-full items-center gap-3 border-b border-border/50 py-2 text-left text-ui-sm hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent'
  const executionList = (rows: ResumeExecution[], label: string) => <ul>{rows.map(({ execution: e, requestName }) => <li key={e.id}>
    <button type="button" className={rowClass} aria-label={i18nText('dynamicOpenRequest', { v0: String(label), v1: String(requestName) })} onClick={() => void onOpen(e.requestId)}>
      <span className="w-14 shrink-0 font-mono text-accent">{e.resolved.method}</span><span className="min-w-0 flex-1 truncate">{requestName}</span>
      <span className={isFailedExecution(e) ? 'text-method-delete' : 'text-method-get'}>{isFailedExecution(e) ? i18nText('jsxFailure') : i18nText('jsxSuccess')} {e.responseStatus ?? i18nText('jsxNoResponse')}</span>
      <time dateTime={new Date(e.executedAt).toISOString()} title={new Date(e.executedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} className="text-muted-foreground">{relativeTime(e.executedAt, now)}</time>
      <span className="max-w-32 truncate text-muted-foreground">{!e.environmentId ? i18nText('jsxNoEnvironment') : envs.state === 'loading' ? i18nText('jsxLoadingEnvironment') : envs.state === 'error' ? i18nText('jsxEnvironmentLookupFailed') : envs.data.find(env => env.id === e.environmentId)?.name ?? i18nText('jsxDeletedEnvironment')}</span>
    </button>
  </li>)}</ul>
  const pinned: Loaded<RequestRow[]> = requests.state === 'ready' ? { state: 'ready', data: favorites.flatMap(id => requests.data.filter(r => r.id === id)) } : requests
  // 요청이 하나도 없으면 이어서 할 것이 없다 — 0 네 줄 대신 시작할 길을 보여준다.
  // 처음 받는 동안·못 받았을 때는 지금처럼 '이어서 하기' 의 각 칸이 로딩·실패를 말한다.
  // 다시 받는 동안에는 직전에 본 개수를 쓴다(실행할 때마다 시작 안내가 깜박이지 않게).
  const count = requests.state === 'ready' ? requests.data.length : requests.state === 'error' ? null : lastCount.current
  if (requests.state === 'ready') lastCount.current = requests.data.length
  if (start && count === 0) return <>
    {restoreError && <p role="alert" className="px-6 pt-6 text-ui-sm text-method-delete">{i18nText('uiFailedToRestorePreviousTabYourSavedTabsWill')}</p>}
    <StartGuide workspaceId={workspaceId} actions={start} />
  </>
  return <div className="mx-auto max-w-5xl space-y-8 px-6 py-6" data-testid="resume-workspace">
    <h1 className="text-ui-lg font-semibold">{i18nText('uiNext')}</h1>
    {restoreError && <p role="alert" className="text-ui-sm text-method-delete">{i18nText('uiFailedToRestorePreviousTabYourSavedTabsWill')}</p>}
    <Block title={i18nText('uiRecentlyExecutedRequest')} value={recent} empty={i18nText('uiWhenYouRunARequestYourMostRecentlyRun')}>{rows => executionList(rows, i18nText('jsxRecentRuns'))}</Block>
    <Block title={i18nText('uiRequestAFavorite')} value={pinned} empty={i18nText('uiPressOnAnyRequestFromTheCollectionAndIt')}>{rows => <ul>{rows.map(r => <li key={r.id}><button type="button" className={rowClass} aria-label={i18nText('dynamicOpenFavoriteRequest', { v0: String(r.name) })} onClick={() => void onOpen(r.id)}><span className="text-accent">★</span><span className="w-14 font-mono text-accent">{r.method}</span>{r.name}</button></li>)}</ul>}</Block>
    <Block title={i18nText('uiRequestFailedToday')} value={failed} empty={i18nText('uiThereWereNoFailedRequestsTodayKSTYouCan')}>{rows => <><p className="text-ui-sm text-muted-foreground">{i18nText('uiThisRequestFailedAtLeastOnceTodayKSTThe')}</p>{executionList(rows, i18nText('jsxFailureToday'))}</>}</Block>
    {/* 스펙 변경을 모아 보던 타임라인은 지웠다 — 바뀐 요청을 바로 열어 무엇이 바뀌었는지 요청 화면에서 본다. */}
    <Block title={i18nText('uiChangeSpecificationsToCheck')} value={specs} empty={i18nText('uiThereAreNoSpecificationChangesToConfirmYouCan')}>{rows => <>
      <p className="text-ui-sm text-muted-foreground">{i18nText('uiSpecificationChange')} {rows.length}{i18nText('uiYouCanCheckTheCase')}</p>
      {requests.state === 'ready' && <ul>{rows.flatMap(id => requests.data.filter(r => r.id === id)).map(r => <li key={r.id}><button type="button" className={rowClass} aria-label={i18nText('dynamicOpenSpecChangeRequest', { v0: String(r.name) })} onClick={() => void onOpen(r.id)}><span className="w-14 font-mono text-accent">{r.method}</span>{r.name}</button></li>)}</ul>}
    </>}</Block>
    <p className="text-ui-sm text-faint-foreground">{i18nText('uiKSearchForRequestsAndCommandsFromAnywhere')}</p>
  </div>
}
