'use client'
import { t as i18nText } from '@/i18n'
import { useEffect, useState } from 'react'
import type { FolderRow, RequestRow } from '@/lib/ui-types'
import { fetchArray } from '@/lib/fetchJson'
import { AuthEditor } from './AuthEditor'
import { KVEditor } from './KVEditor'
import { useToast } from './Toast'
import { methodText } from '@/lib/methodStyle'

export function FolderOverview({ folder, onOpen, onSaved }: {
  folder: FolderRow; workspaceId: string; onOpen: (request: RequestRow) => void; onSaved: () => void
}) {
  const [tab, setTab] = useState<'overview' | 'auth' | 'headers'>('overview')
  const [requests, setRequests] = useState<RequestRow[] | null>(null)
  const [error, setError] = useState('')
  const [description, setDescription] = useState('')
  const [savedDescription, setSavedDescription] = useState('')
  const [auth, setAuth] = useState(folder.sharedAuth ?? { type: 'none' })
  const [headers, setHeaders] = useState(folder.sharedHeaders)
  const [saving, setSaving] = useState(false)
  const toast = useToast()
  useEffect(() => {
    setDescription(folder.description ?? ''); setSavedDescription(folder.description ?? '')
    let alive = true
    fetchArray<RequestRow>(`/api/requests?folderId=${encodeURIComponent(folder.id)}`).then(rows => { if (alive) setRequests(rows) }).catch(() => { if (alive) setError(i18nText('dynamicFailedToLoadRequestList')) })
    return () => { alive = false }
  }, [folder.id, folder.description])
  const saveShared = async () => {
    setSaving(true)
    try {
      const res = await fetch(`/api/folders/${folder.id}`, { method: 'PUT', body: JSON.stringify(tab === 'overview' ? { description } : tab === 'auth' ? { sharedAuth: auth } : { sharedHeaders: headers }) })
      if (!res.ok) throw new Error(String(res.status))
      if (tab === 'overview') setSavedDescription(description)
      onSaved(); toast('success', i18nText('dynamicFolderSettingsHaveBeenSaved'))
    } catch { toast('error', i18nText('dynamicFailedToSaveFolderSettings')) } finally { setSaving(false) }
  }
  const updatedAt = Math.max(0, ...(requests ?? []).map(r => r.updatedAt ?? 0))
  return <div className="flex h-full min-h-0 flex-col" data-testid="folder-overview">
    <div className="border-b border-border px-6 py-4 text-ui-md text-muted-foreground">{i18nText('uiCollection')} <span className="px-2 text-faint-foreground">›</span> {folder.name}</div>
    <nav aria-label={i18nText('uiFolderOverviewTab')} className="flex gap-5 border-b border-border px-6">{([['overview', i18nText('jsxOverview')], ['auth', 'Authorization'], ['headers', 'Headers']] as const).map(([id, name]) => <button key={id} aria-pressed={tab === id} className={`border-b-2 py-3 text-ui-md ${tab === id ? 'border-accent text-foreground' : 'border-transparent text-muted-foreground'}`} onClick={() => setTab(id)}>{name}</button>)}</nav>
    <div className="min-h-0 flex-1 overflow-auto px-8 py-8">
      <h1 className="mb-3 text-3xl font-semibold tracking-tight text-foreground">{folder.name}</h1>
      <p className="mb-8 border-b border-border pb-6 text-ui-md text-faint-foreground">{i18nText('uiRequest')} {requests?.length ?? '…'}{i18nText('uiCountSuffix')}{updatedAt > 0 && ` · 요청 최근 수정 ${new Date(updatedAt).toLocaleString('ko-KR')}`}</p>
      {tab === 'overview' ? <>
        <div className="mb-3 flex items-center justify-between"><label htmlFor="folder-description" className="text-ui-lg font-semibold text-foreground">{i18nText('uiDescription')}</label><span className="text-ui-sm text-faint-foreground">{i18nText('uiIncludesSavingAndExportToWorkspace')}</span></div>
        <textarea id="folder-description" aria-label={i18nText('uiFolderDescription')} value={description} onChange={e => setDescription(e.target.value)} placeholder={i18nText('uiDescribeTheAPIsCoveredByThisCollection')} className="min-h-32 w-full resize-y rounded border border-border bg-transparent p-3 text-ui-lg leading-relaxed text-foreground outline-none focus:border-accent" />
        <div className="mt-2 flex justify-end"><button className="ah-btn disabled:opacity-40" disabled={saving || description === savedDescription} onClick={saveShared}>{i18nText('uiSaveDescription')}</button></div>
        <h2 className="mb-3 mt-8 text-ui-lg font-semibold text-foreground">{i18nText('uiRequest')}</h2>{error && <p role="alert" className="text-method-delete">{error}</p>}
        {requests?.map(r => <button key={r.id} className="flex w-full items-center gap-4 border-b border-border py-3 text-left text-ui-md hover:bg-surface" onClick={() => onOpen(r)}><span className={`w-12 font-mono text-ui-meta font-bold ${methodText(r.method)}`}>{r.method}</span><span className="text-foreground">{r.name}</span><span className="ml-auto max-w-[45%] truncate text-faint-foreground">{r.url}</span></button>)}
      </> : <><p className="mb-5 text-ui-md text-muted-foreground">{i18nText('uiInheritedByRequestsInThisFolder')} {tab === 'auth' ? i18nText('jsxCertification') : i18nText('jsxHeader')}{i18nText('uiItIs')}</p>{tab === 'auth' ? <AuthEditor value={auth} onChange={setAuth} /> : <KVEditor items={headers} onChange={setHeaders} />}<button className="ah-btn ah-btn-primary mt-5" disabled={saving} onClick={saveShared}>{saving ? i18nText('jsxSaving') : i18nText('jsxSaveFolderSettings')}</button></>}
    </div>
  </div>
}
