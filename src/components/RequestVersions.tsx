'use client'
import { t as i18nText } from '@/i18n'
import { useEffect, useState } from 'react'
import { ModalFrame, ModalHeader } from './ModalFrame'
import { fetchJson } from '@/lib/fetchJson'
import type { RequestRow } from '@/lib/ui-types'
import { kstFull } from '@/lib/datetime'
type Version = { id: string; createdAt: number; author: string | null }
export function RequestVersions({ request, onClose, onRestored }: { request: RequestRow; onClose: () => void; onRestored: (row: RequestRow) => void }) {
  const [rows, setRows] = useState<Version[]>([])
  const [selected, setSelected] = useState<(Version & { snapshot: RequestRow }) | null>(null)
  const [current, setCurrent] = useState<RequestRow | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const base = `/api/requests/${encodeURIComponent(request.id)}`
  useEffect(() => {
    let live = true
    Promise.all([fetchJson<Version[]>(`${base}/versions`), fetchJson<RequestRow>(base)]).then(([versions, row]) => { if (live) { setRows(versions); setCurrent(row) } }).catch(() => { if (live) setError(i18nText('dynamicTheSaveCouldNotBeLoadedCloseAndTry')) })
    return () => { live = false }
  }, [base])
  async function select(id: string) {
    setBusy(true); setError(''); setConfirmed(false); setSelected(null)
    try { setSelected(await fetchJson(`${base}/versions?versionId=${encodeURIComponent(id)}`)) }
    catch { setError(i18nText('dynamicFailedToReadSave')) } finally { setBusy(false) }
  }
  async function restore() {
    if (!selected || !current || !confirmed) return
    setBusy(true); setError('')
    try {
      const res = await fetch(`${base}/versions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ versionId: selected.id, ifUpdatedAt: current.updatedAt }) })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? '복원 실패'); return }
      const restored = data.request as RequestRow | undefined
      if (!restored || restored.id !== request.id || restored.updatedAt !== data.updatedAt) {
        setError(i18nText('dynamicFailedToConfirmRestoredDataReOpenTheWindow')); return
      }
      onRestored(restored); onClose()
    } catch { setError(i18nText('dynamicFailedToCheckRestorationResultsOpenItAgainTo')) }
    finally { setBusy(false) }
  }
  const keys = ['name', 'method', 'url', 'description', 'params', 'headers', 'bodyType', 'body', 'assertions', 'preSteps', 'postSteps', 'tags', 'settings', 'vars'] as const
  const changed = selected && current ? keys.filter(key => JSON.stringify(selected.snapshot[key]) !== JSON.stringify(current[key])) : []
  return <ModalFrame label={i18nText('uiRequestSavedCopy')} onClose={onClose}>
    <ModalHeader title={i18nText('dynamicSavedCopy', { v0: String(request.name) })} onClose={onClose} />
    <div className="min-h-0 overflow-auto p-5">
      <p className="mb-4 text-ui-md text-muted-foreground">{i18nText('uiWhenSavingATemplateItRetainsThePreviousDefinition')}</p>
      {error && <p role="alert" className="mb-3 text-method-delete">{error}</p>}
      {!current && !error && <p role="status">{i18nText('uiLoading')}</p>}
      <div className="flex flex-wrap gap-2">{rows.map(row => <button disabled={busy} className={`rounded-[var(--radius-sm)] border px-3 py-2 text-ui-sm ${selected?.id === row.id ? 'border-accent bg-surface-2' : 'border-border'}`} key={row.id} onClick={() => select(row.id)}>{kstFull(row.createdAt)}</button>)}</div>
      {current && rows.length === 0 && <p className="py-8 text-center text-muted-foreground">{i18nText('uiThereAreNoSavesYetFromTheNextTemplate')}</p>}
      {selected && current && <div className="mt-5">
        <p className="mb-3 text-ui-md">{i18nText('uiItemsThatDifferFromTheCurrentDefinition')} {changed.length}{i18nText('uiPersonalAndAuthenticationSettingsAreIncludedInTheRestore')}</p>
        {changed.map(key => <div key={key} className="mb-3 rounded-[var(--radius-sm)] border border-border p-3"><b>{key}</b><div className="mt-2 grid gap-3 sm:grid-cols-2">{[[i18nText('jsxPresent'), current[key]], [i18nText('jsxSelectedSave'), selected.snapshot[key]]].map(([label, value]) => <div key={String(label)}><p className="text-ui-sm text-muted-foreground">{String(label)}</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-ui-sm">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre></div>)}</div></div>)}
        <label className="my-4 flex items-center gap-2 text-ui-sm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />{i18nText('uiRestoresTheRequestDefinitionToTheSelectedSave')}</label>
        <button className="rounded-[var(--radius-sm)] bg-accent-solid px-4 py-2 text-accent-solid-foreground disabled:opacity-50" disabled={busy || !confirmed} onClick={restore}>{busy ? i18nText('jsxProcessing') : i18nText('jsxRestoreToThisSave')}</button>
      </div>}
    </div>
  </ModalFrame>
}
