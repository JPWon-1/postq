'use client'
import { t as i18nText } from '@/i18n'
import { ToolButton } from './ToolButton'
import { createPortal } from 'react-dom'
import { useCallback, useEffect, useState } from 'react'
import { useToast } from './Toast'
import { errorText, fetchArray, fetchJson } from '@/lib/fetchJson'
import type { EnvironmentRow } from '@/lib/ui-types'
import { baseHost, isProdLike } from '@/lib/scheduleEnv'
import { kstFull } from '@/lib/datetime'
import { LoadFailed } from './LoadFailed'

type Flow = { id: string; name: string }
type Schedule = {
  id: string; flowId: string; environmentId: string | null; intervalMinutes: number
  slackWebhookUrl: string | null
  /** 알림 보낼 곳이 있는지 — URL 자체는 자격증명이라 서버가 안 내려준다. */
  hasWebhook?: boolean
  notifyOn: 'always' | 'failure'; enabled: boolean
  lastRunAt: number | null; lastStatus: string | null
}

// scheduler 가 남기는 값: 'ok' | 'failed' | 'error' | 'flow-missing' | 'running'.
// 'ok'/'running' 을 뺀 나머지는 사람이 봐야 하는 상태다.
const FAILED = new Set(['failed', 'error', 'flow-missing'])

