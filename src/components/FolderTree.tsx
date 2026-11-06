'use client'
import { t as i18nText } from '@/i18n'
import { ToolButton } from './ToolButton'
import { TooltipButton } from './TooltipButton'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { methodText } from '@/lib/methodStyle'
import { KEYS, readJson, readStringArray, scoped, writeJson } from '@/lib/localStore'
import { errorText, fetchArray, fetchJson } from '@/lib/fetchJson'
import { LoadFailed } from './LoadFailed'
import { useFavorites } from '@/lib/useFavorites'
import { FavoriteStar } from './FavoriteStar'
import { displayName, groupRequests } from '@/lib/requestGroups'
import type { FolderRow, RequestRow } from '@/lib/ui-types'
import { AUTH_LABEL, type AuthConfig } from '@/lib/requestAuth'
import type { KV } from '@/lib/variables'
import { KVEditor } from './KVEditor'
import { HEADER_SUGGEST } from '@/lib/headerSuggestions'
import { AuthEditor } from './AuthEditor'
import { CollectionRunModal } from './CollectionRunModal'
import { IMPORT_FORMATS, ImportButton } from './ImportButton'
import { createStarterRequest } from '@/lib/starterRequest'
import { RowMenu } from './RowMenu'
import { useToast } from './Toast'

// 폴더 공통 헤더 편집 — 하위 모든 요청에 실행 시 상속된다(요청 쪽 같은 키가 이김).
function SharedHeadersForm({ folder, onSaved, onCancel }: {
  folder: FolderRow
  onSaved: () => void
  onCancel: () => void
}) {
  const toast = useToast()
  const [headers, setHeaders] = useState<KV[]>(folder.sharedHeaders)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      const res = await fetch(`/api/folders/${folder.id}`, {
        method: 'PUT',
        body: JSON.stringify({ sharedHeaders: headers.filter(h => h.key.trim() !== '') }),
      })
      if (!res.ok) { toast('error', i18nText('dynamicFailedToSaveCommonHeader', { v0: String(res.status) })); return }
      toast('success', i18nText('dynamicCommonHeaderStoredAutomaticallyAppliedWhenSubrequestIsExecuted', { v0: String(folder.name) }))
      onSaved()
    } catch (e) {
      // 서버 오류는 알리면서 연결 실패는 조용했다 — 누르고도 아무 일이 없는 것처럼 보인다.
      toast('error', i18nText('dynamicRequestFailed', { v0: String(errorText(e)) }))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mx-1.5 my-1 flex flex-col gap-1.5 rounded-[var(--radius-sm)] border border-accent/40 bg-surface-2 p-1.5">
      <p className="px-0.5 text-ui-sm leading-relaxed text-faint-foreground">
        {i18nText('uiFolderCommonHeaderAutomaticallyAppliedToAllChildRequests')}
        {i18nText('variablePlaceholder')} {i18nText('uiAvailable')}
      </p>
      <KVEditor items={headers} onChange={setHeaders} suggest={HEADER_SUGGEST} />
      <div className="flex justify-end gap-1">
        <button
          type="button"
          className="ah-action h-8 rounded-[var(--radius-sm)] px-3 text-ui-sm font-medium text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
          onClick={onCancel}
        >
          {i18nText('uiCancel')}
        </button>
        <button
          type="button"
          className="h-8 rounded-[var(--radius-sm)] bg-accent-solid px-3 text-ui-sm font-semibold text-accent-solid-foreground transition-colors hover:bg-accent-solid-hover disabled:opacity-50"
          disabled={saving}
          onClick={save}
        >
          {saving ? i18nText('jsxSaving') : i18nText('jsxSave')}
        </button>
      </div>
    </div>
  )
}

// 폴더 공통 인증 편집 — 하위 요청 중 인증이 '상속'인 것들이 실행 시 이 값을 사용한다.
function SharedAuthForm({ folder, onSaved, onCancel }: {
  folder: FolderRow
  onSaved: () => void
  onCancel: () => void
}) {
  const toast = useToast()
  const [auth, setAuth] = useState<AuthConfig>(folder.sharedAuth ?? { type: 'none' })
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      const res = await fetch(`/api/folders/${folder.id}`, {
        method: 'PUT',
        body: JSON.stringify({ sharedAuth: auth }),
      })
      if (!res.ok) { toast('error', i18nText('dynamicCommonAuthenticationSaveFailure', { v0: String(res.status) })); return }
      toast('success', i18nText('dynamicCommonAuthenticationStoredAppliesToChildRequestsThatHave', { v0: String(folder.name) }))
      onSaved()
    } catch (e) {
      // 서버 오류는 알리면서 연결 실패는 조용했다 — 누르고도 아무 일이 없는 것처럼 보인다.
      toast('error', i18nText('dynamicRequestFailed', { v0: String(errorText(e)) }))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mx-1.5 my-1 flex flex-col gap-1.5 rounded-[var(--radius-sm)] border border-accent/40 bg-surface-2 p-1.5">
      <p className="px-0.5 text-ui-sm leading-relaxed text-faint-foreground">
        {i18nText('uiFolderCommonAuthenticationAuthenticationMethod')} <b>{i18nText('uiInheritanceFolderCommon')}</b>{i18nText('uiTheSubrequestYouSetWillUseThisValueWhen')}
      </p>
      <AuthEditor value={auth} onChange={setAuth} />
      <div className="flex justify-end gap-1">
        <button
          type="button"
          className="ah-action h-8 rounded-[var(--radius-sm)] px-3 text-ui-sm font-medium text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
          onClick={onCancel}
        >
          {i18nText('uiCancel')}
        </button>
        <button
          type="button"
          className="h-8 rounded-[var(--radius-sm)] bg-accent-solid px-3 text-ui-sm font-semibold text-accent-solid-foreground transition-colors hover:bg-accent-solid-hover disabled:opacity-50"
          disabled={saving}
          onClick={save}
        >
          {saving ? i18nText('jsxSaving') : i18nText('jsxSave')}
        </button>
      </div>
    </div>
  )
}

function IconChevron({ open }: { open: boolean }) {
  return (
    <svg
      width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden
      className={`shrink-0 text-faint-foreground transition-transform ${open ? 'rotate-90' : ''}`}
    >
      <path d="M3 1.5 7 5l-4 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

const BADGE: Record<string, string> = {
  new: 'bg-badge-new-bg text-badge-new-fg',
  changed: 'bg-badge-changed-bg text-badge-changed-fg',
  deprecated: 'bg-badge-deprecated-bg text-badge-deprecated-fg',
}


function IconPlus() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path d="M6 1.5v9M1.5 6h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function IconRefresh({ spinning }: { spinning: boolean }) {
  return (
    <svg
      width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden
      style={spinning ? { animation: 'spin-slow 0.7s linear infinite' } : undefined}
    >
      <path
        d="M10 5.5A4 4 0 1 1 8.83 2.7M10 5.5V2m0 3.5H6.5"
        stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  )
}

function IconFolder() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden className="shrink-0 text-faint-foreground">
      <path
        d="M1.5 3.5a1 1 0 0 1 1-1h2.6l1.1 1.3h5.3a1 1 0 0 1 1 1v6.2a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-7.5Z"
        stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"
      />
    </svg>
  )
}

function IconSearch() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden className="shrink-0">
      <circle cx="5.2" cy="5.2" r="3.4" stroke="currentColor" strokeWidth="1.2" />
      <path d="M7.7 7.7 10.3 10.3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

// prompt() 대체 인라인 폼 — 트리 안에 자연스럽게 끼어드는 소형 입력 폼.
// Enter=제출, Escape=취소. 네이티브 다이얼로그는 자동화/테스트를 막고 디자인도 깨므로 사용하지 않는다.
function InlineForm({ placeholder, initial = '', submitLabel = '만들기', onSubmit, onCancel }: {
  placeholder: string
  initial?: string
  submitLabel?: string
  onSubmit: (name: string) => void | Promise<void>
  onCancel: () => void
}) {
  const [name, setName] = useState(initial)
  const [submitting, setSubmitting] = useState(false)
  // 제출 중 재제출 차단(동기 가드) — 연타/Enter 연속으로 폴더·요청이 이중 생성되던 것 방지.
  const submit = async () => {
    if (!name.trim() || submitting) return
    setSubmitting(true)
    try { await onSubmit(name.trim()) } finally { setSubmitting(false) }
  }
  return (
    <form
      // 확정 버튼을 입력칸 바로 옆에 둔다. 예전엔 아랫줄 오른쪽 끝이라, 이름을 치고 나서
      // 마우스를 아래로 또 오른쪽으로 옮겨야 했다 — 한 글자 고치는 일에 동선이 길었다.
      // 키보드만으로도 끝난다: Enter 로 확정, Esc 로 취소(아래 안내에 적어 둔다).
      className="mx-1.5 my-1 flex flex-col gap-1 rounded-[var(--radius-sm)] border border-accent/40 bg-surface-2 p-1.5"
      onSubmit={e => { e.preventDefault(); submit() }}
    >
      <div className="flex items-center gap-1">
        <input
          autoFocus
          aria-label={placeholder}
          className="ah-input min-w-0 flex-1 disabled:opacity-60"
          placeholder={placeholder}
          value={name}
          disabled={submitting}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape') onCancel() }}
        />
        <button
          type="submit"
          className="h-8 shrink-0 rounded-[var(--radius-sm)] bg-accent-solid px-3 text-ui-sm font-semibold text-accent-solid-foreground transition-colors hover:bg-accent-solid-hover disabled:opacity-50"
          disabled={!name.trim() || submitting}
        >
          {submitting ? '…' : submitLabel}
        </button>
        <button
          type="button"
          aria-label={i18nText('uiCancel')}
          title={i18nText('uiCancelEsc')}
          className="ah-action h-8 w-8 shrink-0 rounded-[var(--radius-sm)] text-ui-lg text-muted-foreground transition-colors hover:bg-surface hover:text-foreground"
          onClick={onCancel}
        >{i18nText('uiCancel')}</button>
      </div>
      <p className="px-0.5 text-ui-meta text-faint-foreground">{i18nText('uiConfirmWithEnterCancelWithEsc')}</p>
    </form>
  )
}

