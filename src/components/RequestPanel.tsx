'use client'
import { t as i18nText, localizeKorean } from '@/i18n'
import { requestVariableReferences } from '@/lib/requestVariableReferences'
import { ToolButton } from './ToolButton'
import { TextSearchControls, useTextSearch } from './TextSearch'
import { decideExecution } from '@/lib/executionPolicy'
import { VariablePopover } from './VariablePopover'
import { renderVarHighlight } from './VariableText'
import { isFailedExecution } from '@/lib/executionOutcome'
import { ModalFrame, ModalHeader } from './ModalFrame'
import { ReviewTemplateSave } from './ReviewTemplateSave'
import { CopyButton } from './CopyButton'
import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { methodText } from '@/lib/methodStyle'
import { buildAiPrompt } from '@/lib/aiPrompt'
import { KEYS, readFlag, writeFlag } from '@/lib/localStore'
import { kvToText, textToKV } from '@/lib/bulkKV'
import type { LiveRequest } from './RightPanel'
import { useRequestSnippet } from '@/lib/useRequestSnippet'
import { getPersonalVars, setPersonalVar } from '@/lib/personalVars'
import { describeAssertion, type Assertion, type AssertOp, type AssertTarget } from '@/lib/assertions'
import { PRE_OP_LABEL, type PostStep, type PostStepSource, type PreStep, type PreStepOp } from '@/lib/steps'
import type { SnippetContext } from '@/lib/snippetRequest'
import type { AuthConfig } from '@/lib/requestAuth'
import { AuthEditor } from '@/components/AuthEditor'
import { BinaryEditor } from './BinaryEditor'
import { MultipartEditor } from './MultipartEditor'
import type { SchemaIssue } from '@/lib/schemaValidate'
import { explainStatus, explainTransportError } from '@/lib/httpExplain'
import { RequestBodyEditor } from './RequestBodyEditor'
import { JsonView } from './JsonView'
import { collectLeaves } from '@/lib/jsonLeaves'
import type { FolderRow, EnvironmentRow, ExecutionRow, RequestRow } from '@/lib/ui-types'
import { DYNAMIC_VARS, dynamicVars, extractPathParameters, extractVariables, gqlWrap, resolveRequest, resolveText, type KV, type RequestInput, type RequestSettings, type VarMap } from '@/lib/variables'
import { applyVariable, SUGGEST_CLOSED, suggestVariables, type VarSuggestion } from '@/lib/varAutocomplete'
import { useResizable } from '@/lib/useResizable'
import { useFocusTrap } from '@/lib/useFocusTrap'
import { addPathParam, paramsFromUrl, reconcile, urlFromParams } from '@/lib/urlParams'
import { AddPathParam } from './AddPathParam'
import dynamic from 'next/dynamic'
const RequestVersions = dynamic(() => import('./RequestVersions').then(m => m.RequestVersions))
import { findJsonProblem, formatJson, looksLikeJson } from '@/lib/jsonFormat'
import { KVEditor } from './KVEditor'
import { HEADER_SUGGEST } from '@/lib/headerSuggestions'
import { VarSuggest } from './VarSuggest'
import { useToast } from './Toast'
import { GraphqlEditor } from './GraphqlEditor'
import { errorText, fetchArray, fetchJson } from '@/lib/fetchJson'
import { fetchSharedVars, SHARED_SCOPE_LABEL, type SharedVar } from '@/lib/sharedVars'
import { copyText } from '@/lib/clipboard'
import { RequestCookies } from './RequestCookies'
import { parseCurl } from '@/lib/curlParse'
import { takeUrlFocus } from '@/lib/starterRequest'

const toDraft = (r: RequestRow): RequestInput => {
  // URL 쿼리 ⟺ Params 정합화(레거시: params 만 있고 URL 엔 없던 것도 URL 쿼리로 노출) — Postman 동작.
  const { url, params } = reconcile(r.url, r.params)
  return { method: r.method, url, params, headers: r.headers, bodyType: r.bodyType, body: r.body }
}


const BODY_TYPE_LABEL: Record<RequestInput['bodyType'], string> = {
  none: '없음', json: 'JSON', form: 'URL encoded', raw: 'Raw', graphql: 'GraphQL', multipart: 'form-data', binary: 'Binary',
}

// Tests 탭 "예시에서 가져오기" — 빈 목록이라 뭘 하는 곳인지 안 보이던 문제를 없앤다.
const TEST_PRESETS: { label: string; hint: string; make: () => Assertion }[] = [
  { label: '성공(200)', hint: '상태 코드가 200 인지', make: () => ({ target: 'status', op: 'eq', expected: '200' }) },
  { label: 'HTTP 오류 없음', hint: '상태 코드가 400 미만인지', make: () => ({ target: 'status', op: 'lt', expected: '400' }) },
  { label: '응답 1초 이내', hint: '응답 시간이 1000ms 미만인지', make: () => ({ target: 'responseTime', op: 'lt', expected: '1000' }) },
  { label: 'data 존재', hint: '응답에 data 필드가 있는지', make: () => ({ target: 'jsonPath', path: 'data', op: 'exists' }) },
  { label: 'JSON 응답', hint: 'Content-Type 에 json 포함', make: () => ({ target: 'header', path: 'Content-Type', op: 'contains', expected: 'json' }) },
  { label: 'error 필드 없음', hint: '응답 JSON에 error 필드가 없는지 (null도 필드가 있는 것으로 처리)', make: () => ({ target: 'jsonPath', path: 'error', op: 'notExists' }) },
]

// Steps 탭 "예시에서 가져오기" — 빈 화면 대신 자주 쓰는 스텝을 한 번에 넣어 사용법을 보여준다.
const PRE_STEP_PRESETS: { label: string; hint: string; make: () => PreStep }[] = [
  { label: '현재 타임스탬프', hint: '요청 시각(Unix ms)을 변수로', make: () => ({ name: 'ts', op: 'timestamp' }) },
  { label: '멱등키(UUID)', hint: '중복 방지용 고유 키', make: () => ({ name: 'idemKey', op: 'uuid' }) },
  { label: '랜덤 정수', hint: '테스트용 임의 수(min~max)', make: () => ({ name: 'rand', op: 'randomInt', min: '1', max: '99999' }) },
  { label: 'HMAC 서명', hint: '시크릿으로 메시지 서명(hex, 기본 secret)', make: () => ({ name: 'sign', op: 'hmacSha256', key: '{{apiSecret}}', input: '{{ts}}', secret: true }) },
  { label: 'Base64(Basic)', hint: 'user:pass → Base64', make: () => ({ name: 'basicCred', op: 'base64', input: '{{user}}:{{pass}}' }) },
]
const POST_STEP_PRESETS: { label: string; hint: string; make: () => PostStep }[] = [
  { label: '토큰 추출', hint: '응답 data.accessToken → 변수(secret)', make: () => ({ source: 'jsonPath', path: 'data.accessToken', name: 'accessToken', secret: true }) },
  { label: '생성된 ID', hint: '응답 data.id → 변수', make: () => ({ source: 'jsonPath', path: 'data.id', name: 'createdId' }) },
  { label: '요청 ID 헤더', hint: '응답 헤더 X-Request-Id → 변수', make: () => ({ source: 'header', path: 'X-Request-Id', name: 'requestId' }) },
]
// 각 연산이 만들어내는 결과 형태(정적 예시 — 실행 시 실제 값으로 계산됨).
const PRE_OP_SAMPLE: Record<PreStepOp, string> = {
  setValue: '입력한 템플릿을 변수 치환해 그대로',
  timestamp: '1753900000000 (13자리 Unix ms)',
  uuid: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  randomInt: 'min~max 사이 정수',
  base64: 'dXNlcjpwYXNz (입력의 Base64)',
  hmacSha256: '9f86d081884c… (hex 서명 · 기본 secret)',
}

function IconPlay() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden>
      <path d="M2 1.2 8.5 5 2 8.8V1.2Z" />
    </svg>
  )
}

function IconSpinner() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden style={{ animation: 'spin-slow 0.7s linear infinite' }}>
      <path d="M10 5.5A4 4 0 1 1 8.83 2.7M10 5.5V2m0 3.5H6.5"
        stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function IconWarning() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden className="shrink-0">
      <path d="M6 1.2 11.3 10.4H0.7L6 1.2Z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
      <path d="M6 4.6v2.4M6 8.6v.1" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

/** 환경 목록 맨 아래 [환경·변수 관리…] 항목의 값 — 고르면 환경이 바뀌는 대신 설정이 열린다. */
const MANAGE_ENVS = '__manage_envs__'

function StatusPill({ result }: { result: ExecutionRow }) {
  if (result.error) {
    return (
      <span className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-method-delete/10 px-1.5 py-0.5 text-ui-sm font-bold text-method-delete">
        ERROR
      </span>
    )
  }
  const status = result.responseStatus
  const ok = status != null && status < 400
  return (
    <span
      title={status != null ? explainStatus(status).label : undefined}
      className={`inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] px-1.5 py-0.5 font-mono text-ui-sm font-bold ${
        ok ? 'bg-badge-new-bg text-badge-new-fg' : 'bg-method-delete/10 text-method-delete'
      }`}
    >
      {status ?? '—'}
      {status != null && (
        <span className="font-sans font-medium opacity-80">{explainStatus(status).label.split(' — ')[0]}</span>
      )}
    </span>
  )
}

/** '3일 전' 처럼 사람이 읽는 말로. 정확한 시각은 title 로 남긴다. */
function agoText(at: number): string {
  const min = Math.floor((Date.now() - at) / 60_000)
  if (min < 1) return i18nText('dynamicJustNow')
  if (min < 60) return i18nText('dynamicMinutesAgo', { v0: String(min) })
  const hr = Math.floor(min / 60)
  if (hr < 24) return i18nText('dynamicHoursAgo', { v0: String(hr) })
  return i18nText('dynamicDaysAgo', { v0: String(Math.floor(hr / 24)) })
}

/** 스펙 변경 detail(JSON)에서 한 줄 요약. 손상돼 있어도 화면이 죽지 않게 방어한다. */
function specChangeSummary(c: { detail: string | null }): string {
  try {
    const v = JSON.parse(c.detail ?? '[]') as { label?: string; to?: string }[]
    if (!Array.isArray(v) || v.length === 0) return ''
    const first = v[0]
    const more = v.length > 1 ? i18nText('dynamicOther', { v0: String(v.length - 1) }) : ''
    return `${first?.label ?? ''}${first?.to ? `: ${first.to}` : ''}${more}`.trim()
  } catch { return '' }
}

function specChangeTitle(c: { detail: string | null; createdAt: number }): string {
  try {
    const v = JSON.parse(c.detail ?? '[]') as { label?: string; from?: string; to?: string }[]
    if (!Array.isArray(v) || v.length === 0) return i18nText('dynamicNoChangesWereRecorded')
    return v.map(f => `${f.label}: ${f.from} → ${f.to}`).join('\n')
  } catch { return i18nText('dynamicIDidnTReadWhatChanged') }
}

/**
 * /status 는 최근 실행 수·실패·마지막 실패도 주지만 **여기서는 일부러 안 그린다.**
 * 트리의 실패 점·이력 화면과 겹치는 중복 표시라 뺐다(응답 화면 정리 때 결정).
 * '데이터는 오는데 화면에 없다' 를 누락으로 오해해 두 번 되살렸다가 두 번 철회했다(83fda15, 그리고 한 번 더).
 * 되살리기 전에 그 문서부터 볼 것. 그래서 타입에도 쓰는 것만 둔다.
 */
type RequestStatus = {
  specChange: { changeType: 'changed' | 'deprecated'; createdAt: number; detail: string | null } | null
}


/** 응답 도구줄의 글자 버튼 — 같은 줄의 [바디 복사]와 모양을 맞춘다. */
const RESP_TOOL = 'rounded-[var(--radius-sm)] px-2 py-1 text-ui-sm text-muted-foreground hover:bg-surface-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent'