// 시나리오 스케줄 — 주기 실행 + 슬랙 알림 관리.
export function ScheduleManager({ workspaceId, onDirtyChange, sidebarContainer, onActivate }: { sidebarContainer?: HTMLElement | null; onActivate?: () => void; workspaceId: string; onDirtyChange?: (count: number) => void }) {
  const toast = useToast()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // undefined = 아직 모름, null = 못 받아옴. 둘을 '확인 필요' 한 줄로 뭉치면 무엇을 확인할지 모른다.
  const [runtime, setRuntime] = useState<{ started: boolean; lastTickAt: number | null } | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    const refresh = () => fetchJson<{ started: boolean; lastTickAt: number | null }>(`/api/schedules?workspaceId=${encodeURIComponent(workspaceId)}&runtime=1`).then(v => { if (live) setRuntime(v) }).catch(() => { if (live) setRuntime(null) })
    void refresh(); const timer = window.setInterval(refresh, 30000)
    return () => { live = false; window.clearInterval(timer) }
  }, [workspaceId])
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [flows, setFlows] = useState<Flow[]>([])
  const [environments, setEnvironments] = useState<EnvironmentRow[]>([])
  const [flowId, setFlowId] = useState('')
  const [environmentId, setEnvironmentId] = useState('')
  const [interval, setInterval] = useState(60)
  const [webhook, setWebhook] = useState('')
  const [notifyOn, setNotifyOn] = useState<'always' | 'failure'>('failure')
  // 새 스케줄에 손으로 친 것은 알림 주소뿐이다 — 그게 남아 있으면 설정 창이 닫기 전에 묻는다.
  useEffect(() => { onDirtyChange?.(webhook.trim() ? 1 : 0) }, [webhook, onDirtyChange])

  // 못 불러온 것과 '등록된 스케줄이 없다' 는 다른 화면이어야 한다. 예전엔 오류 처리가
  // 아예 없어서, 셋 중 하나만 500 이어도 오류 객체가 상태에 들어가 .map 에서 터졌다 —
  // 스케줄 화면이 통째로 날아갔고, 처리되지 않은 rejection 도 났다.
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async () => {
    try {
      const [sch, fl, envs] = await Promise.all([
        fetchArray<Schedule>(`/api/schedules?workspaceId=${encodeURIComponent(workspaceId)}`),
        fetchArray<Flow>(`/api/flows?workspaceId=${encodeURIComponent(workspaceId)}`),
        fetchArray<EnvironmentRow>(`/api/environments?workspaceId=${encodeURIComponent(workspaceId)}`),
      ])
      setSchedules(sch); setFlows(fl); setEnvironments(envs)
      setLoadError(null); setLoaded(true)
      if (!flowId && fl[0]) setFlowId(fl[0].id)
    } catch (e) {
      setLoadError(errorText(e))
    }
  }, [workspaceId, flowId])
  useEffect(() => { load() }, [workspaceId]) // eslint-disable-line react-hooks/exhaustive-deps

  // 등록 중에는 버튼을 잠근다. 없을 때 두 번 누르면 같은 스케줄이 둘 생기고,
  // 그때부터 주기마다 실제 요청이 두 번씩 나간다 — 화면에는 줄이 하나 더 늘 뿐이라
  // 눈치채기까지 시간이 걸린다. 되돌리기 어려운 쪽에 가깝다.
  const [creating, setCreating] = useState(false)

  const create = async () => {
    if (creating) return
    if (!flowId) { toast('error', i18nText('dynamicCreateAndSelectAScenarioFirst')); return }
    // 운영으로 보이는 환경에 주기 실행을 거는 건 되돌리기 어렵다(등록 후엔 조용히 매 주기 나간다).
    const env = envOf(environmentId || null)
    if (isProdLike(env) && !window.confirm(
      `'${env!.name}' 환경(${baseHost(env) ?? '호스트 미상'})으로 ${interval}분마다 자동 실행됩니다.\n` +
      '운영 환경입니다. 계속할까요?')) return
    setCreating(true)
    try {
      const res = await fetch('/api/schedules', { method: 'POST', body: JSON.stringify({
        workspaceId, flowId, environmentId: environmentId || null, intervalMinutes: interval,
        slackWebhookUrl: webhook || null, notifyOn,
      }) })
      if (!res.ok) { toast('error', i18nText('dynamicScheduleCreationFailedServerResponse', { v0: String(res.status) })); return }
      toast('success', i18nText('dynamicScheduleRegisteredRunsAutomaticallyEveryCycle'))
      setWebhook(''); load()
    } catch (e) {
      // 연결 실패는 조용했다 — 누르고도 아무 일이 없는 것처럼 보인다.
      toast('error', i18nText('dynamicFailedToRegisterSchedule', { v0: String(errorText(e)) }))
    } finally { setCreating(false) }
  }
  // 결과를 안 보고 load() 만 했다. 실패하면 스위치가 슬그머니 원래대로 돌아갈 뿐이라,
  // 껐다고 생각한 스케줄이 새벽에 계속 도는 것을 아침에야 알게 된다.
  const toggle = async (s: Schedule) => {
    try {
      const res = await fetch(`/api/schedules/${s.id}`, { method: 'PUT', body: JSON.stringify({ enabled: !s.enabled }) })
      if (!res.ok) toast('error', i18nText('dynamicFailedServerResponse', { v0: String(s.enabled ? '끄지' : '켜지'), v1: String(res.status) }))
    } catch (e) { toast('error', i18nText('dynamicFailed', { v0: String(s.enabled ? '끄지' : '켜지'), v1: String(errorText(e)) })) }
    finally { load() }
  }
  const remove = async (s: Schedule) => {
    try {
      const res = await fetch(`/api/schedules/${s.id}`, { method: 'DELETE' })
      if (!res.ok) toast('error', i18nText('dynamicDeletionFailedServerResponse', { v0: String(res.status) }))
    } catch (e) { toast('error', i18nText('dynamicFailedToDelete', { v0: String(errorText(e)) })) }
    finally { load() }
  }
  const runNow = async (s: Schedule) => {
    const env = envOf(s.environmentId)
    if (isProdLike(env) && !window.confirm(
      i18nText('dynamicRunNowWithEnvironmentShallWeContinue', { v0: String(env!.name), v1: String(baseHost(env) ?? '호스트 미상') }))) return
    try {
    const res = await fetch(`/api/schedules/${s.id}`, { method: 'POST' })
    const d = await res.json()
    if (!res.ok) { toast('error', d.error ?? '실행 실패'); return }
    toast(d.failed ? 'error' : 'success', d.failed ? i18nText('dynamicExecutionFailureSendNotificationIfEnabled') : i18nText('dynamicRunSuccess'))
    load()
    } catch (e) { toast('error', i18nText('dynamicScheduleExecutionFailed', { v0: String(errorText(e)) })) }
  }
  const flowName = (id: string) => flows.find(f => f.id === id)?.name ?? '(삭제된 시나리오)'
  const envOf = (id: string | null) => environments.find(e => e.id === id)

  return (
    <div className="ah-view">
      {sidebarContainer && createPortal(<div className="px-2 pb-2">
        <ToolButton icon="plus" aria-label={i18nText('uiNewSchedule')} className="ah-sidebar-row text-accent" onClick={() => { onActivate?.(); setSelectedId(null) }} />
        {loadError && <LoadFailed what={i18nText('uiSchedule')} detail={loadError} onRetry={load} />}
        {!loaded && !loadError && <p className="px-2 py-2 text-faint-foreground">{i18nText('uiLoading')}</p>}
        {loaded && !loadError && !schedules.length && <p className="px-2 py-2 text-faint-foreground">{i18nText('uiThereAreNoRegisteredSchedules')}</p>}
        {schedules.map(s => <button key={s.id} className="ah-sidebar-row" aria-pressed={selectedId === s.id}
          onClick={() => { onActivate?.(); setSelectedId(s.id); requestAnimationFrame(() => document.getElementById(`schedule-${s.id}`)?.scrollIntoView({ block: 'nearest' })) }}>
          <span className="truncate">{flows.find(f => f.id === s.flowId)?.name ?? i18nText('jsxScenario')}</span><span className="ml-auto shrink-0 text-faint-foreground">{s.intervalMinutes}{i18nText('uiMinutes')}</span>
        </button>)}
      </div>, sidebarContainer)}
      <div className="border-b border-border px-4 py-3 text-ui-sm text-muted-foreground">{i18nText('uiTheScheduleExecutesTheSavedScenarioAtSetIntervals')}</div>
      <p className="px-4 py-2 text-ui-sm text-muted-foreground" role="status">{runtime === undefined ? i18nText('jsxCheckingScheduleStatus')
        : runtime === null ? i18nText('jsxFailedToLoadScheduleStatusCheckConnectionToPostq')
        : runtime.started ? i18nText('dynamicScheduleIsSpinningLastCheck', { v0: String(runtime.lastTickAt ? kstFull(runtime.lastTickAt) : i18nText('jsxNotYetFirstCheckComingSoon')) })
        : i18nText('jsxScheduleIsOffItSavesButDoesnTRun')}</p>
      {/* 시나리오가 0개면 고를 게 없는 드롭다운만 남는다 — 무엇이 먼저 있어야 하는지 말하고 그리로 보낸다. */}
      {loaded && !loadError && flows.length === 0 && schedules.length === 0 ? (
        <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
          <p className="text-ui-lg font-medium text-foreground">{i18nText('uiCreateAScenarioFirst')}</p>
          <p className="max-w-md text-ui-md leading-relaxed text-faint-foreground">{i18nText('uiTheScheduleExecutesTheSavedScenarioABundleOf')}</p>
          <button type="button" className="h-8 rounded-[var(--radius-sm)] bg-accent-solid px-4 text-ui-md font-semibold text-accent-solid-foreground hover:bg-accent-solid-hover" onClick={() => window.dispatchEvent(new CustomEvent('ah:goto-mode', { detail: 'scenario' }))}>{i18nText('uiCreateAScenario')}</button>
        </div>
      ) : <>
      <div className="ah-toolbar flex-wrap">
        <label className="flex flex-col gap-1 ah-label">{i18nText('uiScenario')}
          <select aria-label={i18nText('uiScenario')} className="w-44 ah-input text-ui-lg font-normal" value={flowId} onChange={e => setFlowId(e.target.value)}>
            <option value="">{i18nText('uiChooseAScenario')}</option>
            {flows.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 ah-label">{i18nText('uiEnvironment')}
          <select aria-label={i18nText('uiEnvironment')} className="ah-input text-ui-lg font-normal" value={environmentId} onChange={e => setEnvironmentId(e.target.value)}>
            <option value="">{i18nText('uiNoEnvironment2')}</option>
            {environments.map(env => <option key={env.id} value={env.id}>{env.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 ah-label">{i18nText('uiCycleMinutes')}
          <input type="number" min={1} className="w-20 ah-input text-ui-lg font-normal" value={interval} onChange={e => setInterval(Math.max(1, Number(e.target.value)))} />
        </label>
        <label className="flex flex-1 flex-col gap-1 ah-label" title={i18nText('uiSlackDiscordTeamsReceivingWebhookAddressIfLeftBlank')}>{i18nText('uiWebhookOptional')}
          <input className="rounded-[var(--radius-sm)] border border-border bg-surface px-2 py-1.5 font-mono text-ui-sm font-normal normal-case text-foreground outline-none focus-visible:border-accent" placeholder="https://hooks.slack.com/..." value={webhook} onChange={e => setWebhook(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 ah-label">{i18nText('uiNotification')}
          <select aria-label={i18nText('uiNotification')} className="ah-input text-ui-lg font-normal" value={notifyOn} onChange={e => setNotifyOn(e.target.value as 'always' | 'failure')}>
            <option value="failure">{i18nText('uiInCaseOfFailure')}</option>
            <option value="always">{i18nText('uiEveryTime')}</option>
          </select>
        </label>
        <button type="button" className="rounded-[var(--radius-sm)] bg-accent-solid px-4 py-1.5 text-ui-lg font-semibold text-accent-solid-foreground hover:bg-accent-solid-hover disabled:opacity-50" disabled={creating} onClick={create}>{creating ? i18nText('jsxAdding') : i18nText('jsxAddSchedule')}</button>
      </div>

      <div className="ah-view-body">
        {loadError && <LoadFailed what={i18nText('uiSchedule')} detail={loadError} onRetry={load} />}
        {!loadError && schedules.length === 0 && <p className="px-4 py-8 text-center text-ui-lg text-faint-foreground">{loaded ? i18nText('jsxThereAreNoRegisteredSchedulesSelectTheScenarioEnvironment') : i18nText('jsxLoading')}</p>}
        {schedules.map(s => (
          <div key={s.id} id={`schedule-${s.id}`} className="flex items-center gap-3 border-b border-border/70 px-4 py-1.5 text-ui-md last:border-b-0">
            {/* 점은 '켜짐/꺼짐' 이 아니라 '건강한가' 를 보여준다. 켜져 있는데 마지막 실행이
                실패한 스케줄이 멀쩡한 것과 같은 초록으로 보이면, 17시간을 실패해도 아무도
                모른다(실제로 그랬다). */}
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${
                !s.enabled ? 'border border-faint-foreground bg-transparent'
                  : FAILED.has(s.lastStatus ?? '') ? 'bg-method-delete'
                  : 'bg-badge-new-fg'
              }`}
              title={!s.enabled ? i18nText('jsxStopped') : FAILED.has(s.lastStatus ?? '') ? i18nText('jsxLastRunFailed') : i18nText('jsxNormal')}
            />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-foreground">{flowName(s.flowId)}</span>
                {/* 어느 환경으로 나가는지 — 이게 안 보여서 운영에 물린 스케줄을 아무도 몰랐다 */}
                <EnvBadge env={envOf(s.environmentId)} />
                {s.enabled && FAILED.has(s.lastStatus ?? '') && (
                  <span className="shrink-0 rounded-full bg-method-delete/15 px-1.5 py-0.5 text-ui-meta font-semibold text-method-delete">
                    {i18nText('uiFailure2')}
                  </span>
                )}
              </span>
              <span className="block truncate text-ui-sm text-faint-foreground">
                {s.intervalMinutes}{i18nText('uiNotificationsEveryMinute')} {s.notifyOn === 'always' ? i18nText('jsxEveryTime') : i18nText('jsxInCaseOfFailure')}
                {/* 알림을 켜 두고 보낼 곳이 없으면 실패가 어디에도 안 간다 — 그 사실을 적는다 */}
                {s.hasWebhook ?? !!s.slackWebhookUrl
                  ? i18nText('jsxNotifications')
                  : <span className="text-method-put"> {i18nText('uiNoPlaceToSend')}</span>}
                {s.lastRunAt
                  ? <> {i18nText('uiRecently')} {kstFull(s.lastRunAt)} (
                      <span className={FAILED.has(s.lastStatus ?? '') ? 'font-semibold text-method-delete' : 'text-badge-new-fg'}>
                        {s.lastStatus}
                      </span>)
                    </>
                  : i18nText('jsxNotExecuted')}
              </span>
            </span>
            {/* 결과를 보는 자리 — 시나리오 화면의 [지난 실행] 이 스텝마다 무엇이 실패했는지 보여 준다. */}
            {flows.some(f => f.id === s.flowId) && (
              <ToolButton icon="history" aria-label={i18nText('uiRunHistory')} type="button" className="shrink-0 rounded-[var(--radius-sm)] bg-transparent px-2 py-1 text-ui-sm text-muted-foreground hover:bg-surface-2 hover:text-foreground" title={i18nText('uiViewPastRunResultsInTheScenarioScreen')} onClick={() => window.dispatchEvent(new CustomEvent('ah:goto-mode', { detail: { mode: 'scenario', flowId: s.flowId } }))} />
            )}
            <button type="button" className="shrink-0 rounded-[var(--radius-sm)] bg-transparent px-2 py-1 text-ui-sm text-muted-foreground hover:bg-surface-2 hover:text-foreground" onClick={() => runNow(s)}>{i18nText('uiRunNow')}</button>
            <button type="button" className="shrink-0 rounded-[var(--radius-sm)] bg-transparent px-2 py-1 text-ui-sm text-muted-foreground hover:bg-surface-2 hover:text-foreground" onClick={() => toggle(s)}>{s.enabled ? i18nText('jsxStop') : i18nText('jsxActive')}</button>
            <button type="button" className="ah-action shrink-0 rounded-[var(--radius-sm)] border border-border px-2 py-1 text-ui-sm text-method-delete/80 hover:text-method-delete" onClick={() => remove(s)}>{i18nText('uiDelete')}</button>
          </div>
        ))}
      </div>
      </>}
    </div>
  )
}

/**
 * 스케줄이 어느 환경으로 나가는지 알리는 배지.
 * 운영으로 보이면 색으로 튀게 하고, 그렇지 않아도 호스트를 title 로 붙여
 * '어디로 나가는지'를 항상 확인할 수 있게 한다.
 */
function EnvBadge({ env }: { env: EnvironmentRow | undefined }) {
  const host = baseHost(env)
  if (!env) {
    return (
      <span className="shrink-0 whitespace-nowrap rounded-[var(--radius-sm)] border border-border px-1.5 py-0.5 text-ui-meta font-semibold text-faint-foreground"
        title={i18nText('uiNoEnvironmentSpecifiedURLIsPopulatedWithGlobalVariables')}>
        {i18nText('uiNoEnvironment2')}
      </span>
    )
  }
  const prod = isProdLike(env)
  return (
    <span
      className={`shrink-0 whitespace-nowrap rounded-[var(--radius-sm)] border px-1.5 py-0.5 text-ui-meta font-semibold ${
        prod
          ? 'border-method-delete/60 bg-method-delete/10 text-method-delete'
          : 'border-border bg-surface-2 text-muted-foreground'
      }`}
      title={host ? `${env.name} — ${host}` : env.name}
    >
      {prod && <span aria-hidden>⚠ </span>}{env.name}{host ? ` · ${host}` : ''}
    </span>
  )
}
