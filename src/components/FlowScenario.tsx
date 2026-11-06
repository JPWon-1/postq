'use client'
import { t as i18nText } from '@/i18n'
import { stepCount, localizeKorean, t } from '@/i18n'
import { ToolButton } from './ToolButton'
import { createPortal } from 'react-dom'
import { decideExecution } from '@/lib/executionPolicy'
import { isFailedExecution, isFailedRow } from '@/lib/executionOutcome'
import { addPathParam, paramsFromUrl, reconcile, urlFromParams } from '@/lib/urlParams'
import { AddPathParam } from './AddPathParam'
import { findJsonProblem, formatJson, looksLikeJson } from '@/lib/jsonFormat'
import { RequestBodyEditor } from './RequestBodyEditor'
import { renderVarHighlight } from './VariableText'
import { ScenarioRequestPicker } from './ScenarioRequestPicker'
import { ModalFrame, ModalHeader } from './ModalFrame'
import { previewFlow } from '@/lib/flowPreview'
import { FlowPreviewPanel } from './FlowPreviewPanel'
import { requestsByFolder } from '@/lib/requestsByFolder'
import { useCallback, useEffect, useRef, useState } from 'react'
import { methodPill } from '@/lib/methodStyle'
import { KEYS, read, write } from '@/lib/localStore'
import { JsonView } from '@/components/JsonView'
import { collectLeaves } from '@/lib/jsonLeaves'
import { useToast } from '@/components/Toast'
import { kstMonthDay, kstTime } from '@/lib/datetime'
import { extractPathParameters, extractVariables, type KV } from '@/lib/variables'
import { KVEditor } from '@/components/KVEditor'
import { CopyButton } from '@/components/CopyButton'
import type { ExtractRule, FlowStep } from '@/lib/flowChain'
import type { EnvironmentRow, ExecutionRow, FolderRow, RequestRow } from '@/lib/ui-types'
import { SkeletonRows } from './Skeleton'
import { errorText, fetchArray } from '@/lib/fetchJson'
import { fetchSharedVars } from '@/lib/sharedVars'
import { LoadFailed } from './LoadFailed'
import { copyText } from '@/lib/clipboard'

type SharedVar = { key: string; value: string; secret?: boolean }
type Flow = { id: string; name: string; steps: FlowStep[]; sharedVars?: SharedVar[]; updatedAt?: number }
type StepResult = {
  requestId: string; name?: string; error?: string
  execution?: ExecutionRow
  extracted?: Record<string, string>; extractMissing?: string[]
}
type RunResult = { steps: StepResult[]; stoppedAt: number | null; runtimeVariables: Record<string, string> }
// checkPassed 는 나중에 저장하기 시작했다 — 옛 기록엔 없어서 그땐 HTTP 코드로 본다(isFailedRow 의 null 규칙).
type FlowRunStep = { name: string | null; method: string | null; url: string | null; status: number | null; ms: number | null; error: string | null; checkPassed?: boolean | null }
type FlowRunRow = { id: string; startedAt: number; durationMs: number; stoppedAt: number | null; executedBy: string; steps: FlowRunStep[] }



// 스텝이 보낼 요청 바디를 어디서 가져올지 — 각 옵션의 정식 명칭 + 한 줄 설명.
const BODY_SOURCES = [
  { val: 'template', label: '템플릿 그대로', desc: '이 요청에 저장된 바디를 그대로 보냅니다.' },
  { val: 'prev', label: '이전 단계 응답 전달', desc: '직전 단계의 응답 전체를 이 요청의 바디로 보냅니다 ({{prevBody}}).' },
  { val: 'custom', label: '직접 작성', desc: '아래에 바디를 직접 입력합니다 — {{변수}}·이전 응답을 넣을 수 있어요.' },
] as const

/**
 * 저장하지 못한 채 화면을 떠난 편집. 컴포넌트의 pending 은 언마운트와 함께 사라져서, 저장이 실패한 뒤
 * 다른 화면으로 갔다 오면 편집이 서버의 옛 정의로 돌아가 있었다(codex 점검). 앱이 떠 있는 동안은 여기 남겨
 * 다시 열 때 되살리고 저장을 다시 시도한다. base 는 그 편집이 딛고 있던 서버 시각 — 그사이 남이 저장했으면 409 로 고르게 한다.
 */
const unsavedDrafts = new Map<string, { flow: Flow; base?: number; workspaceId: string }>()

