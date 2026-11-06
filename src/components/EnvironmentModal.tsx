'use client'
import { t as i18nText } from '@/i18n'
import { ToolButton } from './ToolButton'
import { useEffect, useRef, useState } from 'react'
import type { ExecutionPolicy } from '@/lib/executionPolicy'
import type { EnvironmentRow } from '@/lib/ui-types'
import { getPersonalVars, setPersonalVar } from '@/lib/personalVars'
import { ModalFrame } from './ModalFrame'
import { VariableValueInput } from './VariableValueInput'
import { useToast } from './Toast'
import { errorText, fetchArray } from '@/lib/fetchJson'
import { sharedScopeWorkspace, type SharedScope } from '@/lib/sharedVars'

// id 를 함께 들고 다닌다 — 서버가 '이름이 바뀐 같은 행'을 알아보고 secret 값을 잇게 하기 위함.
type VarDraft = {
  hasValue?: boolean; editing?: boolean; id?: string; key: string; value: string; secret: boolean
  /** 서버가 알려주는 '이 secret 을 지금 쓸 수 있나'. 저장할 때는 안 보낸다(서버가 정한다). */
  keyState?: 'plain' | 'current' | 'old' | 'broken'
}

const GLOBAL = '__GLOBAL__'            // 프로젝트 공통 (이 프로젝트의 모든 환경)
const GLOBAL_ALL = '__GLOBAL_ALL__'    // 전역 (모든 프로젝트)

function IconClose() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden>
      <path d="M1 1l9 9M10 1l-9 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

