'use client'
import { t as i18nText } from '@/i18n'
import { ToolButton } from '@/components/ToolButton'
import dynamic from 'next/dynamic'
import { VariableEditContext } from '@/components/VariablePopover'
import { ModalFrame, ModalHeader } from '@/components/ModalFrame'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppHeader } from '@/components/AppHeader'
import type { SettingsTab } from '@/components/SettingsDialog'
const SettingsDialog = dynamic(() => import('@/components/SettingsDialog').then(m => m.SettingsDialog), { loading: () => <PanelLoading /> })
import { LeftRail, type WorkMode } from '@/components/LeftRail'
import { FolderOverview } from '@/components/FolderOverview'
import { SidebarSection } from '@/components/SidebarSection'
const EnvironmentModal = dynamic(() => import('@/components/EnvironmentModal').then(m => m.EnvironmentModal), { loading: () => <PanelLoading /> })
const CookieSidebar = dynamic(() => import('@/components/CookieManager').then(m => m.CookieSidebar), { loading: () => <PanelLoading /> })
const CookieManager = dynamic(() => import('@/components/CookieManager').then(m => m.CookieManager), { loading: () => <PanelLoading /> })
import { FolderTree } from '@/components/FolderTree'
import { ExportButton, ImportButton } from '@/components/ImportButton'
import { RequestTabs, FocusToggle } from '@/components/RequestTabs'
import { RequestPanel } from '@/components/RequestPanel'
const HistoryPanel = dynamic(() => import('@/components/HistoryPanel').then(m => m.HistoryPanel), { loading: () => <PanelLoading /> })
import { CommandPalette, type PaletteAction } from '@/components/CommandPalette'
const ShortcutHelp = dynamic(() => import('@/components/ShortcutHelp').then(m => m.ShortcutHelp), { loading: () => <PanelLoading /> })
const FlowScenario = dynamic(() => import('@/components/FlowScenario').then(m => m.FlowScenario), { loading: () => <PanelLoading /> })
import { GlobalHistory } from '@/components/GlobalHistory'
const CollectionDocs = dynamic(() => import('@/components/CollectionDocs').then(m => m.CollectionDocs), { loading: () => <PanelLoading /> })
const ScheduleManager = dynamic(() => import('@/components/ScheduleManager').then(m => m.ScheduleManager), { loading: () => <PanelLoading /> })
const RealtimePanel = dynamic(() => import('@/components/RealtimePanel').then(m => m.RealtimePanel), { loading: () => <PanelLoading /> })
import { ToastProvider, toastOutside } from '@/components/Toast'
import { WorkspaceSwitcher } from '@/components/WorkspaceSwitcher'
import { RightPanel, type LiveRequest, type RightTab } from '@/components/RightPanel'
import { StatusBar } from '@/components/StatusBar'
const ConsoleDrawer = dynamic(() => import('@/components/ConsoleDrawer').then(m => m.ConsoleDrawer), { loading: () => <PanelLoading /> })
import { useResizable } from '@/lib/useResizable'
import { KEYS, scoped, readJson, writeJson, read, readFlag, write, writeFlag } from '@/lib/localStore'
import { ResumeWorkspace } from '@/components/ResumeWorkspace'
import { restoreTabs } from '@/lib/resumeWorkspace'
import { setThemePref } from '@/lib/theme'
import { errorText, fetchArray } from '@/lib/fetchJson'
import { createStarterRequest, focusUrlWhenOpened } from '@/lib/starterRequest'
import type { StartActions } from '@/components/StartGuide'
import type { FolderRow, EnvironmentRow, ExecutionRow, RequestRow } from '@/lib/ui-types'
import { useT, type TranslationKey } from '@/i18n'

/**
 * 좌측 레일 순서 = ⌘1~5 순서 = 팔레트 뷰 명령 순서. 한 곳에서 관리.
 *
 * 여기 있는 것은 전부 '보고 다루는 화면' 이다. 설정하고 닫는 것(환경/변수·쿠키·
 * AI 연결·표시)은 [설정] 다이얼로그로 옮겼다 — 성격이 다른 둘을
 * 같은 목록에 두니 매일 쓰는 화면이 밀렸고, 그걸 [더보기] 로 접었더니 이번엔
 * 지금 어디 있는지가 안 보였다.
 */
function PanelLoading() { const tr = useT(); return <div role="status" className="p-4 text-ui-sm text-muted-foreground">{tr('loadingPanel')}</div> }

const VIEW_MODES: { mode: WorkMode; label: TranslationKey }[] = [
  { mode: 'collection', label: 'collection' },
  { mode: 'scenario', label: 'scenario' }, { mode: 'history', label: 'history' },
  // 레일(LeftRail)과 같은 말을 쓴다 — ⌘K 로 찾는 이름과 레일에 적힌 이름이 같아야 한다.
  { mode: 'schedule', label: 'schedule' },
  { mode: 'ws', label: 'realtime' },
]

function ResizeHandleH({ label, onDrag }: { label: string; onDrag: (e: React.MouseEvent) => void }) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={i18nText('dynamicDrag', { v0: String(label) })}
      className="group relative flex w-2.5 shrink-0 items-center justify-center cursor-col-resize select-none"
      onMouseDown={onDrag}
    >
      {/* 가는 경계선 + 가운데 세로 그립 — 응답 높이 핸들과 같은 어피던스로 '잡을 곳'이 보이게 한다 */}
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-accent/50" />
      <div className="relative h-9 w-1 rounded-full bg-border-strong transition-all group-hover:h-14 group-hover:bg-accent group-active:bg-accent" />
    </div>
  )
}

/** 기록 한 칸을 가르는 '화면' — 요청·문서 보기는 컬렉션에서만 화면을 가른다. */
function screenKey(mode: WorkMode, activeId: string | null, docs: boolean): string {
  return mode === 'collection' ? `collection|${activeId ?? ''}|${docs ? 1 : 0}` : mode
}