function IconPencilSmall() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path d="M8.2 1.6 10.4 3.8 4 10.2 1.3 10.7l.5-2.7L8.2 1.6Z"
        stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

type NewFolder = { name: string; specSourceType: 'none' | 'url'; specSourceUrl: string | null }

// 폴더 생성 폼 — 스펙 소스 선택(없음 / OpenAPI URL). URL 을 주면 만든 뒤 바로 동기화해 요청을 채운다.
// withUrl 이면 'OpenAPI 주소로 가져오기' 로 열린 것 — 주소 칸을 처음부터 펼친다.
function FolderForm({ onSubmit, onCancel, withUrl = false }: {
  onSubmit: (v: NewFolder) => void | Promise<void>
  onCancel: () => void
  withUrl?: boolean
}) {
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [sourceType, setSourceType] = useState<'none' | 'url'>(withUrl ? 'url' : 'none')
  const [url, setUrl] = useState('')

  const canSubmit = name.trim() !== '' && (sourceType !== 'url' || url.trim() !== '')

  const submit = async () => {
    if (!canSubmit || submitting) return
    setSubmitting(true)
    try {
      await onSubmit({
        name: name.trim(),
        specSourceType: sourceType,
        specSourceUrl: sourceType === 'url' ? url.trim() : null,
      })
    } finally { setSubmitting(false) }
  }

  const esc = (e: React.KeyboardEvent) => { if (e.key === 'Escape') onCancel() }

  return (
    <form
      className="mx-1.5 my-1 flex flex-col gap-1 rounded-[var(--radius-sm)] border border-accent/40 bg-surface-2 p-1.5"
      onSubmit={e => { e.preventDefault(); submit() }}
    >
      <input
        autoFocus
        aria-label={i18nText('uiFolderName')}
        className="ah-input"
        placeholder={i18nText('uiFolderName')}
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={esc}
      />
      <label className="flex items-center gap-2 text-ui-sm text-muted-foreground"><input type="checkbox" checked={sourceType !== 'none'} onChange={e => setSourceType(e.target.checked ? 'url' : 'none')} />{i18nText('uiFetchRequestFromOpenAPIAddress')}</label>
      {sourceType === 'url' && (
        <input
          aria-label={i18nText('uiOpenAPISpecificationURL')}
          className="ah-input font-mono text-ui-sm"
          placeholder="https://api.example.com/openapi.json"
          value={url}
          onChange={e => setUrl(e.target.value)}
          onKeyDown={esc}
        />
      )}
      <div className="flex justify-end gap-1">
        <button
          type="button"
          className="ah-action h-8 rounded-[var(--radius-sm)] px-3 text-ui-sm font-medium text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
          onClick={onCancel}
        >
          {i18nText('uiCancel')}
        </button>
        <button
          type="submit"
          className="h-8 rounded-[var(--radius-sm)] bg-accent-solid px-3 text-ui-sm font-semibold text-accent-solid-foreground transition-colors hover:bg-accent-solid-hover disabled:opacity-50"
          disabled={!canSubmit}
        >
          {i18nText('uiCreate')}
        </button>
      </div>
    </form>
  )
}