export function RequestPanel({ workspaceId, request, environments, environmentId, onEnvironmentChange, onExecuted, onTemplateSaved, restore, isActive = true, onDirtyChange, onOpenEnvManager, onOpenHistory, historyVisible = false, onEnvironmentsSaved, onLiveChange, folderRevision = 0, registerSave, copyCurlRequested, onCurlCopyHandled }: {
  folderRevision?: number
  onLiveChange?: (live: LiveRequest) => void
  workspaceId: string
  request: RequestRow
  environments: EnvironmentRow[]
  environmentId: string | null
  onEnvironmentChange: (id: string | null) => void
  onExecuted: (e: ExecutionRow) => void
  /**
   * 저장된 값을 부모(탭 목록·트리)에 알린다. 부모가 `{...기존, ...saved}` 로 덮으므로
   * 일부만 보내도 된다 — 스펙 확인 처리처럼 한 필드만 바뀌는 경우에 쓴다.
   */
  onTemplateSaved: (saved: Partial<RequestRow> & Partial<RequestInput> & { name?: string }) => void
  restore: ExecutionRow | null
  isActive?: boolean
  copyCurlRequested?: boolean
  onCurlCopyHandled?: () => void
  registerSave?: (handler: (() => Promise<boolean>) | null) => void
  onDirtyChange?: (dirty: boolean) => void
  onOpenEnvManager?: () => void
  historyVisible?: boolean
  onOpenHistory?: () => void
  onEnvironmentsSaved?: () => void
}) {
  const toast = useToast()
  const [variableRevision, setVariableRevision] = useState(0)
  useEffect(() => {
    let alive = true
    const refresh = () => { setVariableRevision(v => v + 1); void fetchSharedVars(workspaceId).then(vars => { if (alive) setGlobalVars(vars) }).catch(() => {}) }
    window.addEventListener('postq:variables-updated', refresh)
    return () => { alive = false; window.removeEventListener('postq:variables-updated', refresh) }
  }, [workspaceId])

  const [draft, setDraft] = useState<RequestInput>(toDraft(request))
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [editMode, setEditModeRaw] = useState(false)
  const [running, setRunning] = useState(false)
  const [saving, setSaving] = useState(false)
  const [reviewSave, setReviewSave] = useState(false)
  const [result, setResult] = useState<ExecutionRow | null>(null)
  // 실행/미리보기 자체가 실패했을 때(postq 라우트 500·서버 연결 실패)의 상세 — 응답 패널에 표시.
  const [execError, setExecError] = useState<string | null>(null)
  // 방금 받은 응답을 바로 '예시로 고정' — 이력 패널까지 가야 핀할 수 있어 발견성이 낮았다.
  const [pinning, setPinning] = useState(false)
  const [pinnedNow, setPinnedNow] = useState(false)
  // 전송 전 확인 — URL/헤더/바디에 미해석 {{변수}}가 남아있으면 그대로(리터럴) 나가므로 한 번 물어본다.
  const [confirmUnresolved, setConfirmUnresolved] = useState<string[] | null>(null)
  const [tab, setTab] = useState<'params' | 'headers' | 'auth' | 'cookies' | 'body' | 'tests' | 'steps' | 'docs' | 'settings'>('params')
  const [parameterSection, setParameterSection] = useState<'path' | 'query' | null>(null)
  useEffect(() => setParameterSection(null), [request.id])
  const pathNames = extractPathParameters(draft.url)
  // 경로가 없어도 [경로] 칸을 열 수 있다 — 거기서 경로 파라미터를 추가한다.
  const showPathParameters = parameterSection === 'path' || (pathNames.length > 0 && parameterSection !== 'query')

  const [assertions, setAssertions] = useState<Assertion[]>(request.assertions ?? [])
  // pre/post 비주얼 스텝 — 템플릿 메타(assertions 와 동급). draft(요청 I/O)와 분리.
  const [preSteps, setPreSteps] = useState<PreStep[]>(request.preSteps ?? [])
  const [postSteps, setPostSteps] = useState<PostStep[]>(request.postSteps ?? [])
  const [auth, setAuth] = useState<AuthConfig>(request.auth ?? { type: 'none' })
  // 원문 문자열을 상태로 보관하고 태그 배열은 파생 — 매 키입력마다 배열로 왕복하면 쉼표가 즉시 사라져
  // 타이핑으로 2개 이상 태그를 못 만든다(컨트롤드 input 함정).
  const [tagsInput, setTagsInput] = useState<string>((request.tags ?? []).join(', '))
  const tags = tagsInput.split(',').map(t => t.trim()).filter(Boolean)
  const [confirmWrite, setConfirmWrite] = useState(false)
  const [aiExecutionAllowed, setAiExecutionAllowed] = useState(request.aiExecutionAllowed ?? false)
  const [settings, setSettings] = useState<RequestSettings>(request.settings ?? {})
  // 요청별(=이 API 전용) 변수 — 전역/환경 위에, 개인 오버라이드 아래. orderId 등 이 요청에만 쓰는 값.
  const [reqVars, setReqVars] = useState<{ key: string; value: string }[]>(request.vars ?? [])
  // 환경에 속하지 않는 변수(전역·프로젝트 공통) — 실행 시 loadTeamVars 가 병합하므로, 변수 해석/하이라이트 판정에도 반영해야
  // {{baseUrl}} 같은 변수가 '미등록'으로 오표시되지 않는다(secret 값은 서버가 '' 로 마스킹해 내려줌).
  const [globalVars, setGlobalVars] = useState<SharedVar[]>([])
  const [globalVarsError, setGlobalVarsError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    // 전역변수를 못 읽으면 '{{변수}} 를 채울 값이 없습니다' 로 보인다 — 값은 있는데 못 읽은 것뿐이다.
    // 그런데 res.ok 를 안 봐서 500 은 catch 를 안 타고 배열이 아닌 값 → 빈 배열로 떨어졌다.
    // 오류 안내를 만들어 놓고 정작 서버 오류에서는 안 뜨고 있었다.
    fetchSharedVars(workspaceId)
      .then(g => { if (live) { setGlobalVars(g); setGlobalVarsError(null) } })
      .catch(e => { if (live) setGlobalVarsError(errorText(e)) })
    return () => { live = false }
  }, [workspaceId])
  const [showHeaders, setShowHeaders] = useState(false)


  /**
   * 이 요청이 지금 어떤 상태인가 — 스펙이 바뀌었는지, 최근에 얼마나 깨졌는지.
   *
   * 이 정보는 원래 다른 화면들에 흩어져 있어서
   * 보려면 화면을 옮겨 다니며 이 요청을 다시 찾아야 했다 — 그래서 아무도 안 봤다.
   * 실행하기 전에 손을 멈춰야 할 이유는 실행하는 자리에 있어야 한다.
   */
  const [status, setStatus] = useState<RequestStatus | null>(null)
  const [statusVersion, setStatusVersion] = useState(0)
  useEffect(() => {
    let alive = true
    setStatus(null)
    fetchJson<RequestStatus>(`/api/requests/${request.id}/status`)
      .then(v => { if (alive) setStatus(v) })
      // 상태 요약을 못 읽는다고 요청 화면을 막지 않는다 — 곁다리 정보다.
      .catch(() => { if (alive) setStatus(null) })
    return () => { alive = false }
  }, [request.id, statusVersion])

  // editMode는 탭 바의 "저장되지 않은 편집" 점 표시와도 연결되므로, 부모에 즉시 알린다.
  const setEditMode = (v: boolean) => { setEditModeRaw(v); onDirtyChange?.(v) }
  // 편집을 버리고 저장된 정의로 돌아간다. 응답은 남긴다 — 방금 본 결과까지 지울 이유는 없다.
  const discardEdits = () => {
    setReviewSave(false); setDraft(toDraft(request)); setEditMode(false)
    setNameDraft(request.name); setDescDraft(request.description); setAssertions(request.assertions ?? [])
    setPreSteps(request.preSteps ?? []); setPostSteps(request.postSteps ?? [])
    setAuth(request.auth ?? { type: 'none' })
    setTagsInput((request.tags ?? []).join(', ')); setSettings(request.settings ?? {}); setAiExecutionAllowed(request.aiExecutionAllowed ?? false); setReqVars(request.vars ?? [])
    setBulkMode(false)
  }
  const [folderName, setFolderName] = useState('')
  useEffect(() => { let alive = true; fetchArray<FolderRow>(`/api/folders?workspaceId=${encodeURIComponent(workspaceId)}`).then(rows => { if (alive) setFolderName(rows.find(f => f.id === request.folderId)?.name ?? '') }).catch(() => {}); return () => { alive = false } }, [workspaceId, request.folderId])
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  const startRename = () => { setEditMode(true); requestAnimationFrame(() => { nameInputRef.current?.focus(); nameInputRef.current?.select() }) }
  // 무엇을 고치든 '편집 중' 이 된다. 예전엔 URL·메서드만 켰다 — 헤더·파라미터·바디·인증을
  // 고치면 미저장 점도, ⌘S 도, 닫을 때 경고도 없이 편집이 사라졌다.
  // draft·auth 가 바뀔 때만 본다(저장 후 request 가 새로 와도 다시 켜지지 않게).
  const savedDraftJson = JSON.stringify(toDraft(request))
  const savedAuthJson = JSON.stringify(request.auth ?? { type: 'none' })
  const firstDraftCheck = useRef(true)
  useEffect(() => {
    if (firstDraftCheck.current) { firstDraftCheck.current = false; return }
    if (!editMode && (JSON.stringify(draft) !== savedDraftJson || JSON.stringify(auth) !== savedAuthJson)) setEditMode(true)
  }, [draft, auth]) // eslint-disable-line react-hooks/exhaustive-deps


  // 폴더 공통 헤더 상속 안내용 — Headers 탭에 "무엇이 상속되는지"를 보여준다
  const [folderShared, setFolderShared] = useState<KV[]>([])
  const [folderAuth, setFolderAuth] = useState<AuthConfig>({ type: 'none' })
  const [snippetError, setSnippetError] = useState<string | undefined>(i18nText('dynamicLoadingFolderSettings'))
  useEffect(() => {
    let cancelled = false
    setSnippetError(i18nText('dynamicLoadingFolderSettings'))
    fetchArray<FolderRow>(`/api/folders?workspaceId=${encodeURIComponent(workspaceId)}`)
      .then(fs => {
        if (cancelled) return
        const folder = fs.find(f => f.id === request.folderId)
        setFolderShared(folder?.sharedHeaders ?? [])
        setFolderAuth(folder?.sharedAuth ?? { type: 'none' })
        setSnippetError(undefined)
      })
      .catch(() => { if (!cancelled) setSnippetError(i18nText('dynamicFailedToLoadFolderSettingsPleaseReopenTheRequest')) })
    return () => { cancelled = true }
  }, [request.folderId, workspaceId, folderRevision, isActive])

  // 이름/설명 — 템플릿 메타(편집 모드에서만 수정 가능)
  const [nameDraft, setNameDraft] = useState(request.name)
  const [descDraft, setDescDraft] = useState(request.description)
  // params/headers bulk edit 텍스트 모드
  const [bulkMode, setBulkMode] = useState(false)

  // 요청↔응답 세로 분할 — 드래그로 응답 영역 높이 조절(저장됨)
  const panelRef = useRef<HTMLDivElement>(null)
  const requestAreaRef = useRef<HTMLDivElement>(null)
  const [responseMax, setResponseMax] = useState(700)
  const responseArea = useResizable(KEYS.responseHeight, 320, 240, responseMax, 'y')
  const boundedBody = tab === 'body' && ['json', 'raw', 'form'].includes(draft.bodyType)
  const boundedBulk = bulkMode && (tab === 'headers' || (tab === 'params' && !showPathParameters))
  // Keep 144px of editable content plus its controls/padding above the divider.
  // Measure the actual chrome: descriptions, variable chips and find controls can wrap.
  useLayoutEffect(() => {
    const panel = panelRef.current
    const area = requestAreaRef.current
    if (!panel || !area || !isActive) return
    const measure = () => {
      const editor = area.querySelector<HTMLElement>('[data-request-editor-box], [data-request-bulk]')
      const minimum = editor ? editor.getBoundingClientRect().top - area.getBoundingClientRect().top + 144 + 10 : 240
      setResponseMax(Math.max(30, Math.floor(panel.getBoundingClientRect().bottom - area.getBoundingClientRect().top - minimum - 4)))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(panel)
    // Observe fixed chrome as well as the pane, including wrapped search controls.
    Array.from(panel.children).forEach(el => observer.observe(el))
    const editor = area.querySelector('[data-request-editor-box], [data-request-bulk]')
    if (editor) observer.observe(editor)
    return () => observer.disconnect()
  })
  /**
   * 응답/에러 창 접기.
   *
   * 응답이 뜨면 아래쪽 280px 을 계속 차지한다. 그런데 에러 원인을 한 번 읽고 나면
   * 그다음에 하는 일은 위쪽(URL·헤더·바디)을 고치는 것이라, 정작 고치는 자리가 눌린다.
   * 접으면 한 줄만 남는다 — 지운 게 아니라 접은 것이라 결과는 그대로 다시 펼 수 있다.
   *
   * 브라우저에 남긴다. 접어 두는 사람은 계속 접어 두고 쓴다.
   */
  const [respCollapsed, setRespCollapsed] = useState(false)
  useEffect(() => { setRespCollapsed(readFlag(KEYS.responseCollapsed, false)) }, [])
  const toggleResp = () => setRespCollapsed(v => {
    const next = !v
    writeFlag(KEYS.responseCollapsed, next)
    return next
  })
  // 새로 실행하면 편다 — 접힌 채로 결과를 못 보면 [실행]이 먹지 않는 것처럼 보인다.
  const showResult = useCallback(() => { setRespCollapsed(false); writeFlag(KEYS.responseCollapsed, false) }, [])
  // 응답 내 검색
  const [respView, setRespView] = useState<'pretty' | 'raw' | 'preview'>('pretty')

  useEffect(() => { if (isActive) document.title = `${request.name || 'postq'} · postq` }, [isActive, request.name])
  // [curl 붙여넣기] 로 만든 요청은 열리자마자 주소창에 커서를 둔다 — 바로 ⌘V 하면 된다.
  useEffect(() => { if (isActive && takeUrlFocus(request.id)) requestAnimationFrame(() => urlInputRef.current?.focus()) }, [isActive, request.id])

  // 다른 요청으로 바뀔 때만 draft를 템플릿 값으로 초기화 — 실행 모드로 리셋.
  // 의존성이 request 객체가 아니라 request.id인 이유: 템플릿 저장 후 부모(page.tsx)가 탭 항목을
  // 저장된 값으로 갱신하면 객체 identity가 바뀌는데, 그때 draft(이미 저장값과 동일)와 응답 뷰를
  // 리셋해버리면 방금 실행한 응답이 사라지는 UX 회귀가 생긴다.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    setKnownUpdatedAt(request.updatedAt); setReviewSave(false); setDraft(toDraft(request)); setResult(null); setEditMode(false); setShowHeaders(false)
    setNameDraft(request.name); setDescDraft(request.description); setAssertions(request.assertions ?? [])
    setPreSteps(request.preSteps ?? []); setPostSteps(request.postSteps ?? [])
    setAuth(request.auth ?? { type: 'none' })
    setTagsInput((request.tags ?? []).join(', ')); setSettings(request.settings ?? {}); setAiExecutionAllowed(request.aiExecutionAllowed ?? false); setReqVars(request.vars ?? [])
    setBulkMode(false); responseSearch.setQuery(''); setUrlSuggest(SUGGEST_CLOSED)
  }, [request.id])
  // 이력에서 [이 값으로 복원]을 누르면 draft를 그 실행 시점의 resolved 값으로 교체(템플릿은 건드리지 않음).
  useEffect(() => {
    if (restore) setDraft({ ...restore.resolved, bodyType: restore.resolved.bodyType as RequestInput['bodyType'] })
  }, [restore])

  const abortRef = useRef<AbortController | null>(null)
  const cancelRun = () => abortRef.current?.abort()

  // 미리보기 — 실제로 나갈 요청(폴더 헤더·변수 치환·auth 주입, 자격증명 마스킹)을 보내기 전에 확인.
  const [preview, setPreview] = useState<{ preview: { method: string; url: string; headers: KV[]; body: string }; missing: string[]; authError: string | null } | null>(null)
  // 미리보기 모달 — 다른 모달과 동일하게 Esc 닫기·포커스 트랩·초기/복원 포커스.
  const previewTrapRef = useFocusTrap<HTMLDivElement>(!!preview, () => setPreview(null))
  const previewRef = useRef(preview)
  previewRef.current = preview
  const openPreview = async () => {
    try {
      const res = await fetch(`/api/requests/${request.id}/preview`, {
        method: 'POST',
        body: JSON.stringify({ environmentId, input: draft, personalVars: getPersonalVars(environmentId), preSteps, auth, vars: reqVars }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        if (data?.denialReason && data?.id) onExecuted(data as ExecutionRow)
        const detail = data?.error ?? `HTTP ${res.status}`
        setExecError(`미리보기 실패 (${res.status})\n${detail}${data?.stack ? `\n\n${data.stack}` : ''}`); setResult(null)
        toast('error', i18nText('dynamicPreviewFailed', { v0: String(detail) }))
        return
      }
      setPreview(await res.json())
    } catch (e) {
      // fetch 자체 실패(=postq 서버에 도달 못 함) — 서버 로그가 없는 이유를 메시지로 명확히.
      setExecError(`미리보기 실패\npostq 서버에 연결하지 못했습니다 (서버 실행 중인지 확인)\n${errorText(e)}`); setResult(null)
      toast('error', i18nText('dynamicPreviewFailed', { v0: String(errorText(e)) }))
    }
  }

  const run = async (force = false, confirmed = false) => {
    const missingPath = extractPathParameters(draft.url).filter(key => !buildCopyVarMap()[key]?.value && !stepVarNames.has(key))
    if (missingPath.length) {
      setTab('params')
      setParameterSection('path')
      toast('error', i18nText('dynamicEnterThePathParameters', { v0: String(missingPath.join(', ')) }))
      return
    }
    // 미해석 변수 가드 — {{orderId}} 처럼 어디에도 없는 변수는 리터럴로 전송돼 조용히 깨진다.
    // 동적변수($uuid 등)·스텝 변수는 unresolvedVars 에서 이미 제외돼 오탐하지 않는다.
    if (!force && unresolvedVars.length > 0) { setConfirmUnresolved(unresolvedVars); return }
    setConfirmUnresolved(null)
    const decision = decideExecution({ policy: environments.find(e => e.id === environmentId)?.executionPolicy, method: draft.method, source: 'ui', confirmed })
    if (!decision.allowed && decision.confirmationRequired) { setConfirmWrite(true); return }
    setConfirmWrite(false)
    const controller = new AbortController()
    abortRef.current = controller
    setRunning(true)
    // 접힌 채로 실행하면 결과가 안 보여 [실행]이 먹지 않는 것처럼 보인다 — 펴 놓고 시작한다.
    showResult()
    try {
      const res = await fetch(`/api/requests/${request.id}/execute`, {
        method: 'POST',
        body: JSON.stringify({ confirmed, environmentId, input: draft, personalVars: getPersonalVars(environmentId), assertions, preSteps, postSteps, auth, settings, vars: reqVars }),
        signal: controller.signal,
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data || !Array.isArray(data.missingVariables)) {
        if (data?.denialReason && data?.id) onExecuted(data as ExecutionRow)
        const detail = data?.error ?? `HTTP ${res.status} — 서버가 상세 응답을 반환하지 않았습니다`
        // 토스트는 사라지므로 상세(스택 포함)를 응답 패널에도 남긴다.
        setExecError(`실행 실패 (${res.status})\n${detail}${data?.stack ? `\n\n${data.stack}` : ''}`)
        setResult(null)
        toast('error', i18nText('dynamicExecutionFailed', { v0: String(detail) }))
        return
      }
      const exec = data as ExecutionRow
      setExecError(null); setResult(exec); setValidation(null); setPinnedNow(!!exec.pinned); onExecuted(exec)
      // 방금 실행한 결과가 성공률·마지막 실패에 바로 반영돼야 한다 —
      // 실패해 놓고 '성공 100%' 가 그대로 떠 있으면 그 줄을 못 믿게 된다.
      setStatusVersion(v => v + 1)
      // Post-step 추출값 → 개인 오버라이드로 캡처(환경 선택 시). 팀 env(DB)는 건드리지 않음.
      // 빈 값은 제외 — setPersonalVar('')는 기존 개인값을 삭제하고 applyPersonalVars도 ''를 무시하므로 캡처 무의미.
      const extracted = ((data.extracted ?? []) as { name: string; value: string }[]).filter(e => e.value !== '')
      if (extracted.length > 0) {
        if (environmentId) {
          for (const e of extracted) setPersonalVar(environmentId, e.name, e.value)
          toast('success', i18nText('dynamicExtractVariablesStoreAsPrivateValues', { v0: String(extracted.length), v1: String(extracted.map(e => e.name).join(', ')) }))
        } else {
          toast('info', i18nText('dynamicVariablesExtractedSelectEnvironmentToSave', { v0: String(extracted.length) }))
        }
      }
    } catch (e) {
      // 취소(AbortError)는 사용자 의도라 조용히, 그 외 fetch 실패는 postq 서버 연결 실패(대상 서버 에러 아님)로 명확히 안내.
      if (e instanceof DOMException && e.name === 'AbortError') toast('info', i18nText('dynamicUndo'))
      else {
        const msg = `postq 서버에 연결하지 못했습니다 (서버 실행 중인지 확인)\n${errorText(e)}`
        setExecError(`요청 실행 실패\n${msg}`); setResult(null)
        toast('error', i18nText('dynamicRequestExecutionFailed', { v0: String(errorText(e)) }))
      }
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }

  // 단축키 (활성 탭만): ⌘/Ctrl+Enter 실행, ⌘/Ctrl+S 편집 모드에서 템플릿 저장.
  // ref로 최신 핸들러를 참조해 draft가 바뀔 때마다 effect를 재구독하지 않고도 stale closure 를 피한다.
  const runRef = useRef(run)
  runRef.current = run
  const saveRef = useRef<() => void>(() => {})
  useEffect(() => {
    if (!isActive) return
    const onKey = (e: KeyboardEvent) => {
      // 모달이 떠 있으면 뒤의 요청은 비켜선다. 예전엔 미리보기 하나만 막아서, 팀 반영 확인·AI용 복사·
      // 저장본 창에서 ⌘Enter 를 '확정' 으로 누르면 뒤의 요청이 실제로 나갔다(대상이 POST·DELETE 면
      // 진짜 부수효과). 모달을 하나씩 등록하는 대신 '열린 모달이 있나' 를 본다 — 새 모달이 생겨도 빠지지 않게.
      // '보이는' 모달만 본다. 숨긴 탭(비활성 요청은 언마운트하지 않고 hidden 으로 둔다)에 늦게 도착한
      // 미리보기가 aria-modal 을 남기면, 다른 탭의 ⌘Enter·⌘S·⌘F 가 전부 죽었다(코덱스가 짚었다).
      const visibleModal = Array.from(document.querySelectorAll('[aria-modal="true"]')).some(el => el.getClientRects().length > 0)
      if (previewRef.current || visibleModal) return
      // 텍스트로 편집(bulk) 칸은 blur 때 표에 반영된다. 거기서 바로 ⌘Enter·⌘S 를 누르면
      // 방금 친 값이 빠진 채 나갔다 — 먼저 반영(blur)하고, 다시 그려진 뒤에 실행한다.
      const commitThen = (fn: () => void) => {
        const el = document.activeElement
        if (el instanceof HTMLElement && el.dataset.commitOnBlur !== undefined) { el.blur(); setTimeout(() => fn(), 0) } else fn()
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); commitThen(() => runRef.current()) }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); commitThen(() => saveRef.current()) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isActive])

  // 템플릿 저장은 [편집] 모드에서 명시적으로 눌렀을 때만 발생하는 별도 경로(PUT) — run()과 완전히 분리되어 있어
  // 실행 버튼은 어떤 경우에도 서버의 템플릿 값을 바꾸지 않는다.
  // ifUpdatedAt 로 낙관적 잠금 — 그 사이 다른 사람이 저장했으면 409 로 알리고 덮어쓰지 않는다.
  const [knownUpdatedAt, setKnownUpdatedAt] = useState<number | undefined>(request.updatedAt)
  const templateCandidate = { ...draft, name: nameDraft.trim() || request.name, description: descDraft, assertions, preSteps, postSteps, auth, tags, settings, aiExecutionAllowed, vars: reqVars }
  const hasChanges = JSON.stringify(templateCandidate) !== JSON.stringify({
    ...toDraft(request), name: request.name, description: request.description,
    assertions: request.assertions ?? [], preSteps: request.preSteps ?? [], postSteps: request.postSteps ?? [],
    auth: request.auth ?? { type: 'none' }, tags: request.tags ?? [], settings: request.settings ?? {},
    aiExecutionAllowed: request.aiExecutionAllowed ?? false, vars: request.vars ?? [],
  })
  useEffect(() => {
    setEditMode(hasChanges)
    // Changes to any editable tab must enable Save, including settings and scripts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasChanges])

  const saveTemplate = () => { void commitTemplate(knownUpdatedAt ?? 0) }
  const commitTemplate = async (reviewedUpdatedAt: number): Promise<boolean> => {
    setSaving(true)
    try {
      const res = await fetch(`/api/requests/${request.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          ...draft, name: nameDraft.trim() || request.name, description: descDraft, assertions, preSteps, postSteps, auth, tags, settings, aiExecutionAllowed, vars: reqVars,
          ifUpdatedAt: reviewedUpdatedAt,
        }),
      })
      const body = await res.json().catch(() => null)
      if (res.status === 409) {
        setReviewSave(true)
        toast('error', i18nText('dynamicAnyOtherChangesHaveBeenSavedCheckBackFor'))
        return false
      }
      if (!res.ok || !body) { toast('error', i18nText('dynamicFailedToSaveTemplate', { v0: String(res.status) })); return false }
      setKnownUpdatedAt(body.updatedAt)
      toast('success', i18nText('dynamicYourRequestHasBeenSaved'))
      setEditMode(false)
      onTemplateSaved({ ...templateCandidate, updatedAt: body.updatedAt })
      return true
    } catch (e) {
      // 서버 오류는 알리면서 연결 실패는 조용했다 — 누르고도 아무 일이 없는 것처럼 보인다.
      toast('error', i18nText('dynamicRequestFailed', { v0: String(errorText(e)) }))
      return false
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    registerSave?.(() => saving ? Promise.resolve(false) : commitTemplate(knownUpdatedAt ?? 0))
    return () => registerSave?.(null)
  })

  // ⌘S: 편집 모드에서만 저장 동작 (실수로 실행 모드에서 눌러도 무해)
  saveRef.current = () => { if (hasChanges && !saving) saveTemplate() }

  // 응답 본문에서 나오는 값들은 본문이 바뀔 때만 다시 만든다. 예전엔 렌더마다(= 칸에 글자 하나 칠 때마다)
  // 본문 전체를 JSON 으로 두 번 읽고, 다시 문자열로 펴고, 바이트를 세고, 값 목록을 만들었다 —
  // 수 MB 응답을 띄워 둔 채 입력하면 그만큼의 사본이 매 타자 새로 생겼다(codex 점검).
  const body = result?.responseBody
  const parsedResponse = useMemo(() => {
    if (!body) return null
    try { return JSON.parse(body) as unknown } catch { return null }
  }, [body])
  const prettyBody = useMemo(() => {
    if (!body) return body ?? ''
    return parsedResponse !== null ? JSON.stringify(parsedResponse, null, 2) : body
  }, [body, parsedResponse])
  const responseSize = useMemo(() => {
    if (body == null) return null
    const bytes = new TextEncoder().encode(body).length
    return bytes < 1024 ? `${bytes}B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${(bytes / 1024 / 1024).toFixed(1)}MB`
  }, [body])
  const responseLeaves = useMemo(() => (parsedResponse !== null ? collectLeaves(parsedResponse) : []), [parsedResponse])

  const snippets = useRequestSnippet(request.id, { environmentId, input: draft, personalVars: getPersonalVars(environmentId), preSteps, auth, vars: reqVars, settings }, isActive, variableRevision + folderRevision + (result?.executedAt ?? 0))
  const copyCurl = () => snippets.copy('curl')
  const copyCurlRef = useRef(copyCurl)
  copyCurlRef.current = copyCurl
  useEffect(() => {
    if (isActive && copyCurlRequested) { onCurlCopyHandled?.(); void copyCurlRef.current() }
  }, [isActive, copyCurlRequested, onCurlCopyHandled])
  useEffect(() => {
    if (!isActive) return
    const copy = () => { void copyCurlRef.current() }
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.altKey || !(e.metaKey || e.ctrlKey) || !e.shiftKey || (e.code !== 'KeyC' && e.key.toLowerCase() !== 'c')) return
      const target = document.activeElement
      if (target instanceof HTMLElement && (target.closest('input, textarea, select, [role="textbox"]') || target.isContentEditable)) return
      if (Array.from(document.querySelectorAll('[aria-modal="true"]')).some(el => el.getClientRects().length)) return
      e.preventDefault(); copy()
    }
    window.addEventListener('postq:copy-curl', copy)
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('postq:copy-curl', copy); window.removeEventListener('keydown', key) }
  }, [isActive])

  // 복사용 변수맵 = 동적변수(실값) + 팀 env + 개인 오버라이드(secret). pre-step 파생값은 서버 계산이라
  // 리터럴로 남지만 동적변수/실변수는 실제 값으로 채워진다.
  const buildCopyVarMap = (): VarMap => ({
    ...dynamicVars(),
    // 우선순위: 전역 < 프로젝트 < 환경 < 요청 < 개인 (뒤가 이김) — globalVars 는 이미 앞 둘을 합친 것 — 실행 해석과 동일하게 맞춰 스니펫이 실제 전송과 일치.
    ...Object.fromEntries(globalVars.map(v => [v.key, { value: v.value, secret: v.secret }])),
    ...Object.fromEntries((selectedEnv?.variables ?? []).map(v => [v.key, { value: v.value, secret: v.secret }])),
    ...Object.fromEntries(reqVars.filter(v => v.key && v.value !== '').map(v => [v.key, { value: v.value, secret: false }])),
    ...Object.fromEntries(Object.entries(getPersonalVars(environmentId)).map(([k, v]) => [k, { value: v, secret: true }])),
  })
  const snippetContext: SnippetContext = { folderHeaders: folderShared, folderAuth, auth }
  const liveRef = useRef(onLiveChange)
  liveRef.current = onLiveChange
  useEffect(() => {
    if (isActive) liveRef.current?.({ requestId: request.id, name: request.name, draft, referencedVariables: requestVariableReferences(draft, snippetContext, preSteps, postSteps), scriptVariables: preSteps.map(step => step.name), context: snippetContext, prepared: snippets.prepared, copyCode: snippets.copy, snippetError: snippets.error, vars: buildCopyVarMap(), varScopes: {
      ...Object.fromEntries(globalVars.map(v => [v.key, v.scope])),
      ...Object.fromEntries((selectedEnv?.variables ?? []).map(v => [v.key, 'env' as const])),
      ...Object.fromEntries(reqVars.filter(v => v.value !== '').map(v => [v.key, 'request' as const])),
      ...Object.fromEntries(Object.keys(getPersonalVars(environmentId)).map(key => [key, 'personal' as const])),
    }, varSources: {
      ...Object.fromEntries(globalVars.map(v => [v.key, SHARED_SCOPE_LABEL[v.scope]])),
      ...Object.fromEntries((selectedEnv?.variables ?? []).map(v => [v.key, selectedEnv?.name ?? '환경'])),
      ...Object.fromEntries(reqVars.filter(v => v.value !== '').map(v => [v.key, '요청'])),
      ...Object.fromEntries(Object.keys(getPersonalVars(environmentId)).map(key => [key, '개인'])),
    }, envName: environments.find(e => e.id === environmentId)?.name ?? null })
    // Variable values are derived from these inputs; avoid emitting on parent-only renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, request.id, request.name, draft, environmentId, environments, globalVars, reqVars, folderShared, folderAuth, auth, preSteps, postSteps, snippetError, variableRevision, snippets.prepared, snippets.error])

  const copyResponse = async () => {
    if (result?.responseBody == null) return
    const ok = await copyText(prettyBody)
    toast(ok ? 'success' : 'error', ok ? i18nText('dynamicResponseBodyCopied') : i18nText('dynamicCopyFailedYourBrowserMayHaveBlockedTheClipboard'))
  }

  // 코드 스니펫 복사 (fetch/axios/python) — cURL 과 동일 정책(secret {{참조}} 유지)
  const [codeMenuOpen, setCodeMenuOpen] = useState(false)
  const copyCode = async (lang: 'fetch' | 'axios' | 'python') => {
    setCodeMenuOpen(false)
    await snippets.copy(lang)
  }

  // 스펙 검증 — 응답을 스펙 스키마와 대조
  const [validation, setValidation] = useState<{ ok: boolean; issues: SchemaIssue[]; skipped?: string } | null>(null)
  const [validating, setValidating] = useState(false)
  const [schemaAvailability, setSchemaAvailability] = useState<{ available: boolean; reason?: string } | null>(null)
  const responseContentType = Object.entries(result?.responseHeaders ?? {}).find(([key]) => key.toLowerCase() === 'content-type')?.[1] ?? 'application/json'
  useEffect(() => {
    setSchemaAvailability(null)
    setValidation(null)
    // 구조 검사 버튼이 늘 보이므로 응답마다 한 번 확인한다(예전엔 메뉴를 열 때만 물었다).
    if (!result) return
    const controller = new AbortController()
    fetch(`/api/requests/${request.id}/validate?status=${result.responseStatus ?? ''}&contentType=${encodeURIComponent(responseContentType)}`, { signal: controller.signal })
      .then(r => r.json()).then(setSchemaAvailability)
      .catch(e => { if (e.name !== 'AbortError') setSchemaAvailability({ available: false, reason: '스펙 연결을 확인하지 못했습니다' }) })
    return () => controller.abort()
  }, [request.id, result?.id, responseContentType])

  const validateSpec = async () => {
    if (result?.responseBody == null) return
    setValidating(true)
    try {
      const res = await fetch(`/api/requests/${request.id}/validate`, {
        method: 'POST', body: JSON.stringify({ responseBody: result.responseBody, responseStatus: result.responseStatus, contentType: responseContentType }),
      })
      const data = await res.json()
      if (!res.ok) { toast('error', i18nText('dynamicVerificationFailed', { v0: String(data.error ?? res.status) })); return }
      setValidation(data)
      if (data.skipped) toast('info', i18nText('dynamicUnableToCheck', { v0: String(data.skipped) }))
      else if (data.ok) toast('success', i18nText('dynamicPassBasicStructureCheckRequiredFieldsTypesAndAllowable'))
      else toast('error', i18nText('dynamicSpecMismatchCaseBackendResponseIsDifferentFromSpec', { v0: String(data.issues.length) }))
    } catch (e) {
      // 서버 오류는 알리면서 연결 실패는 조용했다 — 누르고도 아무 일이 없는 것처럼 보인다.
      toast('error', i18nText('dynamicRequestFailed', { v0: String(errorText(e)) }))
    } finally {
      setValidating(false)
    }
  }

  // 요청+응답/에러를 LLM 에 바로 붙여넣을 프롬프트로 복사 (MCP 채팅의 경량 대안)
  const [aiPreview, setAiPreview] = useState<string | null>(null)
  const openAiPreview = () => {
    const input = result?.resolved
      ? { ...result.resolved, bodyType: result.resolved.bodyType as RequestInput['bodyType'] }
      : resolveRequest(draft, buildCopyVarMap()).redacted
    const prompt = buildAiPrompt(request.name, input, {
      status: result?.responseStatus, error: result?.error,
      durationMs: result?.durationMs, responseBody: result?.responseBody, responseHeaders: result?.responseHeaders,
    })
    setAiPreview(prompt)
  }
  const copyAiPrompt = async () => {
    if (aiPreview === null) return
    const ok = await copyText(aiPreview)
    toast(ok ? 'success' : 'error', ok
      ? i18nText('dynamicRequestResponseCopiedPasteIntoLocalAITerminal')
      : i18nText('dynamicCopyFailedYourBrowserMayHaveBlockedTheClipboard'))
  }

  // JSON 바디 상태: 정리(beautify) + 문법 오류 표시
  // 바디 타입이 Raw 라도 내용이 JSON 이면 JSON 으로 다룬다. 실제로 저장된 요청 상당수가
  // Raw 인데 안에는 JSON 이라, 선언만 보고 판단하면 정작 필요한 곳에서 도구가 사라진다.
  // {{변수}} 가 값 자리에 맨몸으로 있어도 파싱되도록 jsonFormat 이 처리한다.
  // [정리]가 되돌리기를 살린 채 값을 바꾸려면 편집기 본체가 필요하다.
  const bodyEditorRef = useRef<HTMLTextAreaElement | null>(null)
  const bodyIsJson = draft.bodyType === 'json' || looksLikeJson(draft.body)
  const bodyProblem = bodyIsJson ? findJsonProblem(draft.body) : null
  const bodyJsonError = bodyProblem?.message ?? null
  const beautifyBody = () => {
    const { text, problem } = formatJson(draft.body)
    if (problem) { toast('error', i18nText('dynamicJSONSyntaxErrorCheckLine', { v0: String(problem.line) })); return }
    if (text === draft.body) return
    const ta = bodyEditorRef.current
    if (ta) {
      // 편집기를 통해 바꿔야 ⌘Z 로 되돌아간다. 예전엔 state 를 갈아끼워서, [정리] 한 번에
      // 주석이 사라졌는데 되돌릴 수도 없었다.
      ta.focus()
      ta.setSelectionRange(0, ta.value.length)
      if (document.execCommand('insertText', false, text)) return
    }
    setDraft({ ...draft, body: text })
  }

  // 응답 Content-Type — 뷰 모드(preview 가능 여부·다운로드 MIME) 판단용
  const contentType = (() => {
    const h = result?.responseHeaders
    if (!h) return ''
    const k = Object.keys(h).find(x => x.toLowerCase() === 'content-type')
    return k ? h[k].toLowerCase() : ''
  })()
  const isHtml = contentType.includes('text/html')
  const rawBody = result?.responseBody ?? ''
  // preview 는 HTML 일 때만 유효 — 다른 타입인데 preview 로 남아 있으면 pretty 로 취급
  const effView = respView === 'preview' && !isHtml ? 'pretty' : respView
  const headerEntries = Object.entries(result?.responseHeaders ?? {})
  const headerText = headerEntries.map(([k, v]) => `${k}: ${v}`).join('\n')

  const responseText = effView === 'raw' ? rawBody : prettyBody
  const responseSearch = useTextSearch(responseText)

  const downloadBody = () => {
    if (result?.responseBody == null) return
    const blob = new Blob([result.responseBody], { type: contentType || 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `response-${request.id.slice(0, 8)}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }

  // 응답 JSON 파싱(변수 추출용) — 실패하면 null(추출 버튼 숨김)

  const lastSegment = (path: string) => (path.split('.').pop() ?? path).replace(/\[\d+\]/g, '')

  // 자동 trailing 빈 행(KVEditor)이 카운트에 잡히지 않도록 key가 실제로 채워진 행만 센다.
  const enabledCount = (items: { key: string; enabled: boolean }[]) =>
    items.filter(i => i.enabled && i.key.trim() !== '').length

  // 윗줄 색도 서버와 같은 판정 — 예전엔 HTTP 코드만 봐서, 옆에 '✗ 응답 검증 실패' 가 떠도 초록이었다
  const isErrorResult = !!result && isFailedExecution(result)

  // 참조 변수 실시간 해석 — 실행 전에 어떤 변수가 어느 환경 값으로 치환될지/미등록인지 보여준다.
  // "{{baseUrl}}이 무슨 값인지 모르겠다"를 없애는 핵심 UX: 값 미리보기 + 환경명 병기, secret 은 마스킹.
  const selectedEnv = environments.find(e => e.id === environmentId) ?? null
  const envVarMap = new Map((selectedEnv?.variables ?? []).map(v => [v.key, v]))
  const personalOverrides = getPersonalVars(environmentId)
  const referencedVars = extractVariables(draft)
  // pre/post 스텝이 실행 시 만들어내는 변수 이름 — '미등록' 경고 오탐을 막는다.
  const stepVarNames = new Set([...preSteps, ...postSteps].map(s => s.name).filter(Boolean))
  // 요청별 변수(값 있는 것만) — 해석·하이라이트에 포함
  const reqVarKeys = new Set(reqVars.filter(v => v.key.trim() && v.value !== '').map(v => v.key))
  const globalVarMap = new Map(globalVars.map(v => [v.key, v]))
  // 개인 오버라이드가 있거나 스텝/요청변수/전역변수가 제공하면 선택 환경에 없어도 해결된 것으로 본다
  const unresolvedVars = referencedVars.filter(name => !envVarMap.has(name) && !globalVarMap.has(name) && !personalOverrides[name] && !stepVarNames.has(name) && !reqVarKeys.has(name))
  const previewValue = (value: string) =>
    value.length > 28 ? `${value.slice(0, 28)}…` : value

  // URL 입력 {{변수}} 자동완성 — {{ 를 치면 선택된 환경의 변수명을 드롭다운으로 제안.
  // 열림/후보 판단은 lib/varAutocomplete.ts 순수 함수(suggestVariables)가 담당한다.
  const urlInputRef = useRef<HTMLInputElement>(null)
  const urlBackdropRef = useRef<HTMLDivElement>(null)
  // [⋯] 메뉴 — 항목을 고르면 닫는다(details 는 기본으로 열린 채 남는다)
  const moreRef = useRef<HTMLDivElement>(null)
  const runOptionsRef = useRef<HTMLDivElement>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [runOptionsOpen, setRunOptionsOpen] = useState(false)
  // 응답의 [코드 ▾] 목록 — 바깥을 누르거나 Esc 면 닫는다.
  const codeMenuRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return
      if (!moreRef.current?.contains(event.target)) setMoreOpen(false)
      if (!runOptionsRef.current?.contains(event.target)) setRunOptionsOpen(false)
      if (!codeMenuRef.current?.contains(event.target)) setCodeMenuOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (moreRef.current?.querySelector('[aria-expanded="true"]')) { setMoreOpen(false); moreRef.current.querySelector('button')?.focus() }
      setRunOptionsOpen(false)
      // 목록 안에 포커스가 있었으면 [코드 ▾]로 돌려준다 — 항목이 사라지며 키보드 위치를 잃는다(codex 리뷰).
      if (codeMenuRef.current?.contains(document.activeElement)) codeMenuRef.current.querySelector('button')?.focus()
      setCodeMenuOpen(false)
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape) }
  }, [])

  // 하이라이트 색 판정: 해석 가능(env/개인/스텝/동적/요청변수) 여부. envVarMap 등은 위에서 계산됨.
  const isVarResolvable = (name: string) =>
    envVarMap.has(name) || globalVarMap.has(name) || !!personalOverrides[name] || stepVarNames.has(name)
    || reqVarKeys.has(name) || (DYNAMIC_VARS as readonly string[]).includes(name)
  const [urlSuggest, setUrlSuggest] = useState<VarSuggestion>(SUGGEST_CLOSED)
  const [suggestIndex, setSuggestIndex] = useState(0)
  const updateUrlSuggest = (value: string, caret: number | null) => {
    // '이 이름은 풀린다' 고 판정하는 출처와 같은 곳에서 후보를 낸다 — 예전엔 환경 변수만 제안해서
    // 전역·요청·개인 값은 이름을 외워 쳐야 했다.
    const names = [...new Set([
      ...(selectedEnv?.variables ?? []).map(v => v.key), ...globalVarMap.keys(), ...reqVarKeys,
      ...Object.keys(personalOverrides), ...stepVarNames, ...DYNAMIC_VARS,
    ])].filter(Boolean)
    setUrlSuggest(suggestVariables(value, caret ?? value.length, names))
    setSuggestIndex(0)
  }
  const pickUrlVar = (name: string) => {
    const el = urlInputRef.current
    const caret = el?.selectionStart ?? draft.url.length
    const applied = applyVariable(draft.url, caret, urlSuggest.start, name)
    setDraft({ ...draft, url: applied.text })
    setUrlSuggest(SUGGEST_CLOSED)
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(applied.caret, applied.caret) })
  }
  const onUrlKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    // 주소창 Enter = 보내기 (Postman 과 같다). 변수 제안이 떠 있으면 그 선택이 먼저다.
    if ((!urlSuggest.open || urlSuggest.matches.length === 0) && e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) {
      e.preventDefault(); void run(); return
    }
    if (!urlSuggest.open || urlSuggest.matches.length === 0) return
    const n = urlSuggest.matches.length
    if (e.key === 'ArrowDown') { e.preventDefault(); setSuggestIndex(i => (i + 1) % n) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSuggestIndex(i => (i - 1 + n) % n) }
    else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); pickUrlVar(urlSuggest.matches[Math.min(suggestIndex, n - 1)]) }
    else if (e.key === 'Escape') { e.preventDefault(); setUrlSuggest(SUGGEST_CLOSED) }
  }

  return (
    <div data-request-editor ref={panelRef} className="flex h-full min-h-0 flex-col text-sm">
      {selectedEnv?.executionPolicy && selectedEnv.executionPolicy !== 'open' && <div role="status" data-testid="execution-policy-banner" className="shrink-0 border-b border-accent bg-accent/10 px-4 py-3 font-semibold text-accent">
        {selectedEnv.name} · {selectedEnv.executionPolicy === 'read-only' ? i18nText('jsxOnlyReadRequestsAreExecutedWriteRequestsAreBlocked') : i18nText('jsxWriteRequestsAreExecutedAfterHumanVerificationAIAutoruns')}
      </div>}
      {snippets.dialog}
      {confirmWrite && <ModalFrame label={i18nText('uiConfirmWriteRequestExecution')} onClose={() => setConfirmWrite(false)}>
        <ModalHeader title={i18nText('uiConfirmWriteRequestExecution')} onClose={() => setConfirmWrite(false)} />
        <p className="p-4">{selectedEnv?.name} {i18nText('uiToTheEnvironment')} {draft.method} {i18nText('uiBySendingARequestYourDataMayChange')}</p>
        <div className="flex justify-end gap-2 p-4"><button className="ah-action ah-btn-secondary" onClick={() => setConfirmWrite(false)}>{i18nText('uiCancel')}</button><button className="ah-btn-primary" onClick={() => void run(true, true)}>{i18nText('uiRunWriteAfterConfirmation')}</button></div>
      </ModalFrame>}
      {reviewSave && <ReviewTemplateSave requestId={request.id} baseline={knownUpdatedAt} candidate={templateCandidate} onClose={() => setReviewSave(false)} onSave={commitTemplate} />}
      {aiPreview !== null && <ModalFrame label={i18nText('uiRequestResponseForAI')} onClose={() => setAiPreview(null)}>
        <ModalHeader title={i18nText('uiRequestResponseForAI')} onClose={() => setAiPreview(null)} />
        <textarea aria-label={i18nText('uiCopyContentForAI')} readOnly value={aiPreview} className="m-4 min-h-0 h-[55vh] resize-none overflow-auto rounded-[var(--radius-sm)] border border-border bg-background p-3 font-mono text-ui-md text-foreground" />
        <div className="flex justify-end border-t border-border px-4 py-3">
          {/* 채워진 기본 버튼은 .ah-btn-primary 가 담당한다 — accent 솔리드에 짝이 맞는 글자색.
              직접 bg-accent + text-white 로 쓰면 다크의 밝은 accent(#b1a6ff) 위에서 대비가
              2.15:1 까지 떨어져 글자가 안 읽혔다(AA 기준 4.5). */}
          <button type="button" onClick={copyAiPrompt} className="ah-btn-primary px-4 py-2">{i18nText('uiCopyAll')}</button>
        </div>
      </ModalFrame>}

      {versionsOpen && <RequestVersions request={request} onClose={() => setVersionsOpen(false)} onRestored={row => {
        setDraft(toDraft(row)); setNameDraft(row.name); setDescDraft(row.description); setAssertions(row.assertions ?? []);
        setPreSteps(row.preSteps ?? []); setPostSteps(row.postSteps ?? []); setAuth(row.auth ?? { type: 'none' }); setTagsInput((row.tags ?? []).join(', ')); setSettings(row.settings ?? {}); setAiExecutionAllowed(row.aiExecutionAllowed ?? false); setReqVars(row.vars ?? []);
        setBulkMode(false); setParameterSection(null); setEditMode(false); setKnownUpdatedAt(row.updatedAt); onTemplateSaved(row); toast('success', i18nText('jsxIRestoredMySave'));
      }} />}
      {/* 실행 대상 환경과 요청 조작을 같은 영역에서 확인한다. */}
      <div className="flex shrink-0 flex-col gap-2 border-b border-border/70 px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-2" data-testid="request-toolbar">
        {/* 이름을 누르면 바로 바꾼다 — 예전엔 [팀 공용 요청 편집] 을 먼저 눌러야 이름 칸이 나왔다. */}
        {editMode && <span className="sr-only">{i18nText('uiUnsavedChanges')}</span>}
        <span aria-hidden className="font-mono text-ui-meta font-bold text-accent">HTTP</span>
        <span className="max-w-[25%] truncate text-ui-sm text-faint-foreground" title={folderName}>{folderName || i18nText('jsxCollection')} ›</span>
        <input ref={nameInputRef} aria-label={i18nText('uiTemplateName')} title={i18nText('uiRename')} className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-1 text-ui-md font-semibold text-foreground hover:border-border focus:border-accent focus:outline-none" value={nameDraft} onChange={e => { setNameDraft(e.target.value); setEditMode(true) }} />


        <ToolButton icon="ai" aria-label={i18nText('uiCopyForAI')} type="button" className="rounded-[var(--radius-sm)] px-2.5 py-1.5 text-ui-sm font-medium text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground" onClick={openAiPreview} title={i18nText('uiCheckAndCopyTheRequestResponse')} />
        <ToolButton icon="history" aria-label={i18nText('uiExecutionHistory')} type="button" data-testid="toggle-history" aria-pressed={historyVisible} className={`rounded-[var(--radius-sm)] px-2.5 py-1.5 text-ui-sm font-medium transition-colors ${historyVisible ? 'bg-accent/10 text-accent' : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'}`} onClick={onOpenHistory} />
        {/* 편집·[⋯] 는 실행 왼쪽에 붙인다 — 이것만으로 한 줄을 더 쓸 이유가 없다. */}
        {/* 고치면 저절로 편집 중이 된다. [편집] 버튼을 따로 누를 일이 없어서 뺐고,
            편집 중일 때만 [되돌리기]·[저장] 이 나온다. */}
        {editMode && (
          <>
            <ToolButton icon="undo" aria-label={i18nText('uiRevert')}
              type="button"
              className="shrink-0 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-ui-sm font-medium text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground disabled:opacity-50"
              disabled={saving}
              onClick={discardEdits}
             />
          </>
        )}
            <button
              type="button"
              title={i18nText('uiSaveDirectlyOnRequestS')}
              aria-label={i18nText('uiSaveChangesS')}
              className="flex shrink-0 items-center gap-1 rounded-[var(--radius-sm)] border border-border bg-surface-2 px-3 py-1.5 text-ui-lg font-semibold text-foreground transition-colors hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              disabled={saving || !hasChanges}
              onClick={saveTemplate}
            >
              {saving ? <><IconSpinner />{i18nText('uiSaving')}</> : <><svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden><path d="M3 2h8l2 2v10H3V2Z M5 2v4h5V2 M5 14V9h6v5" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>{i18nText('uiSave')}<kbd className="ml-1 rounded-[var(--radius-sm)] bg-black/10 px-1.5 py-0.5 font-mono text-ui-meta font-normal opacity-80">⌘S</kbd></>}
            </button>
        {/* 자주 안 쓰는 보조 액션은 [⋯] 뒤로 — 5개를 늘어놓으니 좁은 폭에서 툴바가
            3줄로 깨지고 '공유' 만 홀로 다음 줄에 떨어졌다. */}
        <div className="relative shrink-0" ref={moreRef}>
          <ToolButton icon="tools" aria-label={i18nText('uiRequestTool')} aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen(v => !v)} />
          {moreOpen &&           <div className="absolute right-0 z-30 mt-1 flex w-max min-w-[176px] flex-col rounded-[var(--radius-md)] border border-border bg-surface p-1 shadow-[var(--shadow-card)]">
            {([
              [i18nText('jsxConfirmChangesAndSave'), i18nText('jsxCompareWithTheLatestSaveAndSave'), () => setReviewSave(true)],
              [i18nText('jsxResponseConfirmationConditions'), assertions.length ? i18nText('dynamicSetAutomaticallyChecksIfTheResponseIsCorrect', { v0: String(assertions.length) }) : i18nText('jsxAutomaticallyCheckIfTheResponseIsCorrect'), () => setTab('tests')],
              [i18nText('jsxAutoEnterValues'), preSteps.length + postSteps.length ? i18nText('dynamicSetCreateValueBeforeSendingAndDrawResponseValue', { v0: String(preSteps.length + postSteps.length) }) : i18nText('jsxCreateValueBeforeSendingAndDrawResponseValue'), () => setTab('steps')],
              [i18nText('jsxEditDescription'), i18nText('jsxWriteADescriptionExampleForThisRequest'), () => setTab('docs')],
              [i18nText('jsxRunOptions'), i18nText('jsxWaitingTimeRedirectAndRequestSpecificSettings'), () => setTab('settings')],
              [i18nText('jsxSavedCopy'), i18nText('jsxCompareAndRestorePreviousDefinitions'), () => { if (editMode) { toast('info', i18nText('jsxPleaseSaveYourEditsAndOpenIt')); return }; setVersionsOpen(true) }],
              [i18nText('jsxPreview'), i18nText('jsxCheckActualOutgoingRequestFolderHeaderVariableSubstitutionAuthentication'), openPreview],
            ] as const).map(([label, hint, run]) => (
              <button
                key={label}
                type="button"
                title={hint}
                className="rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-ui-lg text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
                onClick={() => { run(); setMoreOpen(false) }}
              >
                {label}
              </button>
            ))}
          </div>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
        <button type="button" title={i18nText('uiCopyCurrentRequestCURLCCtrlShiftC')} className="shrink-0 rounded border border-border px-2 py-1 text-ui-md text-foreground hover:bg-surface-2" onClick={() => void copyCurl()}>{i18nText('uiCopyCURL')}</button>
        <button type="button" aria-label={i18nText('uiCopyLink')} title={i18nText('uiCopyLink')} className="shrink-0 rounded border border-border px-2 py-1 text-muted-foreground" onClick={async () => { const ok = await copyText(`${window.location.origin}/?req=${request.id}`); toast(ok ? 'success' : 'error', ok ? i18nText('jsxLinkCopied') : i18nText('jsxCopyFailed2')) }}>{i18nText('uiCopyLink')}</button>
        </div>
      </div>
      <div className="flex items-center gap-2" data-testid="request-address-bar">
        <select
          aria-label={i18nText('uiHTTPMethod')}
          className={`h-9 shrink-0 rounded-[var(--radius-sm)] border border-border bg-surface px-2 py-1.5 font-mono text-ui-lg font-bold outline-none transition-colors focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25 ${methodText(draft.method)}`}
          value={draft.method}
          onChange={e => { setDraft({ ...draft, method: e.target.value }); if (!editMode) setEditMode(true) }}
        >
          {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(m => <option key={m}>{m}</option>)}
        </select>
        <div className="relative min-w-0 flex-1">
          {/* 하이라이트 백드롭 — {{변수}}(accent/미등록 경고)·{경로파라미터} 색 구분.
              입력은 투명 텍스트 + 보이는 캐럿, 이 레이어가 색을 그린다. 가로 스크롤 동기화. */}
          <div
            ref={urlBackdropRef}
            aria-hidden
            className="pointer-events-none absolute inset-0 flex items-center overflow-hidden whitespace-pre rounded-[var(--radius-sm)] border border-transparent bg-surface px-2.5 font-mono text-ui-lg text-foreground"
          >
            {renderVarHighlight(draft.url, isVarResolvable)}
          </div>
          <input
            ref={urlInputRef}
            aria-label={i18nText('uiRequestURL')}
            className="relative h-9 w-full rounded-[var(--radius-sm)] border border-border bg-transparent px-2.5 py-1.5 font-mono text-ui-lg text-transparent caret-[var(--foreground)] outline-none transition-colors placeholder:text-faint-foreground focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25"
            value={draft.url}
            placeholder={i18nText('uiHttpsApiExampleComOrPasteCurlCommand')}
            onChange={e => { const url = e.target.value; setDraft({ ...draft, url, params: paramsFromUrl(url, draft.params) }); updateUrlSuggest(url, e.target.selectionStart) ; if (!editMode) setEditMode(true) }}
            onClick={e => {
              const caret = e.currentTarget.selectionStart ?? -1
              const match = [...draft.url.matchAll(/\{\{\s*([\p{L}\p{N}_.$-]+)\s*\}\}/gu)].find(m => caret >= m.index! && caret <= m.index! + m[0].length)
              if (match) {
                const root = e.currentTarget.closest('[data-request-editor]')
                const button = Array.from(root?.querySelectorAll<HTMLButtonElement>('[data-variable-name]') ?? []).find(el => el.dataset.variableName === match[1])
                button?.click()
              }
            }}
            onKeyDown={onUrlKeyDown}
            onPaste={e => {
              // 주소창에 curl 명령을 붙여넣으면 메서드·주소·헤더·바디를 채운다(Postman 과 같은 자리).
              // 템플릿은 저장 전까지 그대로라, 마음에 안 들면 [되돌리기]로 돌아간다.
              const text = e.clipboardData.getData('text')
              if (!/^\s*curl\s/i.test(text)) return
              const parsed = parseCurl(text)
              if (!parsed) return
              e.preventDefault()
              setDraft({ ...parsed.input, params: reconcile(parsed.input.url, parsed.input.params).params, url: reconcile(parsed.input.url, parsed.input.params).url })
              // 인증도 curl 에 있는 것만 쓴다. 이전 요청의 토큰·API 키가 남아 있으면 다른 호스트로
              // 실려 나간다 — curl 의 Authorization 헤더는 이미 헤더로 들어왔다.
              const hadAuth = auth.type !== 'none'
              setAuth({ type: 'none' })
              toast('success', i18nText('dynamicCURLLoadedMethodAddressHeaderBody', { v0: String(hadAuth ? i18nText('jsxExistingAuthenticationSettingsHaveBeenTurnedOff') : ''), v1: String(parsed.warnings.length ? ` (${parsed.warnings[0]})` : '') }))
            }}
            onScroll={e => { if (urlBackdropRef.current) urlBackdropRef.current.scrollLeft = e.currentTarget.scrollLeft }}
            onBlur={() => setUrlSuggest(SUGGEST_CLOSED)}
          />
          {urlSuggest.open && (
            <VarSuggest matches={urlSuggest.matches} activeIndex={suggestIndex} onPick={pickUrlVar} />
          )}
        </div>
        <button
          type="button"
          // 폴더의 '일괄 실행 (…)' 툴팁과 제목 패턴이 겹쳐 이름/타이틀 매칭이 모호하다.
          data-testid="run-request"
          title={running ? i18nText('jsxUndo') : i18nText('jsxRunCtrlEnter')}
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-[var(--radius-sm)] bg-accent-solid px-5 py-1.5 text-ui-lg font-semibold text-accent-solid-foreground transition-colors hover:bg-accent-solid-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          onClick={running ? cancelRun : () => run()}
        >
          {running ? <IconSpinner /> : <IconPlay />}
          {running ? i18nText('jsxCancel') : i18nText('jsxRun')}
          {/* 단축키를 툴팁에만 적어 두면 아무도 모른다 — 매번 마우스를 여기까지 옮기게 된다.
              자주 누르는 버튼에는 글자로 적어 둔다(누르는 김에 눈에 들어온다). */}
          {!running && <kbd className="ml-0.5 rounded-[var(--radius-sm)] bg-black/15 px-1.5 py-0.5 font-mono text-ui-meta font-normal opacity-80">⌘↵</kbd>}
        </button>
        <div className="relative shrink-0" ref={runOptionsRef}><ToolButton icon="chevronDown" aria-label={i18nText('uiRunOptionsMenu')} aria-haspopup="menu" aria-expanded={runOptionsOpen} onClick={() => setRunOptionsOpen(v => !v)} />{runOptionsOpen && <div className="absolute right-0 z-40 mt-1 w-44 rounded border border-border bg-surface p-1 shadow-lg"><button className="w-full px-3 py-2 text-left text-ui-md" onClick={() => { setRunOptionsOpen(false); void openPreview() }}>{i18nText('uiPreviewRequestToSend')}</button></div>}</div>
      </div>
      </div>

      {/* 설명(메모) — 실행 모드에서 팀 지식 표시 */}
      {!editMode && request.description && (
        <details className="rounded-[var(--radius-sm)] border border-border px-3 py-2 text-ui-md text-muted-foreground">
          <summary className="cursor-pointer">{i18nText('uiAPIDescription')} {request.description.split('\n')[0]}</summary>
          <p className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap leading-relaxed">{request.description}</p>
        </details>
      )}

      {/* 맥락 줄 — 이 요청이 쓰는 {{변수}}가 어떤 값으로 풀리는지, 그리고 이 API 가 지금
          어떤 상태인지(최근 실패·스펙 변경). 원래 두 줄이었는데 둘 다 '실행 전에 알아야 할 것'
          이라 성격이 같고, 각각 20px 남짓한 얇은 줄이 겹쳐 머리말만 두꺼워졌다.
          한 줄에 두고 넘치면 접는다 — 아무것도 없으면 줄 자체가 안 생긴다. */}
      {(referencedVars.length > 0 || status?.specChange) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-0.5 text-ui-sm">
          {referencedVars.length > 0 && (
          <span className="flex flex-wrap items-center gap-1.5">
          {referencedVars.map(name => {
            // 해석 소스 결정 — 우선순위: 개인 > 요청별 > 환경 > 프로젝트 > 전역 > 스텝(런타임). 없으면 미등록.
            const personal = personalOverrides[name]
            const reqVar = reqVars.find(rv => rv.key === name && rv.value !== '')
            const env = envVarMap.get(name)
            const glob = globalVarMap.get(name)
            const isStep = stepVarNames.has(name)
            const source = personal ? i18nText('dynamicPersonal') : reqVar ? i18nText('dynamicRequest') : env ? (selectedEnv?.name ?? '환경') : glob ? SHARED_SCOPE_LABEL[glob.scope] : isStep ? i18nText('dynamicStep') : undefined
            const displaySource = personal ? i18nText('jsxPersonal') : reqVar ? i18nText('jsxRequest') : env ? (selectedEnv?.name ?? i18nText('jsxEnvironment')) : glob ? i18nText(glob.scope === 'all' ? 'globalScope' : 'projectShared') : isStep ? i18nText('jsxStep') : undefined
            const secret = !!personal || !!env?.secret || !!glob?.secret
            const full = personal ?? reqVar?.value ?? env?.value ?? glob?.value ?? ''
            return <VariablePopover key={name} name={name} value={full} secret={secret} source={source} sourceLabel={displaySource}>
              <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 font-mono">
                <span className="font-semibold text-accent">{name}</span><span>→</span>
                <span className="text-muted-foreground">{secret ? '••••' : previewValue(full) || i18nText('jsxNotRegistered')}</span>
                <span>·{displaySource ?? i18nText('jsxAddToCurrentEnvironment')}</span>
              </span>
            </VariablePopover>
          })}
          {unresolvedVars.length > 0 && (
            <button
              type="button"
              className="rounded-full bg-transparent px-2 py-0.5 font-medium text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              onClick={onOpenEnvManager}
            >
              {i18nText('uiEnvironmentVariableManagement')}
            </button>
          )}
          {/* 전역변수를 못 읽었으면 '미해석' 이 실제 상태가 아니다 — 값은 있는데 못 읽은 것뿐이다 */}
          {globalVarsError && (
            <span className="rounded-full border border-method-delete/40 bg-method-delete/10 px-2 py-0.5 font-medium text-method-delete"
              title={globalVarsError}>
              {i18nText('uiFailedToLoadGlobalProjectVariablesUninterpretedDisplayIs')}
            </span>
          )}
          </span>
          )}
          {status?.specChange && (
          <>
          {status.specChange && (
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium ${
                status.specChange.changeType === 'deprecated'
                  ? 'border-method-delete/40 bg-method-delete/10 text-method-delete'
                  : 'border-method-put/40 bg-method-put/10 text-method-put'
              }`}
              title={specChangeTitle(status.specChange)}
            >
              {status.specChange.changeType === 'deprecated' ? i18nText('jsxDisappearedFromSpecs') : i18nText('jsxSpecificationChange')}
              {' · '}{agoText(status.specChange.createdAt)}
              {specChangeSummary(status.specChange) && ` — ${specChangeSummary(status.specChange)}`}
            </span>
          )}
          {/* 알림은 지울 수 있어야 알림이다. 안 그러면 며칠 뒤엔 벽지가 되고, 그때부터는
              정말 바뀐 것도 눈에 안 들어온다.
              '스펙에서 사라짐' 은 지우지 않는다 — 그건 사건이 아니라 지금도 그런 상태다. */}
          {status.specChange?.changeType === 'changed' && request.specState === 'changed' && (
            <button
              type="button"
              className="rounded-full px-1.5 py-0.5 font-medium text-accent transition-colors hover:bg-accent/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              title={i18nText('uiMarksItAsSeenTheCHANGEDBadgeOnThe')}
              onClick={async () => {
                const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/ack-spec`, {
                  method: 'POST', body: JSON.stringify({ requestIds: [request.id] }),
                }).catch(() => null)
                if (!res?.ok) { toast('error', i18nText('jsxConfirmationProcessingFailed')); return }
                toast('success', i18nText('jsxConfirmedAndProcessed'))
                // 탭이 든 요청과 트리 둘 다 갱신한다 — onTemplateSaved 가 그 둘을 잇는 통로다.
                // (이 값은 서버에 이미 반영됐다. 여기선 화면을 맞추는 것뿐이다)
                onTemplateSaved({ ...request, specState: 'synced' })
                setStatusVersion(v => v + 1)
              }}
            >
              {i18nText('uiOK')}
            </button>
          )}
          </>
          )}

        </div>
      )}

      {/* 미등록 변수를 그 자리에서 만든다 — 발견한 자리에서 손댈 수 있어야 한다.
          여기서 만든 것은 누르는 즉시 서버에 저장돼 다음 실행에 바로 쓰인다. */}
      {/* 전송 전 미해석 변수 경고 — 그대로 보내면 리터럴({{name}})로 나가 URL 이 깨질 수 있다 */}
      {confirmUnresolved !== null && unresolvedVars.length > 0 && (
        <div className="flex flex-col gap-2 rounded-[var(--radius-sm)] border border-method-put/40 bg-method-put/10 px-3 py-2.5">
          <div className="flex items-start gap-2 text-ui-md leading-relaxed text-foreground">
            <span className="mt-px shrink-0 text-method-put"><IconWarning /></span>
            <span>
              {i18nText('uiUninterpretedVariable')} {unresolvedVars.map(v => <code key={v} className="mx-0.5 rounded-[var(--radius-sm)] bg-surface-2 px-1 font-mono text-ui-sm text-method-put">{`{{${v}}}`}</code>)} {i18nText('uiIsNotFoundAnywhereInTheSelectedEnvironmentRequest')} <b>{i18nText('uiTransmitAsIsLiteral')}</b>{i18nText('uiItWorksIfItIsInThePathThe')}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 pl-6">
            <button type="button" className="rounded-[var(--radius-sm)] bg-method-put px-3 py-1 text-ui-md font-semibold text-background transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" onClick={() => run(true)}>
              {i18nText('uiRunAsIs')}
            </button>
            <button type="button" className="ah-action rounded-[var(--radius-sm)] bg-transparent px-3 py-1 text-ui-md font-medium text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" onClick={() => setConfirmUnresolved(null)}>
              {i18nText('uiCancel')}
            </button>
            <button type="button" className="ml-1 text-ui-md font-medium text-accent hover:text-accent-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" onClick={() => { setConfirmUnresolved(null); onOpenEnvManager?.() }}>
              {i18nText('uiEnvironmentVariableManagement')}
            </button>
          </div>
        </div>
      )}

      {/* 파라미터 / 헤더 / 바디 */}
      <div ref={requestAreaRef} data-testid="request-area" className={`flex min-h-0 min-w-0 flex-1 flex-col ${editMode ? 'border-l-2 border-l-badge-changed-fg/50' : ''}`}>
        <div className="request-subtabs flex shrink-0 flex-wrap gap-0 border-b border-border/70 px-2 pt-1.5">
          {(['docs', 'params', 'auth', 'headers', 'body', 'steps', 'tests', 'settings'] as const).map(t => {
            const count = t === 'params' ? enabledCount(draft.params) + pathNames.length : t === 'headers' ? enabledCount(draft.headers) : t === 'auth' && auth.type !== 'none' ? 1 : 0
            const label = t === 'params' ? 'Params' : t === 'headers' ? 'Headers' : t === 'auth' ? 'Authorization' : t === 'docs' ? 'Docs' : t === 'steps' ? 'Scripts' : t === 'tests' ? 'Tests' : t === 'settings' ? 'Settings' : 'Body'
            const active = tab === t
            return (
              <button
                key={t}
                type="button"
                // 어느 탭이 열려 있는지 밑줄 색으로만 알렸다 — 읽어 주는 도구에는 차이가 없다
                aria-pressed={active}
                className={`-mb-px flex shrink-0 items-center gap-1 whitespace-nowrap border-b-2 px-1.5 py-1.5 text-ui-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-accent ${
                  active ? 'border-accent text-foreground font-semibold' : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
                onClick={() => setTab(t)}
              >
                {label}
                {((t === 'body' && draft.bodyType !== 'none' && draft.body) || (t === 'docs' && descDraft) || (t === 'steps' && preSteps.length + postSteps.length) || (t === 'tests' && assertions.length)) ? <span aria-hidden className="h-1 w-1 rounded-full bg-method-get" /> : null}
                {count !== null && count > 0 && (
                  <span className={`px-0.5 text-ui-meta font-normal ${active ? 'bg-accent/15 text-accent' : 'bg-surface-2 text-faint-foreground'}`}>
                    {count}
                  </span>
                )}
              </button>
            )
          })}
          <button type="button" aria-pressed={tab === 'cookies'} className="ml-auto px-2 text-ui-sm text-muted-foreground hover:text-foreground" onClick={() => setTab('cookies')}>Cookies</button>
          {/* [검사·자동화] 는 탭 줄에서 뺐다 — 매번 눈에 걸리는데 거의 안 쓴다. [⋯] 메뉴에서 연다. */}
        </div>

        {(tab === 'tests' || tab === 'steps') && <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
          <button type="button" aria-pressed={tab === 'tests'} onClick={() => setTab('tests')} className={`rounded-[var(--radius-sm)] px-3 py-1.5 text-ui-md ${tab === 'tests' ? 'bg-surface-2 text-foreground' : 'text-muted-foreground'}`}>{i18nText('uiResponseConfirmationConditions')}</button>
          <button type="button" aria-pressed={tab === 'steps'} onClick={() => setTab('steps')} className={`rounded-[var(--radius-sm)] px-3 py-1.5 text-ui-md ${tab === 'steps' ? 'bg-surface-2 text-foreground' : 'text-muted-foreground'}`}>{i18nText('uiAutoEnterValues')}</button>
          <button type="button" className="ml-auto rounded-[var(--radius-sm)] px-2 py-1 text-ui-sm text-muted-foreground hover:bg-surface-2" onClick={() => setTab('params')}>{i18nText('uiReturnToRequests')}</button>
        </div>}
        {!['headers', 'params', 'body', 'auth', 'cookies', 'tests', 'steps'].includes(tab) && (
          <div className="flex shrink-0 items-center justify-between border-b border-border/60 bg-surface px-4 py-2">
            <span className="text-ui-md font-semibold">{tab === 'tests' ? i18nText('jsxResponseValidation') : tab === 'steps' ? i18nText('jsxValueCreationExtraction') : tab === 'docs' ? i18nText('jsxDocument') : i18nText('jsxRunOptions')}</span>
            <button type="button" className="rounded-[var(--radius-sm)] px-2 py-1 text-ui-sm text-muted-foreground hover:bg-surface-2" onClick={() => setTab('params')}>{i18nText('uiReturnToRequests')}</button>
          </div>
        )}
        <div data-testid="request-tab-content" className={`min-h-0 flex-1 p-2.5 ${boundedBody || boundedBulk ? 'flex flex-col overflow-hidden' : 'overflow-y-auto'}`}>
          {tab === 'params' && (
            <div role="tablist" aria-label={i18nText('uiParameterType')} className="mb-3 flex gap-1">
              {(['path', 'query'] as const).map(kind => (
                <button key={kind} type="button" role="tab"
                  aria-selected={kind === 'path' ? showPathParameters : !showPathParameters}
                  onClick={() => setParameterSection(kind)}
                  className={`rounded-[var(--radius-sm)] px-3 py-1.5 text-ui-sm transition-colors ${(kind === 'path' ? showPathParameters : !showPathParameters) ? 'bg-surface-2 font-semibold text-foreground' : 'text-muted-foreground hover:bg-surface-2'}`}>
                  {kind === 'path' ? i18nText('dynamicPath', { v0: String(pathNames.length) }) : i18nText('dynamicQuery', { v0: String(enabledCount(draft.params)) })}
                </button>
              ))}
            </div>
          )}
          {tab === 'params' && showPathParameters && (
            <section aria-label={i18nText('uiRouteParameters')} className="space-y-2">
                {pathNames.length > 0 && <div className="overflow-hidden rounded-[var(--radius-md)] border border-border">
                  {pathNames.map(key => (
                    <label key={key} className="flex items-center gap-3 border-b border-border p-2 last:border-b-0">
                      <span className="w-40 shrink-0 break-all font-mono text-ui-md text-accent">{key} <span className="font-sans text-ui-meta text-muted-foreground">{i18nText('uiRequired')}</span></span>
                      <input aria-label={i18nText('dynamicPathParameter', { v0: String(key) })} placeholder={i18nText('dynamicEnterValue', { v0: String(key) })}
                        className="min-w-0 flex-1 rounded-[var(--radius-sm)] border border-border bg-surface px-2 py-1.5 font-mono text-ui-md outline-none focus:border-accent"
                        value={reqVars.find(v => v.key === key)?.value ?? ''}
                        onChange={e => {
                          const value = e.target.value
                          setReqVars(current => [...current.filter(v => v.key !== key), { key, value }])
                        }} />
                    </label>
                  ))}
                </div>}
                {pathNames.length === 0 && <p className="text-ui-sm text-muted-foreground">{i18nText('uiTheAddressHasNoRouteParametersAddYourName')} {i18nText('pathParameterPlaceholder')} {i18nText('uiWriteItYourself')}</p>}
                <AddPathParam onAdd={name => { setDraft({ ...draft, url: addPathParam(draft.url, name) }); setEditMode(true) }} />
                <details className="text-ui-sm text-muted-foreground">
                  <summary className="cursor-pointer py-1">{i18nText('uiPreviewRequestURL')}</summary>
                  <p className="break-all py-1 font-mono" aria-label={i18nText('uiRequestPathPreview')}>{resolveRequest(draft, buildCopyVarMap()).redacted.url}</p>
                </details>
            </section>
          )}
          {((tab === 'params' && !showPathParameters) || tab === 'headers') && (
            <div className="mb-1.5 flex items-center justify-between gap-2">
              {/* 'Bulk' 한 단어가 표에서 멀찍이 떠 있어 무엇에 대한 버튼인지 안 보였다.
                  무엇을 여는지 글자로 적고, 지금 어느 모드인지도 라벨이 말한다. */}
              <span className="ah-label">
                {tab === 'headers' ? i18nText('jsxRequestHeader') : i18nText('jsxQueryParameters')}
              </span>
              <ToolButton icon={bulkMode ? "table" : "text"} aria-label={bulkMode ? i18nText('jsxEditAsTable') : i18nText('jsxEditWithText')}
                type="button"
                // 라벨이 모드에 따라 바뀐다 — 이름으로 집으면 테스트가 취약해진다.
                data-testid="bulk-toggle"
                title={i18nText('uiEditThemAsTextOnePerLineKeyValue')}
                aria-pressed={bulkMode}
                className={`h-7 shrink-0 rounded-[var(--radius-sm)] border px-2.5 text-ui-sm font-semibold transition-colors ${
                  bulkMode ? 'border-accent bg-accent/10 text-accent' : 'border-border text-muted-foreground hover:border-border-strong hover:text-foreground'
                }`}
                onClick={() => setBulkMode(m => !m)}
               />
            </div>
          )}
          {tab === 'params' && !showPathParameters && (bulkMode ? (
            <textarea
              aria-label={i18nText('uiParamsBulkEditing')}
              data-request-bulk
              className="min-h-0 w-full flex-1 resize-none rounded-[var(--radius-sm)] border border-border bg-surface p-2.5 font-mono text-ui-md leading-relaxed text-foreground outline-none placeholder:text-faint-foreground focus-visible:border-accent"
              placeholder={'key: value\n//disabledKey: value'}
              data-commit-on-blur
              defaultValue={kvToText(draft.params)}
              onBlur={e => { const params = textToKV(e.target.value, draft.params); setDraft({ ...draft, params, url: urlFromParams(draft.url, params) }) }}
            />
          ) : (
            <KVEditor items={draft.params} onChange={params => setDraft({ ...draft, params, url: urlFromParams(draft.url, params) })} />
          ))}
          {tab === 'headers' && bulkMode && (
            <textarea
              aria-label={i18nText('uiHeadersBulkEditing')}
              data-request-bulk
              className="min-h-0 w-full flex-1 resize-none rounded-[var(--radius-sm)] border border-border bg-surface p-2.5 font-mono text-ui-md leading-relaxed text-foreground outline-none placeholder:text-faint-foreground focus-visible:border-accent"
              placeholder={'Authorization: Bearer {{token}}\n//X-Debug: 1'}
              data-commit-on-blur
              defaultValue={kvToText(draft.headers)}
              onBlur={e => setDraft({ ...draft, headers: textToKV(e.target.value, draft.headers) })}
            />
          )}
          {tab === 'headers' && !bulkMode && (
            <div className="flex flex-col gap-2">
              {/* 물려받은 헤더를 같은 표 안에 넣는다 — 예전엔 표 아래 점선 상자에 따로 있어서
                  '실제로 나갈 헤더' 를 알려면 두 목록을 머리로 합쳐야 했고, 같은 키를 적었을 때
                  어느 쪽이 이기는지도 눈으로 안 보였다. */}
              <KVEditor
                items={draft.headers}
                onChange={headers => setDraft({ ...draft, headers })}
                suggest={HEADER_SUGGEST}
                inherited={folderShared}
              />
            </div>
          )}
          {tab === 'auth' && (
            <AuthEditor
              value={auth}
              onChange={setAuth}
              allowInherit
              footer={auth.type !== 'none' && !editMode
                ? <p className="text-ui-sm leading-relaxed text-faint-foreground">{i18nText('uiChangesAreReflectedByEditSave')}</p>
                : null}
            />
          )}
          {tab === 'cookies' && (() => {
            // 실행 때와 같은 변수로 주소를 채워 호스트를 정한다 — {{baseUrl}} 이면 환경마다 도메인이 다르다.
            let host: string | null = null
            try { host = new URL(resolveText(draft.url, buildCopyVarMap())).hostname || null } catch { host = null }
            return (
              <RequestCookies
                workspaceId={workspaceId}
                environmentId={environmentId}
                environmentName={selectedEnv?.name ?? null}
                host={host}
                hasCookieHeader={draft.headers.some(h => h.enabled && h.key.trim().toLowerCase() === 'cookie')}
              />
            )
          })()}
          {tab === 'body' && (
            // Bounded body editors own scrolling; structured forms keep the tab scroller.
            <div className="flex h-full min-h-0 flex-col gap-2">
              <div className="flex shrink-0 flex-wrap items-center gap-2">
              <select
                aria-label={i18nText('uiBodyType')}
                className="ah-input w-auto min-w-24"
                value={draft.bodyType === 'json' ? 'raw' : draft.bodyType}
                onChange={e => setDraft({ ...draft, bodyType: e.target.value === 'raw' ? 'json' : e.target.value as RequestInput['bodyType'] })}
              >
                {(['none', 'raw', 'form', 'graphql', 'multipart', 'binary'] as const).map(t => (
                  <option key={t} value={t}>{t === 'raw' ? 'raw' : localizeKorean(BODY_TYPE_LABEL[t])}</option>
                ))}
              </select>
              {(draft.bodyType === 'json' || draft.bodyType === 'raw') && <select aria-label={i18nText('uiBodyFormat')} className="ah-input w-auto min-w-24" value={draft.bodyType} onChange={e => setDraft({ ...draft, bodyType: e.target.value as 'json' | 'raw' })}><option value="json">JSON</option><option value="raw">Text</option></select>}
              <span className="flex-1" />
              {bodyIsJson && (
                <>
                  <button aria-label={i18nText('uiJSONCleanup')}
                    type="button"
                    title={i18nText('uiJSONCleanupIndentationFormat')}
                    className="rounded-[var(--radius-sm)] bg-transparent px-2 py-1 text-ui-sm font-medium text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground disabled:opacity-40"
                    disabled={!!bodyJsonError || draft.body.trim() === ''}
                    onClick={beautifyBody}
                  >{i18nText('uiOrganizing')}</button>
                  {bodyJsonError && (
                    <span title={bodyJsonError} className="rounded-[var(--radius-sm)] bg-method-delete/10 px-1.5 py-0.5 text-ui-sm font-bold text-method-delete">
                      {/* 'JSON 오류' 만으로는 어디를 볼지 알 수 없다 — 줄 번호까지 말해 준다. */}
                      {i18nText('uiJSONError')}{bodyProblem?.line ? i18nText('dynamicThLine', { v0: String(bodyProblem.line) }) : ''}
                    </span>
                  )}
                </>
              )}
              {/* 바디를 다른 곳(슬랙·Postman·코드)에 붙일 때 — 편집기 드래그는 긴 바디에서 번거로웠다.
                  JSON 이면 실제로 보내는 모양(⌘/ 로 뺀 줄과 그 뒤 끝 쉼표 제거)으로 복사한다.
                  주석이 남은 채 붙이면 받는 쪽에선 JSON 이 아니다. */}
              {draft.bodyType !== 'multipart' && draft.bodyType !== 'binary' && draft.body.trim() !== '' && (
                <CopyButton compact
                  value={draft.bodyType === 'graphql' ? draft.body : gqlWrap(draft.bodyType, draft.body)}
                  label={i18nText('uiCopyBody')}
                  title={bodyIsJson ? i18nText('jsxCopyTheRequestBodyExactlyAsYouSendIt') : i18nText('jsxCopyRequestBody')}
                  className="ml-auto px-2 py-1 text-ui-sm"
                />
              )}
              </div>
              {draft.bodyType === 'binary' ? (<BinaryEditor body={draft.body} onChange={body => setDraft({ ...draft, body })} />) : draft.bodyType === 'multipart' ? (
                <MultipartEditor body={draft.body} onChange={body => setDraft({ ...draft, body })} />
              ) : draft.bodyType === 'graphql' ? (
                <GraphqlEditor
                  key={request.id}
                  body={draft.body}
                  onBodyChange={body => setDraft({ ...draft, body })}
                  // 개인 변수도 넘긴다 — 실행에는 들어가는데 스키마 조회에만 빠져 있었다.
                  // 토큰을 개인 값으로 둔 사람은 실행은 되고 [스키마 불러오기] 만 '미해석 변수' 로 실패했다.
                  ctx={{ url: draft.url, headers: draft.headers, auth, environmentId, workspaceId, vars: reqVars, personalVars: getPersonalVars(environmentId) }}
                />
              ) : draft.bodyType !== 'none' && (
                <RequestBodyEditor
                  fit
                  json={bodyIsJson}
                  editorRef={bodyEditorRef}
                  errorAt={bodyProblem?.index ?? null}
                  aria-label={i18nText('uiRequestBody')}
                  value={draft.body}
                  placeholder={draft.bodyType === 'json' ? '{\n  "key": "value"\n}' : ''}
                  onChange={e => setDraft({ ...draft, body: e.target.value })}
                />
              )}
            </div>
          )}
          {tab === 'tests' && (
            <div className="flex flex-col gap-2">
              <p className="text-ui-sm leading-relaxed text-faint-foreground">
                {i18nText('uiThisIsASuccessConditionThatWillBeAutomatically')}
              </p>
              <div className="flex flex-col gap-1.5 rounded-[var(--radius-sm)] border border-dashed border-border bg-surface-2/40 p-2">
                <span className="text-ui-meta font-bold uppercase tracking-wide text-faint-foreground">{i18nText('uiTakeFromExample')}</span>
                <div className="flex flex-wrap gap-1">
                  {TEST_PRESETS.map(p => (
                    <button key={p.label} type="button" title={localizeKorean(p.hint)}
                      className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] border border-border bg-surface px-2 py-1 text-ui-sm font-medium text-muted-foreground transition-colors hover:border-accent hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                      onClick={() => setAssertions([...assertions, p.make()])}>
                      <span className="text-accent">+</span> {localizeKorean(p.label)}
                    </button>
                  ))}
                </div>
              </div>
              {assertions.map((a, i) => (
                <div key={i} className="flex flex-wrap items-center gap-1.5">
                  <select aria-label={i18nText('uiVerificationSubject')} className="rounded-[var(--radius-sm)] border border-border bg-surface px-1.5 py-1 text-ui-md text-foreground outline-none focus-visible:border-accent" value={a.target} onChange={e => setAssertions(assertions.map((x, j) => j === i ? { ...x, target: e.target.value as AssertTarget } : x))}>
                    <option value="status">{i18nText('uiStatusCode')}</option>
                    <option value="responseTime">{i18nText('uiResponseTimeMs')}</option>
                    <option value="jsonPath">{i18nText('uiJSONPath')}</option>
                    <option value="body">{i18nText('uiResponseBody')}</option>
                    <option value="header">{i18nText('uiHeader')}</option>
                  </select>
                  {(a.target === 'jsonPath' || a.target === 'header') && (
                    <input aria-label={i18nText('uiPathHeaderName')} className="w-36 rounded-[var(--radius-sm)] border border-border bg-surface px-1.5 py-1 font-mono text-ui-sm text-foreground outline-none focus-visible:border-accent" placeholder={a.target === 'jsonPath' ? 'data.id' : 'Content-Type'} value={a.path ?? ''} onChange={e => setAssertions(assertions.map((x, j) => j === i ? { ...x, path: e.target.value } : x))} />
                  )}
                  <select aria-label={i18nText('uiOperation')} className="rounded-[var(--radius-sm)] border border-border bg-surface px-1.5 py-1 text-ui-md text-foreground outline-none focus-visible:border-accent" value={a.op} onChange={e => setAssertions(assertions.map((x, j) => j === i ? { ...x, op: e.target.value as AssertOp } : x))}>
                    <option value="eq">{i18nText('uiEquals')}</option><option value="ne">{i18nText('uiDifferent')}</option><option value="contains">{i18nText('uiIncluded')}</option>
                    <option value="matches">{i18nText('uiRegularExpression')}</option><option value="exists">{i18nText('uiExistence')}</option><option value="notExists">{i18nText('uiNone')}</option>
                    <option value="lt">{i18nText('uiLessThan')}</option><option value="gt">{i18nText('uiGreaterThan')}</option>
                  </select>
                  {a.op !== 'exists' && a.op !== 'notExists' && (
                    <input aria-label={i18nText('uiExpectedValue')} className="w-28 rounded-[var(--radius-sm)] border border-border bg-surface px-1.5 py-1 font-mono text-ui-sm text-foreground outline-none focus-visible:border-accent" placeholder={i18nText('uiExpectedValue')} value={a.expected ?? ''} onChange={e => setAssertions(assertions.map((x, j) => j === i ? { ...x, expected: e.target.value } : x))} />
                  )}
                  <button type="button" aria-label={i18nText('uiDeleteRule')} className="ah-action rounded-[var(--radius-sm)] p-1 text-ui-sm text-muted-foreground hover:text-method-delete focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent" onClick={() => setAssertions(assertions.filter((_, j) => j !== i))}>{i18nText('uiDelete')}</button>
                </div>
              ))}
              <button type="button" className="self-start rounded-[var(--radius-sm)] text-ui-md font-medium text-accent hover:text-accent-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" onClick={() => setAssertions([...assertions, { target: 'status', op: 'eq', expected: '200' }])}>
                {i18nText('uiValidationRules')}
              </button>
              {assertions.length > 0 && !editMode && (
                <p className="text-ui-sm text-faint-foreground">{i18nText('uiYouCanRunItWithYourCurrentRulesSave')} <button type="button" className="ml-2 text-accent" onClick={() => setEditMode(true)}>{i18nText('uiReflectedInTemplate')}</button></p>
              )}
            </div>
          )}
          {tab === 'steps' && (
            <div className="flex flex-col gap-4">
              <div className="border-b border-border pb-3"><h3 className="text-ui-lg font-semibold">{i18nText('uiSetThisWhenYouWantToReduceRepetitiveInput')}</h3><p className="mt-1 text-ui-md text-muted-foreground">{i18nText('uiValuesThatYouEnterDirectlyEveryTimeSuchAs')}</p></div>
              {/* ── Pre-request ── 요청 보내기 전에 변수 계산 */}
              <section className="flex flex-col gap-2">
                <div className="flex items-baseline gap-2">
                  <h4 className="text-ui-md font-bold text-foreground">{i18nText('ui1CreateANewValueEachTimeYouSend')}</h4>
                  <span className="text-ui-sm text-faint-foreground">{i18nText('uiExampleNonDuplicateRequestIDs')}</span>
                </div>

                {/* 예시에서 가져오기 — 자주 쓰는 스텝을 바로 삽입 */}
                <select aria-label={i18nText('uiSelectValueToCreate')} value="" onChange={e => { const preset = PRE_STEP_PRESETS[Number(e.target.value)]; if (preset) setPreSteps([...preSteps, preset.make()]) }} className="self-start rounded-[var(--radius-sm)] border border-border bg-surface px-3 py-2 text-ui-md">
                  <option value="" disabled>{i18nText('uiSelectAValueToCreate')}</option>
                  {PRE_STEP_PRESETS.map((p, i) => <option key={p.label} value={i}>{localizeKorean(p.label)} — {localizeKorean(p.hint)}</option>)}
                </select>

                {preSteps.map((s, i) => (
                  <div key={i} className="flex flex-col gap-1.5 ah-subpanel">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <select aria-label={i18nText('uiOperation')} className="rounded-[var(--radius-sm)] border border-border bg-surface px-1.5 py-1 text-ui-md font-medium text-foreground outline-none focus-visible:border-accent" value={s.op} onChange={e => setPreSteps(preSteps.map((x, j) => j === i ? { ...x, op: e.target.value as PreStepOp } : x))}>
                        {(Object.keys(PRE_OP_LABEL) as PreStepOp[]).map(op => <option key={op} value={op}>{PRE_OP_LABEL[op]}</option>)}
                      </select>
                      <span aria-hidden className="font-mono text-faint-foreground">→</span>
                      <input aria-label={i18nText('uiVariableName')} className="w-28 rounded-[var(--radius-sm)] border border-border bg-surface px-1.5 py-1 font-mono text-ui-sm text-foreground outline-none placeholder:text-faint-foreground focus-visible:border-accent" placeholder={i18nText('uiVariableName2')} value={s.name} onChange={e => setPreSteps(preSteps.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                      <label className="flex items-center gap-1 text-ui-sm text-faint-foreground" title={i18nText('uiMaskingValuesInHistoryAndCURL')}>
                        <input type="checkbox" checked={s.secret ?? s.op === 'hmacSha256'} onChange={e => setPreSteps(preSteps.map((x, j) => j === i ? { ...x, secret: e.target.checked } : x))} /> secret
                      </label>
                      <button type="button" aria-label={i18nText('uiDeletePreStep')} className="ah-action ml-auto rounded-[var(--radius-sm)] p-1 text-ui-sm text-muted-foreground hover:text-method-delete focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent" onClick={() => setPreSteps(preSteps.filter((_, j) => j !== i))}>{i18nText('uiDelete')}</button>
                    </div>

                    {(s.op === 'setValue' || s.op === 'randomInt' || s.op === 'base64' || s.op === 'hmacSha256') && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        {s.op === 'setValue' && (
                          <input aria-label={i18nText('uiValue')} className="min-w-0 flex-1 rounded-[var(--radius-sm)] border border-border bg-surface px-1.5 py-1 font-mono text-ui-sm text-foreground outline-none placeholder:text-faint-foreground focus-visible:border-accent" placeholder={i18nText('uiValueVarUuidAvailable')} value={s.value ?? ''} onChange={e => setPreSteps(preSteps.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} />
                        )}
                        {s.op === 'randomInt' && (<>
                          <input aria-label={i18nText('uiMinimum')} className="w-20 rounded-[var(--radius-sm)] border border-border bg-surface px-1.5 py-1 font-mono text-ui-sm text-foreground outline-none placeholder:text-faint-foreground focus-visible:border-accent" placeholder="min" value={s.min ?? ''} onChange={e => setPreSteps(preSteps.map((x, j) => j === i ? { ...x, min: e.target.value } : x))} />
                          <span aria-hidden className="text-faint-foreground">~</span>
                          <input aria-label={i18nText('uiMaximum')} className="w-20 rounded-[var(--radius-sm)] border border-border bg-surface px-1.5 py-1 font-mono text-ui-sm text-foreground outline-none placeholder:text-faint-foreground focus-visible:border-accent" placeholder="max" value={s.max ?? ''} onChange={e => setPreSteps(preSteps.map((x, j) => j === i ? { ...x, max: e.target.value } : x))} />
                        </>)}
                        {s.op === 'base64' && (
                          <input aria-label={i18nText('uiInput')} className="min-w-0 flex-1 rounded-[var(--radius-sm)] border border-border bg-surface px-1.5 py-1 font-mono text-ui-sm text-foreground outline-none placeholder:text-faint-foreground focus-visible:border-accent" placeholder={i18nText('uiInputToEncodePossiblyVar')} value={s.input ?? ''} onChange={e => setPreSteps(preSteps.map((x, j) => j === i ? { ...x, input: e.target.value } : x))} />
                        )}
                        {s.op === 'hmacSha256' && (<>
                          <input aria-label={i18nText('uiSecretKey')} className="w-44 rounded-[var(--radius-sm)] border border-border bg-surface px-1.5 py-1 font-mono text-ui-sm text-foreground outline-none placeholder:text-faint-foreground focus-visible:border-accent" placeholder={i18nText('uiSecretKeyApiSecret')} value={s.key ?? ''} onChange={e => setPreSteps(preSteps.map((x, j) => j === i ? { ...x, key: e.target.value } : x))} />
                          <input aria-label={i18nText('uiMessage')} className="min-w-0 flex-1 rounded-[var(--radius-sm)] border border-border bg-surface px-1.5 py-1 font-mono text-ui-sm text-foreground outline-none placeholder:text-faint-foreground focus-visible:border-accent" placeholder={i18nText('uiMessageTs')} value={s.input ?? ''} onChange={e => setPreSteps(preSteps.map((x, j) => j === i ? { ...x, input: e.target.value } : x))} />
                        </>)}
                      </div>
                    )}

                    <p className="text-ui-meta leading-relaxed text-faint-foreground">
                      {i18nText('uiExampleResult')} <span className="font-mono text-muted-foreground">{PRE_OP_SAMPLE[s.op]}</span>
                      {s.name.trim() !== '' && <> {i18nText('uiAfter2')} <span className="font-mono text-accent">{`{{${s.name.trim()}}}`}</span> {i18nText('uiUsedAs')}</>}
                    </p>
                  </div>
                ))}

                <button type="button" className="self-start rounded-[var(--radius-sm)] text-ui-md font-medium text-accent hover:text-accent-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" onClick={() => setPreSteps([...preSteps, { op: 'setValue', name: '', value: '' }])}>{i18nText('uiAddDirectValueCreationRule')}</button>
              </section>

              {/* ── Post-response ── 응답에서 변수 추출 */}
              <section className="flex flex-col gap-2">
                <div className="flex items-baseline gap-2">
                  <h4 className="text-ui-md font-bold text-foreground">{i18nText('ui2UseTheResponseValueInTheNextRequest')}</h4>
                  <span className="text-ui-sm text-faint-foreground">{i18nText('uiExampleSaveTheLoginTokenAndUseItFor')}</span>
                </div>

                <select aria-label={i18nText('uiSelectValuesToReuse')} value="" onChange={e => { const preset = POST_STEP_PRESETS[Number(e.target.value)]; if (preset) setPostSteps([...postSteps, preset.make()]) }} className="self-start rounded-[var(--radius-sm)] border border-border bg-surface px-3 py-2 text-ui-md">
                  <option value="" disabled>{i18nText('uiSelectValuesToReuse2')}</option>
                  {POST_STEP_PRESETS.map((p, i) => <option key={p.label} value={i}>{localizeKorean(p.label)} — {localizeKorean(p.hint)}</option>)}
                </select>

                {postSteps.map((s, i) => (
                  <div key={i} className="flex flex-col gap-1.5 ah-subpanel">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <select aria-label={i18nText('uiExtractionSource')} className="rounded-[var(--radius-sm)] border border-border bg-surface px-1.5 py-1 text-ui-md font-medium text-foreground outline-none focus-visible:border-accent" value={s.source} onChange={e => setPostSteps(postSteps.map((x, j) => j === i ? { ...x, source: e.target.value as PostStepSource } : x))}>
                        <option value="jsonPath">{i18nText('uiBodyJSON')}</option>
                        <option value="header">{i18nText('uiHeader')}</option>
                      </select>
                      <input aria-label={i18nText('uiPathHeaderName')} className="min-w-0 flex-1 rounded-[var(--radius-sm)] border border-border bg-surface px-1.5 py-1 font-mono text-ui-sm text-foreground outline-none placeholder:text-faint-foreground focus-visible:border-accent" placeholder={s.source === 'jsonPath' ? 'data.token' : 'X-Request-Id'} value={s.path} onChange={e => setPostSteps(postSteps.map((x, j) => j === i ? { ...x, path: e.target.value } : x))} />
                      <span aria-hidden className="font-mono text-faint-foreground">→</span>
                      <input aria-label={i18nText('uiVariableName')} className="w-28 rounded-[var(--radius-sm)] border border-border bg-surface px-1.5 py-1 font-mono text-ui-sm text-foreground outline-none placeholder:text-faint-foreground focus-visible:border-accent" placeholder={i18nText('uiVariableName2')} value={s.name} onChange={e => setPostSteps(postSteps.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                      <label className="flex items-center gap-1 text-ui-sm text-faint-foreground" title={i18nText('uiMaskingValuesInHistoryAndCURL')}>
                        <input type="checkbox" checked={s.secret ?? false} onChange={e => setPostSteps(postSteps.map((x, j) => j === i ? { ...x, secret: e.target.checked } : x))} /> secret
                      </label>
                      <button type="button" aria-label={i18nText('uiDeletePostStep')} className="ah-action ml-auto rounded-[var(--radius-sm)] p-1 text-ui-sm text-muted-foreground hover:text-method-delete focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent" onClick={() => setPostSteps(postSteps.filter((_, j) => j !== i))}>{i18nText('uiDelete')}</button>
                    </div>

                    {s.source === 'jsonPath' && responseLeaves.length > 0 && (
                      <div className="flex flex-col gap-1">
                        <span className="text-ui-meta text-faint-foreground">{i18nText('uiSelectPathFromPreviousResponse')}</span>
                        <div className="flex flex-wrap gap-1">
                          {responseLeaves.slice(0, 24).map(l => (
                            <button key={l.path} type="button" title={i18nText('dynamicValue', { v0: String(String(l.value).slice(0, 40)) })}
                              className="rounded-[var(--radius-sm)] border border-border px-1.5 py-0.5 font-mono text-ui-sm text-muted-foreground transition-colors hover:border-accent hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                              onClick={() => setPostSteps(postSteps.map((x, j) => j === i ? { ...x, path: l.path, name: x.name.trim() || lastSegment(l.path) } : x))}>
                              {l.path}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    <p className="text-ui-meta leading-relaxed text-faint-foreground">
                      {s.name.trim() !== ''
                        ? <>{i18nText('uiExtractedValue')} <span className="font-mono text-accent">{`{{${s.name.trim()}}}`}</span> {i18nText('uiAndUseItInTheNextRequestAs')}</>
                        : i18nText('jsxIfYouEnterAVariableNameYouCanUse')}
                    </p>
                  </div>
                ))}

                <button type="button" className="self-start rounded-[var(--radius-sm)] text-ui-md font-medium text-accent hover:text-accent-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" onClick={() => setPostSteps([...postSteps, { source: 'jsonPath', path: '', name: '' }])}>{i18nText('uiAddDirectExtractionRules')}</button>
                <p className="text-ui-sm leading-relaxed text-faint-foreground">{i18nText('uiTheExtractedValueIsTheEnvironmentSelectedAtThe')} <b className="text-muted-foreground">{i18nText('uiPersonalValues')}</b>{i18nText('uiSavedEnvironmentValuesRemainIntactOfTheNextRequest')} {i18nText('variablePlaceholder')} {i18nText('uiUseItRightAway')}</p>
              </section>

              {(preSteps.length > 0 || postSteps.length > 0) && !editMode && (
                <p className="text-ui-sm text-faint-foreground">{i18nText('uiYouCanRunItWithYourCurrentRulesSave')} <button type="button" className="ml-2 text-accent" onClick={() => setEditMode(true)}>{i18nText('uiReflectedInTemplate')}</button></p>
              )}
            </div>
          )}
          {tab === 'docs' && (
            <div className="flex h-full min-h-0 flex-col gap-2">
              {/* 설명은 편집 모드 안, 이름 칸 옆에만 있었다. 남기려면 [편집] 을 먼저 눌러야 했고
                  자리도 좁아서, 결국 아무도 안 썼다. 탭으로 꺼내 바로 쓰게 한다. */}
              <div className="flex shrink-0 items-baseline justify-between gap-2">
                <span className="ah-label">{i18nText('uiHowToUseThisRequest')}</span>
                <span className="text-ui-sm text-faint-foreground">
                  {i18nText('uiItAppearsAsIsOnTheRunScreenSave')}
                </span>
              </div>
              <textarea
                aria-label={i18nText('uiRequestDescription')}
                className="min-h-[180px] w-full flex-1 resize-none rounded-[var(--radius-sm)] border border-border bg-surface px-3 py-2 text-ui-lg leading-relaxed text-foreground outline-none placeholder:text-faint-foreground focus-visible:border-accent"
                placeholder={i18nText('requestDescriptionExample')}
                value={descDraft}
                // 여기서 치면 곧 저장할 뜻이다 — [편집] 을 따로 누르게 하지 않는다.
                onChange={e => { setDescDraft(e.target.value); if (!editMode) setEditMode(true) }}
              />
              {!editMode && descDraft.trim() === '' && (
                <p className="shrink-0 text-ui-sm leading-relaxed text-faint-foreground">
                  {i18nText('uiWriteItDownHereSoPeopleWhoSeeThis')}
                </p>
              )}
            </div>
          )}
          {tab === 'settings' && (
            <div className="flex flex-col gap-4">
              <p className="rounded-[var(--radius-sm)] border border-border bg-surface-2 p-3 text-ui-sm text-muted-foreground">{i18nText('uiAppliesToThisRequestOnlyIfYouDonT')}</p>
              <button type="button" className="self-start text-ui-sm text-accent" onClick={() => onOpenEnvManager?.()}>{i18nText('uiCommonEnvironmentVariableManagement')}</button>
              <div className="flex flex-col gap-1.5">
                <span className="text-ui-sm font-bold uppercase tracking-wide text-faint-foreground">{i18nText('uiTag')}</span>
                <input
                  aria-label={i18nText('uiTagsCommaSeparated')}
                  className="rounded-[var(--radius-sm)] border border-border bg-surface px-2 py-1.5 text-ui-md text-foreground outline-none focus-visible:border-accent"
                  placeholder={i18nText('uiSmokePaymentDeprecatedCommaSeparated')}
                  value={tagsInput}
                  onChange={e => setTagsInput(e.target.value)}
                />
                <p className="text-ui-sm leading-relaxed text-faint-foreground">{i18nText('uiTheCategoryToUseWhenSearching')}</p>
              </div>
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2 text-ui-md"><input type="checkbox" checked={aiExecutionAllowed} onChange={e => { setAiExecutionAllowed(e.target.checked); setEditMode(true) }} />{i18nText('uiAllowAIToRun')}</label>
                <p className="text-ui-sm text-muted-foreground">{i18nText('uiSavingTheTemplateAllowsAIToExecuteTheWrite')}</p>
                <div className="flex items-center justify-between"><span className="text-ui-sm font-bold text-muted-foreground">{i18nText('uiRunSettings')}</span><button type="button" className="text-ui-sm text-accent" onClick={() => setSettings({ ...settings, followRedirects: false, timeoutMs: undefined })}>{i18nText('uiRestoreDefaultLaunchSettings')}</button></div>
                <label className="flex flex-wrap items-center gap-3 border-b border-border/50 py-3 text-ui-md text-foreground">
                  <input className="order-last ml-auto" type="checkbox" checked={!!settings.followRedirects} onChange={e => setSettings({ ...settings, followRedirects: e.target.checked })} />
                  {i18nText('uiFollowRedirect')} <span className="text-ui-sm text-faint-foreground">{i18nText('uiGoToTheNewAddressIndicatedByTheServer')}</span>
                </label>
                <label className="flex items-center justify-between gap-3 py-3 text-ui-md text-foreground">
                  {i18nText('uiResponseLatencyMs')}
                  <input
                    type="number" min={0}
                    className="w-28 rounded-[var(--radius-sm)] border border-border bg-surface px-2 py-1 text-ui-md text-foreground outline-none focus-visible:border-accent"
                    placeholder={i18nText('ui30000Default')}
                    value={settings.timeoutMs ?? ''}
                    onChange={e => setSettings({ ...settings, timeoutMs: e.target.value ? Number(e.target.value) : undefined })}
                  />
                </label>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-ui-sm font-bold uppercase tracking-wide text-faint-foreground">{i18nText('uiRequestVariable')}</span>
                <p className="text-ui-sm leading-relaxed text-faint-foreground">{i18nText('uiOnlyUsedInThisRequest')} {i18nText('variablePlaceholder')}{i18nText('uiEGOrderIdPriorityGlobalEnvironment')} <b className="text-muted-foreground">{i18nText('uiRequest')}</b> {i18nText('uiIndividualMarkYourPasswordTokenAsSecretInThe')}</p>
                {reqVars.map((v, vi) => pathNames.includes(v.key) ? null : (
                  <div key={vi} className="flex items-center gap-1.5">
                    <input aria-label={i18nText('uiRequestVariableName')} className="w-44 ah-input font-mono" placeholder="orderId" value={v.key}
                      onChange={e => setReqVars(reqVars.map((x, xi) => (xi === vi ? { ...x, key: e.target.value } : x)))} />
                    <span aria-hidden className="text-faint-foreground">=</span>
                    <input aria-label={i18nText('uiRequestVariableValue')} className="w-56 ah-input font-mono" placeholder="1001" value={v.value}
                      onChange={e => setReqVars(reqVars.map((x, xi) => (xi === vi ? { ...x, value: e.target.value } : x)))} />
                    <button type="button" aria-label={i18nText('uiDeleteRequestVariable')} className="ah-action rounded-[var(--radius-sm)] px-1.5 py-1 text-ui-sm text-muted-foreground transition-colors hover:text-method-delete focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent" onClick={() => setReqVars(reqVars.filter((_, xi) => xi !== vi))}>{i18nText('uiDelete')}</button>
                  </div>
                ))}
                <button type="button" className="self-start rounded-[var(--radius-sm)] text-ui-md font-medium text-accent transition-colors hover:text-accent-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" onClick={() => setReqVars([...reqVars, { key: '', value: '' }])}>{i18nText('uiRequestVariable2')}</button>
              </div>
              {!editMode && <p className="text-ui-sm text-faint-foreground">{i18nText('uiChangesToTagsExecutionSettingsAndRequestVariablesAre')}</p>}
            </div>
          )}
        </div>
      </div>

      {/* 요청↔응답 세로 리사이즈 핸들 — 잡을 곳이 보이도록 가운데 그립 + 넓은 히트영역.
          아래 응답 패널의 색 테두리(상태 표시)와 헷갈리지 않게 분명한 드래그 어피던스를 준다.
          접기 버튼도 여기 단다: 응답 머리줄은 결과·에러·빈 상태마다 생김새가 달라
          세 군데에 각각 붙여야 하는데, 경계선은 한 곳이고 세 상태 모두에 걸린다. */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={i18nText('uiResponsiveAreaSizeAdjustment')}
        title={respCollapsed ? undefined : i18nText('jsxAdjustTheHeightOfTheResponseAreaByDragging')}
        className={`group relative z-10 -my-1.5 flex h-4 shrink-0 items-center justify-center select-none ${respCollapsed ? '' : 'cursor-row-resize'}`}
        onMouseDown={e => { if (!respCollapsed) responseArea.startDrag(e, -1) }}
      >
        <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border transition-colors group-hover:bg-accent/50" />
        {/* 접혀 있으면 그립을 안 낸다 — 끌 수 없는데 끌 수 있어 보이면 안 된다 */}
        {!respCollapsed && (
          <div className="relative h-1 w-9 rounded-full bg-border-strong transition-all group-hover:w-14 group-hover:bg-accent group-active:bg-accent" />
        )}
        <ToolButton icon={respCollapsed ? "expandBottom" : "panelBottom"}
          type="button"
          data-testid="response-toggle"
          title={respCollapsed ? i18nText('jsxExpandResponse') : i18nText('jsxCollapseResponse')}
          aria-label={respCollapsed ? i18nText('jsxExpandResponse') : i18nText('jsxCollapseResponse')}
          aria-expanded={!respCollapsed}
          className="absolute right-2 flex h-4 gap-1 px-1 text-ui-sm items-center justify-center rounded-[var(--radius-sm)] bg-surface text-faint-foreground transition-colors hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          onMouseDown={e => e.stopPropagation()}
          onClick={toggleResp}
         />
      </div>

      {/* 응답 — 실행 전에도 항상 자리를 잡아 아래쪽이 비어 보이지 않게 한다 */}
      <div
        ref={responseSearch.regionRef}
        data-testid="response-panel"
        className="flex shrink-0 flex-col overflow-hidden border-t border-border bg-surface"
        style={{
          // 실행 전에는 안내 문구 한 줄뿐인데 280px 를 비운 채 차지해, 정작 편집하는
          // 위쪽을 눌렀다. 결과가 있을 때만 제 높이를 갖는다(사용자가 조절한 값은 유지).
          height: respCollapsed ? 30 : Math.min(responseArea.size, responseMax),
          ...(result ? { borderTopWidth: 3, borderTopColor: isErrorResult ? 'var(--method-delete)' : 'var(--badge-new-fg)' } : {}),
        }}
      >
        {!respCollapsed && <div className="flex shrink-0 items-center gap-3 border-b border-border/50 px-3 py-2"><h3 className="text-ui-md font-semibold">{i18nText('uiResponse')}</h3><ToolButton icon="history" aria-label={i18nText('uiExecutionHistory')} className="text-ui-sm text-muted-foreground" onClick={onOpenHistory} /><span className="text-ui-sm text-faint-foreground">{running ? i18nText('jsxProcessingRequest') : result ? '' : i18nText('jsxHavenTRunItYet')}</span></div>}
        {/* 접혀도 '어떻게 끝났는지' 는 남긴다. 상태까지 감추면 접는 순간 방금 뭐가 됐는지
            모르게 되고, 그러면 아무도 안 접는다. */}
        {respCollapsed ? (
          <button
            type="button"
            className="flex h-full w-full items-center gap-2 px-2.5 text-left text-ui-md focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
            onClick={toggleResp}
            aria-label={i18nText('uiExpandResponse')}
          >
            {result ? (
              <>
                <StatusPill result={result} />
                {result.durationMs != null && <span className="font-mono text-muted-foreground">{result.durationMs}ms</span>}
                {responseSize && <span className="font-mono text-muted-foreground">{responseSize}</span>}
              </>
            ) : execError ? (
              <span className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-method-delete/10 px-2 py-0.5 text-ui-sm font-bold text-method-delete">
                <IconWarning /> {i18nText('uiExecutionFailed')}
              </span>
            ) : (
              <span className="text-faint-foreground">{i18nText('uiNoResponse')}</span>
            )}
            <span className="ml-auto shrink-0 text-ui-meta text-faint-foreground">{i18nText('uiExpand')}</span>
          </button>
        ) : !result ? (
          execError ? (
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2.5">
              <div className="flex shrink-0 items-center gap-2">
                <span className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-method-delete/10 px-2 py-0.5 text-ui-md font-bold text-method-delete">
                  <IconWarning /> {i18nText('uiRunPreviewFailed')}
                </span>
                <ToolButton icon="copy" aria-label={i18nText('uiCopyError')}
                  type="button"
                  className="rounded-[var(--radius-sm)] bg-transparent px-2 py-0.5 text-ui-sm text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                  onClick={async () => { const ok = await copyText(execError); toast(ok ? 'success' : 'error', ok ? i18nText('jsxErrorDetailsCopied') : i18nText('jsxCopyFailedYourBrowserMayHaveBlockedTheClipboard')) }}
                 />
                <ToolButton icon="clear" aria-label={i18nText('uiClearError')} type="button" className="rounded-[var(--radius-sm)] px-2 py-0.5 text-ui-sm text-faint-foreground hover:text-foreground" onClick={() => setExecError(null)} />
              </div>
              <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-sm)] border border-method-delete/30 bg-method-delete/5 p-2.5 font-mono text-ui-sm leading-relaxed text-foreground">{execError}</pre>
              <p className="shrink-0 text-ui-sm leading-relaxed text-faint-foreground">
                {i18nText('uiThisIsAFailureAtThePostqServerNetwork')}
              </p>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col overflow-auto px-4 py-3 text-center">
              <p className="mt-auto mb-3 shrink-0 text-ui-md text-faint-foreground">{i18nText('uiPressRunAndTheResponseWillBeDisplayedHere')}</p>
              <button className="text-ui-sm text-muted-foreground hover:text-foreground" onClick={() => void run()}>{i18nText('uiSendRequest')} <kbd className="ml-4 text-faint-foreground">⌘↩</kbd></button>
              <button className="text-ui-sm text-muted-foreground hover:text-foreground" onClick={openPreview}>{i18nText('uiPreviewRequestToSend2')}</button>
              <button className="mb-auto shrink-0 text-ui-sm text-muted-foreground hover:text-foreground" onClick={() => setTab('tests')}>{i18nText('uiWriteTests')}</button>
            </div>
          )
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2.5">
            {result.missingVariables.length > 0 && (
              <div className="flex items-center gap-1.5 rounded-[var(--radius-sm)] bg-badge-changed-bg px-2 py-1 text-ui-md font-medium text-badge-changed-fg">
                <IconWarning /> {i18nText('uiUninterpretedVariables')} {result.missingVariables.map(v => `{{${v}}}`).join(', ')}
              </div>
            )}
            <div className="flex shrink-0 items-center gap-2">
              <StatusPill result={result} />
              {result.durationMs != null && (
                <span className="font-mono text-ui-md text-muted-foreground">{result.durationMs}ms</span>
              )}
              {responseSize && (
                <span className="font-mono text-ui-md text-muted-foreground">{responseSize}</span>
              )}
              {result.truncated && (
                <span
                  className="rounded-[var(--radius-sm)] bg-badge-changed-bg px-1.5 py-0.5 text-ui-sm font-semibold text-badge-changed-fg"
                  title={i18nText('uiResponseIsTruncatedAt1MBUpperLimitVariableExtraction')}
                >
                  {i18nText('uiTruncatedOver1MB')}
                </span>
              )}
              {result.assertionResults && result.assertionResults.length > 0 && (() => {
                const passed = result.assertionResults.filter(r => r.pass).length
                const total = result.assertionResults.length
                const allPass = passed === total
                return (
                  <span className={`inline-flex items-center gap-1 rounded-[var(--radius-sm)] px-1.5 py-0.5 text-ui-sm font-bold ${allPass ? 'bg-badge-new-bg text-badge-new-fg' : 'bg-method-delete/10 text-method-delete'}`} title={i18nText('uiResponseVerificationTests')}>
                    {i18nText('responseTests')} {passed}/{total} {allPass ? i18nText('responseTestsPassed') : i18nText('responseTestsFailed')}
                  </span>
                )
              })()}
              {result.error && !explainTransportError(result.error) && (
                <span className="text-ui-md text-method-delete">{result.error}</span>
              )}
              {/* 응답 도구는 전부 꺼내 둔다. 예전엔 [•••] 안에 예시 고정·구조 검사·코드·응답 헤더가
                  숨어 있어 헤더 한 번 보려고 매번 메뉴를 열어야 했다. */}
              <span className="ml-auto flex flex-wrap items-center justify-end gap-1">
                <span className="relative" ref={codeMenuRef}>
                  <ToolButton icon="code" aria-label={i18nText('uiCopyCodeSnippetFetchAxiosPython')} type="button" title={i18nText('uiCopyCodeSnippetFetchAxiosPython')} aria-expanded={codeMenuOpen} className={RESP_TOOL} onClick={() => setCodeMenuOpen(o => !o)} />
                  {codeMenuOpen && (
                    <span className="absolute right-0 top-full z-30 mt-1 flex flex-col overflow-hidden rounded-[var(--radius-sm)] border border-border bg-surface shadow-[var(--shadow-card)]">
                      {(['fetch', 'axios', 'python'] as const).map(l => (
                        <button key={l} type="button" className="px-3 py-1.5 text-left text-ui-md text-foreground hover:bg-surface-2" onClick={() => { copyCode(l); setCodeMenuOpen(false) }}>{l}</button>
                      ))}
                    </span>
                  )}
                </span>
                {result.responseBody != null && (
                  <ToolButton icon="validate" aria-label={validating ? i18nText('jsxChecking') : i18nText('jsxResponseStructureInspection')}
                    type="button"
                    // 못 누를 때 이유를 버튼에 단다 — 예전엔 메뉴 안 작은 글씨로만 있었다.
                    title={!schemaAvailability ? i18nText('jsxCheckingResponseDefinition') : schemaAvailability.available ? i18nText('jsxCompareTheResponseWithTheOpenAPISpecificationRequiredFields') : schemaAvailability.reason}
                    className={`${RESP_TOOL} disabled:cursor-not-allowed disabled:opacity-40`}
                    onClick={validateSpec}
                    disabled={validating || !schemaAvailability?.available}
                   />
                )}
                <ToolButton icon="pin" aria-label={pinnedNow ? i18nText('jsxUnpinExample') : i18nText('jsxFixedAsAnExample')}
                  type="button"
                  disabled={pinning}
                  title={pinnedNow ? i18nText('jsxUnpinExample') : i18nText('jsxPinThisResponseAsAnExampleItWillRemain')}
                  aria-pressed={pinnedNow}
                  className={`${RESP_TOOL} disabled:opacity-50 ${pinnedNow ? 'text-accent' : ''}`}
                  onClick={async () => {
                    const next = !pinnedNow
                    setPinning(true); setPinnedNow(next)
                    try {
                      const res = await fetch(`/api/executions/${result.id}/pin`, { method: 'POST', body: JSON.stringify({ pinned: next }) })
                      if (!res.ok) { setPinnedNow(!next); toast('error', i18nText('dynamicExampleFixationFailure', { v0: String(res.status) })); return }
                      toast('success', next ? i18nText('jsxPinnedAsAnExampleAppearsInDocumentView') : i18nText('jsxUnpinned'))
                      onExecuted(result)
                    } catch (e) {
                      // 서버 오류는 알리면서 연결 실패는 조용했다 — 누르고도 아무 일이 없는 것처럼 보인다.
                      toast('error', i18nText('dynamicRequestFailed', { v0: String(errorText(e)) }))
                    } finally { setPinning(false) }
                  }}
                 />
              </span>
            </div>
            {/* 응답 검증(Tests) 결과 — 실패한 규칙 나열 */}
            {result.assertionResults && result.assertionResults.some(r => !r.pass) && (
              <div className="flex flex-col gap-1 rounded-[var(--radius-sm)] border border-method-delete/30 bg-method-delete/5 px-3 py-2">
                <p className="text-ui-md font-semibold text-method-delete">{i18nText('uiResponseValidationFailed')}</p>
                <ul className="list-disc pl-4 text-ui-md leading-relaxed text-muted-foreground">
                  {result.assertionResults.filter(r => !r.pass).map((r, i) => (
                    <li key={i}>{describeAssertion(r.assertion)} <span className="text-method-delete">{i18nText('uiActual')} {r.actual}</span></li>
                  ))}
                </ul>
              </div>
            )}
            {/* 스펙 검증 결과 */}
            {validation && !validation.skipped && (
              validation.ok ? (
                <div className="rounded-[var(--radius-sm)] border border-badge-new-fg/40 bg-badge-new-bg/40 px-3 py-1.5 text-ui-md font-medium text-badge-new-fg">
                  {i18nText('uiPassBasicStructuralInspection')}
                </div>
              ) : (
                <div className="flex flex-col gap-1 rounded-[var(--radius-sm)] border border-method-delete/30 bg-method-delete/5 px-3 py-2">
                  <p className="text-ui-md font-semibold text-method-delete">{i18nText('uiSpecificationMismatch')} {validation.issues.length}{i18nText('uiGunBackendResponseIsDifferentFromOpenAPISpec')}</p>
                  <ul className="list-disc pl-4 text-ui-md leading-relaxed text-muted-foreground">
                    {validation.issues.slice(0, 15).map((iss, i) => (
                      <li key={i}><span className="font-mono text-foreground">{iss.path || '(root)'}</span> — {iss.message}</li>
                    ))}
                  </ul>
                </div>
              )
            )}
            {/* 실패 원인 친절 설명 — "fetch failed" 대신 원인과 확인 목록 */}
            {result.error && (() => {
              const ex = explainTransportError(result.error!)
              if (!ex) return null
              return (
                <div className="flex flex-col gap-1 rounded-[var(--radius-sm)] border border-method-delete/30 bg-method-delete/5 px-3 py-2">
                  <p className="text-ui-lg font-semibold text-method-delete">{ex.title}</p>
                  <ul className="list-disc pl-4 text-ui-md leading-relaxed text-muted-foreground">
                    {ex.hints.map((h, i) => <li key={i}>{h}</li>)}
                  </ul>
                  <p className="font-mono text-ui-meta text-faint-foreground">{result.error}</p>
                </div>
              )
            })()}
            {/* 상태 코드 도움말 — 4xx/5xx 면 바로 보인다(예전엔 [•••] 안에 접혀 있었다). */}
            {result.responseStatus != null && result.responseStatus >= 400 && (
              <p className="shrink-0 text-ui-sm leading-relaxed text-muted-foreground">{explainStatus(result.responseStatus).hint}</p>
            )}
            {(result.responseBody != null || headerEntries.length > 0) && (
              <>
                <div className="flex shrink-0 items-center gap-2">
                  {/* 바디 / 헤더 — 헤더를 [•••] 메뉴 밖, 바디와 같은 높이의 탭으로 둔다 */}
                  <div role="tablist" aria-label={i18nText('uiViewResponse')} className="flex shrink-0 items-center gap-0.5 rounded-[var(--radius-sm)] border border-border p-0.5">
                    {([['body', i18nText('jsxBody')], ['headers', i18nText('responseHeadersCount', { count: headerEntries.length })]] as const).map(([k, label]) => (
                      <button
                        key={k}
                        type="button"
                        role="tab"
                        aria-selected={(k === 'headers') === showHeaders}
                        className={`rounded-[var(--radius-sm)] px-1.5 py-0.5 text-ui-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
                          (k === 'headers') === showHeaders ? 'bg-accent/15 text-accent' : 'text-muted-foreground hover:text-foreground'
                        }`}
                        onClick={() => setShowHeaders(k === 'headers')}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {/* 검색칸은 자리를 지킨다 — Preview 에서 빠지면 오른쪽 버튼이 왼쪽으로 튀었다. */}
                  {!showHeaders && effView !== 'preview' && result.responseBody != null
                    ? <TextSearchControls search={responseSearch} label={i18nText('uiSearchWithinResponse')} />
                    : <div className="min-w-0 flex-1" />}
                  {showHeaders ? (
                    <CopyButton compact value={headerText} label={i18nText('uiCopyHeader')} title={i18nText('uiCopyResponseHeaders')} className="px-2 py-1 text-ui-sm" />
                  ) : result.responseBody != null && (<>
                  {/* Pretty / Raw / (HTML 이면) Preview 세그먼트 */}
                  <div className="flex shrink-0 items-center gap-0.5 rounded-[var(--radius-sm)] border border-border p-0.5">
                    {(['pretty', 'raw', ...(isHtml ? ['preview'] as const : [])] as const).map(v => (
                      <button
                        key={v}
                        type="button"
                        aria-pressed={effView === v}
                        className={`rounded-[var(--radius-sm)] px-1.5 py-0.5 text-ui-sm font-semibold capitalize transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
                          effView === v ? 'bg-accent/15 text-accent' : 'text-muted-foreground hover:text-foreground'
                        }`}
                        onClick={() => setRespView(v)}
                      >
                        {v === 'pretty' ? 'Pretty' : v === 'raw' ? 'Raw' : 'Preview'}
                      </button>
                    ))}
                  </div>
                  {/* 바디를 다루는 두 동작(복사·저장)은 바디 바로 위에 나란히 둔다 */}
                  <ToolButton icon="copy"
                    type="button"
                    title={i18nText('uiCopyResponseBody')}
                    aria-label={i18nText('uiCopyResponseBody')}
                    className="inline-flex items-center shrink-0 rounded-[var(--radius-sm)] bg-transparent px-1.5 py-1 text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                    onClick={copyResponse}
                   />
                  <ToolButton icon="download"
                    type="button"
                    title={i18nText('uiSaveResponseBodyAsFile')}
                    aria-label={i18nText('uiDownloadResponseBody')}
                    className="inline-flex items-center shrink-0 rounded-[var(--radius-sm)] bg-transparent px-1.5 py-1 text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                    onClick={downloadBody}
                   />
                  </>)}
                </div>
                {showHeaders ? (
                  <pre className="min-h-0 flex-1 overflow-auto whitespace-pre rounded-[var(--radius-sm)] border border-border bg-surface-2 p-2.5 font-mono text-ui-md leading-relaxed text-foreground">
                    {headerText || i18nText('jsxThereAreNoResponseHeaders')}
                  </pre>
                ) : result.responseBody == null ? null : effView === 'preview' ? (
                  // 스크립트 비활성 샌드박스 — HTML 응답을 안전하게 렌더(외부 요청/스크립트 차단)
                  <iframe
                    title={i18nText('uiResponsiveHTMLPreview')}
                    sandbox=""
                    srcDoc={rawBody}
                    className="flex-1 rounded-[var(--radius-sm)] border border-border bg-white"
                  />
                ) : (
                  <div ref={responseSearch.contentRef} className="flex min-h-0 flex-1 flex-col">
                    {/* 안 보이는 탭은 응답을 그리지 않는다 — 탭마다 하이라이트 DOM 을 통째로 들고 있었다.
                        응답 값(result)은 남아 있어서 탭으로 돌아오면 그대로 다시 그린다. */}
                    {isActive && <JsonView text={responseText} matches={responseSearch.matches} current={responseSearch.current} plain={effView === 'raw'}
                      className={`flex-1 overflow-auto ${effView === 'raw' ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'} rounded-[var(--radius-sm)] border border-border bg-surface-2 p-2.5 font-mono text-ui-md leading-relaxed text-foreground`} />}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {preview && (
        <div className="animate-overlay-in fixed inset-0 z-[85] flex items-start justify-center bg-black/40 pt-[10vh]" onClick={() => setPreview(null)}>
          <div
            ref={previewTrapRef}
            role="dialog" aria-modal="true" aria-label={i18nText('uiRequestPreview')}
            className="animate-dialog-in flex max-h-[70vh] w-[640px] max-w-full flex-col overflow-hidden rounded-[var(--radius-lg)] border border-border bg-surface shadow-[var(--shadow-card)]"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border/70 px-4 py-2.5">
              <h3 className="text-ui-lg font-bold text-foreground">{i18nText('uiRequestToActuallyLeaveCredentialMasking')}</h3>
              <ToolButton icon="close" type="button" aria-label={i18nText('uiClose')} className="ah-action flex h-6 w-auto px-1.5 items-center justify-center rounded-[var(--radius-sm)] text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent" onClick={() => setPreview(null)} />
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-4 font-mono text-ui-md">
              <p className="break-all text-foreground"><span className="font-bold text-accent">{preview.preview.method}</span> {preview.preview.url}</p>
              <div className="mt-2 flex flex-col gap-0.5">
                {preview.preview.headers.filter(h => h.enabled && h.key).map((h, i) => (
                  <p key={i} className="break-all text-muted-foreground"><span className="text-foreground">{h.key}</span>: {h.value}</p>
                ))}
              </div>
              {preview.preview.body && (
                <pre className="mt-2 whitespace-pre-wrap break-all rounded-[var(--radius-sm)] border border-border bg-surface-2 p-2 text-muted-foreground">{preview.preview.body}</pre>
              )}
              {preview.authError && <p className="mt-2 text-method-delete">{i18nText('uiAuthenticationError')} {preview.authError}</p>}
              {preview.missing.length > 0 && <p className="mt-2 text-badge-changed-fg">{i18nText('uiUninterpretedVariables')} {preview.missing.join(', ')}</p>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