export default function Home() {
  const tr = useT()
  const [narrow, setNarrow] = useState(false)
  useEffect(() => { const mq = window.matchMedia('(max-width: 767px)'); const sync = () => setNarrow(mq.matches); sync(); mq.addEventListener('change', sync); return () => mq.removeEventListener('change', sync) }, [])
  const [selectedFolder, setSelectedFolder] = useState<FolderRow | null>(null)
  const [draftMethods, setDraftMethods] = useState<Record<string, string>>({})
  const [previewId, setPreviewId] = useState<string | null>(null)
  const previewRef = useRef<string | null>(null)
  const pinPreview = (id: string) => { if (previewRef.current === id) { previewRef.current = null; setPreviewId(null) } }
  const openSequence = useRef(0)
  const [liveRequest, setLiveRequest] = useState<LiveRequest | null>(null)
  const [rightTab, setRightTab] = useState<RightTab | null>(null)
  const [layoutReady, setLayoutReady] = useState(false)
  const [sidebarSections, setSidebarSections] = useState<Record<string, boolean>>({})
  useEffect(() => {
    const stored = read(KEYS.rightTab)
    if (stored && ['code', 'variables'].includes(stored)) setRightTab(stored as RightTab)
    setSidebarSections(readJson(KEYS.sidebarSections, {})); setLayoutReady(true)
  }, [])
  useEffect(() => { if (layoutReady) write(KEYS.rightTab, rightTab ?? '') }, [rightTab, layoutReady])
  const sectionToggle = (name: string, open: boolean) => setSidebarSections(previous => {
    if (previous[name] === open) return previous
    const next = { ...previous, [name]: open }; writeJson(KEYS.sidebarSections, next); return next
  })
  const [activeUtility, setActiveUtility] = useState<string | null>(null)
  const [utilityTabs, setUtilityTabs] = useState<{ id: string; label: string; kind: 'env' | 'cookies'; envId?: string; domain?: string }[]>([])
  const [utilityDirty, setUtilityDirty] = useState<Record<string, number>>({})
  const utilityDirtyRef = useRef(utilityDirty)
  utilityDirtyRef.current = utilityDirty
  const [visitedModes, setVisitedModes] = useState<WorkMode[]>([])
  const [mode, setModeState] = useState<WorkMode>('collection')
  const setMode = useCallback((next: WorkMode) => { setActiveUtility(null); setModeState(next) }, [])
  const openUtility = (kind: 'env' | 'cookies', envId?: string, label?: string, domain?: string) => {
    const id = kind === 'env' ? `env:${envId ?? 'manage'}` : `cookies:${domain ?? 'all'}`
    setUtilityTabs(tabs => tabs.some(t => t.id === id) ? tabs : [...tabs, { id, kind, envId, domain, label: label ?? (kind === 'env' ? i18nText('dynamicEnvironmentVariables') : i18nText('dynamicCookies')) }])
    setMode('collection'); setActiveUtility(id)
  }
  useEffect(() => {
    if (mode !== 'collection') setVisitedModes(previous => previous.includes(mode) ? previous : [...previous, mode])
    if (mode === 'scenario' || mode === 'schedule') sectionToggle(mode, true)
  }, [mode])
  // 실시간 화면을 한 번이라도 열었는지 — 열었으면 계속 붙들어 둔다(연결·기록 유지)
  const [realtimeVisited, setRealtimeVisited] = useState(false)
  useEffect(() => { if (mode === 'ws') setRealtimeVisited(true) }, [mode])
  const modeRef = useRef(mode)
  modeRef.current = mode
  const [locationReady, setLocationReady] = useState(false)

  // 프로젝트(워크스페이스) — 모든 목록/생성의 최상위 스코프. localStorage 유지.
  const saveHandlers = useRef(new Map<string, () => Promise<boolean>>())
  const [pendingLeave, setPendingLeave] = useState<{ kind: 'workspace' | 'tab'; id: string } | null>(null)
  const [leaveSaving, setLeaveSaving] = useState(false)
  const [workspaceId, setWorkspaceId] = useState('default')
  useEffect(() => {
    const stored = read(KEYS.workspace)
    if (stored) setWorkspaceId(stored)
  }, [])
  const switchWorkspace = (id: string) => {
    if (id === (read(KEYS.workspace) ?? 'default')) return
    if (Object.values(dirtyRef.current).some(Boolean) || Object.values(utilityDirtyRef.current).some(Boolean)) {
      setPendingLeave({ kind: 'workspace', id }); return
    }
    performWorkspaceSwitch(id)
  }
  const performWorkspaceSwitch = (id: string) => {
    setSelectedFolder(null)
    setWorkspaceId(id)
    write(KEYS.workspace, id)
    // 프로젝트가 바뀌면 열린 탭/선택/환경은 그 프로젝트 소속이 아니므로 초기화
    // 환경 목록도 비운다 — loadEnvs 는 실패해도 이전 목록을 유지하므로(중복 생성 방지),
    // 프로젝트를 바꿀 때 여기서 안 비우면 남의 프로젝트 환경이 잠시 보인다.
    setTabs([]); setActiveId(null); setRestore(null); setEnvironmentId(null); setDirty({}); setEnvironments([])
    setReloadKey(v => v + 1)
  }
  const [tabs, setTabs] = useState<RequestRow[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  // 단축키 핸들러는 한 번만 붙는다 — 최신 탭·활성 탭·화면은 ref 로 읽는다.
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  const [dirty, setDirty] = useState<Record<string, boolean>>({})
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const [environments, setEnvironments] = useState<EnvironmentRow[]>([])
  const [environmentId, setEnvironmentId] = useState<string | null>(null)
  const [restore, setRestore] = useState<ExecutionRow | null>(null)
  const [historyVersion, setHistoryVersion] = useState(0)
  const [treeVersion, setTreeVersion] = useState(0)
  const onTreeReloaded = useCallback(() => setTreeVersion(v => v + 1), [])
  // 설정은 하나의 다이얼로그다. 어느 칸을 열지만 정한다 — null 이면 닫힘.
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null)
  // 설정·스케줄 안쪽에서 다른 화면으로 보내는 길(예: 스케줄의 [시나리오 만들기]·[실행 기록]).
  // 그 컴포넌트들은 화면 전환 함수를 들고 있지 않다 — 이름이 정해진 화면만 받는다.
  // detail 은 'scenario' 또는 { mode: 'scenario', flowId } — flowId 가 있으면 그 시나리오를 연다.
  useEffect(() => {
    const go = (e: Event) => {
      const detail = (e as CustomEvent<WorkMode | { mode: WorkMode; flowId?: string }>).detail
      const target = typeof detail === 'string' ? detail : detail?.mode
      if (target !== 'scenario') return
      const flowId = typeof detail === 'object' ? detail.flowId : undefined
      if (flowId) setInitialFlowId(flowId)
      setSettingsTab(null); setMode(target)
    }
    window.addEventListener('ah:goto-mode', go)
    return () => window.removeEventListener('ah:goto-mode', go)
  }, [])
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  // 하단 콘솔 — 실행 이력과 같은 데이터를 '화면을 안 떠나고' 까보는 자리(devtools Network 상당)
  const [consoleOpen, setConsoleOpen] = useState(false)
  // 상태바에 쓸 프로젝트 이름 — 이름이 없으면 id(UUID)가 그대로 노출된다.
  // 'default' 일 땐 이름처럼 보여서 드러나지 않았다.
  const [workspaceName, setWorkspaceName] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    fetch('/api/workspaces').then(r => r.json())
      .then((list: { id: string; name?: string }[]) => {
        if (alive) setWorkspaceName(list.find(w => w.id === workspaceId)?.name ?? null)
      })
      .catch(() => { if (alive) setWorkspaceName(null) })
    return () => { alive = false }
  }, [workspaceId])
  // 컬렉션 '문서 모드' — 같은 요청을 읽기 전용 명세로 본다(구 /docs 페이지 흡수).
  const [docsMode, setDocsMode] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [copyCurlTarget, setCopyCurlTarget] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const openModeRef = useRef<(m: WorkMode) => void>(() => {})
  const [scheduleSidebar, setScheduleSidebar] = useState<HTMLDivElement | null>(null)
  const [scenarioSidebar, setScenarioSidebar] = useState<HTMLDivElement | null>(null)
  const [initialFlowId, setInitialFlowId] = useState<string | null>(null)
  // 집중 모드 — 활성 요청 탭을 전체 폭으로 펼치고 좌측 컬렉션·우측 이력을 접는다(⌘\ 또는 탭바 버튼).
  const [focusMode, setFocusMode] = useState(false)
  // 우측 이력 레일 — 기본 접힘. 좌측 레일+트리+이력이 껍데기로 758px 를 먹어
  // 정작 요청을 쓰는 가운데가 가장 좁은 칸이 돼 있었다(툴바가 3줄로 깨질 정도로).
  // 좌측 트리 단독 접기. 집중 모드(⌘\\)는 양쪽을 한꺼번에 접는데, 트리만 잠깐 치우고
  // 이력은 계속 보고 싶을 때가 있다 — 그때마다 집중 모드를 켰다 끄는 건 번거롭다.
  const [sidebarOpen, setSidebarOpen] = useState(true)
  useEffect(() => { setSidebarOpen(readFlag(KEYS.sidebarOpen, true)) }, [])
  const toggleSidebar = useCallback(() => setSidebarOpen(v => {
    const next = !v
    writeFlag(KEYS.sidebarOpen, next)
    return next
  }), [])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyVisited, setHistoryVisited] = useState(false)
  useEffect(() => { if (mode === 'history') setHistoryVisited(true) }, [mode])
  useEffect(() => { setHistoryOpen(readFlag(KEYS.historyOpen, false)) }, [])
  // ⌘B 핸들러가 마운트 시점에 한 번만 잡아 두므로 정체성이 고정돼야 한다.
  const toggleHistory = useCallback(() => setHistoryOpen(v => {
    const next = !v
    writeFlag(KEYS.historyOpen, next)
    return next
  }), [])

  // 상한을 창에 맞춘다. 460px 고정이었을 때, 긴 요청 이름이
  // ('S3 CSV 기반 대량 정책 업로드 (비동…') 잘리는데 더 넓힐 방법이 없었다.
  // 절반까지 허용하되 가운데가 없어지지 않게 480px 은 남긴다.
  const halfish = (vw: number) => Math.max(460, Math.min(Math.round(vw * 0.5), vw - 480))
  const sidebar = useResizable('ah:sidebarWidth', 320, 240, halfish)
  const historyRail = useResizable('ah:historyWidth', 288, 220, halfish)

  useEffect(() => { setUtilityTabs([]); setActiveUtility(null); setUtilityDirty({}) }, [workspaceId])
  const loadEnvs = useCallback(async () => {
    // 배열이 아닌 걸 넣으면 environments.map 이 렌더 도중 터진다 — 여기서 막는다.
    // (catch 가 아예 없어서 500 이 오면 unhandled rejection 이 나고 환경 목록이 통째로 비었다)
    //
    // 실패해도 목록을 비우지 않는다. 비우면 화면에 '환경 없음' 으로 보이고, 사용자는
    // 환경이 사라진 줄 알고 다시 만든다 — 잠깐의 통신 실패가 중복 환경을 남긴다.
    // 프로젝트를 바꿀 때는 switchWorkspace 가 먼저 비우므로 남의 목록이 남을 일은 없다.
    try {
      setEnvironments(await fetchArray<EnvironmentRow>(`/api/environments?workspaceId=${encodeURIComponent(workspaceId)}`))
    } catch { /* 이전 목록 유지 */ }
  }, [workspaceId])
  useEffect(() => { loadEnvs() }, [loadEnvs])

  // 저장 안 된 편집이 있으면 새로고침/창닫기 시 브라우저 기본 경고를 띄운다.
  useEffect(() => {
    if (!Object.values(dirty).some(Boolean) && !Object.values(utilityDirty).some(Boolean)) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty, utilityDirty])

  useEffect(() => {
    // ⌘1~5 뷰 이동(좌측 레일 순서와 동일). API 는 수백 개라 번호가 무의미해 ⌘K 검색이 담당하고,
    // 번호는 개수가 고정된 뷰에만 붙인다.
    const MODES = VIEW_MODES.map(v => v.mode)
    const onKey = async (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      if (e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); return }
      // ⌘\ : 집중 모드(사이드 패널 접기) 토글
      if (e.key === '\\') { e.preventDefault(); setFocusMode(f => !f); return }
      // ⌘B : 실행 이력 레일 토글 — macOS 앱들의 사이드바 토글과 같은 키.
      if (e.key.toLowerCase() === 'b') { e.preventDefault(); setRightTab(null); toggleHistory(); return }
      // ⌘E : 좌측 컬렉션 트리 토글 (⌘B 이력과 짝)
      if (e.key.toLowerCase() === 'e') { e.preventDefault(); toggleSidebar(); return }
      // ⌘⇧[ / ⌘⇧] : 열린 요청 탭 이전/다음 — 크롬·VS Code 와 같은 키. ⇧ 를 누르면 e.key 가 { } 가
      // 되는 자판이 있어 물리 키(e.code)로 본다. ⇧ 없는 ⌘[ ] 는 아래의 프로젝트 전환이다.
      if (e.shiftKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
        e.preventDefault()
        // 모달이 떠 있으면 뒤의 탭을 바꾸지 않는다 — 탭을 누를 때처럼 모달이 막아야 한다(codex 리뷰).
        if (document.querySelector('[aria-modal="true"]')) return
        const list = tabsRef.current
        if (modeRef.current !== 'collection' || list.length < 2) return
        const idx = Math.max(0, list.findIndex(t => t.id === activeIdRef.current))
        const step = e.code === 'BracketRight' ? 1 : list.length - 1
        setActiveId(list[(idx + step) % list.length].id); setRestore(null)   // selectTab 과 같은 동작
        return
      }
      // ⌘[ / ⌘] : 프로젝트(워크스페이스) 이전/다음 순환 — 개수 가변이라 번호 대신 순환.
      if (e.key === '[' || e.key === ']') {
        e.preventDefault()
        // catch 는 있었지만 배열인지는 안 봤다 — 500 의 {error} 가 들어오면 length 가
        // undefined 라 가드를 지나치고 findIndex 에서 터진다(단축키 핸들러라 조용히 죽는다).
        const list = await fetchArray<{ id: string }>('/api/workspaces').catch(() => [])
        if (list.length < 2) return
        const cur = read(KEYS.workspace) ?? 'default'
        const idx = Math.max(0, list.findIndex(w => w.id === cur))
        const next = list[(idx + (e.key === ']' ? 1 : list.length - 1)) % list.length]
        if (next && next.id !== cur) switchWorkspace(next.id)
        return
      }
      // ⌘1~5 : 뷰 이동
      const n = Number(e.key)
      if (Number.isInteger(n) && n >= 1 && n <= MODES.length) { e.preventDefault(); openModeRef.current(MODES[n - 1]) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 공유/실행 링크 복원: ?exec=<id>(실행 값까지) · ?req=<id>(요청 열기) · ?flow=<id>(시나리오 모드)
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search)
    const execId = sp.get('exec'), reqId = sp.get('req'), flowId = sp.get('flow')
    const clear = () => {
      const url = new URL(window.location.href)
      url.searchParams.delete('exec')
      window.history.replaceState(window.history.state, '', url)
      setLocationReady(true)
    }
    setEnvironmentId(sp.get('env') || null)
    const view = sp.get('view')
    if (view && VIEW_MODES.some(v => v.mode === view)) setMode(view as WorkMode)
    // 구 /docs 링크가 리다이렉트로 넘겨준 표식 — 컬렉션을 문서 모드로 연다.
    // 문서 보기 상태도 새로고침 시 유지한다.
    if (sp.get('docs') === '1') {
      setMode('collection'); setDocsMode(true)
      if (!execId && !reqId && !flowId) clear()
    }
    // 공유 대상이 다른 프로젝트 소속이면 그 프로젝트로 먼저 전환 — 안 그러면 엉뚱한 환경으로
    // {{변수}}가 치환돼 잘못된 host/자격증명에 요청이 나갈 수 있다. 현재값은 localStorage 로 읽어
    // 마운트 시점의 stale 클로저(항상 'default')를 피한다.
    const adoptWorkspace = (wsId?: string) => {
      if (!wsId || wsId === (read(KEYS.workspace) ?? 'default')) return
      setWorkspaceId(wsId); write(KEYS.workspace, wsId); setReloadKey(v => v + 1)
    }
    if (execId) {
      fetch(`/api/executions/${execId}`).then(r => r.ok ? r.json() : Promise.reject())
        .then((data: { execution: ExecutionRow; request: RequestRow; workspaceId?: string }) => {
          adoptWorkspace(data.workspaceId)
          setMode('collection'); setTabs(ts => (ts.some(t => t.id === data.request.id) ? ts : [...ts, data.request]))
          setActiveId(data.request.id); setRestore(data.execution)
        }).catch(() => {}).finally(clear)
    } else if (reqId) {
      fetch(`/api/requests/${reqId}`).then(r => r.ok ? r.json() : Promise.reject())
        .then((r: RequestRow & { workspaceId?: string }) => {
          adoptWorkspace(r.workspaceId)
          setMode('collection'); setTabs(ts => (ts.some(t => t.id === r.id) ? ts : [...ts, r])); setActiveId(r.id)
        }).catch(() => {}).finally(clear)
    } else if (flowId) {
      setInitialFlowId(flowId); setMode('scenario'); clear()
    } else clear()
  }, [])

  // URL 복원이 프로젝트를 확정한 뒤 저장된 요청 ID만 읽는다. 편집 내용·비밀값은 저장하지 않는다.
  const [restoredWorkspace, setRestoredWorkspace] = useState<string | null>(null)
  const [tabsRestoreError, setTabsRestoreError] = useState(false)
  useEffect(() => {
    if (!locationReady) return
    let alive = true
    setRestoredWorkspace(null)
    setTabsRestoreError(false)
    const saved = readJson<unknown>(scoped.requestTabs(workspaceId), null)
    const rawIds = (saved as { ids?: unknown } | null)?.ids
    const requestIds = Array.isArray(rawIds) ? [...new Set(rawIds.filter((id): id is string => typeof id === 'string'))] : []
    Promise.all(requestIds.map(async id => {
      const response = await fetch(`/api/requests/${encodeURIComponent(id)}`)
      if (response.status === 404) return null
      if (!response.ok) throw new Error('restore failed')
      const row = await response.json() as RequestRow & { workspaceId?: string }
      return row.workspaceId === workspaceId && row.id === id ? row : null
    })).then(rows => {
      if (!alive) return
      const restored = restoreTabs(saved, rows.filter((r): r is RequestRow & { workspaceId?: string } => r !== null))
      // 이미 열린 URL 요청/사용자가 선택한 요청은 우선하며, 저장된 탭 순서는 보존한다.
      setTabs(current => [...restored.tabs, ...current.filter(r => !restored.tabs.some(t => t.id === r.id))])
      setActiveId(current => current ?? restored.activeId)
      setRestoredWorkspace(workspaceId)
    }).catch(() => {
      if (alive) { setTabsRestoreError(true); setRestoredWorkspace(workspaceId) }
    })
    return () => { alive = false }
  }, [locationReady, workspaceId])
  useEffect(() => {
    if (restoredWorkspace !== workspaceId || tabsRestoreError) return
    writeJson(scoped.requestTabs(workspaceId), { ids: tabs.map(t => t.id), activeId })
  }, [tabs, activeId, workspaceId, restoredWorkspace, tabsRestoreError])

  // 화면 식별자만 URL에 유지한다. 입력값·인증정보·실행 결과는 넣지 않는다.
  //
  // 화면이 바뀌면(뷰·열린 요청·문서 보기) 기록을 하나 쌓는다. 예전엔 전부 replaceState 라
  // 브라우저 기록이 한 칸뿐이었다 — 이력에서 요청으로 넘어간 뒤 마우스 뒤로가기를 누르면
  // 이력이 아니라 앱 밖(시작 화면)으로 나갔다. 환경 바꾸기는 '다른 화면' 이 아니라 쌓지 않는다.
  const navKey = useRef<string | null>(null)
  const navRangeRef = useRef({ index: 0, total: 0 })
  const [navRange, setNavRange] = useState({ index: 0, total: 0 })
  useEffect(() => {
    if (!locationReady || restoredWorkspace !== workspaceId) return
    const url = new URL(window.location.href)
    url.searchParams.set('view', mode)
    if (environmentId) url.searchParams.set('env', environmentId)
    else url.searchParams.delete('env')
    if (mode === 'collection' && activeId) url.searchParams.set('req', activeId)
    else url.searchParams.delete('req')
    if (mode === 'collection' && docsMode) url.searchParams.set('docs', '1')
    else url.searchParams.delete('docs')
    if (mode !== 'scenario') {
      for (const key of ['flow', 'step', 'stepTab']) url.searchParams.delete(key)
    }
    const key = screenKey(mode, activeId, docsMode)
    const push = navKey.current !== null && navKey.current !== key
    navKey.current = key
    if (push) {
      const next = navRangeRef.current.index + 1
      navRangeRef.current = { index: next, total: next }
      setNavRange(navRangeRef.current)
      window.history.pushState({ ...window.history.state, postqNav: next }, '', url)
    } else window.history.replaceState({ ...window.history.state, postqNav: navRangeRef.current.index }, '', url)
  }, [locationReady, restoredWorkspace, workspaceId, mode, activeId, docsMode, environmentId])

  // 뒤로·앞으로 — 주소의 화면 식별자대로 되돌린다. 기대하는 화면 키를 먼저 적어 두어,
  // 되돌린 상태가 위 효과에서 '새 화면' 으로 오인돼 기록이 또 쌓이지(앞으로가 끊기지) 않게 한다.
  const popRef = useRef<{ tabs: RequestRow[]; open: (id: string) => void }>({ tabs: [], open: () => {} })
  useEffect(() => {
    const onPop = () => {
      const index = Number(window.history.state?.postqNav ?? 0)
      navRangeRef.current = { ...navRangeRef.current, index }; setNavRange(navRangeRef.current)
      const sp = new URLSearchParams(window.location.search)
      const view = sp.get('view')
      const next: WorkMode = view && VIEW_MODES.some(v => v.mode === view) ? view as WorkMode : 'collection'
      const req = next === 'collection' ? sp.get('req') : null
      const docs = next === 'collection' && sp.get('docs') === '1'
      setSelectedFolder(null); setMode(next); setDocsMode(docs)
      if (next === 'collection') {
        if (!req) { navKey.current = screenKey(next, null, docs); setActiveId(null); return }
        navKey.current = screenKey(next, req, docs)
        if (popRef.current.tabs.some(t => t.id === req)) { setActiveId(req); setRestore(null) }
        else popRef.current.open(req)  // 닫은 탭으로 돌아가면 다시 연다
      } else {
        navKey.current = screenKey(next, null, docs)
      }
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  /**
   * 트리에서 고른 요청을 연다.
   *
   * 트리는 가벼운 행(이름·메서드만)을 들고 있다 — 바디·헤더·인증은 없다. 그대로 열면
   * 빈 요청처럼 보이고, 그 상태로 저장하면 내용이 날아간다. 그래서 열 때 전부 받는다.
   * 탭은 먼저 띄운다 — 네트워크를 기다리는 동안 아무 일도 안 일어나면 안 눌린 줄 안다.
   */
  const openRequest = async (r: RequestRow, preview = false) => {
    const sequence = ++openSequence.current
    setSelectedFolder(null)
    setMode('collection')
    setRestore(null)

    // 트리는 가벼운 행(이름·메서드만)을 들고 있다 — 바디·헤더·인증은 없다.
    // 그대로 열면 빈 요청처럼 보이고, 그 상태로 저장하면 내용이 날아간다.
    //
    // 탭을 먼저 띄우고 나중에 덮어쓰는 방식은 안 된다. 받아오는 사이에 사용자가 뭔가
    // 입력하면 그 입력을 서버 값이 덮어쓴다 — 실제로 Docs 탭에 설명을 쓰다 날아갔다.
    // 그래서 다 받고 나서 연다. 목록이 가벼워진 덕에 이 한 번은 금방이다.
    // 못 받아오면 열지 않는다. 예전엔 가벼운 행으로라도 열었는데, 그 행엔 params 가 없어서
    // 요청 화면이 그리다가 통째로 깨졌다(codex 점검). 빈 요청처럼 보이는 것도 저장 사고로 이어진다.
    let full = r
    if (r.headers === undefined || r.body === undefined) {
      try {
        const res = await fetch(`/api/requests/${r.id}`)
        if (!res.ok) {
          toastOutside('error', res.status === 404 ? i18nText('dynamicRequestHasBeenDeletedPleaseRefreshTheList', { v0: String(r.name) }) : i18nText('dynamicFailedToOpenRequestTryAgain', { v0: String(r.name), v1: String(res.status) }))
          return
        }
        full = await res.json() as RequestRow
      } catch {
        toastOutside('error', i18nText('dynamicFailedToOpenRequestCheckYourConnectionToThe', { v0: String(r.name) }))
        return
      }
    }
    if (sequence !== openSequence.current) return
    if (preview && !tabs.some(t => t.id === full.id && t.id !== previewRef.current)) {
      const previous = previewRef.current
      setTabs(ts => [...ts.filter(t => t.id !== full.id && !(t.id === previous && !dirtyRef.current[t.id])), full])
      previewRef.current = full.id; setPreviewId(full.id)
    } else {
      pinPreview(full.id)
      setTabs(ts => (ts.some(t => t.id === full.id) ? ts : [...ts, full]))
    }
    setActiveId(full.id)
    return true
  }
  // 요청이 0개인 프로젝트의 시작 안내(StartGuide) 동작들.
  // 예시 요청은 만들고 열기만 한다 — 바깥 주소로 나가는 건 사용자가 [실행] 을 눌렀을 때뿐이다.
  // [OpenAPI 주소로 추가] — 컬렉션의 폴더 만들기 폼을 OpenAPI 주소 칸까지 펼쳐 연다.
  const [openApiFormKey, setOpenApiFormKey] = useState(0)
  const startWith = async (kind: 'blank' | 'example', focusUrl = false) => {
    try {
      const created = await createStarterRequest(workspaceId, kind)
      if (focusUrl) focusUrlWhenOpened(created.id)
      setReloadKey(v => v + 1)
      await openRequest(created)
      if (focusUrl) toastOutside('info', i18nText('dynamicPasteTheCurlCommandInTheAddressBarV'))
    } catch (e) {
      toastOutside('error', i18nText('dynamicFailedToCreateRequest', { v0: String(errorText(e)) }))
    }
  }
  const startActions: StartActions = {
    onExample: () => startWith('example'),
    onBlank: () => startWith('blank'),
    onCurl: () => startWith('blank', true),
    onImported: () => setReloadKey(v => v + 1),
    onOpenApi: () => {
      setMode('collection'); setFocusMode(false)
      if (!sidebarOpen) toggleSidebar()
      setOpenApiFormKey(v => v + 1)
    },
  }
  // API 이력 등에서 requestId 만 알 때 — 템플릿을 받아와 컬렉션 탭으로 연다(워크스페이스 다르면 전환).
  const openRequestById = async (requestId: string) => {
    try {
      const res = await fetch(`/api/requests/${requestId}`)
      // 실패를 조용히 삼키면 '눌렀는데 아무 일도 없음' 으로 보인다 — 삭제됐는지 연결 문제인지 말한다.
      if (!res.ok) { toastOutside('error', res.status === 404 ? i18nText('dynamicThatRequestHasBeenDeleted') : i18nText('dynamicFailedToOpenRequestTryAgain2', { v0: String(res.status) })); return }
      const r = await res.json() as RequestRow & { workspaceId?: string }
      // 다른 프로젝트 소속이면 먼저 전환 — 안 그러면 엉뚱한 환경으로 {{변수}}가 치환된다.
      const wsId = r.workspaceId
      if (wsId && wsId !== (read(KEYS.workspace) ?? 'default')) {
        setTabs([]); setActiveId(null); setRestore(null); setDirty({}); setEnvironmentId(null)
        setWorkspaceId(wsId); write(KEYS.workspace, wsId); setReloadKey(v => v + 1)
      }
      openRequest(r)
    } catch { toastOutside('error', i18nText('dynamicFailedToOpenRequestCheckYourConnectionToThe2')) }
  }
  popRef.current = { tabs, open: id => { void openRequestById(id) } }
  const selectTab = (id: string) => { setSelectedFolder(null); setActiveId(id); setRestore(null) }
  /**
   * 탭을 닫는다. reason='deleted' 는 요청 자체가 사라져서 닫는 경우다.
   *
   * 예전엔 삭제도 같은 확인을 거쳤다. 그런데 이미 지워진 요청에 '이 탭을 닫을까요?' 를
   * 묻는 건 뜻이 없다 — [취소] 를 누르면 없는 요청의 탭이 남고, 거기서 ⌘S 를 누르면
   * (서버가 없는 행에도 200 을 주던 탓에) '저장됨' 까지 떴다. 20개를 한꺼번에 지우면
   * 뜻 없는 확인창이 20번 떴다.
   *
   * 삭제일 때는 묻지 않고 닫되, 미저장 편집이 있었다면 그게 함께 사라졌다고 말한다.
   * 조용히 버리는 것과 뜻 없이 묻는 것 사이에서 고를 문제가 아니다.
   */
  const closeTab = (id: string, reason?: 'deleted' | 'confirmed'): { hadUnsaved: boolean } => {
    const idx = tabs.findIndex(t => t.id === id)
    if (idx === -1) return { hadUnsaved: false }
    const hadUnsaved = !!dirty[id]
    // 삭제면 묻지 않고 닫는다. 대신 미저장 편집이 있었다는 사실을 호출부에 알려
    // 삭제 알림에 같이 싣는다(이 컴포넌트는 토스트 제공자라 자기 안에서 못 띄운다).
    if (!reason && hadUnsaved) { setPendingLeave({ kind: 'tab', id }); return { hadUnsaved } }
    const next = tabs.filter(t => t.id !== id)
    setTabs(next)
    setDirty(d => { const copy = { ...d }; delete copy[id]; return copy })
    if (activeId === id) {
      const newActive = next[idx] ?? next[idx - 1] ?? null
      setActiveId(newActive?.id ?? null)
      setRestore(null)
    }
    return { hadUnsaved }
  }

  const finishLeave = () => {
    if (!pendingLeave) return
    if (pendingLeave.kind === 'workspace') performWorkspaceSwitch(pendingLeave.id)
    else closeTab(pendingLeave.id, 'confirmed')
    setPendingLeave(null)
  }
  const saveAndLeave = async () => {
    if (!pendingLeave || leaveSaving) return
    setLeaveSaving(true)
    try {
      const ids = pendingLeave.kind === 'tab' ? [pendingLeave.id] : Object.keys(dirtyRef.current).filter(id => dirtyRef.current[id])
      for (const id of ids) if (!await saveHandlers.current.get(id)?.()) { setPendingLeave(null); setMode('collection'); setActiveUtility(null); setSelectedFolder(null); setActiveId(id); return }
      finishLeave()
    } finally { setLeaveSaving(false) }
  }
  useEffect(() => {
    const close = () => {
      if (document.querySelector('[aria-modal="true"]') || mode !== 'collection' || activeUtility || !activeId) return
      const input = document.activeElement
      if (input instanceof HTMLElement && input.dataset.commitOnBlur !== undefined) { input.blur(); setTimeout(() => window.dispatchEvent(new Event('postq:close-request-tab')), 0); return }
      closeTab(activeId)
    }
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.altKey && (e.code === 'KeyW' || e.key.toLowerCase() === 'w')) { e.preventDefault(); close() }
    }
    window.addEventListener('postq:close-request-tab', close)
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('postq:close-request-tab', close); window.removeEventListener('keydown', key) }
  })

  // ⌘K 팔레트 명령 — 뷰 이동 · 환경 전환 · 관리 모달 · 테마. (요청 검색은 팔레트가 자체 로드)
  const paletteActions = useMemo<PaletteAction[]>(() => {
    const views: PaletteAction[] = VIEW_MODES.map((v, i) => ({
      id: `view:${v.mode}`, badge: tr('view'), label: tr(v.label), hint: `⌘${i + 1}`,
      keywords: v.mode, run: () => openModeRef.current(v.mode),
    }))
    const envs: PaletteAction[] = environments.map(e => ({
      id: `env:${e.id}`, badge: tr('environment'), label: e.name,
      hint: environmentId === e.id ? i18nText('dynamicCurrently') : undefined,
      keywords: 'environment env 전환', run: () => setEnvironmentId(e.id),
    }))
    if (environmentId) envs.push({
      id: 'env:none', badge: tr('environment'), label: tr('clearEnvironment'),
      keywords: 'clear none 없음', run: () => setEnvironmentId(null),
    })
    const settings: PaletteAction[] = [
      { id: 'open:env', badge: tr('settings'), label: tr('openEnvironmentManager'), keywords: 'environment manage', run: () => setSettingsTab('env') },
      { id: 'open:cookie', badge: tr('settings'), label: tr('openCookieManager'), keywords: 'cookie jar', run: () => setSettingsTab('cookies') },
      { id: 'open:ai', badge: tr('settings'), label: tr('openClaudeMcp'), keywords: 'ai mcp assistant claude AI 연결', run: () => setSettingsTab('ai') },
    ]
    const themes: PaletteAction[] = [
      { id: 'theme:light', badge: tr('theme'), label: tr('lightTheme'), keywords: 'light 밝게', run: () => setThemePref('light') },
      { id: 'theme:dark', badge: tr('theme'), label: tr('darkTheme'), keywords: 'dark 어둡게', run: () => setThemePref('dark') },
      { id: 'theme:system', badge: tr('theme'), label: tr('systemTheme'), keywords: 'system auto os', run: () => setThemePref('system') },
    ]
    const requestActions: PaletteAction[] = mode === 'collection' && activeId && !activeUtility && !selectedFolder && !docsMode ? [
      { id: 'request:curl', badge: tr('request'), label: tr('copyCurl'), hint: '⌘⇧C', keywords: 'curl copy 복사', run: () => window.dispatchEvent(new Event('postq:copy-curl')) },
    ] : []
    return [...requestActions, ...views, ...envs, ...settings, ...themes]
  }, [environments, environmentId, mode, activeId, activeUtility, selectedFolder, docsMode, tr])

  /**
   * 화면 이동. 목록이 필요한 화면으로 가면 목록을 연다.
   *
   * [컬렉션] 을 눌렀는데 아무것도 안 나오는 일이 실제로 있었다 — 언젠가 목록을 숨겨
   * 뒀고 그 상태가 브라우저에 남아 있었던 것이다. 되돌릴 방법이 작은 아이콘 하나뿐이라
   * '눌러도 안 되는 화면' 으로 보인다. 컬렉션을 눌렀다는 건 컬렉션을 보겠다는 뜻이다.
   */
  const goMode = useCallback((m: WorkMode) => {
    if (m === 'scenario' || m === 'schedule') sectionToggle(m, true)
    setMode(m)
    // 다른 화면에서 넘어왔으면 연다. [컬렉션] 을 눌렀는데 아무것도 안 뜨면 안 된다.
    if (!sidebarOpen) toggleSidebar()
  }, [sidebarOpen, toggleSidebar, setMode])
  // ⌘K·⌘1~5 로 옮겨도 레일을 누른 것과 같은 곳에 닿게 한다 — 예전엔 화면만 바꾸고 숨긴 목록은
  // 닫힌 채로 두어서, 같은 '컬렉션으로 이동' 인데 도착한 모습이 달랐다(codex 점검).
  // 이미 그 화면이어도 목록이 닫혀 있으면 연다. 접기는 목록 버튼과 ⌘E로 한다.
  openModeRef.current = (m: WorkMode) => {
    setFocusMode(false)
    if (!sidebarOpen) toggleSidebar()
    if (m === 'scenario' || m === 'schedule') sectionToggle(m, true)
    else setMode(m)
    const previousFocus = document.activeElement
    requestAnimationFrame(() => {
      // 다음 프레임 전에 사용자가 입력 칸으로 옮겼다면 포커스를 빼앗지 않는다.
      if (document.activeElement === previousFocus || document.activeElement === document.body) {
        document.querySelector<HTMLElement>(`[data-testid="rail-${m}"]`)?.focus()
      }
    })
  }

  const showLeftList = !focusMode && sidebarOpen
  const showHistory = mode === 'collection' && !activeUtility && !focusMode && historyOpen

  return (
    <>
      <ToastProvider>
      <VariableEditContext.Provider value={{ workspaceId, environmentId, onSaved: () => { void loadEnvs() } }}>
        {pendingLeave && <ModalFrame label={tr('unsavedChanges')} width="w-[min(480px,94vw)]" onClose={() => { if (!leaveSaving) setPendingLeave(null) }}>
          <ModalHeader title={tr('unsavedChanges')} />
          <p className="p-4">{tr(pendingLeave.kind === 'workspace' ? 'saveBeforeWorkspaceSwitch' : 'saveBeforeTabClose')}</p>
          {pendingLeave.kind === 'workspace' && Object.values(utilityDirty).some(Boolean) && <p className="px-4 text-ui-sm">{tr('saveEnvironmentFirst')}</p>}
          <div className="flex justify-end gap-2 p-4">
            <button className="ah-btn px-3" disabled={leaveSaving} onClick={() => setPendingLeave(null)}>{tr('cancel')}</button>
            <button className="ah-btn px-3" disabled={leaveSaving} onClick={finishLeave}>{tr('discard')}</button>
            <button className="ah-btn-primary" disabled={leaveSaving || (pendingLeave.kind === 'workspace' && Object.values(utilityDirty).some(Boolean))} onClick={saveAndLeave}>{tr('save')}</button>
          </div>
        </ModalFrame>}
        <div className="flex h-screen flex-col bg-background" onContextMenu={e => {
          // 앱다운 화면을 위해 웹뷰 기본 메뉴(새로고침·검사)는 막되, 글을 치거나 고른 자리에서는 살린다.
          // 전부 막으니 입력칸·응답에서 마우스로 복사·붙여넣기를 할 길이 없었다(codex 점검).
          const t = e.target as HTMLElement
          if (t.closest('input, textarea, [contenteditable="true"]')) return
          if (window.getSelection()?.toString()) return
          e.preventDefault()
        }}>
          <AppHeader
            canBack={navRange.index > 0} canForward={navRange.index < navRange.total}
            workspaceSlot={<WorkspaceSwitcher workspaceId={workspaceId} onChange={switchWorkspace} />}
            onOpenSearch={() => setPaletteOpen(true)}
            onOpenSettings={() => setSettingsTab('env')}
          />
          <main className="flex min-h-0 min-w-0 flex-1 overflow-x-hidden">
            <div data-testid="sidebar-pane" className={showLeftList ? "hidden min-h-0 shrink-0 flex-col overflow-hidden bg-surface md:flex" : "hidden"} style={{ width: sidebar.width }}>
              {showLeftList && !narrow && <LeftRail mode={mode} onMode={goMode} orientation="horizontal" />}
              <div className="min-h-0 flex-1 overflow-hidden">
                <FolderTree workspaceId={workspaceId} selectedId={activeId}
                  onSelect={(r, pin) => { setSelectedFolder(null); void openRequest(r, !pin) }}
                  onCopyCurl={r => { void openRequest(r).then(opened => { if (opened) setCopyCurlTarget(r.id) }) }}
                  onFolderSelect={folder => { setMode('collection'); setSelectedFolder(folder) }}
                  reloadKey={reloadKey} onReloaded={onTreeReloaded}
                  headerExtra={<><ImportButton workspaceId={workspaceId} onImported={() => setReloadKey(v => v + 1)} /><ExportButton /></>}
                  onDeleted={id => closeTab(id, 'deleted').hadUnsaved} onHide={toggleSidebar} openApiFormKey={openApiFormKey} />
              </div>
              <div className="max-h-[60%] shrink-0 overflow-y-auto">
                <SidebarSection name={tr('environment')} open={!!sidebarSections.env} onToggle={() => sectionToggle('env', !sidebarSections.env)}>
                  <div className="px-2 pb-2"><button className="ah-sidebar-row text-accent" onClick={() => openUtility('env')}>{tr('manageEnvironments')}</button>
                  {environments.map(env => <button key={env.id} className="ah-sidebar-row" aria-pressed={activeUtility === `env:${env.id}`} onClick={() => openUtility('env', env.id, env.name)}>{env.name}</button>)}</div>
                </SidebarSection>
                <SidebarSection name={tr('scenario')} active={mode === 'scenario' && !activeUtility} testId="rail-scenario" shortcut="⌘2" open={!!sidebarSections.scenario} onToggle={() => sectionToggle('scenario', !sidebarSections.scenario)}><div ref={setScenarioSidebar} /></SidebarSection>
                <SidebarSection name={tr('schedule')} active={mode === 'schedule' && !activeUtility} testId="rail-schedule" shortcut="⌘4" open={!!sidebarSections.schedule} onToggle={() => sectionToggle('schedule', !sidebarSections.schedule)}><div ref={setScheduleSidebar} /></SidebarSection>
                <SidebarSection name={tr('cookies')} open={!!sidebarSections.cookies} onToggle={() => sectionToggle('cookies', !sidebarSections.cookies)}>{sidebarSections.cookies && <CookieSidebar workspaceId={workspaceId} onOpen={domain => openUtility('cookies', undefined, domain, domain)} />}</SidebarSection>
              </div>
            </div>
            <div className={showLeftList ? "hidden md:flex" : "hidden"}><ResizeHandleH label={tr('resizeSidebar')} onDrag={e => sidebar.startDrag(e, 1)} /></div>

            {/* 가운데 */}
            <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
                  <div className="flex min-h-10 flex-wrap shrink-0 items-center border-b border-border bg-surface">
                    {(!showLeftList || narrow) && <LeftRail mode={mode} onMode={goMode} orientation="horizontal" />}
                    <div role="tablist" aria-label={tr('workTabs')} className="flex min-w-0 shrink-0 max-w-[40%] overflow-x-auto [scrollbar-width:none]">
                      {visitedModes.map(item => <button key={item} role="tab" aria-selected={mode === item && !activeUtility} onClick={() => setMode(item)} className="ah-work-tab">{tr(({ scenario: 'scenario', schedule: 'schedule', history: 'history', ws: 'realtimeShort', collection: 'request' } as const)[item])}</button>)}
                      {utilityTabs.map(item => <div key={item.id} className="flex shrink-0 items-center border-r border-border">
                        <button role="tab" aria-selected={activeUtility === item.id} className="ah-work-tab border-r-0" onClick={() => { setMode('collection'); setActiveUtility(item.id) }}>{item.label}</button>
                        <ToolButton icon="close" aria-label={i18nText('dynamicCloseTab', { v0: String(item.label) })} className="ah-action px-1 text-faint-foreground" onClick={() => {
                          if (utilityDirty[item.id]) { toastOutside('error', i18nText('jsxYouHaveUnsavedChangesToYourEnvironmentPleaseSave')); return }
                          setUtilityTabs(tabs => tabs.filter(t => t.id !== item.id)); if (activeUtility === item.id) setActiveUtility(null)
                        }} />
                      </div>)}
                    </div>
                    {mode === 'collection' && !activeUtility && selectedFolder && <div className="flex h-full max-w-48 shrink-0 items-center gap-3 border-r border-t-2 border-r-border border-t-accent bg-background px-3 text-ui-md italic"><span className="truncate">{selectedFolder.name}</span><ToolButton icon="close" aria-label={tr('closeFolderOverview')} onClick={() => setSelectedFolder(null)} /></div>}
                    <RequestTabs tabs={tabs.map(t => draftMethods[t.id] ? { ...t, method: draftMethods[t.id] } : t)} previewId={previewId} onPin={pinPreview} activeId={mode === 'collection' && !activeUtility ? activeId : null} dirty={dirty} onSelect={id => { setMode('collection'); setSelectedFolder(null); selectTab(id) }} onClose={closeTab} onNew={startActions.onBlank} />
                    <div className="ml-auto flex h-10 shrink-0 items-center gap-1 border-l border-border px-2">
                      <div role="group" aria-label={tr('requestDisplayMode')} className="flex rounded border border-border">{([[false, 'editRequest'], [true, 'viewDocs']] as const).map(([value, label]) => <ToolButton icon={value ? "book" : "edit"} aria-label={tr(label)} key={label} className="px-1 text-ui-sm text-muted-foreground" aria-pressed={docsMode === value} onClick={() => setDocsMode(value)} />)}</div>
{<>              <select
                aria-label={tr('executionEnvironment')}
                title={tr('executionEnvironmentHint')}
                className="h-7 max-w-[168px] shrink-0 rounded-[var(--radius-sm)] border border-border bg-surface-2 px-2 text-ui-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25"
                value={environmentId ?? ''}
                onChange={e => e.target.value === '__manage_envs__' ? setSettingsTab('env') : setEnvironmentId(e.target.value || null)}
              >
                <option value="">{tr('noEnvironment')}</option>
                {environments.map(env => <option key={env.id} value={env.id}>{env.name}</option>)}
              <option value="__manage_envs__">{tr('manageEnvironmentsMore')}</option></select></>}
                      <FocusToggle focusMode={focusMode} onToggle={() => setFocusMode(v => !v)} />
                    </div>
                  </div>
              {/* 컬렉션 화면은 다른 화면으로 옮겨도 '지우지 않고 감춘다'.
                  언마운트하면 RequestPanel 의 draft 가 서버 값으로 되돌아가, 저장하지 않은
                  URL·메서드 수정이 경고 한 줄 없이 사라졌다 — 실제로 그렇게 잃었다.
                  (탭 사이에서 이미 쓰던 방식과 같다. display:contents 라 배치는 그대로다.) */}
              <div className={mode === 'collection' && !activeUtility ? 'contents' : 'hidden'}>
                <>
                  {/* 실행 ↔ 문서 모드 — 같은 요청을 '보내는 화면'과 '명세로 읽는 화면'으로 전환.
                      (별도 /docs 페이지를 없애고 여기로 흡수 — 좌측 폴더 트리가 곧 문서 목차)
                      전용 줄을 두면 탭 아래 32px 를 상시로 먹어서 탭 줄 오른쪽에 붙인다. */}
                  <div className={`min-h-0 flex-1 ${docsMode || tabs.length === 0 ? 'overflow-y-auto p-4' : 'overflow-hidden'}`}>
                    {selectedFolder && <FolderOverview key={`${workspaceId}:${selectedFolder.id}`} folder={selectedFolder} workspaceId={workspaceId} onOpen={r => { setSelectedFolder(null); void openRequest(r) }} onSaved={() => setReloadKey(v => v + 1)} />}
                    {!selectedFolder && tabs.length === 0 && (restoredWorkspace !== workspaceId ? <PanelLoading /> : <ResumeWorkspace key={workspaceId} workspaceId={workspaceId} version={historyVersion + reloadKey + treeVersion} onOpen={openRequestById} restoreError={tabsRestoreError} start={startActions} />)}
                    {!selectedFolder && docsMode && tabs.length > 0 && (
                      <CollectionDocs workspaceId={workspaceId} activeRequest={tabs.find(t => t.id === activeId) ?? null} />
                    )}
                    {/* 문서를 보는 동안에도 요청 패널은 숨겨 둘 뿐 내리지 않는다. 내리면 다시 올릴 때
                        저장된 값으로 새로 시작해, 모든 탭의 저장 안 한 편집이 말없이 사라졌다(codex 리뷰). */}
                    {tabs.map(t => (
                      <div key={t.id} className={t.id === activeId && !docsMode && !selectedFolder ? 'flex h-full flex-col' : 'hidden'}>
                        <RequestPanel folderRevision={reloadKey}
                          copyCurlRequested={copyCurlTarget === t.id} onCurlCopyHandled={() => setCopyCurlTarget(null)}
                          registerSave={handler => { if (handler) saveHandlers.current.set(t.id, handler); else saveHandlers.current.delete(t.id) }}
                          onLiveChange={live => { setLiveRequest(live); setDraftMethods(previous => previous[live.requestId] === live.draft.method ? previous : { ...previous, [live.requestId]: live.draft.method }) }}
                          workspaceId={workspaceId}
                          request={t}
                          environments={environments}
                          environmentId={environmentId}
                          onEnvironmentChange={setEnvironmentId}
                          onExecuted={() => setHistoryVersion(v => v + 1)}
                          onTemplateSaved={saved => {
                            setTabs(ts => ts.map(x => (x.id === t.id ? { ...x, ...saved } : x)))
                            setReloadKey(v => v + 1)
                          }}
                          restore={t.id === activeId ? restore : null}
                          isActive={mode === 'collection' && !activeUtility && t.id === activeId && !docsMode && !selectedFolder}
                          onDirtyChange={d => { if (d) pinPreview(t.id); setDirty(prev => (prev[t.id] === d ? prev : { ...prev, [t.id]: d })) }}
                          historyVisible={showHistory}
                          onOpenHistory={() => { setRightTab(null); toggleHistory(); setFocusMode(false) }}
                          onOpenEnvManager={() => setSettingsTab('env')}
                          onEnvironmentsSaved={loadEnvs}
                        />
                      </div>
                    ))}
                  </div>
                </>
              </div>

              {(sidebarSections.scenario || mode === 'scenario' || visitedModes.includes('scenario')) && <div className={mode === 'scenario' ? 'flex min-h-0 flex-1' : 'hidden'}>
                <FlowScenario sidebarContainer={scenarioSidebar} active={mode === 'scenario'} onActivate={() => setMode('scenario')} key={workspaceId} workspaceId={workspaceId} environmentId={environmentId} initialFlowId={initialFlowId} onFlowConsumed={() => setInitialFlowId(null)} />
              </div>}
              {utilityTabs.map(item => <div key={`${workspaceId}:${item.id}`} className={activeUtility === item.id ? 'min-h-0 flex-1 overflow-y-auto p-6' : 'hidden'}>
                {item.kind === 'env' ? <EnvironmentModal embedded active={activeUtility === item.id && !settingsTab} workspaceId={workspaceId} environments={environments} activeEnvironmentId={item.envId} onActivate={setEnvironmentId}
                  onSaved={loadEnvs} onClose={() => setActiveUtility(null)} onDirtyChange={count => setUtilityDirty(old => old[item.id] === count ? old : { ...old, [item.id]: count })} />
                  : <CookieManager embedded active={activeUtility === item.id && !settingsTab} initialDomain={item.domain} workspaceId={workspaceId} environments={environments} onClose={() => setActiveUtility(null)} />}
              </div>)}
              {/* 실행 이력은 한 번 열면 계속 붙여 둔다 — 상세에서 요청으로 갔다가 뒤로 오면
                  검색·필터·열어 둔 상세가 그대로 있어야 '돌아왔다' 고 느낀다. */}
              {(mode === 'history' || historyVisited) && <div className={mode === 'history' ? 'ah-view' : 'hidden'}>
                <GlobalHistory key={`${workspaceId}:${environmentId}`} onOpenRequest={openRequestById} workspaceId={workspaceId} environmentId={environmentId} />
              </div>}
              {/* 스케줄 — 시나리오 정기 실행과 마지막 결과. 행의 [실행 기록] 이 그 시나리오의 지난 실행으로 보낸다. */}
              {(sidebarSections.schedule || mode === 'schedule' || visitedModes.includes('schedule')) && <div className={mode === 'schedule' ? 'min-h-0 flex-1 overflow-y-auto' : 'hidden'}><ScheduleManager sidebarContainer={scheduleSidebar} onActivate={() => setMode('schedule')} key={workspaceId} workspaceId={workspaceId} /></div>}
              {/* 실시간은 한 번 열면 다른 화면에 가도 내리지 않는다 — 내리면 연결이 끊기고 받은 메시지·
                  쓰던 입력까지 사라졌다(codex 리뷰). 숨겨 둘 뿐이라 돌아오면 그대로다. */}
              {(mode === 'ws' || realtimeVisited) && <div className={mode === 'ws' ? 'contents' : 'hidden'}><RealtimePanel /></div>}
            </section>

            {/* 우측 이력 (컬렉션 모드). 숨기는 조작은 헤더의 패널 아이콘 하나뿐이다 —
                접었을 때 띠를 남겨 뒀더니 세로로 누운 글자가 붙은 기둥이 하나 더 생겨,
                치우려고 접은 사람에게 다른 것을 하나 더 보여주는 꼴이었다. */}
            {showHistory && (
              <>
                <div className="hidden md:flex"><ResizeHandleH label={tr('resizeHistoryPanel')} onDrag={e => historyRail.startDrag(e, -1)} /></div>
                <aside aria-label={tr('executionHistoryPanel')} className="flex shrink-0 flex-col overflow-y-auto bg-surface" style={{ width: historyRail.width }}>
                  <div className="flex items-center border-b border-border/70 px-4 py-2.5">
                    <span className="ah-label flex-1">{tr('executionHistory')}</span><ToolButton icon="close" type="button" aria-label={tr('closeExecutionHistory')} onClick={toggleHistory} className="ah-action px-2 text-muted-foreground" />
                  </div>
                  <div className="flex-1 overflow-y-auto p-3">
                    {activeId ? (
                      <HistoryPanel key={`${activeId}:${environmentId}`} environmentId={environmentId} environments={environments} requestId={activeId} version={historyVersion} />
                    ) : (
                      <div className="flex h-full items-center justify-center px-2 text-center text-ui-lg text-faint-foreground">
                        {tr('openRequestForHistory')}
                      </div>
                    )}
                  </div>
                </aside>
              </>
            )}
            {mode === 'collection' && !activeUtility && !focusMode && <RightPanel live={!selectedFolder && liveRequest?.requestId === activeId ? liveRequest : null} tab={rightTab} onTab={tab => { setRightTab(tab); if (tab && historyOpen) toggleHistory() }} onSettings={setSettingsTab} />}
          </main>
          <ConsoleDrawer open={consoleOpen} onClose={() => setConsoleOpen(false)} version={historyVersion} workspaceId={workspaceId} />
          <StatusBar
            hint={activeUtility ? i18nText('jsxManageYourEnvironmentAndLocalData') : mode === 'collection' ? selectedFolder ? i18nText('jsxManageFolderDescriptionsAndCommonSettings') : activeId ? i18nText('jsxSendRequest') : i18nText('jsxStartByOpeningARequestOrCreatingANew') : ({ scenario: i18nText('jsxConnectRequestsToRunScenarios'), history: i18nText('jsxSelectExecutionHistoryToSeeRequestsAndResponses'), schedule: i18nText('jsxRunReservationsAndCheckRecentResults'), ws: i18nText('jsxCheckWebSocketAndSSEConnectionsAndMessages') } as Record<string, string>)[mode]}
            sidebarOpen={showLeftList}
            onToggleSidebar={toggleSidebar}
            onOpenGlobals={() => setSettingsTab('env')}
            onOpenCookies={() => setSettingsTab('cookies')}
            onOpenShortcuts={() => setShortcutsOpen(v => !v)}
            onToggleConsole={() => setConsoleOpen(v => !v)}
            rightOpen={rightTab !== null}
            onToggleRight={mode === 'collection' && !activeUtility && !selectedFolder && !!activeId && !focusMode ? () => { setRightTab(t => t ? null : 'code'); if (!rightTab && historyOpen) toggleHistory() } : undefined}
            consoleOpen={consoleOpen}
          />
        </div>

        {settingsTab && (
          <SettingsDialog
            workspaceId={workspaceId}
            environments={environments}
            activeEnvironmentId={environmentId}
            initialTab={settingsTab}
            onEnvironmentChange={setEnvironmentId}
            onClose={() => setSettingsTab(null)}
            onEnvSaved={loadEnvs}
            onDataImported={() => { void loadEnvs(); setReloadKey(v => v + 1) }}
          />
        )}
        <CommandPalette workspaceId={workspaceId} open={paletteOpen} actions={paletteActions} onClose={() => setPaletteOpen(false)} onPick={openRequest} />
        <ShortcutHelp pinned={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      </VariableEditContext.Provider>
      </ToastProvider>
    </>
  )
}