// confirm() 대체 2단계 삭제 버튼 — 첫 클릭에 "무장(armed)" 상태로 바뀌고 3초 안에 다시 누르면 삭제.
export function FolderTree({ workspaceId, selectedId, onSelect, reloadKey, headerExtra, onDeleted, onHide, onReloaded, openApiFormKey = 0, onFolderSelect, onCopyCurl }: {
  workspaceId: string
  selectedId: string | null
  onFolderSelect?: (folder: FolderRow) => void
  onCopyCurl?: (r: RequestRow) => void
  onSelect: (r: RequestRow, pin?: boolean) => void
  reloadKey: number
  headerExtra?: ReactNode
  /** 열려 있던 탭을 닫는다. 미저장 편집이 함께 사라졌으면 true — 그건 사람에게 알려야 한다. */
  onDeleted?: (requestId: string) => boolean | void
  /** 이 목록을 숨긴다. 되살리기는 레일의 같은 항목·⌘E. */
  onHide?: () => void
  onReloaded?: () => void
  /** 값이 바뀔 때마다 'OpenAPI 주소로 가져오기' 폴더 폼을 연다(시작 안내·빈 화면의 [OpenAPI 주소로 추가]). */
  openApiFormKey?: number
}) {
  const toast = useToast()
  const [foldersList, setFolders] = useState<FolderRow[]>([])
  const [reqs, setReqs] = useState<Record<string, RequestRow[]>>({})
  const [syncing, setSyncing] = useState<string | null>(null)
  // 메서드 필터 — 요청이 수백 개라 텍스트 검색만으로는 좁히기 어렵다.
  const [methodFilter, setMethodFilter] = useState('')
  const [tagFilter, setTagFilter] = useState('')
  const [loaded, setLoaded] = useState(false)
  // 왜 못 불러왔는지까지 들고 있는다 — '서버·네트워크 문제일 수 있습니다' 만으로는
  // VPN 인지 주소가 틀렸는지 권한인지 못 가른다. 서버가 적어 보낸 한 줄이 그걸 가른다.
  const [loadError, setLoadError] = useState<string | null>(null)
  const dupInFlight = useRef(false)
  const [q, setQ] = useState('')
  const [collectionOpen, setCollectionOpen] = useState(true)
  const [overflowOpen, setOverflowOpen] = useState(false)
  /**
   * 트리에 표시를 달 요청들 — 최근에 깨진 것과 스펙이 바뀐 것.
   *
   * 목록을 훑을 때 '어느 게 문제인지' 가 안 보이면, 문제를 알려면 하나씩 열어 봐야 한다.
   * 요청마다 부르면 수백 번 두드리게 되므로 프로젝트 단위로 한 번에 받는다.
   * 실패해도 트리는 그대로 그린다 — 표시는 곁다리다.
   */
  const [flags, setFlags] = useState<{ failed: Set<string>; latest?: Record<string, number>; spec: Record<string, 'changed' | 'deprecated'> }>(
    { failed: new Set(), spec: {} })
  // 표시를 아직 못 받았는지. 트리가 먼저 그려지고 요약 바가 나중에 끼어들면 목록이 한 칸
  // 밀려 내려가, 마침 누르려던 것이 손 아래에서 도망간다.
  const [flagsLoaded, setFlagsLoaded] = useState(false)
  const [onlyFlagged, setOnlyFlagged] = useState(false)
  const [acking, setAcking] = useState(false)
  // 필터를 접어 둘지. 조건이 하나라도 걸려 있으면 처음부터 펼쳐 둔다 —
  // 접힌 채로 목록이 좁혀져 있으면 '왜 안 보이지' 가 된다.
  const [filterOpen, setFilterOpen] = useState(false)
  // 메뉴는 Esc 로 닫혀야 한다. 이 앱의 다른 메뉴들이 다 그렇고, 무엇보다 열어 둔 채로
  // 화면 전체를 덮는 투명 배경이 깔려서 안 닫히면 다른 곳을 아무것도 못 누른다.
  useEffect(() => {
    if (!overflowOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOverflowOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [overflowOpen])
  // 폴더 내 요청 정렬 — 기본(삽입순)/이름/메서드. 스펙 sync 로 수십 개 쌓인 폴더 탐색용.
  const [sortMode, setSortMode] = useState<'default' | 'name' | 'method'>('default')
  const sortReqs = (list: RequestRow[]): RequestRow[] => {
    if (sortMode === 'default') return list
    const copy = [...list]
    if (sortMode === 'name') copy.sort((a, b) => displayName(a.name).localeCompare(displayName(b.name), 'ko'))
    else copy.sort((a, b) => a.method.localeCompare(b.method) || displayName(a.name).localeCompare(displayName(b.name), 'ko'))
    return copy
  }
  // 현재 열려 있는 인라인 폼: 폴더 생성('folder') 또는 특정 폴더의 요청 생성(폴더 id)
  const [openForm, setOpenForm] = useState<'folder' | string | null>(null)
  // 폴더 폼을 OpenAPI 주소 칸까지 펼쳐 열지 — 바깥에서 [OpenAPI 주소로 추가] 로 왔을 때.
  const [folderFormUrl, setFolderFormUrl] = useState(false)
  useEffect(() => {
    if (!openApiFormKey) return
    setFolderFormUrl(true); setOpenForm('folder')
  }, [openApiFormKey])
  // 공통 헤더 편집 중인 폴더 id
  const [sharedHeadersFor, setSharedHeadersFor] = useState<string | null>(null)
  // 공통 인증 편집 중인 폴더 id
  const [sharedAuthFor, setSharedAuthFor] = useState<string | null>(null)
  // 일괄 실행(Collection Runner) 모달 대상 폴더
  const [runFolder, setRunFolder] = useState<FolderRow | null>(null)
  // 대량 선택(이동/삭제) — 스펙 sync 로 쌓인 템플릿 정리용
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const toggleSelected = (id: string) => setSelectedIds(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const clearSelection = () => { setSelectedIds(new Set()); setSelectMode(false) }

  // 일괄 작업은 결과를 세지 않고 '${n}개 처리됨' 을 띄우고 있었다. 20개 중 3개가 실패해도
  // 20개가 된 것처럼 말한다 — 실패한 것만 다시 시도할 방법이 화면에 없어진다.
  // 하나가 실패해도 나머지는 계속한다(멈추면 어디까지 됐는지가 더 모호해진다).
  const bulkEach = async (fn: (id: string) => Promise<Response>): Promise<{ done: string[]; failed: number }> => {
    const done: string[] = []
    let failed = 0
    for (const id of selectedIds) {
      try {
        const res = await fn(id)
        if (res.ok) done.push(id); else failed++
      } catch { failed++ }
    }
    return { done, failed }
  }
  const bulkTell = (verb: string, done: number, failed: number) => {
    if (failed === 0) toast('success', i18nText('dynamicundefined', { v0: String(done), v1: String(verb) }))
    else if (done === 0) toast('error', i18nText('dynamicAllFailedNone', { v0: String(failed), v1: String(verb.replace('됨', '')) }))
    else toast('error', i18nText('dynamicFailuresFailuresRemain', { v0: String(done), v1: String(verb), v2: String(failed) }))
  }

  const bulkDelete = async () => {
    if (!window.confirm(i18nText('dynamicDoYouWantToDeleteTheSelectedRequestsIncluding', { v0: String(selectedIds.size) }))) return
    const { done, failed } = await bulkEach(id => fetch(`/api/requests/${id}`, { method: 'DELETE' }))
    // 지워진 것만 화면에서 뺀다 — 실패한 것까지 빼면 reload 때 되살아나 유령처럼 보인다.
    let lost = 0
    for (const id of done) if (onDeleted?.(id)) lost++
    bulkTell(i18nText('dynamicDeleted'), done.length, failed)
    if (lost) toast('info', i18nText('dynamicUnsavedEditsInOpenTabsAreAlsoGone', { v0: String(lost) }))
    clearSelection(); reload()
  }
  const bulkMove = async (targetFolderId: string) => {
    if (!targetFolderId) return
    const { done, failed } = await bulkEach(id =>
      fetch(`/api/requests/${id}`, { method: 'PUT', body: JSON.stringify({ folderId: targetFolderId }) }))
    bulkTell(i18nText('dynamicMoved'), done.length, failed); clearSelection(); reload()
  }
  // 접힘 상태 — 폴더는 folderId, 서브그룹은 `${folderId}|${group}` 키. localStorage 유지.
  // 그룹은 기본 접힘(첫 방문 시 컴팩트 뷰), 폴더는 기본 펼침. 검색 중에는 접힘을 무시하고 매칭을 다 보여준다.
  // 요청이 2000개까지 늘어난다 — 자주 쓰는 것을 트리 맨 위 고정 구역으로 뽑는다.
  const favRequests = useFavorites(scoped.favRequests(workspaceId))
  /**
   * 트리 드래그 — 요청은 폴더 사이·폴더 안에서, 폴더는 서로 앞뒤로 옮긴다.
   *
   * 끌고 있는 것은 dataTransfer 로 나른다. React 상태로 들고 있으면 onDragStart 의
   * setState 가 반영되기 전에 onDragOver 가 먼저 도착해 stale 값을 보고 드롭을 거부한다.
   * (상태는 '어디에 놓일지' 선을 그리는 용도로만 쓴다 — 늦게 반영돼도 표시만 한 프레임 밀린다)
   *
   * 자리 계산은 서버가 한다. 화면은 "무엇 앞에" 만 말한다 — 자세한 이유는 sortOrder.ts.
   */
  const REQ_TYPE = 'application/x-postq-request'
  const FOLDER_TYPE = 'application/x-postq-folder'
  const [dragReq, setDragReq] = useState<RequestRow | null>(null)
  const [dropFolder, setDropFolder] = useState<string | null>(null)
  /** 선을 그릴 자리. 표시 전용이다 — 실제 저장 위치는 drop 이벤트에서 다시 계산한다. */
  const [dropAt, setDropAt] = useState<{ kind: 'req' | 'folder'; beforeId: string | null; folderId?: string } | null>(null)
  const clearDrag = () => { setDragReq(null); setDropFolder(null); setDropAt(null) }

  /**
   * 이름순·메서드순으로 보고 있을 때는 순서를 바꿀 수 없다.
   *
   * 보이는 순서가 저장된 순서가 아니기 때문이다. 이때 드롭을 받으면 화면에서는 A와 B
   * 사이에 놓았는데 저장은 전혀 다른 자리에 되고, 정렬을 '기본순' 으로 되돌리는 순간
   * 엉뚱한 데 가 있다. 막고 이유를 말하는 편이 낫다.
   */
  const canReorder = sortMode === 'default'

  const moveRequest = async (r: { id: string; name: string; folderId: string }, folderId: string, beforeId: string | null) => {
    if (r.folderId === folderId && beforeId === null && !canReorder) return
    const to = foldersList.find(f => f.id === folderId)
    const crossFolder = r.folderId !== folderId
    try {
      const res = await fetch('/api/requests/reorder', {
        method: 'POST', body: JSON.stringify({ id: r.id, folderId, beforeId }),
      })
      if (!res.ok) { toast('error', i18nText('dynamicMoveFailed', { v0: String(res.status) })); return }
      // 놓은 자리가 원래 자리면 서버가 아무것도 안 바꾼다(updated: 0). 그때는 말도 안 한다 —
      // 순서는 그대로인데 '순서를 바꿨습니다' 가 뜨면, 정말 바뀐 때의 같은 문구도 못 믿는다.
      const r2 = await res.json().catch(() => null)
      if (crossFolder) toast('success', i18nText('dynamicMovedFrom', { v0: String(r.name), v1: String(to?.name ?? '폴더') }))
      else if (r2?.updated !== 0) toast('success', i18nText('dynamicTheOrderOfHasBeenChanged', { v0: String(r.name) }))
      reload()
    } catch (e) {
      toast('error', i18nText('dynamicFailedToMove2', { v0: String(errorText(e)) }))
    }
  }

  const moveFolder = async (id: string, name: string, beforeId: string | null) => {
    try {
      const res = await fetch('/api/folders/reorder', { method: 'POST', body: JSON.stringify({ id, beforeId }) })
      if (!res.ok) { toast('error', i18nText('dynamicFailedToMoveFolder', { v0: String(res.status) })); return }
      // 요청 이동과 같은 이유로, 제자리면 말하지 않는다(서버가 updated: 0 을 준다).
      const r = await res.json().catch(() => null)
      if (r?.updated !== 0) toast('success', i18nText('dynamicTheOrderOfHasBeenChanged', { v0: String(name) }))
      reload()
    } catch (e) {
      toast('error', i18nText('dynamicFailedToMove', { v0: String(errorText(e)) }))
    }
  }

  /** 커서가 행의 위쪽 절반이면 '이 앞', 아래쪽이면 '다음 것 앞'. */
  const halfOf = (e: React.DragEvent, thisId: string, nextId: string | null) => {
    const b = e.currentTarget.getBoundingClientRect()
    return e.clientY < b.top + b.height / 2 ? thisId : nextId
  }
  /** 그 자리에 선을 그릴지 — 렌더에서 클래스로 쓴다. */
  const lineAt = (kind: 'req' | 'folder', beforeId: string | null, folderId?: string) =>
    dropAt && dropAt.kind === kind && dropAt.beforeId === beforeId && dropAt.folderId === folderId
      ? 'shadow-[inset_0_2px_0_0_var(--color-accent)]' : ''
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  /**
   * 즐겨찾기 구역의 행. 트리 안의 행과 달리 폴더 밖에 떠 있으므로
   * 어느 폴더 것인지 같이 보여준다 — 이름만으로는 같은 이름이 여럿일 수 있다.
   */
  const renderFavoriteRow = (r: RequestRow, folderName: string) => (
    <div
      key={`fav:${r.id}`}
      role="button"
      tabIndex={0}
      title={`${folderName} / ${r.name}`}
      className={i18nText('dynamicGroupRelativeFlexWFullItemsCenterGap2', { v0: String(selectedId === r.id ? 'border-accent bg-accent/15 text-foreground' : 'text-foreground hover:bg-surface-2') })}
      onClick={() => onSelect(r)}
      onDoubleClick={() => onSelect(r, true)}
      onKeyDown={e => { if (e.target !== e.currentTarget) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(r) } }}
    >
      <span className={`w-[42px] shrink-0 font-mono text-ui-meta font-bold ${methodText(r.method)}`}>{r.method}</span>
      <span className="min-w-0 flex-1 truncate text-ui-md">
        {r.name}
        <span className="ml-1.5 text-ui-meta text-faint-foreground">{folderName}</span>
      </span>
      <FavoriteStar on onToggle={() => favRequests.toggle(r.id)} label={r.name} />
    </div>
  )

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())

  useEffect(() => {
    // 손상된 값이면 readStringArray 가 빈 배열로 떨어뜨린다 — 여기서 던지면 트리가 안 그려진다
    setCollapsed(new Set(readStringArray(KEYS.collapsedFolders)))
    setExpandedGroups(new Set(readStringArray(KEYS.expandedGroups)))
  }, [])

  const toggleFolder = (folderId: string) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      // setState 업데이터 안이다 — 여기서 던지면 React 가 렌더 도중 죽는다.
      // writeJson 이 프라이빗 모드/용량 초과를 삼킨다.
      writeJson(KEYS.collapsedFolders, [...next])
      return next
    })
  }
  /**
   * 모두 접기 / 모두 펼치기.
   *
   * 폴더는 하나씩 접을 수 있었지만 전부 접는 방법이 없었다. 스펙 하나가 80~200개를
   * 끌고 오는 도구라, 폴더 셋만 열려 있어도 목록이 수백 줄이 된다 — 다른 폴더를 보려면
   * 스크롤을 한참 내리거나 열린 것을 하나씩 눌러 닫아야 했다.
   *
   * 하나로 겸한다. 하나라도 펼쳐져 있으면 [모두 접기], 전부 접혀 있으면 [모두 펼치기].
   * 버튼 두 개를 나란히 두면 그중 하나는 늘 아무 일도 안 하는 버튼이 된다.
   */
  const allCollapsed = foldersList.length > 0 && foldersList.every(f => collapsed.has(f.id))
  const toggleAll = () => {
    setCollapsed(() => {
      const next = allCollapsed ? new Set<string>() : new Set(foldersList.map(f => f.id))
      writeJson(KEYS.collapsedFolders, [...next])
      return next
    })
  }

  const toggleGroup = (folderId: string, group: string) => {
    const key = `${folderId}|${group}`
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      writeJson(KEYS.expandedGroups, [...next])
      return next
    })
  }
  // 탭을 바꾸거나 이력·⌘K 로 열면 트리도 그 요청으로 따라간다 — 접힌 폴더·그룹을 펼치고 보이게 스크롤.
  // 펼친 상태는 저장하지 않는다(사용자가 접어 둔 구성을 덮어쓰지 않게, 이번 화면에서만).
  // 한 요청에 한 번만 — 그 뒤 사용자가 폴더를 접으면, 목록이 다시 불려와도 다시 펼치지 않는다.
  const revealedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!selectedId || revealedRef.current === selectedId) return
    const folderId = Object.keys(reqs).find(fid => reqs[fid]?.some(r => r.id === selectedId))
    if (!folderId) return
    revealedRef.current = selectedId
    setCollapsed(prev => { if (!prev.has(folderId)) return prev; const next = new Set(prev); next.delete(folderId); return next })
    const bucket = groupRequests(reqs[folderId]).find(b => b.items.some(r => r.id === selectedId))
    if (bucket?.group != null) {
      const key = `${folderId}|${bucket.group}`
      setExpandedGroups(prev => prev.has(key) ? prev : new Set(prev).add(key))
    }
    const raf = requestAnimationFrame(() => {
      document.querySelector(`[data-req-id="${CSS.escape(selectedId)}"]`)?.scrollIntoView({ block: 'nearest' })
    })
    return () => cancelAnimationFrame(raf)
  }, [selectedId, reqs])

  const matchText = (r: RequestRow) => !q
    || r.name.toLowerCase().includes(q.toLowerCase())
    || r.url.toLowerCase().includes(q.toLowerCase())
    || (r.tags ?? []).some(t => t.toLowerCase().includes(q.toLowerCase()))  // 태그 검색(#tag 도 매칭)
  // 메서드 필터는 텍스트 검색과 AND — 수백 개에서 "POST 만" 같은 좁히기가 가능해진다.
  const match = (r: RequestRow) => matchText(r)
    && (!methodFilter || r.method === methodFilter)
    && (!tagFilter || (r.tags ?? []).includes(tagFilter))
    // '문제만 보기' — 깨진 것과 스펙이 바뀐 것만 남긴다. 수백 개 중에서 손볼 것을
    // 눈으로 찾게 하지 않는다.
    && (!onlyFlagged || flags.failed.has(r.id) || !!flags.spec[r.id])
  // 무엇으로든 좁히는 중이면 매칭되는 폴더만 보인다. 폴더 순서 계산도 '보이는 목록'
  // 기준이어야 화면에서 가리킨 자리와 저장되는 자리가 같다.
  // (match 보다 반드시 아래에 둔다 — 렌더 중 바로 실행되므로 위에 두면 TDZ 로 화면이 통째로 죽는다)
  //
  // 예전엔 검색어(q)일 때만 접었다. 그래서 메서드나 태그로 좁히면 결과가 없는 폴더의
  // 머리만 줄줄이 남아, 어느 폴더에 뭐가 있는지 눈으로 훑어야 했다.
  const filtering = !!q || !!methodFilter || !!tagFilter || onlyFlagged
  // 접힌 필터 버튼에 다는 숫자. 검색은 칸이 따로 보이니 세지 않는다.
  const activeFilters = [methodFilter, tagFilter, sortMode !== 'default' ? sortMode : '', selectMode ? 'sel' : ''].filter(Boolean).length
  // 조건이 하나라도 걸려 있으면 접혀 있어도 펼쳐 둔다 — 접힌 채로 목록이 좁혀져 있으면
  // '왜 안 보이지' 가 된다. (선언 위치 주의: sortMode·selectMode 아래여야 TDZ 로 안 죽는다)
  const filterPanelOpen = filterOpen || activeFilters > 0
  const shownFolders = foldersList.filter(f => !filtering || (reqs[f.id] ?? []).some(match))
  /** 지금 걸려 있는 조건을 사람 말로 — 결과가 없을 때 무엇 때문인지 보여준다. */
  const changedIds = Object.entries(flags.spec).filter(([, v]) => v === 'changed').map(([id]) => id)
  const filterLabel = [q && `'${q}'`, methodFilter, tagFilter && `#${tagFilter}`, onlyFlagged && '문제만'].filter(Boolean).join(' · ')

  // 워크스페이스에 실제로 쓰인 태그만 모아 칩으로 — 태그가 없으면 UI 자체를 숨긴다.
  const allTags = [...new Set(Object.values(reqs).flat().flatMap(r => r.tags ?? []))].sort()

  const reloadVersion = useRef(0)
  const reload = useCallback(async () => {
    const version = ++reloadVersion.current
    // 조회 실패(서버 500·네트워크) 시 loaded 가 영영 false 로 남아 트리가 영구 공백이 되던 것 →
    // 에러 상태로 전환해 '다시 시도' UI 를 보여준다.
    try {
      setLoadError(null)
      const fs = await fetchArray<FolderRow>(`/api/folders?workspaceId=${encodeURIComponent(workspaceId)}`)
      // 프로젝트 전체를 한 번에, 트리가 쓰는 칸만 받는다.
      // 예전엔 폴더마다 한 번씩(12번) 불렀고 매번 바디까지 통째로 와서 985KB 였다 —
      // 트리는 이름과 메서드만 그리는데도. 요청을 열 때 그때 전부 받는다.
      const all = await fetchArray<RequestRow>(
        `/api/requests?workspaceId=${encodeURIComponent(workspaceId)}&slim=1`)
      const grouped: Record<string, RequestRow[]> = {}
      for (const f of fs) grouped[f.id] = []
      for (const r of all) (grouped[r.folderId] ??= []).push(r)
      if (version !== reloadVersion.current) return
      setFolders(fs)
      setReqs(grouped)
      setLoaded(true)
      onReloaded?.()
    } catch (e) {
      if (version === reloadVersion.current) setLoadError(errorText(e))
    }
  }, [workspaceId, onReloaded])
  useEffect(() => { void reload(); return () => { reloadVersion.current++ } }, [reload, reloadKey])

  useEffect(() => {
    let alive = true
    fetchJson<{ failed: string[]; failedLatest?: Record<string, number>; spec: Record<string, 'changed' | 'deprecated'> }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/flags`)
      .then(v => { if (alive) {
        const dismissed = readJson<Record<string, number>>(`ah:failed-dismissed:${workspaceId}`, {})
        setFlags({ failed: new Set(v.failed.filter(id => !v.failedLatest?.[id] || v.failedLatest[id] > (dismissed?.[id] ?? 0))), latest: v.failedLatest, spec: v.spec ?? {} })
      } })
      // 표시는 곁다리다 — 못 받아도 트리는 그대로 그린다.
      .catch(() => { if (alive) setFlags({ failed: new Set(), spec: {} }) })
      .finally(() => { if (alive) setFlagsLoaded(true) })
    return () => { alive = false }
  }, [workspaceId, reloadKey])

  const addFolder = async (v: NewFolder) => {
    const res = await fetch('/api/folders', { method: 'POST', body: JSON.stringify({ ...v, workspaceId }) })
    if (!res.ok) { toast('error', i18nText('dynamicFolderCreationFailed', { v0: String(res.status) })); return }
    setOpenForm(null)
    // 스펙 소스가 있으면 첫 동기화를 자동으로 — "빈 폴더 → ⟳ 찾기" 단계를 없앤다
    if (v.specSourceType !== 'none') {
      const created = await res.json()
      await syncFolder(created.id)
    }
    reload()
  }

  const renameFolder = async (id: string, name: string) => {
    const res = await fetch(`/api/folders/${id}`, { method: 'PUT', body: JSON.stringify({ name }) })
    if (!res.ok) { toast('error', i18nText('dynamicNameChangeFailed', { v0: String(res.status) })); return }
    setOpenForm(null); reload()
  }

  const removeFolder = async (f: FolderRow) => {
    const res = await fetch(`/api/folders/${f.id}`, { method: 'DELETE' })
    if (!res.ok) { toast('error', i18nText('dynamicFolderDeletionFailed', { v0: String(res.status) })); return }
    let lost = 0
    for (const r of reqs[f.id] ?? []) if (onDeleted?.(r.id)) lost++
    toast('info', `'${f.name}' 폴더 삭제됨 (요청 ${reqs[f.id]?.length ?? 0}개 + 이력 포함)`
      + (lost ? i18nText('dynamicAnyUnsavedEditsAreAlsoGone', { v0: String(lost) }) : ''))
    reload()
  }

  const addRequest = async (folderId: string, name: string) => {
    const res = await fetch('/api/requests', { method: 'POST', body: JSON.stringify({ folderId, name }) })
    if (!res.ok) { toast('error', i18nText('dynamicRequestCreationFailed', { v0: String(res.status) })); return }
    // 만들고 나서 다시 찾아 눌러야 했다 — 만든 요청을 바로 연다.
    const created = await res.json().catch(() => null) as RequestRow | null
    setOpenForm(null); await reload()
    if (created?.id) onSelect(created, true)
  }
  // 빈 상태의 [+ 새 요청] — 폴더가 없으면 '내 요청' 폴더를 만들고 이름 없이 바로 연다.
  // 예전엔 폴더 만들기 → 이름 → 폴더 위에 마우스 → [+] → 요청 이름까지 거쳐야 첫 요청이 생겼다.
  const [starting, setStarting] = useState(false)
  const startBlank = async () => {
    if (starting) return
    setStarting(true)
    try {
      const created = await createStarterRequest(workspaceId, 'blank')
      await reload()
      onSelect(created, true)
    } catch (e) {
      toast('error', i18nText('dynamicFailedToCreateRequest', { v0: String(errorText(e)) }))
    } finally {
      setStarting(false)
    }
  }
  const syncFolder = async (id: string) => {
    setSyncing(id)
    const res = await fetch(`/api/folders/${id}/sync`, { method: 'POST' })
    const body = await res.json()
    if (!res.ok) toast('error', i18nText('dynamicSyncFailed', { v0: String(body.error) }))
    else toast('success', i18nText('dynamicSyncCompletedAddedChangedDeprecated', { v0: String(body.added), v1: String(body.changed), v2: String(body.deprecated) }))
    setSyncing(null); reload()
  }
  const duplicate = async (r: RequestRow) => {
    if (dupInFlight.current) return  // 연타로 '(copy)' 가 2개 생성되던 것 방지(동기 가드)
    dupInFlight.current = true
    try {
      // 트리의 r 은 slim 행(이름·메서드·URL)이라 여기서 베끼면 헤더·바디가 빈 채로 복제된다.
      // 서버가 원본 행 전체를 베껴 원본 바로 아래에 둔다.
      const res = await fetch(`/api/requests/${r.id}/duplicate`, { method: 'POST' })
      if (!res.ok) { toast('error', i18nText('dynamicReplicationFailed', { v0: String(res.status) })); return }
      toast('success', i18nText('dynamicDuplicated', { v0: String(r.name) }))
      reload()
    } catch (e) {
      // 서버 오류는 알리면서 연결 실패는 조용했다 — 누르고도 아무 일이 없는 것처럼 보인다.
      toast('error', i18nText('dynamicRequestFailed', { v0: String(errorText(e)) }))
    } finally {
      dupInFlight.current = false
    }
  }
  const remove = async (r: RequestRow) => {
    const res = await fetch(`/api/requests/${r.id}`, { method: 'DELETE' })
    if (!res.ok) { toast('error', i18nText('dynamicDeletionFailed', { v0: String(res.status) })); return }
    const lost = onDeleted?.(r.id)
    toast('info', `'${r.name}' 삭제됨 (이력 포함)`
      + (lost ? i18nText('dynamicAnyUnsavedEditsAreAlsoGone2') : ''))
    reload()
  }

  return (
    <div className="flex h-full w-full flex-col bg-surface">
      {/* 검색은 한 줄을 통째로 쓴다. 예전엔 메서드 필터와 한 줄을 나눠 써서 폭이 절반이었고,
          긴 요청 이름을 치면 앞부분만 보였다 — 목록에서 제일 많이 쓰는 칸인데 제일 좁았다.
          필터 넷은 그 아래 한 줄로 모은다(예전엔 두 줄로 흩어져 있었다). */}
      <div className="flex shrink-0 flex-col gap-1.5 px-2 py-1">
        <div className="flex flex-wrap items-center gap-1.5">
        <div className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-[var(--radius-sm)] border border-border bg-surface px-2 transition-colors focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25">
        <ToolButton icon="filter"
          type="button"
          data-testid="filter-toggle"
          aria-pressed={filterOpen}
          aria-label={i18nText('uiFilter')}
          title={i18nText('uiMethodTagSortMultipleSelection')}
          className={`flex shrink-0 items-center gap-1 rounded-[var(--radius-sm)] border-0 px-0 py-0 text-ui-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
            activeFilters > 0 ? 'border-accent/60 bg-accent/10 text-accent'
              : filterOpen ? 'border-border-strong text-foreground' : 'border-border text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => setFilterOpen(v => !v)}
         />
          <input
            aria-label={i18nText('uiRequestSearch')}
            className="w-full min-w-0 flex-1 bg-transparent text-ui-md text-foreground outline-none placeholder:text-faint-foreground"
            placeholder={i18nText('uiRequestSearch')}
            value={q}
            onChange={e => setQ(e.target.value)}
          />
        </div>

        <span className="flex shrink-0 items-center gap-0.5">
          <ToolButton icon="folderPlus" aria-label={i18nText('uiCreateAFolder')}
            className="flex items-center gap-1 rounded-[var(--radius-sm)] bg-transparent px-1.5 py-1 text-ui-sm font-medium text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            onClick={() => { setFolderFormUrl(false); setOpenForm(openForm === 'folder' ? null : 'folder') }}
           />
          {/* 가져오기·내보내기는 이름이 보이는 메뉴 하나로 합친다. */}
          <div className="relative">
            <ToolButton icon="transfer"
              type="button"
              data-testid="list-overflow"
              aria-label={i18nText('uiMoreListTools')}
              aria-expanded={overflowOpen}
              title={i18nText('uiImportExport')}
              className="flex h-6 gap-1 px-1.5 text-ui-sm whitespace-nowrap shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-faint-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              onClick={() => setOverflowOpen(v => !v)}
             />
            {overflowOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setOverflowOpen(false)} />
                <div
                  role="menu"
                  className="absolute right-0 top-7 z-50 flex flex-col gap-1 rounded-[var(--radius-md)] border border-border bg-surface p-1.5 shadow-[var(--shadow-card)]"
                  onClick={() => setOverflowOpen(false)}
                >
                  {headerExtra}
                </div>
              </>
            )}
          </div>
          {/* 목록을 숨기는 버튼은 목록 위에. 되살리기는 레일의 같은 항목을 다시 누르거나 ⌘E —
              헤더 왼쪽 끝은 레일 바로 위라 '메뉴 접기' 로 읽혀서 쓰지 않는다. */}
          {onHide && (
            <ToolButton icon="panelLeft"
              type="button"
              data-testid="hide-list"
              title={i18nText('uiHideListETapTheSameItemInThe')}
              aria-label={i18nText('uiHideList')}
              className="flex h-6 gap-1 px-1.5 text-ui-sm whitespace-nowrap shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-faint-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              onClick={onHide}
             />
          )}
        </span>

        </div>
        {/* 필터는 하나로 접는다.
            검색·메서드·태그·정렬·선택 다섯이 늘어서면 사이드바 기본 폭에서 두 줄로 밀린다.
            자주 쓰는 건 검색이고 나머지는 가끔이다 — 접되, 조건이 걸려 있으면 버튼에
            개수를 달아 '왜 목록이 이런지' 를 잊지 않게 한다(0건일 때의 안내와 짝이다). */}
        {filterPanelOpen && (
          <div className="flex flex-wrap items-center gap-1.5 rounded-[var(--radius-sm)] border border-border bg-surface-2/40 p-1.5">
        <select
          aria-label={i18nText('uiMethodFilter')}
          title={i18nText('uiNarrowByMethod')}
          className="shrink-0 rounded-[var(--radius-sm)] border border-border bg-surface px-1.5 py-1 text-ui-md text-muted-foreground outline-none focus-visible:border-accent"
          value={methodFilter}
          onChange={e => setMethodFilter(e.target.value)}
        >
          <option value="">{i18nText('uiAll')}</option>
          {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        {allTags.length > 0 && (
          <select
            aria-label={i18nText('uiTagFilter')}
            title={i18nText('uiNarrowByTags')}
            className="shrink-0 rounded-[var(--radius-sm)] border border-border bg-surface px-1.5 py-1 text-ui-md text-muted-foreground outline-none focus-visible:border-accent"
            value={tagFilter}
            onChange={e => setTagFilter(e.target.value)}
          >
            <option value="">{i18nText('uiTag')}</option>
            {allTags.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
        <select
          aria-label={i18nText('uiRequestSorting')}
          title={i18nText('uiSortRequestsWithinFolders')}
          className="shrink-0 rounded-[var(--radius-sm)] border border-border bg-surface px-1.5 py-1 text-ui-sm text-muted-foreground outline-none focus-visible:border-accent"
          value={sortMode}
          onChange={e => setSortMode(e.target.value as typeof sortMode)}
        >
          <option value="default">{i18nText('uiOrder')}</option>
          <option value="name">{i18nText('uiName')}</option>
          <option value="method">{i18nText('uiMethodOrder')}</option>
        </select>
        {/* 왜 드래그가 안 먹는지 알려 준다. 조용히 무시하면 '가끔 안 되는 기능' 이 된다. */}
        {!canReorder && (
          <span
            className="shrink-0 text-ui-meta text-faint-foreground"
            title={i18nText('uiTheOrderOfNamesAndMethodsIsNotThe')}
          >
            {i18nText('uiFixedOrder')}
          </span>
        )}
        <ToolButton icon="select" aria-label={selectMode ? i18nText('jsxCancelSelection') : i18nText('jsxSelectMultipleRequests')}
          type="button"
          title={i18nText('uiSelectMultipleRequestsMoveDelete')}
          aria-pressed={selectMode}
          className={`shrink-0 rounded-[var(--radius-sm)] border px-1.5 py-1 text-ui-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${selectMode ? 'border-accent text-accent' : 'border-border text-muted-foreground hover:text-foreground'}`}
          onClick={() => (selectMode ? clearSelection() : setSelectMode(true))}
         />
          </div>
        )}
        </div>
      <div className="flex h-7 shrink-0 items-center px-2">
        <button type="button" aria-expanded={collectionOpen} className="flex h-full flex-1 items-center gap-2 px-1 text-left text-ui-meta font-semibold tracking-[.04em] text-muted-foreground" onClick={() => setCollectionOpen(v => !v)}>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden className={collectionOpen ? 'rotate-90' : ''}><path d="m3.5 2 3 3-3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>{i18nText('uiCollection')}
        </button>
        <ToolButton icon={allCollapsed ? "expandAll" : "collapseAll"} type="button" data-testid="collapse-all" aria-expanded={!allCollapsed} title={allCollapsed ? i18nText('jsxExpandAllFolders') : i18nText('jsxCollapseAllFolders')} aria-label={allCollapsed ? i18nText('jsxExpandAllFolders') : i18nText('jsxCollapseAllFolders')} className="px-1 text-ui-sm text-faint-foreground hover:text-foreground" onClick={toggleAll} />
      </div>
      <div className={collectionOpen ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      {/* 손볼 것이 있으면 목록 위에 모아 말한다.
          점만 찍어 두면 수백 줄 중에서 눈으로 찾아야 하고, 결국 안 찾는다. */}
      {/* 표시를 받고 나서만 그린다. 빈 자리를 미리 잡아 두면 표시가 없을 때 빈 줄이
          잠깐 보였다 사라져서 반대 방향으로 또 튄다. */}
      {flagsLoaded && (flags.failed.size > 0 || changedIds.length > 0) && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border/70 bg-surface-2/40 px-2.5 py-1.5 text-ui-sm">
          {flags.failed.size > 0 && (
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-method-delete" />
              {i18nText('uiRecentFailure')} {flags.failed.size}
              <ToolButton icon="clear" type="button" aria-label={i18nText('uiClearRecentFailureNotifications')} title={i18nText('uiClearsOnlyTheCurrentFailureNotificationExecutionHistoryIs')} className="ml-1 rounded-[var(--radius-sm)] border border-border px-2 py-0.5 text-ui-sm hover:text-foreground" onClick={() => {
                const key = `ah:failed-dismissed:${workspaceId}`
                const dismissed = readJson<Record<string, number>>(key, {})
                for (const id of flags.failed) if (flags.latest?.[id]) dismissed[id] = flags.latest[id]
                writeJson(key, dismissed)
                setFlags(f => ({ ...f, failed: new Set() }))
                setOnlyFlagged(false)
              }} />
            </span>
          )}
          {changedIds.length > 0 && (
            <span className="text-muted-foreground">{i18nText('uiSpecificationChange')} {changedIds.length}</span>
          )}
          <ToolButton icon="alert" aria-label={onlyFlagged ? i18nText('jsxSeeAll2') : i18nText('jsxSeeOnlyProblems')}
            type="button"
            aria-pressed={onlyFlagged}
            className={`ml-auto rounded-[var(--radius-sm)] border px-2 py-0.5 font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
              onlyFlagged ? 'border-accent/60 bg-accent/10 text-accent' : 'border-border text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setOnlyFlagged(v => !v)}
           />
          {changedIds.length > 0 && (
            <ToolButton icon="check" aria-label={i18nText('uiCheckAll')}
              type="button"
              disabled={acking}
              title={i18nText('uiMarkAllSpecChangesAsSeenLeaveTheOnes')}
              className="rounded-[var(--radius-sm)] border border-border px-2 py-0.5 font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              onClick={async () => {
                setAcking(true)
                try {
                  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/ack-spec`, {
                    method: 'POST', body: JSON.stringify({ requestIds: changedIds }),
                  })
                  if (!res.ok) { toast('error', i18nText('dynamicVerificationProcessingFailed', { v0: String(res.status) })); return }
                  const { acked } = await res.json() as { acked: number }
                  toast('success', i18nText('dynamicSpecificationChangeHasBeenConfirmedAndProcessed', { v0: String(acked) }))
                  // 트리와 표시를 같이 다시 읽는다 — 배지는 트리 행에서, 요약 바는 표시에서 온다.
                  reload()
                  setFlags(f => ({ ...f, spec: Object.fromEntries(
                    Object.entries(f.spec).filter(([, v]) => v !== 'changed')) }))
                } catch (e) {
                  toast('error', i18nText('dynamicOKProcessingFailed', { v0: String(errorText(e)) }))
                } finally { setAcking(false) }
              }}
             />
          )}
        </div>
      )}

      {selectMode && selectedIds.size > 0 && (
        <div className="flex items-center gap-2 border-b border-border bg-accent/5 px-2.5 py-1.5 text-ui-md">
          <span className="font-semibold text-foreground">{selectedIds.size}{i18nText('uiSelectedCountSuffix')}</span>
          <select
            aria-label={i18nText('uiFolderToMove')}
            className="rounded-[var(--radius-sm)] border border-border bg-surface px-1.5 py-1 text-ui-sm text-muted-foreground outline-none focus-visible:border-accent"
            defaultValue=""
            onChange={e => { bulkMove(e.target.value); e.target.value = '' }}
          >
            <option value="" disabled>{i18nText('uiMove2')}</option>
            {foldersList.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <button type="button" className="ah-action rounded-[var(--radius-sm)] border border-method-delete/40 px-2 py-1 text-ui-sm font-medium text-method-delete hover:bg-method-delete/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" onClick={bulkDelete}>{i18nText('uiDelete')}</button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1 text-ui-md">
        {openForm === 'folder' && (
          <FolderForm key={folderFormUrl ? 'url' : 'plain'} withUrl={folderFormUrl} onSubmit={addFolder} onCancel={() => { setOpenForm(null); setFolderFormUrl(false) }} />
        )}
        {/* 다른 화면과 같은 문구·같은 모양으로 — '못 불러온 것' 과 '비어 있는 것' 은
            바로 아래 '아직 비어 있습니다' 와 헷갈리면 안 되는 다른 상태다 */}
        {!loaded && loadError && (
          <LoadFailed what={i18nText('uiFolderList')} detail={loadError} onRetry={() => reload()} />
        )}
        {!loaded && !loadError && (
          <p className="px-2 py-6 text-center text-ui-md text-faint-foreground">{i18nText('uiLoading')}</p>
        )}
        {loaded && foldersList.length === 0 && openForm !== 'folder' && (
          <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
            <p className="text-ui-lg font-medium text-foreground">{i18nText('uiItSStillEmpty')}</p>
            {/* 1순위는 '요청 하나 만들기' 다. 폴더는 나중에 묶을 때 만들어도 된다 —
                [+ 새 요청] 은 폴더가 없으면 '내 요청' 폴더를 알아서 만든다.
                가져오기는 같은 높이의 테두리 버튼으로 낮췄다(두 개의 채운 버튼이 경쟁했다). */}
            <p className="max-w-[250px] text-ui-md leading-relaxed text-faint-foreground">
              {i18nText('uiCreateARequestOrImportAFile')}
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                disabled={starting}
                className="h-8 rounded-[var(--radius-sm)] bg-accent-solid px-4 text-ui-md font-semibold text-accent-solid-foreground transition-colors hover:bg-accent-solid-hover disabled:opacity-50"
                onClick={startBlank}
              >
                {starting ? i18nText('jsxMaking') : i18nText('jsxNewRequest')}
              </button>
              <ImportButton workspaceId={workspaceId} onImported={reload} big />
            </div>
            <p className="max-w-[250px] text-ui-sm leading-relaxed text-faint-foreground">
              {i18nText('uiFilesYouCanImport')} {IMPORT_FORMATS}
            </p>
            <div className="flex flex-wrap justify-center gap-3 text-ui-sm">
              <button className="text-muted-foreground hover:text-foreground" onClick={() => setOpenForm('folder')}>{i18nText('uiCreateFolder')}</button>
              <button className="text-muted-foreground hover:text-foreground" onClick={() => { setFolderFormUrl(true); setOpenForm('folder') }}>{i18nText('uiCreateFolderWithOpenAPIAddress')}</button>
            </div>
          </div>
        )}
        {/* 예전엔 검색어일 때만 이 안내가 떴다. 메서드나 태그로 좁혀 0건이 되면 트리가
            그냥 텅 빈 채로 남아서, 고장인지 정말 없는 건지 알 수 없었다. */}
        {loaded && foldersList.length > 0 && filtering && !foldersList.some(f => (reqs[f.id] ?? []).some(match)) && (
          <p className="px-2 py-4 text-ui-md leading-relaxed text-faint-foreground">
            {filterLabel}{i18nText('uiThereAreNoMatchingRequests')}
            <button
              type="button"
              className="ml-1 rounded-[var(--radius-sm)] px-1 text-accent underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              onClick={() => { setQ(''); setMethodFilter(''); setTagFilter('') }}
            >
              {i18nText('uiClearConditions')}
            </button>
          </p>
        )}
        {/* 즐겨찾기 — 등록한 순서대로 트리 맨 위에. 폴더를 접어 두거나 검색 중이어도
            여기서는 늘 보인다(그게 즐겨찾기를 만든 이유다). */}
        {(() => {
          const all = foldersList.flatMap(f => (reqs[f.id] ?? []).map(r => ({ r, folder: f })))
          const byId = new Map(all.map(x => [x.r.id, x]))
          const picked = favRequests.favorites.map(id => byId.get(id)).filter(Boolean) as typeof all
          const shown = picked.filter(({ r }) => match(r))
          if (shown.length === 0) return null
          return (
            <div className="mb-2 border-b border-border pb-1.5">
              <p className="px-1.5 pb-1 ah-label">{i18nText('uiFavorites')} {shown.length}</p>
              {shown.map(({ r, folder }) => renderFavoriteRow(r, folder.name))}
            </div>
          )
        })()}
        {shownFolders.map((f, fi) => (
          <div key={f.id} className="mb-0.5">
            <div
              draggable={canReorder && !selectMode}
              onDragStart={e => {
                e.stopPropagation()
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData(FOLDER_TYPE, JSON.stringify({ id: f.id, name: f.name }))
                e.dataTransfer.setData('text/plain', f.name)
              }}
              onDragEnd={clearDrag}
              className={`group relative flex items-center justify-between gap-1 rounded-[var(--radius-sm)] px-1.5 py-0.5 ${
                dropFolder === f.id ? 'bg-accent/15 outline outline-1 outline-accent' : ''
              } ${lineAt('folder', f.id)}`}
              onDragOver={e => {
                // preventDefault 를 안 하면 브라우저가 드롭을 거부한다(원인 없이 '안 되는' 것처럼 보인다)
                const types = e.dataTransfer.types
                if (types.includes(FOLDER_TYPE)) {
                  e.preventDefault(); e.dataTransfer.dropEffect = 'move'
                  setDropFolder(null)
                  setDropAt({ kind: 'folder', beforeId: halfOf(e, f.id, shownFolders[fi + 1]?.id ?? null) })
                  return
                }
                if (!types.includes(REQ_TYPE)) return
                // 폴더 이름 위에 놓으면 그 폴더의 맨 뒤로. 같은 폴더면 할 일이 없다.
                if (dragReq?.folderId === f.id) return
                e.preventDefault(); e.dataTransfer.dropEffect = 'move'
                setDropAt(null); setDropFolder(f.id)
              }}
              onDragLeave={() => { setDropFolder(c => (c === f.id ? null : c)) }}
              onDrop={e => {
                e.preventDefault()
                const fold = e.dataTransfer.getData(FOLDER_TYPE)
                const req = e.dataTransfer.getData(REQ_TYPE)
                // 요청 행과 같은 이유로 이벤트에서 다시 계산한다(위 주석 참고)
                const before = halfOf(e, f.id, shownFolders[fi + 1]?.id ?? null)
                clearDrag()
                try {
                  if (fold) {
                    const d = JSON.parse(fold) as { id: string; name: string }
                    if (d.id !== before) moveFolder(d.id, d.name, before)
                    return
                  }
                  if (!req) return
                  const r = JSON.parse(req) as { id: string; name: string; folderId: string }
                  moveRequest(r, f.id, null)
                } catch { /* 다른 곳에서 끌어온 것 — 무시 */ }
              }}
            >
              <ToolButton icon={filtering || !collapsed.has(f.id) ? "chevronDown" : "chevronRight"} type="button" aria-label={i18nText('dynamicFolder', { v0: String(collapsed.has(f.id) ? i18nText('jsxExpand') : i18nText('jsxFold')), v1: String(f.name) })} aria-expanded={!collapsed.has(f.id)} className="flex h-7 w-8 shrink-0 items-center justify-center" onClick={() => toggleFolder(f.id)} />
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                onClick={() => onFolderSelect?.(f)}
              >
                <IconFolder />
                <span className="truncate text-ui-lg font-semibold text-foreground" title={f.name}>{f.name}</span>
                <span className="shrink-0 text-ui-meta text-faint-foreground">{(reqs[f.id] ?? []).length}</span>
              </button>
              {/* 폴더 액션. 아이콘 6개가 304px 행에서 172px 을 덮어 폴더 이름이 그만큼
                  잘렸고, 열쇠·톱니 같은 아이콘은 눌러 보기 전엔 무엇인지 알 수 없었다.
                  매번 쓰는 둘(요청 추가·동기화)만 남기고 나머지는 ⋯ 안에 글자로 적는다.
                  hidden 이 아니라 opacity 로 감추는 이유는 자리를 미리 잡아 두어야
                  hover 때 이름이 흔들리지 않기 때문이다.

                  has-[[role=menu]] 는 ⋯ 메뉴가 열려 있는 동안 바를 붙잡아 두는 것이다.
                  메뉴는 이 바 안에 그려지는데 바가 행 hover 에 묶여 있어서, ⋯ 버튼 아래
                  3.5px(mt-1) 띠를 지나는 순간 hover 가 풀려 메뉴째로 투명해졌다. 그 띠에서
                  잡히는 것은 폴더 행도 메뉴도 아닌 아래쪽 요청 행이다. Chrome 은
                  focus-within 이 대신 버텨 줘서 안 드러나지만, 버튼 클릭에 포커스를 주지
                  않는 엔진에서는 그대로 사라진다. 열린 메뉴는 hover·focus 와 무관하게
                  보여야 한다. */}
              <span className="absolute right-1.5 flex items-center gap-1 rounded-[var(--radius-sm)] bg-surface-2 px-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 has-[[role=menu]]:opacity-100">
                {f.specSourceType === 'url' && (
                  <ToolButton icon="refresh"
                    title={i18nText('uiRefreshSpecs')}
                    aria-label={i18nText('dynamicSpecSynchronization', { v0: String(f.name) })}
                    className="flex h-6 gap-1 px-1 text-ui-sm items-center justify-center rounded-[var(--radius-sm)] text-faint-foreground transition-colors hover:bg-surface-2 hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:opacity-50"
                    onClick={() => syncFolder(f.id)}
                    disabled={syncing === f.id}
                   />
                )}
                <ToolButton icon="plus"
                  title={i18nText('uiAddRequest')}
                  aria-label={i18nText('dynamicAddRequestTo', { v0: String(f.name) })}
                  className="flex h-6 gap-1 px-1 text-ui-sm items-center justify-center rounded-[var(--radius-sm)] text-faint-foreground transition-colors hover:bg-surface-2 hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                  onClick={() => setOpenForm(openForm === f.id ? null : f.id)}
                 />
                <RowMenu
                  label={i18nText('dynamicWorkingWithFolder', { v0: String(f.name) })}
                  items={[
                    { label: i18nText('jsxChangeName'), onClick: () => setOpenForm(openForm === `rename:${f.id}` ? null : `rename:${f.id}`) },
                    {
                      label: i18nText('jsxCommonHeader'),
                      hint: f.sharedHeaders.length > 0 ? i18nText('dynamicSetAppliesToSubrequests', { v0: String(f.sharedHeaders.length) }) : i18nText('jsxAutomaticallyAppliedToAllChildRequests'),
                      onClick: () => { setSharedAuthFor(null); setSharedHeadersFor(sharedHeadersFor === f.id ? null : f.id) },
                    },
                    {
                      label: i18nText('jsxCommonAuthentication'),
                      hint: f.sharedAuth && f.sharedAuth.type !== 'none' ? AUTH_LABEL[f.sharedAuth.type] : i18nText('jsxAppliesToRequestsWithAuthenticationSetToInherited'),
                      onClick: () => { setSharedHeadersFor(null); setSharedAuthFor(sharedAuthFor === f.id ? null : f.id) },
                    },
                    {
                      label: i18nText('jsxBatchExecution'),
                      hint: `요청 ${(reqs[f.id] ?? []).length}개를 순서대로 — 스모크/회귀`,
                      onClick: () => setRunFolder(f),
                    },
                    {
                      label: i18nText('jsxExportToOpenAPI'),
                      hint: i18nText('jsxOpenAPI30FileWithoutCredentialValues'),
                      onClick: () => { const link = document.createElement('a'); link.href = `/api/folders/${f.id}/openapi`; link.download = ''; link.click() },
                    },
                    {
                      label: i18nText('jsxDeleteFolder'),
                      danger: true,
                      hint: `요청 ${(reqs[f.id] ?? []).length}개와 실행 이력까지`,
                      confirm: i18nText('jsxDoYouReallyWantToDeleteItCannotBe'),
                      onClick: () => removeFolder(f),
                    },
                  ]}
                />
              </span>
            </div>

            {openForm === f.id && (
              <InlineForm
                placeholder={i18nText('uiRequestNameGroupIsGroupName')}
                onSubmit={name => addRequest(f.id, name)}
                onCancel={() => setOpenForm(null)}
              />
            )}

            {openForm === `rename:${f.id}` && (
              <InlineForm
                placeholder={i18nText('uiFolderName')}
                initial={f.name}
                submitLabel={i18nText('uiChange')}
                onSubmit={name => renameFolder(f.id, name)}
                onCancel={() => setOpenForm(null)}
              />
            )}

            {sharedHeadersFor === f.id && (
              <SharedHeadersForm
                folder={f}
                onSaved={() => { setSharedHeadersFor(null); reload() }}
                onCancel={() => setSharedHeadersFor(null)}
              />
            )}

            {sharedAuthFor === f.id && (
              <SharedAuthForm
                folder={f}
                onSaved={() => { setSharedAuthFor(null); reload() }}
                onCancel={() => setSharedAuthFor(null)}
              />
            )}

            {/* 좁히는 중이면 접힘을 무시하고 걸린 것을 다 보여준다. 예전엔 검색어일 때만
                그랬다 — 메서드·태그·'문제만 보기' 로 좁히면 접힌 폴더 안의 결과가 안 보였다. */}
            {/* 요청이 0개인 폴더 — [+] 는 마우스를 올려야 보여서, 폴더를 막 만든 사람은
                다음에 무엇을 할지 찾지 못했다. 빈 폴더 아래에 늘 보이는 길을 둔다. */}
            {!filtering && !collapsed.has(f.id) && (reqs[f.id] ?? []).length === 0 && openForm !== f.id && (
              <p className="flex items-center gap-1 py-1 pl-7 pr-1.5 text-ui-sm text-faint-foreground">
                {i18nText('uiThereAreNoRequestsInThisFolder')}
                <button
                  type="button"
                  className="rounded-[var(--radius-sm)] px-1 font-medium text-accent underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                  onClick={() => setOpenForm(f.id)}
                >
                  {i18nText('uiAddRequest2')}
                </button>
              </p>
            )}
            {(filtering || !collapsed.has(f.id)) && (() => {
            const visible = sortReqs((reqs[f.id] ?? []).filter(match))
            const buckets = groupRequests(visible)
            // 화면에 그려지는 차례 그대로 — 그룹이 있으면 목록 순서와 다르다.
            // '이 행 다음' 을 물을 때는 사용자가 실제로 본 다음 행이어야 한다.
            const flat = buckets.flatMap(b => b.items)
            const nextIdOf = (id: string) => {
              const i = flat.findIndex(x => x.id === id)
              return i < 0 || i + 1 >= flat.length ? null : flat[i + 1].id
            }
            return buckets.map(bucket => {
              const groupKey = bucket.group === null ? null : `${f.id}|${bucket.group}`
              // 메서드·태그·'문제만' 필터도 검색처럼 펼친다 — 접힌 그룹 안에 결과가 숨어 '없다' 로 읽혔다.
              const groupOpen = filtering || (groupKey !== null && expandedGroups.has(groupKey))
              const renderRow = (r: RequestRow, padClass: string, label: string) => {
                const active = selectedId === r.id
                const checked = selectedIds.has(r.id)
                return (
                  <div
                    key={r.id}
                    data-req-id={r.id}
                    role="button"
                    tabIndex={0}
                    title={r.name}
                    draggable={!selectMode}
                    onDragStart={e => {
                      setDragReq(r)
                      e.dataTransfer.effectAllowed = 'move'
                      // 커스텀 타입은 dragover 에서도 types 로 확인할 수 있다(값은 drop 때만 읽힌다)
                      e.dataTransfer.setData(REQ_TYPE, JSON.stringify({ id: r.id, name: r.name, folderId: r.folderId }))
                      e.dataTransfer.setData('text/plain', r.name)
                    }}
                    onDragEnd={clearDrag}
                    onDragOver={e => {
                      if (!canReorder || !e.dataTransfer.types.includes(REQ_TYPE)) return
                      e.preventDefault(); e.dataTransfer.dropEffect = 'move'
                      setDropFolder(null)
                      setDropAt({ kind: 'req', folderId: f.id, beforeId: halfOf(e, r.id, nextIdOf(r.id)) })
                    }}
                    onDrop={e => {
                      e.preventDefault(); e.stopPropagation()
                      const raw = e.dataTransfer.getData(REQ_TYPE)
                      // 자리는 이 이벤트에서 다시 계산한다. dropAt(상태) 를 읽으면 빠르게 놓았을 때
                      // onDragOver 의 setState 가 아직 반영되지 않아 null 을 보고 폴더 맨 뒤로 보낸다
                      // — 한 칸 어긋난 것도 아니고 목록 끝으로 날아간다. 실측으로 잡았다.
                      const before = canReorder ? halfOf(e, r.id, nextIdOf(r.id)) : null
                      clearDrag()
                      try {
                        if (!raw) return
                        const d = JSON.parse(raw) as { id: string; name: string; folderId: string }
                        if (d.id !== before) moveRequest(d, f.id, before)
                      } catch { /* 다른 곳에서 끌어온 것 — 무시 */ }
                    }}
                    className={i18nText('dynamicGroupRelativeFlexWFullItemsCenterGap22', { v0: String(padClass), v1: String(lineAt('req', r.id, f.id)), v2: String(selectMode && checked ? 'border-accent bg-accent/15 text-foreground' : active ? 'border-accent bg-accent/15 text-foreground' : 'text-foreground hover:bg-surface-2') })}
                    onClick={() => (selectMode ? toggleSelected(r.id) : onSelect(r))}
                    onDoubleClick={() => { if (!selectMode) onSelect(r, true) }}
                    onKeyDown={e => { if (e.target !== e.currentTarget) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectMode ? toggleSelected(r.id) : onSelect(r) } }}
                  >
                    {selectMode && (
                      <input type="checkbox" readOnly checked={checked} className="shrink-0" aria-label={i18nText('dynamicSelect', { v0: String(r.name) })} />
                    )}
                    <span
                      className={`w-[42px] shrink-0 font-mono text-ui-meta font-bold ${methodText(r.method)}`}
                    >
                      {r.method}
                    </span>
                    <span className={`min-w-0 flex-1 truncate text-ui-lg ${r.specState === 'deprecated' ? 'text-faint-foreground line-through' : active ? 'text-foreground' : ''}`}>
                      {label}
                    </span>
                    {/* 최근에 깨진 요청 — 목록을 훑을 때 '어느 게 문제인지' 가 보여야 한다.
                        예전엔 하나씩 열어 봐야 알았다. 빨간 점 하나면 충분하다. */}
                    {/* 행 버튼 안이라 이 라벨이 행 이름 뒤에 붙어 읽힌다.
                        'GET 주문 생성, 최근 실패' 정도면 되고, 긴 문장은 title 로. */}
                    {flags.failed.has(r.id) && (
                      <span
                        aria-label={i18nText('uiRecentFailure')}
                        title={i18nText('uiThereAreFailedRunsInTheLast24Hours')}
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-method-delete"
                      />
                    )}
                    {r.specState && r.specState !== 'synced' && r.specState !== 'new' && (
                      <span className={`shrink-0 rounded-[var(--radius-sm)] px-1 py-[1px] text-ui-meta font-bold tracking-wide ${BADGE[r.specState]}`}>
                        {r.specState.toUpperCase()}
                      </span>
                    )}
                    {/* 복제·삭제는 연 요청에만 있었다 — 복제하려면 먼저 열어야 했다(codex 점검).
                        이제 행에 마우스를 올리거나 포커스가 가면 나온다. 연 요청에서는 늘 보인다. */}
                    {!selectMode && (
                      <span className="ah-row-actions ml-auto shrink-0">
                        <RowMenu compact label={i18nText('dynamicRequestAction', { v0: String(r.name) })} items={[
                          { label: favRequests.isFavorite(r.id) ? i18nText('jsxUnfavorite') : i18nText('jsxAddToFavorites'), onClick: () => favRequests.toggle(r.id) },
                          { label: i18nText('jsxCopyCURL'), onClick: () => onCopyCurl?.(r) },
                          { label: i18nText('jsxRequestReplication'), onClick: () => { void duplicate(r) } },
                          { label: i18nText('jsxDeleteRequest'), danger: true, confirm: i18nText('jsxDeletionConfirmedHistoryWillAlsoBeDeleted'), onClick: () => { void remove(r) } },
                        ]} />
                      </span>
                    )}
                  </div>
                )
              }

              if (bucket.group === null) {
                return <div key={groupKey} className="relative before:pointer-events-none before:absolute before:bottom-0 before:left-[15px] before:top-0 before:border-l before:border-border">{bucket.items.map(r => renderRow(r, 'pl-6', r.name))}</div>
              }
              return (
                <div key={groupKey}>
                  <TooltipButton
                    type="button"
                    className="flex w-full items-center gap-1.5 rounded-[var(--radius-sm)] py-1 pl-5 pr-2 text-left transition-colors hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                    aria-expanded={groupOpen}
                    onClick={() => toggleGroup(f.id, bucket.group!)}
                  >
                    <IconChevron open={groupOpen} />
                    <IconFolder />
                    <span className="min-w-0 flex-1 truncate text-ui-md font-medium text-foreground" title={bucket.group}>
                      {bucket.group}
                    </span>
                    <span className="shrink-0 text-ui-meta text-faint-foreground">{bucket.items.length}</span>
                  </TooltipButton>
                  {groupOpen && <div className="relative before:pointer-events-none before:absolute before:bottom-0 before:left-7 before:top-0 before:border-l before:border-border">{bucket.items.map(r => renderRow(r, 'pl-8', displayName(r.name)))}</div>}
                </div>
              )
            })
            })()}
          </div>
        ))}

      </div>
      </div>
      {runFolder && (
        <CollectionRunModal folder={{ id: runFolder.id, name: runFolder.name }} workspaceId={workspaceId} onClose={() => setRunFolder(null)} />
      )}
    </div>
  )
}