export function EnvironmentModal({ workspaceId, environments, activeEnvironmentId, onClose, onSaved, onActivate, onDirtyChange, embedded = false, active = true }: {
  workspaceId: string; environments: EnvironmentRow[]; activeEnvironmentId?: string | null; onClose: () => void; onSaved: () => void
  /** 저장 안 한 편집이 있는지 — 설정 창이 닫기·항목 전환 전에 묻는다 */
  onDirtyChange?: (count: number) => void
  /** 설정 다이얼로그 안에 놓일 때 — 배경·닫기 없이 내용만 낸다 */
  onActivate?: (id: string) => void
  embedded?: boolean
  active?: boolean
}) {
  const toast = useToast()
  // 현재 선택된 환경(운영 등)으로 열리게 한다 — 없으면 첫 환경으로 폴백.
  const initialEnvId = (activeEnvironmentId && environments.some(e => e.id === activeEnvironmentId))
    ? activeEnvironmentId
    : (environments[0]?.id ?? null)
  const [envId, setEnvId] = useState<string | null>(initialEnvId)
  const initialEnv = environments.find(e => e.id === initialEnvId)
  const [executionPolicy, setExecutionPolicy] = useState<ExecutionPolicy>(initialEnv?.executionPolicy ?? 'open')
  const [name, setName] = useState(initialEnv?.name ?? '')
  const [vars, setVars] = useState<VarDraft[]>(initialEnv?.variables ?? [])
  const [varsError, setVarsError] = useState<string | null>(null)
  const [varsLoading, setVarsLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [addingEnv, setAddingEnv] = useState(false)
  const [newEnvName, setNewEnvName] = useState('')
  const [rekeying, setRekeying] = useState(false)

  // 저장 안 한 편집 — 마지막으로 불러오거나 저장한 모습과 다르면. 환경을 바꾸거나 설정을 닫으면
  // 말없이 사라졌다(토큰을 고치다 옆 환경을 눌러 보는 일이 흔하다).
  const snapshot = () => JSON.stringify({ name, executionPolicy, vars: vars.map(v => [v.key, v.value, v.secret]) })
  const [baseline, setBaseline] = useState<string | null>(null)
  // 불러오기·저장이 끝난 '다음 렌더' 의 모습을 기준으로 잡는다(setState 가 한 번에 반영되므로).
  const [rebaseTick, setRebaseTick] = useState(1)
  const rebase = () => setRebaseTick(t => t + 1)
  useEffect(() => { setBaseline(snapshot()) }, [rebaseTick])  // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = !!envId && !varsLoading && !varsError && baseline !== null && snapshot() !== baseline
  useEffect(() => { onDirtyChange?.(dirty ? 1 : 0) }, [dirty, onDirtyChange])
  const confirmLeave = () => !dirty || window.confirm(i18nText('dynamicThereAreUnsavedChangesToIfYouGoSomewhere', { v0: String(name) }))

  const brokenCount = vars.filter(v => v.keyState === 'broken').length
  const oldKeyCount = vars.filter(v => v.keyState === 'old').length

  /**
   * 옛 키에 묶인 값을 현재 키로 옮긴다 — 평문은 그대로, 포장만 바꾼다.
   * 브라우저는 값을 만지지 않는다(만질 수도 없다). 서버가 하고 개수만 돌려준다.
   */
  const rekey = async () => {
    setRekeying(true)
    try {
      const res = await fetch('/api/secrets/rekey', { method: 'POST' })
      if (!res.ok) { toast('error', i18nText('dynamicFailedToMove', { v0: String(await errorText(res)) })); return }
      const r = await res.json() as { moved: number; broken: number }
      // 못 읽는 값이 남았으면 성공으로 말하지 않는다 — 옮긴 개수만 보고 끝난 줄 알면
      // 죽은 자격증명을 그대로 들고 간다.
      toast(
        r.broken > 0 ? 'error' : 'success',
        r.broken > 0
          ? i18nText('dynamicWereMovedCannotBeReadWithAnyKeyAnd', { v0: String(r.moved), v1: String(r.broken) })
          : i18nText('dynamicMovedToTheCurrentKeyYouCanNowDelete', { v0: String(r.moved) }),
      )
      onSaved()  // 목록을 다시 읽어 표시를 갱신한다
    } catch (e) {
      toast('error', i18nText('dynamicFailedToMove', { v0: String(e instanceof Error ? e.message : '알 수 없는 오류') }))
    } finally {
      setRekeying(false)
    }
  }

  // Escape 로 닫기는 이 화면을 품은 설정 다이얼로그의 포커스 트랩(SettingsDialog 의 useFocusTrap)이 한다.
  // 이 컴포넌트는 항상 embedded 로 쓰여 ModalFrame 쪽 트랩은 꺼져 있다.
  // 여기 있던 window 리스너는 맨 앞에서 embedded 면 반환해 한 번도 닿지 않는 죽은 코드라 걷어냈다.

  // ⌘/Ctrl+Enter 로 저장 — 확정 경로가 [저장] 클릭뿐이었다.
  // capture 로 먼저 먹는다: 뒤에 살아 있는 요청 패널의 ⌘Enter(요청 실행)가 대신 발동하던 것을 막는다.
  const saveRef = useRef<() => void>(() => {})
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (!active || ev.key !== 'Enter' || !(ev.metaKey || ev.ctrlKey)) return
      ev.preventDefault(); ev.stopPropagation()
      saveRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active])

  // 개인 오버라이드(브라우저 로컬) — 선택 환경 기준
  const [personal, setPersonalState] = useState<Record<string, string>>({})
  useEffect(() => { setPersonalState(getPersonalVars(envId)) }, [envId])
  const setPersonal = (key: string, value: string) => {
    if (!envId) return
    setPersonalVar(envId, key, value)
    setPersonalState(getPersonalVars(envId))
  }

  // 이 환경을 열었을 때의 저장 시각. 서버가 이것과 다르면 그 사이 다른 사람이 저장한 것이다.
  const [knownUpdatedAt, setKnownUpdatedAt] = useState<number | undefined>(initialEnv?.updatedAt)
  // 어느 고르기가 최신인지. 전역 변수를 부르는 사이 다른 환경을 고르면, 늦게 도착한 전역 목록이
  // 그 환경 화면을 덮었다 — 제목은 'stage' 인데 목록은 전역이고, 저장하면 stage 변수(토큰 포함)가
  // 전역 목록으로 갈아 끼워져 사라졌다(서버는 지우고 다시 넣는다).
  const pickSeq = useRef(0)
  const pick = (e: EnvironmentRow) => {
    pickSeq.current++
    // varsError 는 전역 로드 실패의 흔적이다 — 안 지우면 변수가 0개인 멀쩡한 환경을
    // '불러오지 못했습니다' 로 그린다(비어 있는 것과 실패가 뒤섞인다).
    setEnvId(e.id); setName(e.name); setExecutionPolicy(e.executionPolicy ?? 'open'); setVars(e.variables); setKnownUpdatedAt(e.updatedAt)
    setVarsError(null); setVarsLoading(false); rebase()
  }
  // 환경이 아닌 두 단계 — 전역(모든 프로젝트)과 프로젝트 공통. 모든 환경이 상속하는 특별 스코프.
  const sharedScope: SharedScope | null = envId === GLOBAL_ALL ? 'all' : envId === GLOBAL ? 'project' : null
  const isGlobal = sharedScope !== null
  const sharedTitle = (scope: SharedScope) => (scope === 'all' ? i18nText('dynamicGlobalVariables') : i18nText('dynamicProjectCommonVariables'))
  const pickGlobal = async (scope: SharedScope) => {
    // 목록을 먼저 비운다 — 안 비우면 직전 환경의 변수가 '전역 변수' 제목 아래 그대로 남고,
    // 그 상태에서 [저장]을 누르면 그 목록이 전역에 써진다.
    const seq = ++pickSeq.current
    setEnvId(scope === 'all' ? GLOBAL_ALL : GLOBAL); setName(sharedTitle(scope)); setVars([]); setVarsError(null); setVarsLoading(true)
    try {
      const vars = await fetchArray<VarDraft>(`/api/global-vars?workspaceId=${encodeURIComponent(sharedScopeWorkspace(scope, workspaceId))}`)
      if (seq !== pickSeq.current) return   // 그 사이 다른 환경을 골랐다 — 그 화면을 덮지 않는다
      setVars(vars)
      setVarsError(null)
      rebase()
    } catch (e) {
      if (seq !== pickSeq.current) return
      // '변수가 없습니다' 로 보이면 전역 변수를 다시 만들어 중복이 생긴다.
      setVarsError(errorText(e))
      setVars([])
    } finally {
      if (seq === pickSeq.current) setVarsLoading(false)
    }
  }

  const addEnv = async () => {
    const n = newEnvName.trim(); if (!n) return
    if (!confirmLeave()) return
    const res = await fetch('/api/environments', { method: 'POST', body: JSON.stringify({ name: n, workspaceId }) })
    if (!res.ok) { toast('error', i18nText('dynamicEnvironmentCreationFailed', { v0: String(res.status) })); return }
    const created = await res.json()
    pickSeq.current++   // 부르던 전역 목록이 새 환경 화면을 덮지 않게
    onSaved(); setEnvId(created.id); setName(n); setVars([])
    setVarsError(null); setVarsLoading(false); rebase()  // 갓 만든 빈 환경에 직전 실패 문구가 남지 않게
    setAddingEnv(false); setNewEnvName('')
  }

  const save = async () => {
    // 아직 불러오는 중이면 저장하지 않는다 — 화면에 없는 목록으로 덮어쓰게 된다.
    // 불러오기에 실패했을 때도 마찬가지다. 화면의 빈 목록은 '없음' 이 아니라 '못 읽음' 인데,
    // 서버는 지우고 다시 넣으므로 그대로 저장하면 공통 변수(토큰 포함)가 통째로 지워진다(codex 리뷰).
    if (!envId || saving || varsLoading || varsError) return
    // 응답이 오기 전에 다른 환경을 고르면, 늦게 온 A 의 저장 결과가 B 화면을 덮었다(codex 리뷰).
    const seq = pickSeq.current
    setSaving(true)
    try {
      const res = sharedScope
        ? await fetch('/api/global-vars', { method: 'PUT', body: JSON.stringify({ workspaceId: sharedScopeWorkspace(sharedScope, workspaceId), variables: vars }) })
        : await fetch(`/api/environments/${envId}`, { method: 'PUT', body: JSON.stringify({ name, executionPolicy, ifUpdatedAt: knownUpdatedAt, variables: vars.map(v => ({ id: v.id, key: v.key, value: v.value, secret: v.secret })) }) })
      if (res.status === 409) {
        // 앞사람이 넣은 변수를 조용히 지우지 않는다. 토큰이 들어 있는 자리라 무엇을 잃을지
        // 모르는 채로 덮어쓰는 것이 제일 나쁘다.
        const d = await res.json().catch(() => null) as { error?: string } | null
        toast('error', i18nText('dynamicCloseTheWindowAndReopenItToCheck', { v0: String(d?.error ?? '다른 사람이 먼저 저장했습니다') }))
        return
      }
      if (!res.ok) { toast('error', i18nText('dynamicSaveFailed', { v0: String(res.status) })); return }
      toast('success', sharedScope === 'all' ? i18nText('dynamicStoredGlobalVariablesInheritedByAllEnvironmentsInAll') : sharedScope ? i18nText('dynamicProjectCommonVariablesStoredInheritedByAllEnvironmentsIn') : i18nText('dynamicEnvironmentSaved', { v0: String(name) }))
      const saved = await res.json() as { updatedAt?: number; variables?: VarDraft[] }
      onSaved()
      if (seq !== pickSeq.current) return
      if (!isGlobal) {
        setKnownUpdatedAt(saved.updatedAt)
        if (saved.variables) setVars(saved.variables)
      } else {
        setVars(current => current.map(v => v.secret ? { ...v, hasValue: !!v.value || v.hasValue, value: '', editing: false } : v))
      }
      rebase()
    } catch (e) {
      // 서버 오류는 알리면서 연결 실패는 조용했다 — 누르고도 아무 일이 없는 것처럼 보인다.
      toast('error', i18nText('dynamicRequestFailed', { v0: String(errorText(e)) }))
    } finally {
      setSaving(false)
    }
  }

  saveRef.current = save  // ⌘/Ctrl+Enter 가 항상 최신 save 를 부르게 한다

  const setVar = (i: number, patch: Partial<VarDraft>) =>
    setVars(vars.map((v, idx) => (idx === i ? { ...v, ...patch } : v)))

  // 환경 삭제 — 2단계 확인(3초 무장)
  const [deleteArmed, setDeleteArmed] = useState(false)
  const removeEnv = async () => {
    if (!envId) return
    const res = await fetch(`/api/environments/${envId}`, { method: 'DELETE' })
    if (!res.ok) { toast('error', i18nText('dynamicEnvironmentDeletionFailed', { v0: String(res.status) })); return }
    toast('info', i18nText('dynamicEnvironmentDeleted', { v0: String(name) }))
    onSaved()
    const rest = environments.filter(e => e.id !== envId)
    if (rest.length > 0) pick(rest[0])
    else { setEnvId(null); setName(''); setVars([]) }
    setDeleteArmed(false)
  }

  return (
    <ModalFrame embedded={embedded} label={i18nText('uiEnvironmentalManagement')} onClose={onClose}>
        <div className="flex shrink-0 items-center gap-2 border-b border-border/70 px-4 py-3">
          {!embedded && <h2 className="text-ui-lg font-bold text-foreground">{i18nText('uiEnvironmentalManagement')}</h2>}
          <select
            aria-label={i18nText('uiSelectEnvironment')}
            className="ml-1 rounded-[var(--radius-sm)] border border-border bg-surface px-2 py-1 text-ui-lg text-foreground outline-none transition-colors focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25"
            value={envId ?? ''}
            onChange={e => { if (!confirmLeave()) return; if (e.target.value === GLOBAL_ALL) { pickGlobal('all'); return } if (e.target.value === GLOBAL) { pickGlobal('project'); return } const env = environments.find(x => x.id === e.target.value); if (env) pick(env) }}
          >
            {environments.length === 0 && <option value="">{i18nText('uiNoEnvironment2')}</option>}
            {environments.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
            <option value={GLOBAL}>{i18nText('uiProjectCommonAllEnvironmentsInThisProject')}</option>
            <option value={GLOBAL_ALL}>{i18nText('uiGlobalAllProjects')}</option>
          </select>
          {addingEnv ? (
            <form
              className="flex items-center gap-1"
              onSubmit={e => { e.preventDefault(); addEnv() }}
            >
              <input
                autoFocus
                aria-label={i18nText('uiNewEnvironmentName')}
                className="w-32 rounded-[var(--radius-sm)] border border-accent bg-surface px-2 py-1 text-ui-md text-foreground outline-none placeholder:text-faint-foreground"
                placeholder={i18nText('uiEnvironmentName')}
                value={newEnvName}
                onChange={e => setNewEnvName(e.target.value)}
                /* capture 로 받는다 — bubble(onKeyDown)은 앱 루트에 위임돼 바깥 다이얼로그의
                   포커스 트랩보다 늦게 돌아, Esc 가 '이름 입력 취소' 대신 설정 창 전체를 닫았다.
                   preventDefault 가 트랩에게 '이미 처리됐다'고 알리는 표시다. */
                onKeyDownCapture={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setAddingEnv(false); setNewEnvName('') } }}
              />
              <button
                type="submit"
                className="ah-action rounded-[var(--radius-sm)] bg-accent-solid px-2 py-1 text-ui-md font-semibold text-accent-solid-foreground hover:bg-accent-solid-hover disabled:opacity-50"
                disabled={!newEnvName.trim()}
              >
                {i18nText('uiAdd')}
              </button>
            </form>
          ) : (
            <button
              type="button"
              className="flex items-center gap-1 rounded-[var(--radius-sm)] bg-transparent px-2 py-1 text-ui-md font-medium text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              onClick={() => setAddingEnv(true)}
            >
              {i18nText('uiEnvironment2')}
            </button>
          )}
          {/* 고르는 것과 실행에 쓰는 것은 다르다 — 예전엔 그 설명을 문장 한 줄로 따로 띄웠다.
              지금 고른 환경이 실행 중인지만 그 자리에서 보여주고, 아니면 바로 바꾸게 한다. */}
          {envId && !isGlobal && (envId === activeEnvironmentId ? (
            <span className="ml-auto rounded-full bg-accent/10 px-2 py-0.5 text-ui-sm font-medium text-accent">{i18nText('uiWritingToRun')}</span>
          ) : onActivate && (
            <button type="button" className="ml-auto rounded-[var(--radius-sm)] px-2 py-1 text-ui-sm font-medium text-accent transition-colors hover:bg-accent/10" title={i18nText('dynamicExecutionEnvironment', { v0: String(environments.find(e => e.id === activeEnvironmentId)?.name || i18nText('jsxNotSelected')) })} onClick={() => onActivate(envId)}>{i18nText('uiRunWithThisEnvironment')}</button>
          ))}
          {/* 설정 안에서는 닫기를 내지 않는다 — 다이얼로그의 닫기와 나란히 있으면
              어느 것이 무엇을 닫는지 알 수 없다 */}
          {!embedded && (
            <ToolButton icon="close"
              type="button"
              aria-label={i18nText('uiClose')}
              className="ah-action ml-auto flex h-6 w-auto px-1.5 items-center justify-center rounded-[var(--radius-sm)] text-faint-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              onClick={onClose}
             />
          )}
        </div>

        <p className="border-b border-border bg-surface-2/40 px-4 py-1.5 text-ui-sm leading-relaxed text-faint-foreground">
          <span className="flex flex-wrap items-center gap-1">
            <span className="font-semibold" title={i18nText('uiIfThereAreMultipleVariablesWithTheSameName')}>{i18nText('uiApplicationOrder')}</span>
            {[
              { k: i18nText('jsxGlobal'), d: i18nText('jsxCommonToAllProjects') },
              { k: i18nText('jsxProject'), d: i18nText('jsxCommonToAllEnvironmentsInThisProject') },
              { k: i18nText('jsxEnvironment'), d: i18nText('jsxThisEnvironmentRightNow') },
              { k: i18nText('jsxByRequest'), d: i18nText('jsxSettingsTabForEachRequest') },
              { k: i18nText('jsxPersonal'), d: i18nText('jsxOnlyInMyBrowser') },
            ].map((x, idx, arr) => (
              <span key={x.k} className="flex items-center gap-1">
                <span title={x.d}
                  className={`rounded-[var(--radius-sm)] border px-1.5 py-0.5 text-ui-meta ${x.k === i18nText('jsxPersonal') ? 'border-accent/50 bg-accent/10 text-accent' : 'border-border text-muted-foreground'}`}>
                  {x.k}
                </span>
                {idx < arr.length - 1 && <span aria-hidden className="text-faint-foreground">›</span>}
              </span>
            ))}
            <span className="text-faint-foreground">{i18nText('uiIfTheNameIsTheSameUseTheValue')}</span>
          </span>
        </p>
        {envId ? (
          // 저장하는 동안에는 잠근다. 응답이 오기 전에 더 친 것은 서버에 안 갔는데, 응답이 오면 그 화면을
          // '저장된 모습' 으로 삼아 경고 없이 닫혔다(codex 리뷰).
          <fieldset disabled={saving} className="m-0 flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto border-0 p-4">
            {isGlobal ? (
              <p className="rounded-[var(--radius-sm)] border border-accent/40 bg-accent/5 px-3 py-2 text-ui-md text-muted-foreground">
                {sharedScope === 'all'
                  ? <>{i18nText('uiGlobalVariablesAre')} <b>{i18nText('uiAllProjects')}</b>{i18nText('uiAllEnvironmentsInheritItEnterProjectSpecificValuesSuch')} <b>{i18nText('uiThatOneComesFirst')}</b>{i18nText('uiIDo')}</>
                  : <>{i18nText('uiProjectCommonVariablesAreInheritedByAllEnvironmentsIn')} <b>{i18nText('uiEnvironmentalValuesTakePrecedence')}</b>{i18nText('uiIDo')}</>}
              </p>
            ) : (
              <label className="flex flex-col gap-1 ah-label">
                {i18nText('uiEnvironmentName')}
                <input
                  className="rounded-[var(--radius-sm)] border border-border bg-surface px-2.5 py-1.5 text-ui-lg font-normal normal-case tracking-normal text-foreground outline-none transition-colors focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25"
                  value={name}
                  onChange={e => setName(e.target.value)}
                />
              </label>
            )}

            {/* 값이 안 보이는 자리라, 상해 있어도 화면은 멀쩡한 빈칸이다 — 그래서 말로 한다. */}
            {(brokenCount > 0 || oldKeyCount > 0) && (
              <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[var(--radius-sm)] border px-3 py-2 text-ui-md ${
                brokenCount > 0 ? 'border-method-delete/40 bg-method-delete/5' : 'border-accent/40 bg-accent/5'
              }`}>
                {brokenCount > 0 && (
                  <span className="text-muted-foreground">
                    <b className="text-method-delete">{i18nText('uiSecretValue')} {brokenCount}{i18nText('uiValuesUnreadable')}</b>
                    {' — '}{i18nText('uiTheEncryptionKeyIsDifferentFromWhenSavingThese')} <b>{i18nText('uiEmptyValue')}</b>{i18nText('uiExit')}
                  </span>
                )}
                {oldKeyCount > 0 && (
                  <>
                    <span className="text-muted-foreground">{i18nText('uiSecretValue')} {oldKeyCount}{i18nText('uiValuesUseOldKey')}</span>
                    <button
                      type="button"
                      className="rounded-[var(--radius-sm)] border border-accent/50 px-2 py-0.5 text-ui-sm font-semibold text-accent transition-colors hover:bg-accent/10 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      onClick={rekey}
                      disabled={rekeying}
                    >
                      {rekeying ? i18nText('jsxMoving') : i18nText('jsxMoveToCurrentKey')}
                    </button>
                  </>
                )}
              </div>
            )}

              {!isGlobal && <label className="mb-3 flex items-center gap-2 text-ui-md">{i18nText('uiExecutionPolicy')}
                <select aria-label={i18nText('uiExecutionPolicy')} value={executionPolicy} onChange={e => setExecutionPolicy(e.target.value as ExecutionPolicy)} className="rounded-[var(--radius-sm)] border border-border bg-surface px-2 py-1">
                  <option value="open">{i18nText('uiAnyRequestCanBeExecuted')}</option>
                  <option value="confirm-writes">{i18nText('uiOnlyExecuteHumanVerifiedWrites')}</option>
                  <option value="read-only">{i18nText('uiOnlyExecuteReadRequests')}</option>
                </select>
              </label>}
            <div className="overflow-x-auto rounded-[var(--radius-md)] border border-border">

              <table className="w-full table-fixed border-collapse text-ui-md">
                <thead>
                  <tr className="border-b border-border bg-surface-2 text-left text-ui-sm font-semibold uppercase tracking-wide text-faint-foreground">
                    <th className="w-[120px] px-2 py-1.5 font-semibold">{i18nText('uiKey')}</th>
                    <th className="px-2 py-1.5 font-semibold">{i18nText('uiStoredValue')}</th>
                    {!isGlobal && <>
                    <th className="px-2 py-1.5 font-semibold text-accent" title={i18nText('uiSaveOnlyInThisBrowserItDoesNotEnter')}>{i18nText('uiMyValuesPrivate')}</th>
                    </>}
                    <th className="w-16 whitespace-nowrap px-2 py-1.5 text-center font-semibold">{i18nText('uiSecretValue')}</th>
                    <th className="w-12" />
                  </tr>
                </thead>
                <tbody>
                  {/* 불러오는 중에는 '없습니다' 라고 말하지 않는다 — 행 높이만 먼저 잡아 둔다. */}
                  {varsLoading && [0, 1, 2].map(i => (
                    <tr key={`skeleton-${i}`} className="border-t border-border first:border-t-0">
                      <td colSpan={isGlobal ? 4 : 5} className="p-1">
                        <div role={i === 0 ? 'status' : undefined} aria-label={i === 0 ? i18nText('jsxLoadingVariables') : undefined} className="ah-skeleton h-6 w-full" />
                      </td>
                    </tr>
                  ))}
                  {!varsLoading && vars.length === 0 && (
                    <tr>
                      <td colSpan={isGlobal ? 4 : 5} className="px-2 py-3 text-center text-ui-md text-faint-foreground">
                        {varsError
                          ? <>{i18nText('uiFailedToLoadVariable')}{varsError}{i18nText('uiItIsNotEmpty')} <button type="button" className="ah-btn-inline" onClick={() => { if (sharedScope) pickGlobal(sharedScope) }}>{i18nText('uiTryAgain')}</button></>
                          : i18nText('jsxThereAreNoVariablesAddItWithVariableBelow')}
                      </td>
                    </tr>
                  )}
                  {vars.map((v, i) => (
                    <tr key={i} className="border-t border-border first:border-t-0">
                      <td className="p-1">
                        <input
                          aria-label={i18nText('uiVariableKey')}
                          className="w-full rounded-[var(--radius-sm)] border border-transparent bg-transparent px-1.5 py-1 font-mono text-ui-md text-foreground outline-none transition-colors hover:border-border focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25"
                          value={v.key}
                          onChange={e => setVar(i, { key: e.target.value })}
                        />
                      </td>
                      <td className="p-1">
                        {/* 표 한 칸에 URL 을 넣으면 절반이 잘린다 — 마우스를 올리면 전체를 낸다 */}
                        {v.secret && !v.editing && !v.value && v.keyState !== 'broken' && v.hasValue ? <div className="flex items-center justify-between gap-2 px-1.5 py-1 text-ui-md"><span className="text-muted-foreground">{i18nText('uiSaved')}</span><button type="button" aria-label={i18nText('dynamicChangeSecretValue', { v0: String(v.key) })} className="rounded-[var(--radius-sm)] border border-border px-2 py-1 text-ui-sm" onClick={() => setVar(i, { editing: true })}>{i18nText('uiChange')}</button></div> : <>
                          <VariableValueInput
                            aria-label={i18nText('uiVariableValue')}
                            className={`ah-hint-sans w-full rounded-[var(--radius-sm)] border bg-transparent px-1.5 py-1 font-mono text-ui-md text-foreground outline-none transition-colors placeholder:text-faint-foreground focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25 ${
                              v.keyState === 'broken'
                                ? 'border-method-delete/60 placeholder:text-method-delete'
                                : 'border-transparent hover:border-border'
                            }`}
                            value={v.value}
                            placeholder={v.secret ? (v.keyState === 'broken' ? i18nText('jsxTheValueCouldNotBeReadPleaseEnterIt') : (v.hasValue ? i18nText('jsxEnterNewSecretValue') : i18nText('jsxNotRegisteredEnterSecretValue'))) : ''}
                            secret={v.secret}
                            onChange={e => setVar(i, { value: e.target.value })}
                          />
                        </>}
                      </td>
                      {!isGlobal && <>
                      <td className="p-1">
                        <VariableValueInput
                          aria-label={i18nText('uiMyValuePrivateOverride')}
                          className="ah-hint-sans w-full rounded-[var(--radius-sm)] border border-transparent bg-transparent px-1.5 py-1 font-mono text-ui-md text-accent outline-none transition-colors placeholder:text-faint-foreground hover:border-accent/40 focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25"
                          secret
                          inlineReveal
                          placeholder={isGlobal ? i18nText('jsxCommonVariablesHaveNoIndividualValues') : i18nText('jsxIfEmptyUseStoredValue')}
                          value={isGlobal ? '' : (personal[v.key] ?? '')}
                          onChange={e => setPersonal(v.key, e.target.value)}
                          disabled={!v.key.trim() || !envId || isGlobal}
                        />
                      </td>
                      </>}
                      <td className="p-1 text-center">
                        <input
                          aria-label={i18nText('uiSecretValue2')}
                          type="checkbox"
                          className="h-3.5 w-3.5 accent-accent"
                          checked={v.secret}
                          onChange={e => setVar(i, { secret: e.target.checked })}
                        />
                      </td>
                      <td className="p-1 text-center">
                        <button
                          type="button"
                          aria-label={v.key ? i18nText('dynamicDeleteVariable', { v0: String(v.key) }) : i18nText('jsxDeleteUnnamedVariable')}
                          title={v.secret && v.hasValue ? i18nText('jsxTheSavedSecretValueAlsoDisappears') : undefined}
                          className="ah-action flex h-6 w-auto px-1.5 items-center justify-center rounded-[var(--radius-sm)] text-muted-foreground transition-colors hover:bg-surface-2 hover:text-method-delete focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                          onClick={() => setVars(vars.filter((_, idx) => idx !== i))}
                        >{i18nText('uiDelete')}</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <button
              type="button"
              className="self-start text-ui-md font-semibold text-accent transition-colors hover:text-accent-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              onClick={() => setVars([...vars, { key: '', value: '', secret: false }])}
            >
              {i18nText('uiVariable')}
            </button>
          </fieldset>
        ) : (
          <div className="flex flex-1 items-center justify-center p-8 text-center text-ui-lg text-faint-foreground">
            {i18nText('uiCreateYourFirstEnvironmentWithEnvironment')}
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-border/70 px-4 py-3">
          {envId && !isGlobal && (
            deleteArmed ? (
              <button
                type="button"
                className="mr-auto rounded-[var(--radius-sm)] bg-method-delete px-3 py-1.5 text-ui-lg font-bold text-background focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                onClick={removeEnv}
              >
                {/* 헤더에 '현재 실행 환경'의 다른 이름이 같이 떠 있다 — 어느 쪽이 지워지는지 라벨로 못박는다 */}
                {i18nText('dynamicReallyDeleteIncludingVariables', { v0: String(name) })}
              </button>
            ) : (
              <button
                type="button"
                className="mr-auto rounded-[var(--radius-sm)] border border-border px-3 py-1.5 text-ui-lg font-medium text-method-delete/80 transition-colors hover:border-method-delete/50 hover:text-method-delete focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                onClick={() => { setDeleteArmed(true); setTimeout(() => setDeleteArmed(false), 3000) }}
              >
                {i18nText('uiDeleteEnvironment')}
              </button>
            )
          )}
          {!embedded && <button
            type="button"
            className="ah-action rounded-[var(--radius-sm)] bg-transparent px-3 py-1.5 text-ui-lg font-medium text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            onClick={onClose}
          >
            {i18nText('uiCancel')}
          </button>}
          <button
            type="button"
            aria-keyshortcuts="Meta+Enter Control+Enter"
            className="flex items-center rounded-[var(--radius-sm)] bg-accent-solid px-3.5 py-1.5 text-ui-lg font-semibold text-accent-solid-foreground transition-colors hover:bg-accent-solid-hover disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            disabled={!envId || saving || varsLoading || !!varsError}
            title={varsError ? i18nText('jsxCouldNotSaveBecauseVariableCouldNotBeLoaded') : undefined}
            onClick={save}
          >
            {/* 단축키는 툴팁이 아니라 버튼에 글자로 — aria-hidden 으로 읽는 이름은 '저장' 그대로 둔다 */}
            {saving ? i18nText('jsxSaving') : <>{i18nText('uiSave')}<kbd aria-hidden className="ml-1 rounded-[var(--radius-sm)] bg-black/15 px-1.5 py-0.5 font-mono text-ui-meta font-normal opacity-80">⌘↵</kbd></>}
          </button>
        </div>
    </ModalFrame>
  )
}
