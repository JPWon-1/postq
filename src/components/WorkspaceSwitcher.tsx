'use client'
import { t as i18nText } from '@/i18n'
import { ToolButton } from './ToolButton'
import { useEffect, useState } from 'react'
import { ModalFrame, ModalHeader } from './ModalFrame'
import { readStringArray, writeJson } from '@/lib/localStore'
import { useToast } from './Toast'
import { errorText, fetchArray } from '@/lib/fetchJson'

export type WorkspaceRow = { id: string; name: string }

// 프로젝트(워크스페이스) 전환 — 폴더/환경/시나리오의 최상위 스코프.
export function WorkspaceSwitcher({ workspaceId, onChange }: {
  workspaceId: string
  onChange: (id: string) => void
}) {
  const toast = useToast()
  const [list, setList] = useState<WorkspaceRow[]>([])
  const [managerOpen, setManagerOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [favorites, setFavorites] = useState<string[]>([])
  useEffect(() => { setFavorites(readStringArray('ah:workspaceFavorites')) }, [])
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [renameVal, setRenameVal] = useState('')

  // 오류 처리가 아예 없었다. 500 이면 오류 객체가 list 에 들어가 바로 아래 effect 의
  // list.some 에서 터진다 — 헤더 맨 위, 항상 떠 있는 컴포넌트라 앱 전체가 같이 죽는다.
  //
  // 실패해도 이전 목록을 지우지 않는다. 비우면 프로젝트 선택칸이 텅 비어 '프로젝트가
  // 사라졌다' 로 보이고, 그 상태로 새로 만들면 중복이 쌓인다.
  const load = () => fetchArray<WorkspaceRow>('/api/workspaces')
    .then(rows => { setList(rows); setLoadError(null) })
    .catch(e => setLoadError(errorText(e)))
  const [loadError, setLoadError] = useState<string | null>(null)
  useEffect(() => { load() }, [])

  // 저장된 프로젝트가 서버에 없으면(삭제됨·다른 DB) 조용히 '기본'으로 되돌린다.
  // 방치하면 select 는 매칭 option 이 없어 첫 항목 이름을 보여주는데 실제 스코프는 죽은 id 라,
  // "프로젝트 이름은 멀쩡한데 컬렉션이 텅 빈" 혼란이 생긴다.
  useEffect(() => {
    if (list.length === 0) return
    if (list.some(w => w.id === workspaceId)) return
    const fallback = list.find(w => w.id === 'default') ?? list[0]
    toast('info', i18nText('dynamicPreviouslyOpenProjectDisappearedAndSwitchedTo', { v0: String(fallback.name) }))
    onChange(fallback.id)
  }, [list, workspaceId, onChange, toast])

  const cancelAdd = () => { setAdding(false); setName('') }
  const openManager = () => { setQuery(''); setManagerOpen(true); load() }
  const closeManager = () => { setManagerOpen(false); cancelAdd() }

  const create = async () => {
    const n = name.trim(); if (!n) return
    const res = await fetch('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: n }) })
    if (!res.ok) { toast('error', i18nText('dynamicProjectCreationFailed', { v0: String(res.status) })); return }
    const created = await res.json()
    cancelAdd(); setManagerOpen(false)
    await load()
    onChange(created.id)
    toast('success', i18nText('dynamicProjectCreatedStartingFromAnEmptyProject', { v0: String(n) }))
  }

  /**
   * 프로젝트 이름 변경. 서버는 진작 PUT 을 갖고 있었는데 화면에 길이 없었다 —
   * 오타를 낸 채로 만들면 지우고 다시 만드는 수밖에 없었고, 그러면 그 안의 것도 같이 날아간다.
   */
  const rename = async () => {
    const next = renameVal.trim()
    const current = list.find(w => w.id === workspaceId)
    if (!next || next === current?.name) { setRenaming(false); return }
    const res = await fetch(`/api/workspaces/${workspaceId}`, { method: 'PUT', body: JSON.stringify({ name: next }) })
    if (!res.ok) { toast('error', i18nText('dynamicFailedToRename', { v0: String(res.status) })); return }
    setRenaming(false)
    await load()
    toast('success', i18nText('dynamicChangedTheProjectNameTo', { v0: String(next) }))
  }

  return (
    <div className="flex items-center gap-1.5">
      {/* ▦ 만 있을 때는 무엇인지 몰랐고, 옆의 + 와 무엇이 다른지도 몰랐다. 새 프로젝트는 이 목록 안에서만 만든다. */}
      <ToolButton icon="projects" type="button" aria-label={i18nText('uiProjectList')} title={i18nText('uiProjectListSearchFavoritesNewProject')} className="h-7 shrink-0 whitespace-nowrap rounded-[var(--radius-sm)] px-2 text-ui-md text-muted-foreground hover:bg-surface-2 hover:text-foreground" onClick={openManager} />
      {managerOpen && <ModalFrame label={i18nText('uiProjectList')} onClose={closeManager}>
        <ModalHeader title={i18nText('uiProject')} onClose={closeManager}>
          {!adding && <button type="button" className="ml-auto ah-btn-primary px-3 py-1.5" onClick={() => setAdding(true)}>{i18nText('uiNewProject')}</button>}
        </ModalHeader>
        <div className="min-h-0 overflow-auto p-5">
          {adding && (
            <form className="mb-4 flex items-center gap-2" onSubmit={e => { e.preventDefault(); create() }}>
              <input
                autoFocus
                aria-label={i18nText('uiNewProjectName')}
                className="ah-input min-w-0 flex-1"
                placeholder={i18nText('uiNewProjectName')}
                value={name}
                onChange={e => setName(e.target.value)}
                /* capture — 안 그러면 Esc 가 이름 입력이 아니라 목록 창 전체를 닫는다 */
                onKeyDownCapture={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelAdd() } }}
              />
              <button type="submit" disabled={!name.trim()} className="ah-btn-primary px-3 py-1.5 disabled:opacity-50">{i18nText('uiCreate')}</button>
              <button type="button" className="ah-action ah-btn px-3 py-1.5" onClick={cancelAdd}>{i18nText('uiCancel')}</button>
            </form>
          )}
          <p className="mb-4 text-ui-md text-muted-foreground">{i18nText('uiWeManageCollectionsEnvironmentsAndScenariosForEachProject')}</p>
          <input aria-label={i18nText('uiProjectSearch')} className="ah-input mb-4 w-full" placeholder={i18nText('uiSearchForProjectName')} value={query} onChange={e => setQuery(e.target.value)} />
          {loadError && <div role="alert" className="mb-3 text-ui-sm text-method-delete">{i18nText('uiFailedToLoadList')} <button className="ah-btn" type="button" onClick={load}>{i18nText('uiTryAgain')}</button></div>}
          <div className="divide-y divide-border/50">
            {[...list].filter(w => w.name.toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => Number(favorites.includes(b.id)) - Number(favorites.includes(a.id))).map(w => <div key={w.id} className="flex items-center gap-3 py-3">
              <ToolButton icon="star" filled={favorites.includes(w.id)} type="button" aria-label={i18nText('dynamicFavorites2', { v0: String(w.name) })} aria-pressed={favorites.includes(w.id)} className="p-2 text-accent" onClick={() => { const next = favorites.includes(w.id) ? favorites.filter(id => id !== w.id) : [...favorites, w.id]; setFavorites(next); writeJson('ah:workspaceFavorites', next) }} />
              <button type="button" className="min-w-0 flex-1 truncate py-2 text-left text-ui-lg font-medium hover:text-accent" onClick={() => { onChange(w.id); setManagerOpen(false) }}>{w.name}</button>
              {w.id === workspaceId && <><span className="text-ui-sm text-muted-foreground">{i18nText('uiCurrentProject')}</span><button type="button" className="text-ui-sm text-accent" onClick={() => { setManagerOpen(false); setRenameVal(w.name); setRenaming(true) }}>{i18nText('uiChangeName')}</button></>}
            </div>)}
          </div>
          {!list.some(w => w.name.toLowerCase().includes(query.trim().toLowerCase())) && !loadError && <p className="py-8 text-center text-ui-md text-muted-foreground">{i18nText('uiThereAreNoMatchingProjects')}</p>}
          <p className="mt-4 text-ui-sm text-faint-foreground">{i18nText('uiYourFavoritesAreSavedInThisBrowser')}</p>
        </div>
      </ModalFrame>}
      {renaming && <ModalFrame label={i18nText('uiRenameProject')} width="w-[min(420px,94vw)]" onClose={() => setRenaming(false)}>
        <ModalHeader title={i18nText('uiChangeProjectName')} onClose={() => setRenaming(false)} />
        <form className="flex flex-wrap items-center gap-2 p-4" onSubmit={e => { e.preventDefault(); rename() }}>
          <input
            autoFocus
            aria-label={i18nText('uiChangeProjectName')}
            className="h-8 w-full rounded-[var(--radius-sm)] border border-accent bg-surface px-2 text-ui-md font-semibold text-foreground outline-none"
            value={renameVal}
            onChange={e => setRenameVal(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') setRenaming(false) }}
          />
          <button type="submit" className="h-7 shrink-0 rounded-[var(--radius-sm)] bg-accent-solid px-2 text-ui-md font-semibold text-accent-solid-foreground">{i18nText('uiSave')}</button>
          <button type="button" aria-label={i18nText('uiCancelNameChange')} title={i18nText('uiCancelRenameEsc')} className="ah-action flex h-7 w-auto px-1.5 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-muted-foreground hover:bg-surface-2 hover:text-foreground" onClick={() => setRenaming(false)}>{i18nText('uiCancel')}</button>
        </form>
      </ModalFrame>}
        <>
          <select
            aria-label={i18nText('uiProject')}
            title={i18nText('uiProjectSwitchingFoldersEnvironmentsScenariosAreSeparatedByProject')}
            className="h-7 max-w-[160px] rounded-[var(--radius-sm)] border border-border bg-surface px-2 text-ui-md font-semibold text-foreground outline-none focus-visible:border-accent"
            value={workspaceId}
            onChange={e => onChange(e.target.value)}
          >
            {list.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>

        </>
    </div>
  )
}