export function FlowScenario({ workspaceId, environmentId, initialFlowId, onFlowConsumed, sidebarContainer, onHide, active = true, onActivate }: { active?: boolean; onActivate?: () => void; sidebarContainer?: HTMLElement | null; onHide?: () => void; workspaceId: string; environmentId: string | null; initialFlowId?: string | null; onFlowConsumed?: () => void }) {
  const toast = useToast()
  const [flowList, setFlowList] = useState<Flow[]>([])
  const [selected, setSelected] = useState<Flow | null>(null)
  // 보고 있던 시나리오를 기억한다 — 아래 '복귀 시 복원' 이 이 값을 읽는다.
  const pickFlow = useCallback((f: Flow | null) => {
    setSelected(f)
    write(KEYS.scenarioFlow, f?.id ?? '')
  }, [])
  const [deleteTarget, setDeleteTarget] = useState<Flow | null>(null)
  const [stepDeleteArmed, setStepDeleteArmed] = useState<number | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [folders, setFolders] = useState<FolderRow[]>([])
  const [allRequests, setAllRequests] = useState<RequestRow[]>([])
  const [environments, setEnvironments] = useState<EnvironmentRow[]>([])
  // 전역 변수 이름. 안 읽으면 전역에만 있는 값이 전부 '어디에도 없음' 으로 잘못 잡혀
  // 미리보기가 없는 문제를 만들어낸다 — 거짓 경고는 경고 전체를 무시하게 만든다.
  const [globalVarNames, setGlobalVarNames] = useState<string[]>([])
  // 못 읽었다는 사실을 따로 들고 있는다. 빈 목록으로 뭉개면 바로 위 주석이 걱정한 그 일이
  // 벌어진다 — 전역에만 있는 값이 전부 '어디에도 없음' 으로 잡히고, 사람은 그 경고를
  // 한 번 무시하고 나면 진짜 경고도 안 본다.
  const [globalVarsUnknown, setGlobalVarsUnknown] = useState(false)
  useEffect(() => {
    let alive = true
    // 전역(모든 프로젝트)과 프로젝트 공통 둘 다 — 실행 때 둘 다 채워진다
    fetchSharedVars(workspaceId)
      .then(rows => { if (alive) { setGlobalVarNames(rows.map(v => v.key)); setGlobalVarsUnknown(false) } })
      .catch(() => { if (alive) { setGlobalVarNames([]); setGlobalVarsUnknown(true) } })
    return () => { alive = false }
  }, [workspaceId])
  const [search, setSearch] = useState('')
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameVal, setRenameVal] = useState('')
  const [running, setRunning] = useState(false)
  const [run, setRun] = useState<RunResult | null>(null)
  const [openStep, setOpenStep] = useState<number | null>(null)
  const [stepSettingsOpen, setStepSettingsOpen] = useState(false)
  const stepSettingsRef = useRef<HTMLDivElement>(null)
  const openSettings = (index: number) => { setOpenStep(index); setStepSettingsOpen(true); setStepDeleteArmed(null) }
  const closeSettings = () => { setStepSettingsOpen(false); setStepDeleteArmed(null) }
  useEffect(() => { setStepSettingsOpen(false); setStepDeleteArmed(null) }, [selected?.id])
  // [정리]가 되돌리기를 살린 채 값을 바꾸려면 편집기 본체가 필요하다(컬렉션과 같은 방식).
  const bodyEditorRef = useRef<HTMLTextAreaElement | null>(null)
  // 실행 모드: 자동(전부) / 단계(응답 확인 후 [다음] 클릭으로 진행)
  const [runMode, setRunMode] = useState<'auto' | 'step'>('auto')
  const [stepRuntime, setStepRuntime] = useState<Record<string, string>>({})
  // 단계 모드에서 secret 으로 추출된 변수 이름 — 서버로 왕복시켜 다음 스텝 마스킹을 유지.
  const [stepSecretNames, setStepSecretNames] = useState<string[]>([])
  // 목록 로드 완료 여부 — flowList 가 비어있을 때 '아직 안 옴'과 '정말 0개'를 구분해,
  // 공유 링크의 not-found 처리가 빈 워크스페이스에서 조용히 묻히지 않게 한다.
  const [loaded, setLoaded] = useState(false)
  // 지난 실행 — 새벽에 스케줄이 깨졌을 때 '어느 스텝에서 멈췄나'를 여기서 바로 본다.
  const [pastOpen, setPastOpen] = useState(false)
  const [past, setPast] = useState<FlowRunRow[] | null>(null)
  const [pastError, setPastError] = useState<string | null>(null)

  // 오류 처리가 아예 없었다. 셋 중 하나만 500 이어도 오류 객체가 상태에 들어가 .map 에서
  // 터졌고, 시나리오 화면이 통째로 날아갔다(처리되지 않은 rejection 도 났다).
  // 게다가 '못 불러옴' 이 '시나리오 0개' 로 보이면 있는 걸 또 만들게 된다.
  const [loadError, setLoadError] = useState<string | null>(null)

  const reload = useCallback(async (): Promise<Flow[] | null> => {
    try {
      let [fs, envs, folderList] = await Promise.all([
        fetchArray<Flow>(`/api/flows?workspaceId=${encodeURIComponent(workspaceId)}`),
        fetchArray<EnvironmentRow>(`/api/environments?workspaceId=${encodeURIComponent(workspaceId)}`),
        fetchArray<FolderRow>(`/api/folders?workspaceId=${encodeURIComponent(workspaceId)}`),
      ])
      setFolders(folderList)
      // 이 프로젝트에서 사라진 시나리오의 초안은 버린다 — 되살릴 자리가 없는데 앱이 꺼질 때까지 남아 있었다(codex 점검).
      const ids = new Set(fs.map(f => f.id))
      for (const [id, d] of unsavedDrafts) if (d.workspaceId === workspaceId && !ids.has(id)) unsavedDrafts.delete(id)
      const restored = fs.flatMap(f => { const d = unsavedDrafts.get(f.id); return d ? [d] : [] })
      if (restored.length) fs = fs.map(f => unsavedDrafts.get(f.id)?.flow ?? f)
      setFlowList(fs); setEnvironments(envs); setLoaded(true); setLoadError(null)
      // 목록을 읽은 시점의 저장 시각을 기억한다. 안 심어 두면 첫 저장이 잠금 없이 나가
      // 그 한 번은 남의 편집을 덮어쓸 수 있다.
      // 단 뒤로는 가지 않는다. 이 조회는 400ms 디바운스 저장과 겹칠 수 있어서, 방금 내 저장이
      // 돌려준 새 updatedAt 을 조회 응답의 옛 값이 덮어쓰곤 했다. 그러면 다음 저장이 옛 시각을
      // 들고 나가 서버가 409 를 준다 — 혼자 편집하는데 '다른 사람이 먼저 저장했다' 가 뜬다.
      for (const fl of fs) {
        if (typeof fl.updatedAt === 'number' && fl.updatedAt > (knownUpdatedAt.current[fl.id] ?? 0)) {
          knownUpdatedAt.current[fl.id] = fl.updatedAt
        }
      }
      for (const d of restored) {
        if (typeof d.base === 'number') knownUpdatedAt.current[d.flow.id] = d.base
        if (!pending.current) pending.current = d.flow
      }
      if (restored.length) {
        toast('error', i18nText('dynamicRevivedUnsavedScenarioEditsSaveAgain', { v0: String(restored.length) }))
        if (saveTimer.current) clearTimeout(saveTimer.current)
        saveTimer.current = setTimeout(() => { void flushSave() }, SAVE_DELAY_MS)
      }
      // 폴더 하나가 실패해도 나머지 요청은 고를 수 있게 한다 — 스텝을 못 만드는 것보다 낫다.
      const byFolder = await requestsByFolder(workspaceId, { slim: false })
      const reqs = await Promise.all(folderList.map(f =>
        Promise.resolve(byFolder[f.id] ?? [])))
      setAllRequests(reqs.flat())
      return fs
    } catch (e) {
      setLoadError(errorText(e))
      setLoaded(true)
      return null
    }
  }, [workspaceId])
  useEffect(() => { reload() }, [reload])

  // 공유 링크(?flow=<id>)로 진입: 목록 로드 완료 후 해당 시나리오를 자동 선택.
  useEffect(() => {
    if (!initialFlowId || !loaded) return
    const target = flowList.find(f => f.id === initialFlowId)
    if (target) {
      const sp = new URLSearchParams(window.location.search)
      const step = Number(sp.get('step'))
      pickFlow(target); setRun(null); setStepRuntime({})
      setOpenStep(sp.get('step') === 'none' ? null : target.steps.length ? (Number.isInteger(step) && step >= 1 && step <= target.steps.length ? step - 1 : 0) : null)
    }
    else toast('error', i18nText('dynamicSharedScenarioNotFoundDeletedOrAnotherProject'))
    onFlowConsumed?.()
  }, [initialFlowId, loaded, flowList, onFlowConsumed, toast])

  /**
   * 다른 화면에 다녀오면 보고 있던 시나리오를 다시 연다.
   *
   * 예전엔 일부러 목록부터 보여줬다. 시나리오를 드롭다운으로 고르던 시절에는 그게 맞바꿈이었다
   * — 선택을 복원하면 어떤 시나리오들이 있는지 보려고 드롭다운을 한 번 더 열어야 했다.
   * 지금은 목록이 늘 보이는 사이드바라 그 맞바꿈이 없다. 복원해도 목록은 그대로 다 보인다.
   *
   * 게다가 기준이 사용자에게 안 보이는 데서 갈렸다. 새로고침은 URL 의 ?flow= 로 복원되는데,
   * 레일을 옮겼다 오면 page.tsx 가 그 쿼리를 지워서 안 됐다. 쓰는 사람 입장에선 둘 다
   * '잠깐 다른 걸 보고 온 것' 인데 한쪽만 기억하는 셈이다.
   *
   * 마운트 직후 한 번만 본다 — 사용자가 목록으로 되돌린 것(selected=null)을 덮지 않는다.
   */
  const restored = useRef(false)
  useEffect(() => {
    if (restored.current || !loaded || initialFlowId) return
    restored.current = true
    const id = read(KEYS.scenarioFlow)
    if (!id || selected) return
    // 지워졌거나 다른 프로젝트 것이면 조용히 목록을 보여준다 — 없는 걸 두고 오류를 낼 일이 아니다.
    const target = flowList.find(f => f.id === id)
    if (target) { pickFlow(target); setOpenStep(target.steps.length ? 0 : null) }
  }, [loaded, initialFlowId, flowList, selected, pickFlow])

  // 보고 있는 시나리오·단계를 URL 에 남긴다 — 새로고침과 링크 공유가 같은 화면을 연다.
  useEffect(() => {
    if (!active || !loaded || initialFlowId) return
    const url = new URL(window.location.href)
    if (selected) {
      url.searchParams.set('flow', selected.id)
      url.searchParams.set('step', openStep === null ? 'none' : String(openStep + 1))
      url.searchParams.delete('stepTab')
    } else {
      for (const key of ['flow', 'step', 'stepTab']) url.searchParams.delete(key)
    }
    window.history.replaceState(window.history.state, '', url)
  }, [active, loaded, initialFlowId, selected?.id, openStep])

  // 패널을 열 때만 불러온다 — 시나리오를 고를 때마다 미리 받을 이유가 없다.
  const loadPast = useCallback(async () => {
    if (!selected) return
    try {
      setPast(await fetchArray<FlowRunRow>(`/api/flows/${selected.id}/runs`))
      setPastError(null)
    } catch (e) {
      // 못 불러온 걸 '아직 실행 기록이 없습니다' 로 보여주면 없는 줄 알고 넘어간다.
      setPastError(errorText(e))
      setPast([])
    }
  }, [selected])
  useEffect(() => { if (pastOpen) loadPast() }, [pastOpen, loadPast])
  // 시나리오를 바꾸면 이전 시나리오의 기록이 잠깐 보이지 않게 비운다
  useEffect(() => { setPast(null) }, [selected?.id])

  const reqName = (id: string) => allRequests.find(r => r.id === id)
  /**
   * 저장을 미뤄 모은다. 화면은 즉시 바뀌고 서버 쓰기만 늦춘다.
   *
   * persist 가 편집마다 바로 PUT 했다. 그런데 URL·바디·입력값 칸은 onChange 에 물려 있어서
   * 40자를 치면 PUT 이 40번 나갔다. 낭비만이 아니라 더 나쁜 게 있다 — 응답이 순서대로
   * 오지 않으면 나중에 도착한 예전 요청이 이겨서, 치다 만 값이 저장된 채로 남는다.
   * (서버는 매번 steps JSON 전체를 다시 쓰고, sharedVars 는 secret 유지를 위해 조회까지 한다)
   *
   * 마지막 편집만 보낸다. 화면을 떠나기 전에 남은 것이 있으면 그때 보낸다.
   */
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<Flow | null>(null)
  // 내가 알고 있는 마지막 저장 시각. 서버가 이것과 다르면 그 사이 다른 사람이 저장한 것이다.
  const knownUpdatedAt = useRef<Record<string, number>>({})
  const SAVE_DELAY_MS = 400
  /**
   * 저장 충돌 — 다른 사람이 먼저 저장한 시나리오.
   *
   * 예전엔 409 를 받자마자 knownUpdatedAt 을 서버의 새 시각으로 앞당겼다. 그러면 바로 다음
   * 타자가 그 시각을 들고 나가 통과했고, 방금 막았던 덮어쓰기가 한 박자 늦게 조용히 일어났다.
   * 안내는 [다시 불러오기] 를 누르라고 했지만 그런 버튼은 없었다.
   * 이제 충돌이 나면 그 시나리오의 저장을 멈추고(편집은 화면에 남는다), 둘 중 하나를 직접 고르게 한다.
   */
  // mine: 저장 못 한 내 편집. pending 과 따로 둔다 — 다른 시나리오를 만지다 pending 이 바뀌어도 잃지 않게.
  const [conflict, setConflict] = useState<{ flowId: string; serverUpdatedAt?: number; mine: Flow } | null>(null)
  const conflictRef = useRef(conflict)
  conflictRef.current = conflict
  useEffect(() => {
    // 입력 중 충돌이 오면 disabled 필드가 포커스를 잃는다. 닫기로 옮겨 Esc와 Tab을 계속 쓸 수 있게 한다.
    if (stepSettingsOpen && (running || conflict?.flowId === selected?.id)) {
      stepSettingsRef.current?.querySelector<HTMLButtonElement>('button[aria-label="닫기"]')?.focus()
    }
  }, [stepSettingsOpen, running, conflict?.flowId, selected?.id])

  const persist = (flow: Flow) => {
    pickFlow(flow)
    setFlowList(list => list.map(f => (f.id === flow.id ? flow : f)))
    // 충돌을 정리하기 전에는 보내지 않는다 — 보내 봐야 또 409 이고, 어느 쪽을 살릴지는 사람이 정한다.
    // 편집은 계속 받아서 '내 편집' 에 쌓아 둔다.
    const c = conflictRef.current
    if (c?.flowId === flow.id) {
      const next = { ...c, mine: flow }
      conflictRef.current = next
      setConflict(next)
      return
    }
    pending.current = flow
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => { void flushSave() }, SAVE_DELAY_MS)
  }

  /** 저장이 끝났으면(또는 보낼 것이 없으면) true. 실행 전에 이걸 보고 멈춘다. */
  /**
   * 전송 중인 저장. 예전엔 추적하지 않아서 '보낼 것 없음' 을 '저장 끝' 으로 착각했다 — 자동 저장이 전송 중일 때
   * [실행] 을 누르면 기다리지 않고 실행이 먼저 나갔고, 그 저장이 뒤늦게 409 가 나면 화면과 다른 것이 돌았다.
   * 두 저장이 엇갈려 도착할 수도 있었다. 이제 저장은 한 번에 하나씩, 실행은 그 끝을 기다린다.
   */
  const inflight = useRef<Promise<boolean> | null>(null)
  const flushSave = async (): Promise<boolean> => {
    let ok = true
    for (let cur = inflight.current; cur; cur = inflight.current === cur ? null : inflight.current) ok = (await cur) && ok
    const flow = pending.current
    if (!flow) return ok
    if (conflictRef.current?.flowId === flow.id) return false
    pending.current = null
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    const p = saveNow(flow)
    inflight.current = p
    try { return (await p) && ok } finally { if (inflight.current === p) inflight.current = null }
  }
  // 실패한 저장의 편집을 버리지 않는다. 예전엔 pending 을 비운 채 실패해서, 연결이 돌아온 뒤 [실행] 을
  // 누르면 '보낼 것 없음 = 저장 끝' 으로 보고 서버의 이전 정의를 돌렸다(codex 리뷰). 그 사이 더 친 것이
  // 있으면 그게 최신이라 덮지 않는다.
  const keepUnsaved = (flow: Flow) => {
    unsavedDrafts.set(flow.id, { flow, base: knownUpdatedAt.current[flow.id], workspaceId })
    if (!pending.current) pending.current = flow
  }
  const saveNow = async (flow: Flow): Promise<boolean> => {
    // 저장 fetch 실패(네트워크 블립·서버 재시작)를 잡지 않으면 처리되지 않은 에러가 앱 전체를 덮는다 →
    // 다른 액션들처럼 toast 로 알린다(로컬 편집은 유지되나 서버 미저장이므로 재시도 안내).
    try {
      const res = await fetch(`/api/flows/${flow.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: flow.name, steps: flow.steps, sharedVars: flow.sharedVars ?? [],
          ifUpdatedAt: knownUpdatedAt.current[flow.id],
        }),
      })
      if (res.ok) {
        const { updatedAt } = await res.json().catch(() => ({ updatedAt: undefined })) as { updatedAt?: number }
        if (typeof updatedAt === 'number') knownUpdatedAt.current[flow.id] = updatedAt
        if (unsavedDrafts.get(flow.id)?.flow === flow) unsavedDrafts.delete(flow.id)
        return true
      }
      if (res.status === 409) {
        // 앞사람의 스텝을 조용히 지우지 않는다. 내 편집은 pending 에 되돌려 두고(버리지 않는다)
        // 저장을 멈춘다. knownUpdatedAt 은 앞당기지 않는다 — 그게 덮어쓰기의 통로였다.
        const d = await res.json().catch(() => null) as { error?: string; updatedAt?: number } | null
        // 이 저장이 전송되는 사이 더 친 것이 있으면(pending) 그게 '내 편집' 의 최신이다. 그대로 두면 그 편집이
        // 충돌을 정리한 뒤 최신 시각을 들고 나가, 방금 고른 서버 버전을 조용히 덮었다(코덱스가 재현했다).
        const latest = pending.current?.id === flow.id ? pending.current : flow
        if (pending.current?.id === flow.id) {
          pending.current = null
          if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
        }
        const next = { flowId: flow.id, serverUpdatedAt: d?.updatedAt, mine: latest }
        conflictRef.current = next
        setConflict(next)
        toast('error', i18nText('dynamicChooseWhichSideYouWantToLeaveOnThe', { v0: String(d?.error ?? '다른 사람이 먼저 저장했습니다') }))
        return false
      }
      if (!res.ok) {
        // 404 는 시나리오가 사라진 것이라 '다시 시도' 가 틀린 안내다 — 눌러도 계속 실패한다.
        const why = await res.json().then(d => d?.error).catch(() => null)
        toast('error', res.status === 404
          ? i18nText('dynamicFailedToSaveScenarioCopyYourEditsAndCreate', { v0: String(why ?? '시나리오가 없습니다') })
          : i18nText('dynamicFailedToSaveScenarioPleaseTryAgain', { v0: String(res.status) }))
      }
      // 404 는 시나리오가 사라진 것 — 붙들고 있으면 다른 시나리오의 실행까지 매번 막는다(codex 리뷰).
      if (res.status !== 404) keepUnsaved(flow)
      else unsavedDrafts.delete(flow.id)
      return false
    } catch (e) {
      toast('error', i18nText('dynamicFailedToSaveScenario', { v0: String(errorText(e)) }))
      keepUnsaved(flow)
      return false
    }
  }

  // 충돌 정리 ① — 내 편집을 버리고 서버의 최신 내용으로 다시 연다.
  const takeLatest = async () => {
    const c = conflictRef.current
    if (!c) return
    // 남은 편집·예약 저장도 버린다 — 하나라도 남으면 정리 뒤 최신 시각을 들고 나가 서버 버전을 덮는다.
    if (pending.current?.id === c.flowId) {
      pending.current = null
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    }
    unsavedDrafts.delete(c.flowId)
    const fresh = await reload()
    // 못 불러온 것은 '삭제됐다' 가 아니다. 충돌과 내 편집을 그대로 두고 다시 시도하게 한다.
    if (fresh === null) { toast('error', i18nText('dynamicTheLatestContentFailedToLoadTheEditsWere')); return }
    const latest = fresh.find(f => f.id === c.flowId)
    conflictRef.current = null
    setConflict(null)
    if (latest) pickFlow(latest)
    else { pickFlow(null); toast('error', i18nText('dynamicMeanwhileTheScenarioWasDeleted')) }
  }
  // 충돌 정리 ② — 알고서 덮어쓴다. 서버 시각을 받아들이는 건 이때 한 번뿐이다.
  const overwriteWithMine = async () => {
    const c = conflictRef.current
    if (!c) return
    if (typeof c.serverUpdatedAt === 'number') knownUpdatedAt.current[c.flowId] = c.serverUpdatedAt
    conflictRef.current = null
    setConflict(null)
    pending.current = c.mine
    if (await flushSave()) toast('success', i18nText('dynamicISavedItAsMyEdit'))
  }

  // 시나리오 이름 변경 — persist 가 name 을 PUT 하고 flowList 라벨(드롭다운)도 갱신한다.
  const doRename = () => {
    const n = renameVal.trim()
    if (!selected || !n || n === selected.name) { setRenaming(false); return }
    persist({ ...selected, name: n })
    setRenaming(false)
  }

  // 미룬 저장이 남은 채로 화면을 떠나면 마지막 타자가 사라진다.
  // 언마운트·시나리오 전환·탭 닫힘 직전에 내보낸다.
  useEffect(() => {
    const onLeave = () => { if (pending.current) void flushSave() }
    window.addEventListener('beforeunload', onLeave)
    return () => {
      window.removeEventListener('beforeunload', onLeave)
      onLeave()
    }
    // flushSave 는 ref 만 읽으므로 의존성에 넣지 않는다(매 렌더 재등록을 피한다).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 다른 시나리오로 옮기기 전에도 내보낸다 — 안 그러면 앞 시나리오의 마지막 편집이 남는다.
  useEffect(() => {
    if (pending.current && pending.current.id !== selected?.id) void flushSave()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id])

  const createFlow = async () => {
    onActivate?.()
    if (!newName.trim()) return
    try {
      const res = await fetch('/api/flows', { method: 'POST', body: JSON.stringify({ name: newName.trim(), workspaceId }) })
      if (!res.ok) { toast('error', i18nText('dynamicScenarioCreationFailed', { v0: String(res.status) })); return }
      const created = await res.json()
      // 새 시나리오는 0스텝 — 이전 선택의 openStep 이 남으면 없는 스텝을 가리킨다.
      setNewName(''); setFlowList(l => [...l, created]); pickFlow(created); setRun(null); setOpenStep(null)
    } catch (e) {
      toast('error', i18nText('dynamicFailedToCreateScenario', { v0: String(errorText(e)) }))
    }
  }

  const deleteFlow = async () => {
    if (!deleteTarget || deleting || running) return
    const target = deleteTarget
    setDeleting(true)
    try {
      await flushSave()
      const res = await fetch(`/api/flows/${encodeURIComponent(target.id)}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(i18nText('dynamicDeletionFailed', { v0: String(res.status) }))
      unsavedDrafts.delete(target.id)
      setFlowList(list => list.filter(f => f.id !== target.id))
      if (selected?.id === target.id) {
        pickFlow(null); setRun(null); setOpenStep(null); setStepRuntime({}); setPastOpen(false); setRenaming(false)
      }
      setDeleteTarget(null)
      toast('success', i18nText('dynamicScenarioDeleted'))
    } catch (e) { toast('error', errorText(e)) }
    finally { setDeleting(false) }
  }

  const addStep = (requestId: string) => {
    if (!selected || !requestId) return
    persist({ ...selected, steps: [...selected.steps, { requestId, extracts: [] }] })
  }
  const removeStep = (i: number) => {
    if (!selected || running || conflictRef.current?.flowId === selected.id) return
    persist({ ...selected, steps: selected.steps.filter((_, idx) => idx !== i) })
  }
  const setExtracts = (i: number, extracts: ExtractRule[]) => {
    if (!selected || running || conflictRef.current?.flowId === selected.id) return
    persist({ ...selected, steps: selected.steps.map((s, idx) => (idx === i ? { ...s, extracts } : s)) })
  }
  // 스텝 바디 소스 변경 — template(저장 바디) / prev(직전 응답 통짜) / custom(직접 작성)
  const setStepBody = (i: number, patch: Partial<Pick<FlowStep, 'bodySource' | 'bodyOverride'>>) => {
    if (!selected || running || conflictRef.current?.flowId === selected.id) return
    persist({ ...selected, steps: selected.steps.map((s, idx) => (idx === i ? { ...s, ...patch } : s)) })
  }
  // 스텝 전용 입력값(pre) — 이 단계에서만 우선 적용(다음 단계로 전파 안 됨).
  const setStepVars = (i: number, vars: { key: string; value: string }[]) => {
    if (!selected || running || conflictRef.current?.flowId === selected.id) return
    persist({ ...selected, steps: selected.steps.map((st, idx) => (idx === i ? { ...st, vars } : st)) })
  }

  // 스텝별 요청값 오버라이드(Postman 처럼 이 단계에서 직접 편집). 없으면 템플릿 값을 시드로 쓴다.
  const setStepReq = (i: number, patch: Partial<Pick<FlowStep, 'params' | 'headers' | 'url' | 'name'>>) => {
    if (!selected || running || conflictRef.current?.flowId === selected.id) return
    persist({ ...selected, steps: selected.steps.map((st, idx) => (idx === i ? { ...st, ...patch } : st)) })
  }

  const setSharedVars = (sharedVars: SharedVar[]) => {
    if (!selected) return
    persist({ ...selected, sharedVars })
  }

  const runSequence = useRef(0)
  useEffect(() => {
    runSequence.current++
    setRun(null); setRunning(false); setStepRuntime({}); setStepSecretNames([])
    return () => { runSequence.current++ }
  }, [environmentId, selected?.id])

  const runFlow = async () => {
    if (!selected) return
    if (conflictRef.current?.flowId === selected.id) {
      // 화면(내 편집)과 서버(남의 저장)가 다르다 — 지금 실행하면 화면에 없는 것이 돈다.
      toast('error', i18nText('dynamicCleanUpAnySaveConflictsFirstYouCanDo'))
      return
    }
    // 서버는 저장된 것을 실행한다. 미룬 저장이 남아 있으면 방금 추가한 스텝이 없는 채로 돈다 —
    // 화면에는 보이는데 실행에는 없는 상태가 되고, 그건 도구를 못 믿게 만든다.
    const seq = ++runSequence.current
    // 저장이 안 됐으면 실행하지 않는다 — 서버는 저장된 것을 돌리므로, 화면과 다른 것이 실행된다.
    if (!(await flushSave())) return
    if (seq !== runSequence.current) return
    setRunning(true); setRun(null)
    try {
      const res = await fetch(`/api/flows/${selected.id}/run`, {
        method: 'POST',
        body: JSON.stringify({ environmentId: environmentId || undefined }),
      })
      const data = await res.json()
      if (seq !== runSequence.current) return
      if (!res.ok) { toast('error', i18nText('dynamicExecutionFailed', { v0: String(data.error ?? res.status) })); return }
      setRun(data)
      if (data.stoppedAt !== null) setOpenStep(data.stoppedAt)
      if (pastOpen) loadPast()
      toast(data.stoppedAt === null ? 'success' : 'error',
        data.stoppedAt === null
          ? i18nText('dynamicScenarioCompletedAllStepsSucceeded', { v0: String(data.steps.length) })
          : i18nText('dynamicStoppedAtStep', { v0: String(data.stoppedAt + 1), v1: String(data.steps[data.stoppedAt]?.error ?? '응답을 확인하세요') }))
    } catch (e) {
      if (seq !== runSequence.current) return
      toast('error', i18nText('dynamicFailedToRunScenario', { v0: String(errorText(e)) }))
    } finally {
      if (seq === runSequence.current) setRunning(false)
    }
  }

  // 단계 실행 — 다음 스텝 하나만 실행하고 결과를 누적, 응답을 자동으로 펼쳐 사용자가 확인하게 한다
  const runNextStep = async () => {
    if (!selected) return
    if (conflictRef.current?.flowId === selected.id) {
      // 화면(내 편집)과 서버(남의 저장)가 다르다 — 지금 실행하면 화면에 없는 것이 돈다.
      toast('error', i18nText('dynamicCleanUpAnySaveConflictsFirstYouCanDo'))
      return
    }
    const seq = ++runSequence.current
    if (!(await flushSave())) return   // 전체 실행과 같은 이유 — 서버는 저장된 것을 실행한다
    if (seq !== runSequence.current) return
    const idx = run?.steps.length ?? 0
    setRunning(true)
    try {
      const res = await fetch(`/api/flows/${selected.id}/run`, {
        method: 'POST',
        body: JSON.stringify({

          environmentId: environmentId || undefined,
          stepIndex: idx, runtime: stepRuntime, secretNames: stepSecretNames,
        }),
      })
      const data = await res.json()
      if (seq !== runSequence.current) return
      if (!res.ok) { toast('error', i18nText('dynamicExecutionFailed', { v0: String(data.error ?? res.status) })); return }
      const steps = [...(run?.steps ?? []), data.step]
      setRun({ steps, stoppedAt: data.failed ? idx : null, runtimeVariables: data.runtimeVariables })
      setStepRuntime(data.runtimeVariables)
      setStepSecretNames(data.secretNames ?? [])
      setOpenStep(idx)
      if (data.failed) toast('error', i18nText('dynamicStepFailed', { v0: String(idx + 1), v1: String(data.step?.error ?? '응답을 확인하세요') }))
      else if (!data.hasNext) toast('success', i18nText('dynamicScenarioCompletedAllStepsSuccessful'))
      else toast('info', i18nText('dynamicCompleteStepCheckTheResponseAndPressNext', { v0: String(idx + 1) }))
    } catch (e) {
      if (seq !== runSequence.current) return
      toast('error', i18nText('dynamicStepExecutionFailed', { v0: String(errorText(e)) }))
    } finally {
      if (seq === runSequence.current) setRunning(false)
    }
  }
  const resetRun = () => { setRun(null); setStepRuntime({}); setStepSecretNames([]) }

  const stepDone = run?.steps.length ?? 0
  const stepFailed = run?.stoppedAt !== null && run?.stoppedAt !== undefined
  const stepFinished = !!selected && stepDone >= selected.steps.length

  const policy = environments.find(e => e.id === environmentId)?.executionPolicy
  const blockedStep = selected?.steps.map(step => {
    const request = reqName(step.requestId)
    return request ? decideExecution({ policy, method: request.method, source: 'flow' }) : null
  }).find(decision => decision && !decision.allowed)

  const stepState = (i: number): 'ok' | 'fail' | 'idle' => {
    if (!run) return 'idle'
    const r = run.steps[i]
    if (!r) return 'idle'
    // 판정은 서버와 같은 함수로 — '404 를 기대' 한 스텝이 404 로 통과하면 초록이어야 한다.
    // 예전엔 여기서 HTTP 400 이상을 덧붙여, 서버는 성공이라는데 화면은 ✗ 로 그렸다.
    const failed = !!r.error || (!!r.execution && isFailedExecution(r.execution))
    return failed ? 'fail' : 'ok'
  }

  return (
    // 시안과 같은 3구역 고정 편집기: 툴바 / 캔버스 / PRE·POST 분할.
    // 이전엔 max-w-5xl 안에 박스를 쌓아서 화면 아래 절반이 늘 비어 있었다.
    <div className="flex min-h-0 w-full flex-1 text-ui-md">
      {sidebarContainer && createPortal(<section aria-label={i18nText('uiScenarioList')} className="flex min-h-0 w-full flex-col bg-surface">
        <div className="flex items-center justify-end px-2 py-1">

          <span className="flex items-center gap-1.5">
            <ToolButton icon="plus" type="button" aria-label={i18nText('uiCreateANewScenario')} className="rounded-[var(--radius-sm)] border border-border px-2 py-0.5 text-ui-sm text-muted-foreground hover:text-foreground" onClick={() => setCreating(true)} />

          </span>
        </div>
        <div className="px-2 py-1"><input aria-label={i18nText('uiScenarioSearch')} className="w-full ah-input" placeholder={i18nText('uiScenarioSearch')} value={search} onChange={e => setSearch(e.target.value)} /></div>
        {creating ? (
          <form className="flex flex-wrap items-center gap-1 border-b border-border px-2.5 py-2" onSubmit={e => { e.preventDefault(); createFlow(); setCreating(false) }}>
            <input
              autoFocus
              aria-label={i18nText('uiNewScenarioName')}
              className="w-44 rounded-[var(--radius-sm)] border border-accent bg-surface px-2 py-1.5 text-ui-lg text-foreground outline-none placeholder:text-faint-foreground"
              placeholder={i18nText('uiNewScenarioName')}
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); setCreating(false); setNewName('') } }}
            />
            <button type="submit" disabled={!newName.trim()} className="rounded-[var(--radius-sm)] bg-accent-solid px-2 py-1.5 text-ui-md font-semibold text-accent-solid-foreground hover:bg-accent-solid-hover disabled:opacity-50">{i18nText('uiCreate')}</button>
            <button type="button" className="ah-action rounded-[var(--radius-sm)] px-2 py-1.5 text-ui-md font-medium text-muted-foreground hover:text-foreground" onClick={() => { setCreating(false); setNewName('') }}>{i18nText('uiCancel')}</button>
            <span className="ml-1 text-ui-meta text-faint-foreground">{i18nText('uiConfirmWithEnterCancelWithEsc')}</span>
          </form>
        ) : null}

