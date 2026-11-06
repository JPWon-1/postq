'use client'
import { t as i18nText, localizeKorean } from '@/i18n'
import { ToolButton } from './ToolButton'
import { useEffect, useRef, useState } from 'react'
import { isWriteMethod } from '@/lib/executionPolicy'
import { methodText } from '@/lib/methodStyle'
import { useFocusTrap } from '@/lib/useFocusTrap'
import { getPersonalVars, setPersonalVar } from '@/lib/personalVars'
import type { EnvironmentRow } from '@/lib/ui-types'
import type { RunPlan, RunRow } from '@/lib/collectionRun'

const labels = { waiting: '대기', running: '실행 중', passed: '성공', failed: '실패', skipped: '건너뜀' }
export function CollectionRunModal({ folder, workspaceId, onClose }: {
  folder: { id: string; name: string }; workspaceId: string; onClose: () => void
}) {
  const trapRef = useFocusTrap<HTMLDivElement>(true)
  const active = useRef<AbortController | null>(null)
  const [envs, setEnvs] = useState<EnvironmentRow[]>([])
  const [envId, setEnvId] = useState('')
  const [includeWrites, setIncludeWrites] = useState(false)
  const [plan, setPlan] = useState<RunPlan | null>(null)
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [savePersonal, setSavePersonal] = useState(false)
  const [rows, setRows] = useState<RunRow[]>([])
  const [running, setRunning] = useState(false)
  const [hasRun, setHasRun] = useState(false)
  const [failedOnly, setFailedOnly] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const controller = new AbortController()
    fetch(`/api/environments?workspaceId=${encodeURIComponent(workspaceId)}`, { signal: controller.signal })
      .then(async r => { if (!r.ok) throw new Error(); setEnvs(await r.json()) }).catch(() => { if (!controller.signal.aborted) setError(i18nText('dynamicFailedToLoadEnvironmentPleaseOpenTheWindowAgain')) })
    return () => { controller.abort(); active.current?.abort() }
  }, [workspaceId])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !running) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, running])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError(null); setHasRun(false)
    fetch(`/api/folders/${folder.id}/run`, { method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preview: true, environmentId: envId || undefined, includeWrites }) })
      .then(async r => { const data = await r.json(); if (!r.ok) throw new Error(data.error); return data as RunPlan })
      .then(data => { setPlan(data); setRows(data.rows); setInputs(previous => Object.fromEntries(data.inputs.map(i => [i.name, previous[i.name] ?? getPersonalVars(envId)[i.name] ?? i.value]))) })
      .catch(e => { if (!controller.signal.aborted) { setPlan(null); setRows([]); setError(String(e.message)) } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [folder.id, envId, includeWrites])
  useEffect(() => {
    if (!running) return
    const start = Date.now(); setElapsed(0)
    const timer = setInterval(() => setElapsed(Date.now() - start), 100)
    return () => clearInterval(timer)
  }, [running])

  const run = async () => {
    const controller = new AbortController(); active.current = controller
    setRunning(true); setHasRun(true); setError(null); setFailedOnly(false)
    if (savePersonal && envId) for (const [key, value] of Object.entries(inputs)) setPersonalVar(envId, key, value)
    try {
      const res = await fetch(`/api/folders/${folder.id}/run?stream=1`, {
        method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ environmentId: envId || undefined, includeWrites, personalVars: { ...getPersonalVars(envId), ...inputs } }),
      })
      if (!res.ok) throw new Error((await res.json()).error || `실행 실패 (${res.status})`)
      if (!res.body) throw new Error(i18nText('dynamicIHavenTReceivedAnyProgressInformationRunAgain'))
      const reader = res.body.getReader(), decoder = new TextDecoder()
      let buffer = '', completed = false
      for (;;) {
        const { done, value } = await reader.read()
        buffer += decoder.decode(value, { stream: !done })
        const lines = buffer.split('\n'); buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          const event = JSON.parse(line)
          if (event.type === 'start') setRows(event.rows)
          if (event.type === 'running') setRows(previous => previous.map(r => r.requestId === event.requestId ? { ...r, state: 'running' } : r))
          if (event.type === 'result') setRows(previous => previous.map(r => r.requestId === event.row.requestId ? event.row : r))
          if (event.type === 'error') throw new Error(event.error)
          if (event.type === 'done') completed = true
        }
        if (done) break
      }
      if (!completed) throw new Error(i18nText('dynamicProgressTheConnectionHasBeenLostCheckCompletedRows'))
    } catch (e) {
      setError(controller.signal.aborted ? i18nText('dynamicStoppedRequestsAlreadySentCanBeCompletedOnThe') : e instanceof Error ? e.message : i18nText('dynamicExecutionFailedCheckTheConnectionAndRunAgain'))
      setRows(previous => previous.map(r => r.state === 'running' || r.state === 'waiting' ? { ...r, state: 'skipped', error: '중단됨 — 결과를 확인하고 다시 실행하세요.' } : r))
    } finally { active.current = null; setRunning(false) }
  }
  const done = rows.filter(r => ['passed', 'failed', 'skipped'].includes(r.state)).length
  const visible = rows.filter(r => !failedOnly || r.state === 'failed')
  const control = 'rounded-[var(--radius-sm)] border border-border bg-surface px-2 py-1 text-ui-md text-foreground disabled:opacity-50'
  return (
    <div className="animate-overlay-in fixed inset-0 z-[85] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={() => { if (!running) onClose() }}>
      <div ref={trapRef} role="dialog" aria-modal="true" aria-label={i18nText('dynamicBatchExecutionOfFolder', { v0: String(folder.name) })} className="animate-dialog-in flex max-h-[85vh] w-[820px] max-w-full flex-col overflow-hidden rounded-[var(--radius-lg)] border border-border/60 bg-surface shadow-[var(--shadow-card)]" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-ui-lg font-bold text-foreground">{i18nText('uiExecuteFoldersInBatches')} {folder.name}</h2>
          <ToolButton icon="close" aria-label={i18nText('uiClose')} className={control} disabled={running} onClick={onClose} />
        </div>
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 text-ui-md text-foreground">
          <label>{i18nText('uiEnvironment')} <select aria-label={i18nText('uiExecutionEnvironment')} className={control} value={envId} onChange={e => { setInputs({}); setEnvId(e.target.value) }} disabled={running}>
            <option value="">{i18nText('uiNoEnvironment')}</option>{envs.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select></label>
          <span>{i18nText('uiWrite')} {plan?.writeCount ?? 0}{i18nText('uiCountSuffix')}</span>
          <label><input type="checkbox" checked={includeWrites} disabled={running} onChange={e => setIncludeWrites(e.target.checked)} /> {i18nText('uiIncludesWriting')}</label>
          {!includeWrites && <span className="text-muted-foreground">{i18nText('uiOnlyExecuteReadRequests')}</span>}
          {running ? <button className={control} onClick={() => active.current?.abort()}>{i18nText('uiStop')}</button> : <button className="ml-auto rounded-[var(--radius-sm)] bg-accent-solid px-3 py-1.5 text-accent-solid-foreground disabled:opacity-50" disabled={loading || !plan || !rows.some(r => !r.denialReason && (includeWrites || !isWriteMethod(r.method)))} onClick={run}>{hasRun ? i18nText('jsxRunAgain') : i18nText('jsxFullRun')}</button>}
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3 text-ui-md text-foreground">
          {loading && <p>{i18nText('uiLoadingCommonInputsWithRequest')}</p>}
          {error && <p role="alert" className="mb-3 text-method-delete">{error}</p>}
          {!loading && plan && <>
            {plan.inputs.length > 0 && <fieldset disabled={running} className="mb-3 rounded-[var(--radius-sm)] border border-border p-3">
              <legend>{i18nText('uiCommonInputsDefaultAppliesOnlyToThisRun')}</legend>
              <div className="flex flex-wrap gap-3">{plan.inputs.map(i => <label key={i.name} className="flex flex-col gap-1">{i.name}
                <input aria-label={i.name} autoComplete="off" type={i.secret || !!getPersonalVars(envId)[i.name] ? 'password' : 'text'} className={control} value={inputs[i.name] ?? ''} placeholder={i.secret && i.supplied ? i18nText('jsxEnvironmentSecretValueInUseEnterWhenChanging') : i18nText('jsxPleaseEnterAValue')} onChange={e => setInputs(previous => ({ ...previous, [i.name]: e.target.value }))} />
              </label>)}</div>
              <label className="mt-2 block"><input type="checkbox" disabled={!envId} checked={savePersonal} onChange={e => setSavePersonal(e.target.checked)} /> {i18nText('uiSaveAsPersonalSettingsForSelectedEnvironmentThisBrowser')}</label>
            </fieldset>}
            <div className="mb-3 flex flex-wrap items-center gap-3" role="status">
              <span>{hasRun ? i18nText('dynamicProgressElapsedSeconds', { v0: String(done), v1: String(rows.length), v2: String((elapsed / 1000).toFixed(1)) }) : i18nText('dynamicRequests', { v0: String(rows.length) })}</span>
              <span>{i18nText('uiSuccess')} {rows.filter(r => r.state === 'passed').length} {i18nText('uiFailure')} {rows.filter(r => r.state === 'failed').length} {i18nText('uiSkip')} {rows.filter(r => r.state === 'skipped').length}</span>
              <label><input type="checkbox" checked={failedOnly} onChange={e => setFailedOnly(e.target.checked)} /> {i18nText('uiSeeOnlyFailures')}</label>
            </div>
            {!rows.length && <p>{i18nText('uiThereAreNoRequestsInTheFolderAddYour')}</p>}
            {rows.length > 0 && !visible.length && <p>{i18nText('uiThereWereNoFailedRequests')}</p>}
            <div className="flex flex-col gap-2">{visible.map(r => <details key={r.requestId} data-testid={`run-row-${r.requestId}`} className={`rounded-[var(--radius-sm)] border p-2 ${r.state === 'failed' ? 'border-method-delete/40' : 'border-border'}`}>
              <summary className="cursor-pointer">
                <span className="mr-2">{localizeKorean(labels[r.state])}</span><span className={`mr-2 font-mono ${methodText(r.method)}`}>{r.method}</span><span>{r.name}</span>
                <span className="ml-2 text-muted-foreground">{r.status ?? '—'} {r.durationMs == null ? '' : `${r.durationMs}ms`}</span>
                {r.error && <span className="mt-1 block break-words text-method-delete">{r.error}</span>}
              </summary>
              <div className="mt-2 space-y-2 break-words border-t border-border pt-2">
                <p>{i18nText('uiTransferURL')} {r.url ?? i18nText('jsxBeforeSending')}</p><p>{i18nText('uiStatus')} {r.status ?? i18nText('jsxNoResponse')}</p>
                {r.denialReason && <p>{i18nText('uiReasonForPolicyRejection')} {r.denialReason}</p>}
                {r.missingVariables.length > 0 && <p>{i18nText('uiVariablesRequiringInput')} {r.missingVariables.join(', ')}</p>}
                <p>{i18nText('uiVerification')} {r.assertions.passed}/{r.assertions.total}</p>
                {!!r.assertions.results?.length && <pre className="overflow-auto whitespace-pre-wrap text-ui-sm">{JSON.stringify(r.assertions.results, null, 2)}</pre>}
                <p>{i18nText('uiResponseBodyMaximum8000Characters')}</p><pre className="max-h-52 overflow-auto whitespace-pre-wrap text-ui-sm">{r.responseBody || i18nText('jsxNoResponseBody')}</pre>
              </div>
            </details>)}</div>
          </>}
        </div>
      </div>
    </div>
  )
}