{loadError && <LoadFailed what={i18nText('uiScenarioList')} detail={loadError} onRetry={reload} />}
        <div className="min-h-0 px-1.5 py-1 text-ui-md">
          {/* 아직 못 불러왔을 때 '전체 0개' 라고 하면 진짜 0개와 구분이 안 된다 —
              기준 커밋엔 '불러오는 중…' 표시가 있었는데 개편하면서 빠졌다. */}
          <p className="px-2 pb-1 text-ui-sm text-faint-foreground">
            {!loaded && !loadError ? i18nText('jsxLoading') : <>{search ? i18nText('jsxSearchResults') : i18nText('jsxAll')} {flowList.filter(f => f.name.toLowerCase().includes(search.trim().toLowerCase())).length}{i18nText('uiCountSuffix')}</>}
          </p>
          {/* '없습니다' 로 끝내면 다음에 뭘 할지 모른다 — 만드는 버튼을 바로 둔다(만드는 중이면 위 입력칸이 그 자리다). */}
          {loaded && !loadError && flowList.length === 0 && (
            <div className="flex flex-col items-start gap-2 px-2 py-4">
              <p className="text-ui-md leading-relaxed text-faint-foreground">{i18nText('uiThereIsNoScenarioYetTryChainingMultipleRequests')}</p>
              {!creating && <button type="button" className="h-8 rounded-[var(--radius-sm)] bg-accent-solid px-3 text-ui-md font-semibold text-accent-solid-foreground hover:bg-accent-solid-hover" onClick={() => setCreating(true)}>{i18nText('uiCreateYourFirstScenario')}</button>}
            </div>
          )}
          {flowList.filter(f => f.name.toLowerCase().includes(search.trim().toLowerCase())).map(f => <button key={f.id} type="button" disabled={running || deleting} aria-label={i18nText('dynamicOpen', { v0: String(f.name) })} aria-pressed={selected?.id === f.id} title={f.name}
            className="flex w-full items-center gap-2 rounded-[var(--radius-sm)] h-7 px-2 text-left text-ui-md hover:bg-surface-2 aria-pressed:bg-accent/15 aria-pressed:text-accent disabled:opacity-50"
            onClick={() => { onActivate?.(); pickFlow(f); setRun(null); setOpenStep(f.steps.length ? 0 : null); setStepRuntime({}); setDeleteTarget(null); setRenaming(false); setPastOpen(false) }}>
            <span className="min-w-0 flex-1 truncate">{f.name}</span><span className="shrink-0 text-ui-sm text-faint-foreground">{t(f.steps.length === 1 ? 'scenarioListCountOne' : 'scenarioListCountOther', { count: f.steps.length })}</span>
          </button>)}
          {search && !flowList.some(f => f.name.toLowerCase().includes(search.trim().toLowerCase())) && <p className="px-2 py-4 text-ui-sm text-faint-foreground">{i18nText('uiNoSearchResults')}</p>}
        </div>
      </section>, sidebarContainer)}

    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {conflict && conflict.flowId === selected?.id && (
          <div role="alert" className="mt-3 flex flex-wrap items-center gap-3 rounded-[var(--radius-sm)] border border-method-put/40 bg-method-put/10 px-3 py-2.5 text-ui-md">
            <p className="min-w-0 flex-1 text-foreground">
              <b>{i18nText('uiSomeoneElseSavedThisScenarioFirst')}</b>{' '}
              <span className="text-muted-foreground">{i18nText('uiMyEditsHavenTBeenSavedYetChooseWhich')}</span>
            </p>
            <button type="button" className="rounded-[var(--radius-sm)] border border-border px-2 py-1 text-ui-sm disabled:opacity-40" onClick={() => void takeLatest()}>{i18nText('uiLoadLatestContentDiscardMyEdits')}</button>
            <button type="button" className="ah-btn text-method-delete" onClick={() => void overwriteWithMine()}>{i18nText('uiOverwriteWithMyEdit')}</button>
          </div>
        )}
        {deleteTarget && <div role="alert" className="mt-3 rounded-[var(--radius-sm)] border border-border p-3">
          <p><b>{deleteTarget.name}</b> {i18nText('uiShouldIDeleteTheScenario')}</p>
          <p className="my-2 text-ui-sm text-muted-foreground">{i18nText('uiLinkedSchedulesAreAlsoDeletedTheOriginalAPIRequest')}</p>
          <button type="button" disabled={deleting} className="ah-action mr-3 rounded-[var(--radius-sm)] border border-border px-3 py-1" onClick={() => setDeleteTarget(null)}>{i18nText('uiCancel')}</button>
          {/* 되돌릴 수 없는 쪽이 눈에 띄어야 한다. 예전엔 border-danger/text-danger 였는데
              danger 는 이 프로젝트에 없는 색이라 CSS 가 한 줄도 안 나왔고, 그래서 삭제 버튼이
              옆의 [취소] 와 똑같이 보였다. 같은 파일 '스텝 삭제' 와 같은 토큰을 쓴다. */}
          <button type="button" disabled={deleting || running} className="rounded-[var(--radius-sm)] border border-method-delete/60 px-3 py-1 text-method-delete hover:border-method-delete hover:bg-method-delete/10" onClick={() => void deleteFlow()}>{deleting ? i18nText('jsxDeleting') : i18nText('jsxConfirmScenarioDeletion')}</button>
        </div>}
      {/* 시나리오 선택/생성 + 실행 바 — 박스가 아니라 상단 툴바 */}
      <div className={selected ? "flex shrink-0 flex-wrap items-center gap-2 border-b border-border/70 px-4 py-2.5" : "hidden"}>

        {selected && <h2 className="min-w-0 truncate text-ui-lg font-semibold">{selected.name}</h2>}
        {selected && (renaming ? (
          <form className="flex items-center gap-1" onSubmit={e => { e.preventDefault(); doRename() }}>
            <input
              autoFocus
              aria-label={i18nText('uiScenarioName')}
              className="w-44 rounded-[var(--radius-sm)] border border-accent bg-surface px-2 py-1.5 text-ui-lg text-foreground outline-none focus-visible:border-accent"
              value={renameVal}
              onChange={e => setRenameVal(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); setRenaming(false) } }}
            />
            <button type="submit" disabled={!renameVal.trim()} className="rounded-[var(--radius-sm)] bg-accent-solid px-2 py-1.5 text-ui-md font-semibold text-accent-solid-foreground hover:bg-accent-solid-hover disabled:opacity-50">{i18nText('uiSave')}</button>
            <button type="button" className="ah-action rounded-[var(--radius-sm)] px-2 py-1.5 text-ui-md font-medium text-muted-foreground hover:text-foreground" onClick={() => setRenaming(false)}>{i18nText('uiCancel')}</button>
          </form>
        ) : (
          <ToolButton icon="edit" aria-label={i18nText('uiChangeScenarioName')}
            type="button"
            title={i18nText('uiChangeScenarioName')}
            className="rounded-[var(--radius-sm)] bg-transparent px-2 py-1.5 text-ui-md font-medium text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            onClick={() => { setRenameVal(selected.name); setRenaming(true) }}
           />
        ))}
        {selected && <ToolButton icon="trash" type="button" disabled={running || deleting} aria-label={i18nText('dynamicDelete', { v0: String(selected.name) })} className="ah-action rounded-[var(--radius-sm)] border border-border px-2 py-1 text-ui-sm text-muted-foreground hover:text-method-delete" onClick={() => setDeleteTarget(selected)} />}
        {selected && (
          <span className="ml-auto flex flex-wrap items-center gap-2 [&>*]:shrink-0 [&>*]:whitespace-nowrap">
            <ToolButton icon="link"
              type="button"
              title={i18nText('uiCopyTheLinkForThisScenarioOpeningItWill')}
              aria-label={i18nText('uiCopyScenarioSharingLink')}
              className="rounded-[var(--radius-sm)] bg-transparent px-2 py-1.5 text-ui-md font-medium text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
              onClick={async () => { const ok = await copyText(`${window.location.origin}/?flow=${selected.id}`); toast(ok ? 'success' : 'error', ok ? i18nText('jsxScenarioSharingLinkCopied') : i18nText('jsxCopyFailedYourBrowserMayHaveBlockedTheClipboard')) }}
             />
            <ToolButton icon="history" aria-label={i18nText('uiLastRun')}
              type="button"
              title={i18nText('uiPastExecutionsOfThisScenarioWhenAndAtWhat')}
              aria-pressed={pastOpen}
              className={`rounded-[var(--radius-sm)] border px-2 py-1.5 text-ui-md font-medium transition-colors ${
                pastOpen ? 'border-accent bg-accent/15 text-accent' : 'border-border text-muted-foreground hover:border-border-strong hover:text-foreground'
              }`}
              onClick={() => setPastOpen(v => !v)}
             />
            <span className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-ui-sm text-muted-foreground" title={i18nText('uiIfYouChangeTheExecutionEnvironmentAtTheTop')}>
              <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
              {i18nText('uiRunTarget')} <b className="font-medium text-foreground">{environments.find(e => e.id === environmentId)?.name ?? i18nText('jsxNoEnvironment')}</b>
            </span>
            <select
              aria-label={i18nText('uiExecutionMode')}
              title={i18nText('uiAutoExecuteEverythingSequentiallyStepCheckResponseAndProceed')}
              className="rounded-[var(--radius-sm)] border border-border bg-surface px-2 py-1.5 text-ui-lg text-muted-foreground outline-none focus-visible:border-accent"
              value={runMode}
              onChange={e => { setRunMode(e.target.value as 'auto' | 'step'); resetRun() }}
            >
              <option value="auto">{i18nText('uiAutorun')}</option>
              <option value="step">{i18nText('uiExecuteStepProceedAfterConfirmation')}</option>
            </select>
            {runMode === 'auto' ? (
              <button
                type="button"
                disabled={running || selected.steps.length === 0}
                className="rounded-[var(--radius-sm)] bg-accent-solid px-4 py-1.5 text-ui-lg font-semibold text-accent-solid-foreground transition-colors hover:bg-accent-solid-hover disabled:cursor-not-allowed disabled:opacity-50"
                onClick={runFlow}
              >
                {running ? i18nText('jsxRunning') : i18nText('jsxRunScenario')}
              </button>
            ) : stepFailed || stepFinished ? (
              <ToolButton icon="undo" aria-label={i18nText('uiFromTheBeginning')}
                type="button"
                className="rounded-[var(--radius-sm)] bg-transparent px-4 py-1.5 text-ui-lg font-medium text-muted-foreground hover:bg-surface-2 hover:text-foreground"
                onClick={resetRun}
               />
            ) : (
              <button
                type="button"
                disabled={running || selected.steps.length === 0}
                className="rounded-[var(--radius-sm)] bg-accent-solid px-4 py-1.5 text-ui-lg font-semibold text-accent-solid-foreground transition-colors hover:bg-accent-solid-hover disabled:cursor-not-allowed disabled:opacity-50"
                onClick={runNextStep}
              >
                {running ? i18nText('jsxRunning') : stepDone === 0 ? i18nText('jsxExecuteStep1') : i18nText('dynamicNext', { v0: String(stepDone + 1), v1: String(selected.steps.length) })}
              </button>
            )}
          </span>
        )}
      </div>

      {!selected ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-ui-lg text-faint-foreground">
          {/* 목록 실패 안내는 사이드바 안에 있다. 사이드바를 접어 두면(⌘E) 그 안내도 같이 숨어서, 본문엔
              '시나리오를 여세요' 만 떴다 — 목록을 못 부른 것을 '없다' 로 읽고 같은 걸 또 만들게 된다. */}
          {loadError && <LoadFailed what={i18nText('uiScenarioList')} detail={loadError} onRetry={reload} />}
          <p>{loaded && !loadError && flowList.length === 0 ? i18nText('jsxThereAreNoScenariosYetCreateANewOne') : i18nText('jsxOpenAScenarioFromTheListOrCreateA')}</p>
          <p className="text-ui-sm">{i18nText('uiYouCanExecuteMultipleAPIRequestsInSequenceAnd')}</p>

        </div>
      ) : (
        <>
          {blockedStep && !blockedStep.allowed && (
            <p data-testid="scenario-policy-notice" className="shrink-0 border-b border-border bg-surface-2 px-4 py-2 text-ui-sm text-method-delete">
              {blockedStep.reason}
            </p>
          )}
          {run?.stoppedAt != null && (
            <p role="alert" data-testid="scenario-run-error" className="shrink-0 border-b border-border px-4 py-2 text-ui-sm text-method-delete">
              {run.stoppedAt + 1}{i18nText('uiStepInterruption')} {run.steps[run.stoppedAt]?.error ?? run.steps[run.stoppedAt]?.execution?.error ?? i18nText('jsxCheckTheResponse')}
            </p>
          )}
          {/* 시나리오 입력값 — 1단계에 넣을 값과 전 단계 공통 값. 접어두면 "처음에 뭘 넣지?"를
              못 찾으므로 항상 펼쳐 두고, 비어 있을 때는 예시로 무엇을 넣는 곳인지 알려준다. */}
          {/* 비어 있을 때 큰 안내 박스를 띄우면 캔버스를 밀어내서, 없을 땐 한 줄로만 둔다 */}
          <section className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/70 px-4 py-1.5">
            <h3 className="shrink-0 text-ui-md font-bold text-foreground">{i18nText('uiCommonInputValues')}</h3>
            {(selected.sharedVars ?? []).length === 0 ? (
              <span className="text-ui-sm text-faint-foreground">
                {i18nText('uiAValueSharedByAllStepsExample')} <span className="font-mono text-muted-foreground">userId = test01</span> {i18nText('uiURLOf')} <span className="font-mono text-accent">{'{{userId}}'}</span> {i18nText('uiVariableFillsUrl')}
              </span>
            ) : (
              <span className="text-ui-sm text-faint-foreground">{i18nText('uiIfYouWantToDoItDifferentlyAtEach')} <b className="text-muted-foreground">{i18nText('uiInputsToThisStep')}</b>{i18nText('uiThisTakesPrecedence')}</span>
            )}

            <ToolButton icon="plus" aria-label={i18nText('uiAddInput')} type="button" className="shrink-0 rounded-[var(--radius-sm)] text-ui-md font-medium text-accent hover:text-accent-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" onClick={() => setSharedVars([...(selected.sharedVars ?? []), { key: '', value: '' }])} />

            <div className={`flex w-full flex-col gap-1.5 ${(selected.sharedVars ?? []).length ? 'pt-1' : 'hidden'}`}>
              {(selected.sharedVars ?? []).map((v, vi) => (
                <div key={vi} className="flex items-center gap-1.5">
                  <input aria-label={i18nText('uiInputName')} className="w-44 ah-input font-mono" placeholder="userId" value={v.key}
                    onChange={e => setSharedVars((selected.sharedVars ?? []).map((x, xi) => (xi === vi ? { ...x, key: e.target.value } : x)))} />
                  <span aria-hidden className="text-faint-foreground">=</span>
                  <input aria-label={i18nText('uiInputValue')} type={v.secret ? 'password' : 'text'}
                    className="ah-hint-sans w-56 ah-input font-mono"
                    placeholder={v.secret ? i18nText('jsxKeepStoredValues') : 'test01'} value={v.value}
                    onChange={e => setSharedVars((selected.sharedVars ?? []).map((x, xi) => (xi === vi ? { ...x, value: e.target.value } : x)))} />
                  {/* secret — 토큰·비밀번호처럼 DB 에 암호문으로 두고 이력에서도 {{이름}} 으로 가려야 하는 값 */}
                  <label className="flex shrink-0 items-center gap-1 text-ui-sm text-muted-foreground" title={i18nText('uiEncryptAndSaveInDBAndHideValuesIn')}>
                    <input type="checkbox" className="h-3.5 w-3.5" checked={!!v.secret}
                      onChange={e => setSharedVars((selected.sharedVars ?? []).map((x, xi) => (xi === vi ? { ...x, secret: e.target.checked } : x)))} />
                    secret
                  </label>
                  {v.key.trim() && (
                    <span className="font-mono text-ui-meta text-faint-foreground">→ {'{{'}{v.key.trim()}{'}}'}</span>
                  )}
                  <button type="button" aria-label={i18nText('uiDeleteInput')} className="ah-action ml-auto rounded-[var(--radius-sm)] px-1.5 py-1 text-ui-sm text-muted-foreground hover:text-method-delete focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent" onClick={() => setSharedVars((selected.sharedVars ?? []).filter((_, xi) => xi !== vi))}>{i18nText('uiDelete')}</button>
                </div>
              ))}
            </div>
          </section>

          {/* 지난 실행 — 캔버스 위에 얹지 않고 그 자리에서 펼친다(맥락을 잃지 않게) */}
          {pastOpen && (
            <section className="max-h-56 shrink-0 overflow-y-auto border-b border-border">
              {past === null && <SkeletonRows rows={3} />}
              {/* 위 loadPast 의 주석대로 못 불러온 것과 없는 것을 갈라 보여준다 —
                  pastError 를 담아만 두고 그리는 곳이 없어서, 조회 실패가 '기록 없음' 으로
                  보였다. 실패했는데 없다고 하면 그대로 넘어가게 된다. */}
              {pastError && (
                <p role="alert" className="px-4 py-4 text-center text-ui-md text-method-delete">
                  {i18nText('uiFailedToLoadPastRunsTheyAreNotEmpty')}<br />
                  <span className="text-ui-sm text-muted-foreground">{pastError}</span>
                </p>
              )}
              {!pastError && past?.length === 0 && (
                <p className="px-4 py-4 text-center text-ui-md text-faint-foreground">
                  {i18nText('uiThereIsNoExecutionHistoryYetWhenYouPress')}
                </p>
              )}
              {past?.map(r => {
                const ok = r.stoppedAt === null
                return (
                  <div key={r.id} className="flex items-start gap-3 border-b border-border/70 px-4 py-1.5 text-ui-md last:border-b-0">
                    <span className={`w-12 shrink-0 font-bold ${ok ? 'text-badge-new-fg' : 'text-method-delete'}`}>
                      {ok ? i18nText('jsxSuccess') : i18nText('dynamicStage', { v0: String(r.stoppedAt! + 1) })}
                    </span>
                    <span className="min-w-0 flex-1">
                      {/* 스텝 결과를 한 줄 띠로 — 어디서 끊겼는지 형태로 먼저 읽힌다 */}
                      <span className="flex flex-wrap items-center gap-1">
                        {r.steps.map((st, i) => (
                          <span
                            key={i}
                            title={`${i + 1}. ${st.name ?? ''} ${st.method ?? ''} ${st.url ?? ''} → ${st.error ?? st.status ?? '?'}`}
                            className={`rounded-[var(--radius-sm)] px-1.5 py-0.5 font-mono text-ui-meta ${
                              isFailedRow({ error: st.error, checkPassed: st.checkPassed ?? null, status: st.status })
                                ? 'bg-method-delete/15 text-method-delete'
                                : 'bg-badge-new-bg/60 text-badge-new-fg'
                            }`}
                          >
                            {i + 1}·{st.error ? 'ERR' : st.status}
                          </span>
                        ))}
                      </span>
                      {r.steps.map((st, i) => st.error && (
                        <span key={i} className="mt-1 block text-ui-sm text-method-delete">{i + 1}{i18nText('uiSteps')} {st.error}</span>
                      ))}
                    </span>
                    <span className="w-14 shrink-0 text-right font-mono text-ui-sm text-faint-foreground">{r.durationMs}ms</span>
                    <span className="w-28 shrink-0 text-right font-mono text-ui-sm text-faint-foreground">
                      {kstMonthDay(r.startedAt)}
                    </span>
                  </div>
                )
              })}
            </section>
          )}

          {/* 값 흐름 미리보기 — 돌려 보기 전에 연결이 이어져 있는지 본다 */}
          <FlowPreviewPanel
            onSelectStep={openSettings}
            steps={selected.steps}
            requests={allRequests.map(r => ({
              id: r.id, name: r.name, method: r.method, url: r.url,
              params: r.params, headers: r.headers, body: r.body,
            }))}
            knownVars={[
              ...(selected.sharedVars ?? []).map(v => v.key).filter(Boolean),
              ...(environments.find(e => e.id === environmentId)?.variables ?? []).map(v => v.key),
              ...globalVarNames,
            ]}
            // 전역 변수를 못 읽었으면 '어디에도 없음' 판정을 믿을 수 없다 — 미리보기가
            // 없는 문제를 만들어내는 대신, 못 읽었다고 말한다.
            unknownScope={globalVarsUnknown ? i18nText('jsxGlobalVariable') : null}
          />

          {/* 플로우차트 — 가로 노드 체인 */}
          <div className="ah-canvas flex h-[196px] shrink-0 items-center gap-0 overflow-x-auto rounded-none border-x-0 border-t-0 px-6">
            {selected.steps.length === 0 && (
              <span className="text-ui-lg text-faint-foreground">{i18nText('uiAddYourFirstStepRequestBelow')}</span>
            )}
            {selected.steps.map((s, i) => {
              const r = reqName(s.requestId)
              const state = stepState(i)
              const stopped = run?.stoppedAt === i
              return (
                <span key={i} className="flex shrink-0 items-center">
                  {i > 0 && (() => {
                    // 이름을 채운 규칙만 라벨로 — 빈 규칙까지 그리면 '{{}}' 같은 정체불명 표시가 된다.
                    const rules = selected.steps[i - 1].extracts ?? []
                    const named = rules.filter(x => x.variable.trim())
                    const incomplete = rules.length - named.length
                    // 시안처럼 '선 위에 얹힌 칩' — 앞 단계가 뒤 단계로 무엇을 넘기는지가 연결선 자체에 보인다.
                    return (
                      // 폭을 고정한다 — flex-1 로 두면 좁아진 연결선 위에서 칩이 넘쳐 노드를 덮는다.
                      <span className="relative flex w-[148px] shrink-0 items-center" aria-hidden={named.length === 0 && incomplete === 0}>
                        <span className="h-px w-full bg-border" />
                        {(named.length > 0 || incomplete > 0) && (
                          <span className="absolute left-1/2 top-1/2 flex max-w-[140px] -translate-x-1/2 -translate-y-1/2 items-center gap-1">
                            {named.length > 0 && (
                              <span className="ah-chip ah-chip-accent min-w-0 truncate" title={named.map(x => `{{${x.variable.trim()}}}`).join(' ')}>
                                {named.map(x => `{{${x.variable.trim()}}}`).join(' ')}
                              </span>
                            )}
                            {incomplete > 0 && (
                              <span className="ah-chip shrink-0 border-method-put/50 text-method-put" title={i18nText('dynamicStepHasExtractionRulesWithEmptyNamePleaseFill', { v0: String(i), v1: String(incomplete) })}>⚠ {incomplete}</span>
                            )}
                          </span>
                        )}
                      </span>
                    )
                  })()}
                  <button
                    type="button"
                    onClick={() => openSettings(i)}
                    // 실행 결과도 이름에 넣는다 — 카드에 보이는 ✓ 200 이 스크린리더에선 들리지 않았다.
                    aria-label={i18nText('dynamicStepSettings2', { v0: String(i + 1), v1: String(s.name || r?.name || i18nText('jsxDeletedRequest')), v2: String(state === 'ok' ? ` · ✓ ${run?.steps[i]?.execution?.responseStatus}`
                      : state === 'fail' ? ` · ✗ ${run?.steps[i]?.execution?.responseStatus ?? 'ERR'}${stopped ? i18nText('jsxInterruption') : ''}`
                      : '') })}
                    className={`ah-node ${openStep === i ? 'ah-node-active' : ''} flex min-w-[204px] flex-col gap-2 px-4 py-3 text-left ${
                      state === 'ok' ? 'border-badge-new-fg/60'
                      : state === 'fail' ? 'border-method-delete/60'
                      : ''
                    } ${runMode === 'step' && !stepFailed && i === stepDone && !stepFinished ? 'animate-pulse ring-2 ring-accent/60' : ''}`}
                  >
                    <span className="flex items-center gap-2">
                      <span className="ah-node-num">{i + 1}</span>
                      {state === 'ok' && <span className="text-ui-meta font-semibold text-badge-new-fg">✓ {run?.steps[i]?.execution?.responseStatus}</span>}
                      {state === 'fail' && <span className="text-ui-meta font-bold text-method-delete">✗ {run?.steps[i]?.execution?.responseStatus ?? 'ERR'}{stopped ? i18nText('jsxInterruption') : ''}</span>}
                      <span className={`ml-auto shrink-0 rounded-[var(--radius-sm)] border px-1.5 py-0.5 font-mono text-ui-meta font-bold ${methodPill(r?.method ?? '')}`}>{r?.method ?? '?'}</span>
                    </span>
                    <span className="max-w-[200px] truncate text-ui-md text-foreground">{s.name || r?.name || i18nText('jsxRequestRemoved')}</span>
                  </button>
                </span>
              )
            })}
            {/* 인라인 스텝 추가 — 요청 선택 영역까지 내려가지 않아도 체인에서 바로 (시안 반영) */}
            <button
              type="button"
              title={i18nText('uiAddStepPickARequestFromAFolder')}
              aria-label={i18nText('uiAddStep')}
              className="ah-action flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-dashed border-border text-[18px] leading-none text-faint-foreground transition-colors hover:border-accent hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              onClick={() => setPickerOpen(true)}
            >{i18nText('uiAdd')}</button>
          </div>

          {/* 스텝 추가 — 캔버스의 [+] 와 같은 폴더 선택기를 연다. */}
          <div className="flex shrink-0 items-center gap-2 border-b border-border/70 px-4 py-1.5">
            <label htmlFor="flow-add-step" className="ah-label shrink-0">{i18nText('uiAddStep')}</label>
            <button id="flow-add-step" type="button" aria-label={i18nText('uiRequestToAdd')} className="rounded-[var(--radius-sm)] border border-border px-3 py-1 text-ui-md text-accent hover:bg-surface-2" onClick={() => setPickerOpen(true)}>{i18nText('uiSelectRequestFromFolder')}</button>
            <span className="ml-auto shrink-0 text-ui-sm text-faint-foreground">{stepCount(selected.steps.length)}</span>
          </div>

          {pickerOpen && <ScenarioRequestPicker folders={folders} requests={allRequests}
            onClose={() => setPickerOpen(false)} onPickMany={requests => {
              const first = selected.steps.length
              persist({ ...selected, steps: [...selected.steps, ...requests.map(r => ({ requestId: r.id, extracts: [] }))] })
              setOpenStep(first); setPickerOpen(false)
            }} onPick={request => {
              setAllRequests(prev => prev.some(r => r.id === request.id) ? prev : [...prev, request])
              addStep(request.id); setOpenStep(selected.steps.length); setPickerOpen(false)
              if (!allRequests.some(r => r.id === request.id)) void reload()
            }} />}

          <p className="px-6 py-4 text-ui-sm text-faint-foreground">{i18nText('uiWhenYouPressTheStepCardYouCanSet')}</p>
          <div ref={stepSettingsRef} className="min-h-0 flex-1 overflow-auto">
            {selected.steps.map((s, i) => {
              if (!stepSettingsOpen || openStep !== i) return null
              const r = reqName(s.requestId)
              const res = run?.steps[i]
              // URL 의 쿼리와 표를 먼저 맞춘다(컬렉션이 요청을 열 때 하는 것과 같다).
              // 옛 데이터는 둘이 어긋나 있을 수 있는데, 그대로 두고 URL 만 고치면 표에 있던
              // 항목이 소리 없이 사라진다. 맞춰 두면 어느 쪽을 고치든 다른 쪽이 따라온다.
              const eff = reconcile(s.url ?? r?.url ?? '', (s.params ?? r?.params ?? []) as KV[])
              const editBlocked = running || conflict?.flowId === selected.id
              const suppliedNames = new Set([
                ...(selected.sharedVars ?? []).filter(v => v.value.trim() || v.secret).map(v => v.key),
                ...(environments.find(e => e.id === environmentId)?.variables ?? []).map(v => v.key), ...globalVarNames,
              ])
              const preview = previewFlow(selected.steps, new Map(allRequests.map(request => [request.id, request])), suppliedNames).steps[i]
              const requiredNames = r ? extractVariables({ method: r.method, bodyType: r.bodyType, url: eff.url, params: eff.params, headers: [],
                body: s.bodySource === 'prev' ? '' : s.bodySource === 'custom' ? s.bodyOverride ?? '' : r.body,
              }) : []
              requiredNames.push(...extractPathParameters(eff.url).filter(name => !requiredNames.includes(name)))
              const importantNames = requiredNames.filter(name => {
                if (s.vars?.some(v => v.key === name)) return true
                if (suppliedNames.has(name)) return false
                if (selected.steps.slice(0, i).some(step => step.extracts?.some(rule => rule.variable.trim() === name && rule.path.trim()))) return false
                return preview.consumes.find(c => c.name === name)?.origin.kind !== 'auto'
              })
              return (
                <ModalFrame key={i} label={i18nText('uiStepSettings')} width="w-[min(1120px,94vw)]" onClose={closeSettings}>
                  <ModalHeader title={i18nText('dynamicStepSettings3', { v0: String(i + 1) })} onClose={closeSettings}>
                    <button type="button" className="rounded-[var(--radius-sm)] border border-border px-2 py-1 text-ui-sm disabled:opacity-40" disabled={i === 0} onClick={() => openSettings(i - 1)}>{i18nText('uiPreviousStep')}</button>
                    <button type="button" className="rounded-[var(--radius-sm)] border border-border px-2 py-1 text-ui-sm disabled:opacity-40" disabled={i === selected.steps.length - 1} onClick={() => openSettings(i + 1)}>{i18nText('uiNextStep')}</button>
                    <span className="text-ui-sm text-faint-foreground">{i18nText('uiChangedValuesAreAutomaticallySaved')}</span>
                  </ModalHeader>
                  {editBlocked && <p role="status" aria-label={i18nText('uiStepEditStatus')} className="px-5 py-3 text-ui-sm text-method-put">{running ? i18nText('jsxStepsCannotBeEditedWhileRunning') : i18nText('jsxEditingAbortedDueToSaveConflictCloseTheWindow')}</p>}
                  <div className="min-h-0 overflow-y-auto p-5">
                  <fieldset disabled={editBlocked} className="min-w-0 space-y-5 disabled:opacity-60">
                  <div className="flex items-center gap-2">
                    <label className="flex flex-1 items-center gap-2 text-ui-sm">{i18nText('uiStepName')}
                      <input aria-label={i18nText('uiStepName')} className="ah-input flex-1" value={s.name ?? r?.name ?? ''} onChange={e => setStepReq(i, { name: e.target.value })} />
                    </label>
                    {/* 한 번에 지우지 않는다. 스텝에는 직접 쓴 바디·입력값·추출 규칙이 들어 있고, 지우면
                        400ms 뒤 자동 저장돼 되돌릴 길이 없다. 시나리오·요청 삭제처럼 두 번 눌러야 지운다. */}
                    <button type="button"
                      className={`ml-auto rounded-[var(--radius-sm)] border px-2 py-0.5 text-ui-sm ${stepDeleteArmed === i ? 'border-method-delete bg-method-delete/10 font-semibold text-method-delete' : 'border-border text-method-delete/80 hover:border-method-delete/50 hover:text-method-delete'}`}
                      onBlur={() => setStepDeleteArmed(null)}
                      onClick={() => {
                        if (stepDeleteArmed !== i) { setStepDeleteArmed(i); return }
                        setStepDeleteArmed(null)
                        removeStep(i)
                        if (selected.steps.length > 1) openSettings(Math.max(0, i - 1))
                        else { setOpenStep(null); closeSettings() }
                      }}>
                      {stepDeleteArmed === i ? i18nText('jsxClickOnceMoreToDeleteIncludingBodyInputValue') : i18nText('jsxDeleteStep')}
                    </button>
                  </div>

                  <section aria-label={i18nText('uiValueToFillFirst')} className="space-y-3 rounded-[var(--radius-md)] border border-accent/40 bg-accent/5 p-4">
                    <h3 className="text-ui-lg font-semibold">{i18nText('uiValuesRequiredForExecutionValuesToBeUsedDifferently')}</h3>
                    {importantNames.length === 0 && <p className="text-ui-sm text-muted-foreground">{i18nText('uiRequiredVariablesAreFilledInFromCommonInputsEnvironment')}</p>}
                    {globalVarsUnknown && <p className="text-ui-sm text-method-put">{i18nText('uiFailedToReadGlobalVariableTheValuesBelowMay')}</p>}
                    {importantNames.map(name => <label key={name} className="flex items-center gap-3 text-ui-sm">
                      <code className="w-40 shrink-0 break-all">{name}</code>
                      <input aria-label={i18nText('dynamicRequiredValue', { v0: String(name) })} className="ah-input flex-1" placeholder={i18nText('uiValuesToUseForThisStep')} value={s.vars?.find(v => v.key === name)?.value ?? ''}
                        onChange={e => setStepVars(i, [...(s.vars ?? []).filter(v => v.key !== name), ...(e.target.value ? [{ key: name, value: e.target.value }] : [])])} />
                    </label>)}
                          {r && (
                            <>
                              <p className="pb-1 text-ui-meta text-faint-foreground">{i18nText('uiQueryParametersValuesToSendToTheAddress')} {i18nText('variablePlaceholder')} {i18nText('uiThePositionsAreFilledWithTheAboveInputValues')}</p>
                              <KVEditor items={eff.params}
                                onChange={next => setStepReq(i, { params: next, url: urlFromParams(eff.url, next) })} />
                            </>
                          )}
                    <details><summary className="cursor-pointer text-ui-sm">{i18nText('uiCheckRouteParametersAndAutomaticConnection')}</summary>                          {r && <div className="space-y-2">
                            <p className="text-ui-meta text-faint-foreground">{i18nText('uiAddressOf')} {'{orderId}'} {i18nText('uiThisIsTheValueToBePlacedInThe')}</p>
                            {extractPathParameters(eff.url).length === 0 && <p className="text-ui-sm text-muted-foreground">{i18nText('uiTheAddressHasNoRouteParametersAddYourName')} {i18nText('pathParameterPlaceholder')} {i18nText('uiWriteItYourself')}</p>}
                            <AddPathParam onAdd={name => setStepReq(i, { url: addPathParam(eff.url, name), params: eff.params })} />
                            {extractPathParameters(eff.url).map(name => {
                              const producer = selected.steps.slice(0, i).findLastIndex(st => st.extracts?.some(x => x.variable.trim() === name))
                              const extraction = producer >= 0 ? selected.steps[producer].extracts?.find(x => x.variable.trim() === name) : undefined
                              const received = producer >= 0 ? run?.steps[producer]?.extracted?.[name] : undefined
                              const own = s.vars?.find(v => v.key === name)?.value ?? ''
                              return <div key={name} className="space-y-2 rounded-[var(--radius-sm)] border border-border p-2">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="font-mono text-method-patch">{name}</span>
                                  {producer < 0 && <span className="text-ui-meta text-muted-foreground">{i18nText('uiRequired')}</span>}
                                  {producer >= 0 && <span className="text-ui-sm text-accent">{own ? i18nText('jsxUseDirectInput') : i18nText('dynamicAutomaticConnectionLevelResponse', { v0: String(producer + 1) })}</span>}
                                </div>
                                {extraction && <div className="break-all text-ui-sm text-muted-foreground">
                                  <span className="font-mono">{extraction.path}</span>
                                  <span> → </span>
                                  {received !== undefined
                                    ? <span className="font-mono text-foreground">{extraction.secret ? i18nText('jsxSecretValue') : received}</span>
                                    : <span>{run?.steps[producer] ? i18nText('jsxNoPaymentReceivedCheckTheExtractionResultsForThat') : i18nText('dynamicAutomaticallyPopulatedAfterExecutionOfStep', { v0: String(producer + 1) })}</span>}
                                </div>}
                                <label className="block space-y-1">
                                  <span className="text-ui-meta text-faint-foreground">{producer >= 0 ? i18nText('jsxSpecifyDirectlyAutomaticallyConnectsWhenSelectedEmptied') : i18nText('jsxValue')}</span>
                                  <input aria-label={i18nText('dynamicPathParameter', { v0: String(name) })} className="w-full min-w-0 rounded-[var(--radius-sm)] border border-border bg-surface px-2 py-1 font-mono text-ui-sm" value={own} placeholder={producer >= 0 ? i18nText('jsxAutomaticallyUsesTheReceivedValue') : i18nText('jsxEnterValue')}
                                    onChange={e => setStepVars(i, [...(s.vars ?? []).filter(v => v.key !== name), ...(e.target.value ? [{ key: name, value: e.target.value }] : [])])} />
                                </label>
                              </div>
                            })}
                            {extractPathParameters(eff.url).length > 0 && (
                              // 값을 넣어도 위 URL 은 {id} 그대로라 '무엇이 나가는지' 를 확인할 자리가 없었다.
                              // 컬렉션의 '요청 URL 미리보기' 와 같은 역할.
                              <details className="text-ui-sm text-muted-foreground">
                                <summary className="cursor-pointer py-1">{i18nText('uiViewAddressToSendWithThisValue')}</summary>
                                <p className="break-all py-1 font-mono" aria-label={i18nText('uiInterpretedRequestAddress')}>
                                  {extractPathParameters(eff.url).reduce((url, name) => {
                                    const own = (s.vars?.find(v => v.key === name)?.value ?? '').trim()
                                    return url.replaceAll(`{${name}}`, own || `{${name}}`)
                                  }, eff.url)}
                                </p>
                              </details>
                            )}
                          </div>}
</details>
                    <details><summary className="cursor-pointer text-ui-sm">{i18nText('uiSpecifyOtherStepInputs')}</summary>                    {/* 이 단계 전용 입력값 — 같은 요청을 단계마다 다른 값으로 */}
                    <div className="flex flex-col gap-1 border-t border-border pt-2">
                      {/* 위의 쿼리 파라미터와 표 모양이 똑같아서 같은 것으로 읽힌다 —
                          하나는 '보내는 것', 하나는 '{{자리}}를 채우는 것' 이라 전혀 다르다.
                          그 차이를 여기서 말한다. */}
                      <p className="text-ui-meta leading-relaxed text-faint-foreground">
                        <b className="text-muted-foreground">{i18nText('uiInputsToThisStep')}</b> {i18nText('uiThisValueItselfIs')} <b className="text-muted-foreground">{i18nText('uiNotSent')}</b>{i18nText('uiWrittenInTheAboveURLParametersHeaderAndBody')} <span className="font-mono text-accent">{i18nText('doublePathParameterPlaceholder')}</span> {i18nText('uiFillsThePlace')}
                        <br />
                        {i18nText('uiIfTheSameNameExistsInMultiplePlaces')} <span className="text-muted-foreground">{i18nText('uiPersonalThisStepCommonInputsEnvironmentGlobal')}</span> {i18nText('uiWriteTheValueFoundFirstInOrder')}
                      </p>
                      {/* 지금 이 단계가 실제로 쓰는 이름을 보여준다 — 어디에도 안 쓰이는 이름을
                          적어 두면 아무 일도 안 일어나는데, 그걸 알 방법이 없었다. */}
                      {(() => {
                        const used = extractVariables({
                          method: reqName(s.requestId)?.method ?? 'GET', bodyType: 'json',
                          url: s.url ?? reqName(s.requestId)?.url ?? '',
                          params: (s.params ?? reqName(s.requestId)?.params ?? []) as KV[],
                          headers: (s.headers ?? reqName(s.requestId)?.headers ?? []) as KV[],
                          body: s.bodySource === 'custom' ? (s.bodyOverride ?? '') : (reqName(s.requestId)?.body ?? ''),
                        })
                        used.push(...extractPathParameters(s.url ?? reqName(s.requestId)?.url ?? '').filter(name => !used.includes(name)))
                        const unused = (s.vars ?? []).filter(v => v.key && !used.includes(v.key)).map(v => v.key)
                        return (
                          <p className="text-ui-meta leading-relaxed">
                            {used.length > 0 && (
                              <span className="text-faint-foreground">
                                {i18nText('uiThisStepUses')} {used.map(n => <code key={n} className="mr-1 font-mono text-accent">{`{{${n}}}`}</code>)}
                              </span>
                            )}
                            {unused.length > 0 && (
                              <span className="block text-method-delete">
                                {unused.map(n => `'${n}'`).join(', ')} {i18nText('uiIsNotUsedAnywhereInThisStepAndHas')}
                              </span>
                            )}
                          </p>
                        )
                      })()}
                      {/* 경로 파라미터는 [경로 파라미터] 칸에서만 고친다. 여기에도 같은 이름이 또 나오면
                          별개 값으로 보이고, 여기서 이름을 바꾸거나 지우면 경로 입력이 같이 사라졌다.
                          컬렉션도 같은 이유로 경로 이름을 이 목록에서 뺀다. */}
                      {(s.vars ?? []).map((v, vi) => extractPathParameters(s.url ?? r?.url ?? '').includes(v.key) ? null : (
                        <div key={vi} className="flex items-center gap-1.5">
                          <input aria-label={i18nText('uiStepInputName')} className="w-36 ah-input font-mono text-ui-sm" placeholder="userId" value={v.key}
                            onChange={e => setStepVars(i, (s.vars ?? []).map((x, xi) => (xi === vi ? { ...x, key: e.target.value } : x)))} />
                          <span aria-hidden className="text-faint-foreground">=</span>
                          <input aria-label={i18nText('uiStepInput')} className="min-w-0 flex-1 ah-input font-mono text-ui-sm" placeholder="test01" value={v.value}
                            onChange={e => setStepVars(i, (s.vars ?? []).map((x, xi) => (xi === vi ? { ...x, value: e.target.value } : x)))} />
                          <button type="button" aria-label={i18nText('uiDeleteInput')} className="ah-action rounded-[var(--radius-sm)] px-1 py-1 text-ui-sm text-muted-foreground hover:text-method-delete" onClick={() => setStepVars(i, (s.vars ?? []).filter((_, xi) => xi !== vi))}>{i18nText('uiDelete')}</button>
                        </div>
                      ))}
                      <button type="button" className="self-start text-ui-sm font-medium text-accent hover:text-accent-hover" onClick={() => setStepVars(i, [...(s.vars ?? []), { key: '', value: '' }])}>{i18nText('uiInputsForThisStep')}</button>
                    </div>
</details>
                  </section>
                    {/* 요청 줄 — 메서드 pill + URL(편집 가능) */}
                    {r && (
                      <div className="flex items-center gap-1.5">
                        <span className={`shrink-0 rounded-[var(--radius-sm)] border px-1.5 py-1 font-mono text-ui-meta font-bold ${methodPill(r.method)}`}>{r.method}</span>
                        <div className="relative min-w-0 flex-1">
                          <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-all rounded-[var(--radius-sm)] border border-transparent bg-surface px-2 py-1 font-mono text-ui-sm leading-6 text-foreground">{renderVarHighlight(eff.url)}</div>
                          <textarea aria-label={i18nText('uiThisStepURL')} rows={4} spellCheck={false} className="relative block w-full resize-y whitespace-pre-wrap break-all rounded-[var(--radius-sm)] border border-border bg-transparent px-2 py-1 font-mono text-ui-sm leading-6 text-transparent caret-[var(--foreground)] outline-none focus-visible:border-accent"
                            value={eff.url} onChange={e => {
                              // 컬렉션과 같은 규칙으로 URL 과 쿼리 표를 맞춘다. 예전엔 따로 놀아서
                              // URL 의 ?id=1 을 2로 고쳐도 표에 남은 1이 실제로 나갔다.
                              const url = e.target.value.replace(/[\r\n]/g, '')
                              setStepReq(i, { url, params: paramsFromUrl(url, eff.params) })
                            }}
                            onScroll={e => { const backdrop = e.currentTarget.previousElementSibling; if (backdrop) { backdrop.scrollLeft = e.currentTarget.scrollLeft; backdrop.scrollTop = e.currentTarget.scrollTop } }} />
                        </div>
                        <CopyButton value={eff.url} title={i18nText('uiCopyThisStepAddress')} />
                        {Boolean(s.params || s.headers || s.url || s.vars?.length) && (
                          <button type="button" title={i18nText('uiClearsEditingOfThisStepAndRevertsToSaved')}
                            className="shrink-0 rounded-[var(--radius-sm)] border border-border px-1.5 py-1 text-ui-meta text-faint-foreground transition-colors hover:border-method-delete hover:text-method-delete"
                            onClick={() => setStepReq(i, { params: undefined, headers: undefined, url: undefined })}>
                            {i18nText('uiRevert')}
                          </button>
                        )}
                      </div>
                    )}

                  {/* ── POST : 이 단계가 만드는 값 ── */}
                  <section className="flex min-w-0 flex-col gap-3 rounded-[var(--radius-md)] border border-border p-4">
                    <p className="flex items-center gap-1.5 ah-label">
                      <span className="rounded-[var(--radius-sm)] border border-badge-new-fg/40 bg-badge-new-bg px-1 py-0.5 font-mono text-ui-meta normal-case tracking-normal text-badge-new-fg">POST</span>
                      {i18nText('uiTheValueThisStepCreates')}
                    </p>
                    <p className="text-ui-meta leading-relaxed text-faint-foreground">
                      {i18nText('uiResponsePathEG')} <span className="font-mono text-muted-foreground">data.id</span>{i18nText('uiTheValueIsSavedAsAVariableAndCan')}
                    </p>

                    {(s.extracts ?? []).map((x, xi) => {
                      const incomplete = !x.path.trim() || !x.variable.trim()
                      return (
                        <div key={xi} className="flex items-center gap-1.5">
                          <input
                            aria-label={i18nText('uiExtractionPath')}
                            className={`min-w-0 flex-1 rounded-[var(--radius-sm)] border bg-surface px-2 py-1 font-mono text-ui-sm text-foreground outline-none placeholder:text-faint-foreground focus-visible:border-accent ${incomplete ? 'border-method-put/50' : 'border-border'}`}
                            placeholder="data.accessToken"
                            value={x.path}
                            onChange={e => setExtracts(i, s.extracts.map((y, yi) => (yi === xi ? { ...y, path: e.target.value } : y)))}
                          />
                          <span aria-hidden className="shrink-0 text-faint-foreground">→</span>
                          <input
                            aria-label={i18nText('uiVariableName')}
                            className={`w-28 shrink-0 rounded-[var(--radius-sm)] border bg-surface px-2 py-1 font-mono text-ui-sm text-foreground outline-none placeholder:text-faint-foreground focus-visible:border-accent ${incomplete ? 'border-method-put/50' : 'border-border'}`}
                            placeholder="accessToken"
                            value={x.variable}
                            onChange={e => setExtracts(i, s.extracts.map((y, yi) => (yi === xi ? { ...y, variable: e.target.value } : y)))}
                          />
                          {/* 뽑은 값이 토큰이면 이력에 남으면 안 된다. 헤더에 넣을 때는
                              헤더 이름 덕에 우연히 가려졌지만, URL 쿼리(?access_token=)나
                              바디에 넣으면 그대로 보였다 — 값 기준으로 가리려면 여기서 표시해야 한다. */}
                          <label
                            className="flex shrink-0 cursor-pointer items-center gap-1 text-ui-meta text-faint-foreground"
                            title={i18nText('uiTheExtractedValuesAreHiddenFromTheExecutionHistory')}
                          >
                            <input
                              type="checkbox"
                              aria-label={i18nText('uiHideThisValueFromHistory')}
                              checked={!!x.secret}
                              onChange={e => setExtracts(i, s.extracts.map((y, yi) => (yi === xi ? { ...y, secret: e.target.checked } : y)))}
                            />
                            {i18nText('uiCover')}
                          </label>
                          <button type="button" aria-label={i18nText('uiDeleteRule')} className="ah-action shrink-0 rounded-[var(--radius-sm)] px-1 py-1 text-ui-sm text-muted-foreground hover:text-method-delete" onClick={() => setExtracts(i, s.extracts.filter((_, yi) => yi !== xi))}>{i18nText('uiDelete')}</button>
                        </div>
                      )
                    })}

                    {/* 직전 실행에서 실제로 뽑힌 값 — 규칙이 맞는지 눈으로 확인(시안의 '실시간 검증') */}
                    {res && (s.extracts ?? []).some(x => x.variable.trim()) && (
                      <div className="flex flex-col gap-1">
                        <span className="ah-label">{i18nText('uiPreviousExecutionResult')}</span>
                        <div className="ah-console">
                          {(s.extracts ?? []).filter(x => x.variable.trim()).map((x, xi) => {
                            const name = x.variable.trim()
                            const got = res.extracted?.[name]
                            const failed = res.extractMissing?.includes(name)
                            const at = res.execution?.executedAt
                            return (
                              <p key={xi} className="whitespace-nowrap">
                                {at && <span className="ah-console-time">[{kstTime(at)}] </span>}
                                <span className="ah-console-time">{x.path || i18nText('jsxNoPath')}</span>
                                <span aria-hidden className="ah-console-time"> → </span>
                                <span className="text-accent">{'{{'}{name}{'}}'}</span>
                                {got !== undefined
                                  ? <span className="ah-console-ok"> = {got.length > 40 ? `${got.slice(0, 40)}…` : got}</span>
                                  : failed
                                    ? <span className="ah-console-err"> {i18nText('uiExtractionFailedCheckPath')}</span>
                                    : <span className="ah-console-time"> {i18nText('uiNotRunningYet')}</span>}
                              </p>
                            )
                          })}
                        </div>
                      </div>
                    )}
                    <button type="button" className="self-start text-ui-sm font-medium text-accent hover:text-accent-hover" onClick={() => setExtracts(i, [...(s.extracts ?? []), { path: '', variable: '' }])}>
                      {i18nText('uiExtractionRules')}
                    </button>

                    {/* 직전 실행 응답에서 경로 클릭 → 규칙 자동 추가(오타 방지) */}
                    {res?.execution?.responseBody && (() => {
                      let leaves: { path: string; value: string }[] = []
                      try { leaves = collectLeaves(JSON.parse(res.execution.responseBody)).slice(0, 24) } catch { /* JSON 아님 */ }
                      if (leaves.length === 0) return null
                      return (
                        <div className="flex flex-col gap-1 border-t border-border pt-1.5">
                          <p className="text-ui-meta text-faint-foreground">{i18nText('uiSelectRouteFromPreviousResponseAddRule')}</p>
                          <div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto">
                            {leaves.map(l => (
                              <button key={l.path} type="button" title={i18nText('dynamicValue', { v0: String(l.value.slice(0, 40)) })}
                                className="rounded-[var(--radius-sm)] border border-border px-1.5 py-0.5 font-mono text-ui-meta text-muted-foreground transition-colors hover:border-accent hover:text-accent"
                                onClick={() => setExtracts(i, [...(s.extracts ?? []), { path: l.path, variable: (l.path.split('.').pop() ?? l.path).replace(/\[\d+\]/g, '') }])}>
                                {l.path}
                              </button>
                            ))}
                          </div>
                        </div>
                      )
                    })()}

                  </section>
                  <div aria-label={i18nText('uiWhereToWriteInTheNextStep')} className="space-y-1 text-ui-sm text-muted-foreground">
                    {preview.produces.map((value, index) => <p key={index}><code>{value.variable}</code> → {value.usedBy.length ? value.usedBy.map(n => i18nText('dynamicStage', { v0: String(n + 1) })).join(', ') : i18nText('jsxNoPlaceToWriteInTheNextStep')}</p>)}
                  </div>
<section aria-label={i18nText('uiRequestBody')} className="space-y-3"><h3 className="text-ui-lg font-semibold">{i18nText('uiBodyToSend')}</h3>                          {r && (
                            ['GET', 'HEAD'].includes(r.method.toUpperCase()) ? (
                              <p className="rounded-[var(--radius-sm)] border border-dashed border-border px-2 py-2 text-ui-sm leading-relaxed text-faint-foreground">
                                {r.method} {i18nText('uiDoesNotSendTheBody')} <b className="text-muted-foreground">{i18nText('uiQueryParameters')}</b>{i18nText('uiPleaseEnterTheValue')}
                              </p>
                            ) : (
                              <div className="flex flex-col gap-1.5">
                                <div className="flex flex-wrap items-center gap-1">
                                  {BODY_SOURCES.map(({ val, label }) => {
                                    const active = (s.bodySource ?? 'template') === val
                                    return (
                                      <button key={val} type="button" aria-pressed={active}
                                        className={`rounded-[var(--radius-sm)] border px-2 py-1 text-ui-sm font-medium transition-colors ${active ? 'border-accent bg-accent/15 text-accent' : 'border-border text-muted-foreground hover:border-border-strong hover:text-foreground'}`}
                                        onClick={() => setStepBody(i, val === 'custom' && !(s.bodyOverride ?? '').trim()
                                          // 빈 칸으로 떨어뜨리면 템플릿 JSON 을 통째로 다시 쳐야 한다. 대개는 한 필드만
                                          // 고치려고 여기 온다 — 저장된 바디를 채워 두고 거기서 고치게 한다.
                                          // 이미 쓰던 override 가 있으면 건드리지 않는다.
                                          ? { bodySource: val, bodyOverride: formatJson(r.body ?? '').text }
                                          : { bodySource: val })}>
                                        {localizeKorean(label)}
                                      </button>
                                    )
                                  })}
                                  {i === 0 && s.bodySource === 'prev' && <span className="text-ui-meta text-method-put">{i18nText('uiThereIsNoPreviousResponseInStep1')}</span>}
                                </div>
                                <p className="text-ui-meta leading-relaxed text-faint-foreground">{localizeKorean(BODY_SOURCES.find(b => b.val === (s.bodySource ?? 'template'))?.desc ?? '')}</p>

                                {(s.bodySource ?? 'template') === 'template' && (
                                  r.body?.trim()
                                    ? <JsonView
                                        text={formatJson(r.body).text}
                                        className="max-h-80 min-h-40 overflow-auto whitespace-pre rounded-[var(--radius-sm)] border border-border bg-surface-2 p-2 font-mono text-ui-sm leading-relaxed"
                                      />
                                    : <p className="rounded-[var(--radius-sm)] border border-dashed border-border px-2 py-1.5 text-ui-sm text-faint-foreground">{i18nText('uiThereIsNoBodySavedFillInBodyFrom')}</p>
                                )}

                                {s.bodySource === 'custom' && (
                                  <div className="flex flex-col gap-1">
                                    <div className="flex flex-wrap items-center gap-1">
                                      {/* 컬렉션 바디 편집기와 같은 도구를 붙인다 — 긴 JSON 에서 값 하나를 찾고
                                          형식을 맞추는 일을 손으로 하게 두면 여기서만 불편해진다. */}
                                      {(() => {
                                        const problem = findJsonProblem(s.bodyOverride ?? '')
                                        const canTidy = looksLikeJson(s.bodyOverride ?? '') && !problem
                                        return <>
                                          <button type="button" title={i18nText('uiJSONCleanupIndentationFormat')} disabled={!canTidy}
                                            className="rounded-[var(--radius-sm)] border border-border bg-surface-2 px-2 py-0.5 text-ui-sm font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
                                            onClick={() => {
                                              const next = formatJson(s.bodyOverride ?? '').text
                                              if (next === (s.bodyOverride ?? '')) return
                                              const ta = bodyEditorRef.current
                                              // 편집기를 통해 바꿔야 ⌘Z 로 되돌아간다. state 를 갈아끼우면 기록이 끊긴다.
                                              if (ta) {
                                                ta.focus()
                                                ta.setSelectionRange(0, ta.value.length)
                                                if (document.execCommand('insertText', false, next)) return
                                              }
                                              setStepBody(i, { bodyOverride: next })
                                            }}>
                                            {i18nText('uiOrganizing')}
                                          </button>
                                          {problem && <span title={problem.message} className="rounded-[var(--radius-sm)] bg-method-delete/10 px-1.5 py-0.5 text-ui-sm font-bold text-method-delete">{i18nText('uiJSONError')}{problem.line ? i18nText('dynamicThLine', { v0: String(problem.line) }) : ''}</span>}
                                        </>
                                      })()}
                                      <span className="ml-1 text-ui-meta text-faint-foreground">{i18nText('uiIncludeAnExample')}</span>
                                      {['{{prevBody|json}}', '{{prevBody}}', '{{prevStatus}}'].map(snip => (
                                        <button key={snip} type="button" title={i18nText('uiInsertAtTheEndOfTheBody')}
                                          className="rounded-[var(--radius-sm)] border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-ui-meta text-muted-foreground transition-colors hover:border-accent hover:text-accent"
                                          onClick={() => setStepBody(i, { bodyOverride: (s.bodyOverride ?? '') + snip })}>
                                          {snip}
                                        </button>
                                      ))}
                                    </div>
                                    {/* 컬렉션과 같은 편집기 — ⌘F 로 긴 JSON 안을 찾고 JSON 을 색으로 구분한다.
                                        예전엔 밋밋한 textarea 라 값 하나 찾는 것도 눈으로 훑어야 했다. */}
                                    <RequestBodyEditor
                                      json
                                      editorRef={bodyEditorRef}
                                      errorAt={findJsonProblem(s.bodyOverride ?? '')?.index ?? null}
                                      aria-label={i18nText('uiCreateYourOwnBody')}
                                      className="min-h-[320px] resize-y rounded-[var(--radius-sm)] border border-border bg-surface px-2 py-1.5 font-mono text-ui-md leading-relaxed text-foreground outline-none focus:border-accent"
                                      placeholder={'{"customerId": {{prevBody|json}}}'}
                                      value={s.bodyOverride ?? ''}
                                      onChange={e => setStepBody(i, { bodyOverride: e.target.value })}
                                    />
                                  </div>
                                )}
                              </div>
                            )
                          )}
</section>
                  <details className="rounded-[var(--radius-md)] border border-border p-4">
                    <summary className="cursor-pointer text-ui-md font-semibold">{i18nText('uiAdvancedSettingsHeaderAuthenticationValueSourceAutomaticVariable')}</summary>
                    <div className="mt-3 space-y-4">
                      <p className="text-ui-sm text-muted-foreground">{i18nText('uiAuthenticationUsesSettingsFromARequestTemplateAndFolder')}</p>
                          {r && (
                            <KVEditor items={(s.headers ?? r.headers ?? []) as KV[]} onChange={next => setStepReq(i, { headers: next })} />
                          )}
                    <div className="flex flex-wrap gap-2" aria-label={i18nText('uiValueSource')}>
                      {preview.consumes.map(({ name, origin }) => <span key={name} className="ah-chip">
                        <code>{name}</code> · {origin.kind === 'stepVar' ? i18nText('jsxInputsToThisStep') : origin.kind === 'env' ? i18nText('jsxEnvironmentCommonValues') : origin.kind === 'extract' ? i18nText('dynamicStepExtraction', { v0: String(origin.step + 1) }) : origin.kind === 'auto' ? i18nText('dynamicStepResponse', { v0: String(origin.step + 1) }) : origin.kind === 'later' ? i18nText('dynamicStageNotYetExecuted', { v0: String(origin.step + 1) }) : i18nText('jsxNoValueToFill')}
                      </span>)}
                    </div>

                    {/* 자동 제공 변수 — 규칙 없이도 쓸 수 있는 값 */}
                    <div className="flex flex-wrap items-center gap-1 border-t border-border pt-1.5">
                      <span className="w-full text-ui-meta leading-relaxed text-faint-foreground">{i18nText('uiEvenWithoutRules')} <b className="text-muted-foreground">{i18nText('uiAutomatic')}</b>{i18nText('uiValueResultingFromClickToCopy')}</span>
                      {[
                        { token: '{{prevBody}}', label: i18nText('jsxAllPreviousResponses') },
                        { token: `{{step${i + 1}Body}}`, label: `${i + 1}단계 응답` },
                        { token: '{{prevStatus}}', label: i18nText('jsxStatusCode') },
                      ].map(({ token, label }) => (
                        <button key={token} type="button" title={i18nText('dynamicClickToCopy', { v0: String(label) })}
                          className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] border border-border bg-surface-2 px-1.5 py-0.5 transition-colors hover:border-accent"
                          onClick={async () => { const ok = await copyText(token); toast(ok ? 'success' : 'error', ok ? i18nText('dynamicCopied', { v0: String(token) }) : i18nText('jsxCopyFailedYourBrowserMayHaveBlockedTheClipboard')) }}>
                          <span className="font-mono text-ui-meta text-muted-foreground">{token}</span>
                          <span className="text-ui-meta text-faint-foreground">{label}</span>
                        </button>
                      ))}
                    </div>
                    </div>
                  </details>
                  </fieldset>
                  {/* 실행 결과 + 자동 수집 로그 */}
                  {(res?.error || res?.execution?.error) && (
                    <p data-testid="scenario-step-error" className="text-ui-sm text-method-delete">{res.error ?? res.execution?.error}</p>
                  )}
                  {res?.execution && (
                    <>
                      <p className="text-ui-md text-muted-foreground">
                        {res.execution.responseStatus ?? 'ERR'} · {res.execution.durationMs}ms
                        {res.extracted && Object.keys(res.extracted).length > 0 && (
                          <span className="text-accent"> {i18nText('uiExtraction')} {Object.entries(res.extracted).map(([k, v]) => `${k}=${v.slice(0, 20)}`).join(', ')}</span>
                        )}
                        {res.extractMissing && res.extractMissing.length > 0 && (
                          <span className="text-method-delete"> {i18nText('uiExtractionFailure')} {res.extractMissing.join(', ')}</span>
                        )}
                      </p>
                      {res.execution.responseBody && (
                        <JsonView
                          text={(() => { try { return JSON.stringify(JSON.parse(res.execution!.responseBody!), null, 2) } catch { return res.execution!.responseBody! } })()}
                          className="max-h-48 overflow-auto whitespace-pre rounded-[var(--radius-sm)] border border-border bg-surface-2 p-2 font-mono text-ui-sm leading-relaxed"
                        />
                      )}
                    </>
                  )}
                  </div>
                </ModalFrame>
              )
            })}

          </div>
        </>
      )}
    </div>
    </div>
  )
}
