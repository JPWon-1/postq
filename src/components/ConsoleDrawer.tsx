'use client'
import { t as i18nText, localizeKorean } from '@/i18n'
import { ToolButton } from './ToolButton'
import { useCallback, useEffect, useState } from 'react'
import { useResizable } from '@/lib/useResizable'
import { kstTime } from '@/lib/datetime'
import { methodText } from '@/lib/methodStyle'
import { CopyButton } from './CopyButton'
import { LoadFailed } from './LoadFailed'
import type { ExecutionRow } from '@/lib/ui-types'
import { errorText, fetchArray } from '@/lib/fetchJson'
import { copyText } from '@/lib/clipboard'

type Row = { execution: ExecutionRow; requestName: string | null; folderName: string | null }
type LogEntry = { id: number; at: number; level: 'error' | 'warn' | 'info'; scope: string; message: string; detail?: string; href?: string }
type Tab = 'requests' | 'server'
type Filter = '' | 'ok' | 'error' | '4xx' | '5xx'

const FILTERS: { val: Filter; label: string }[] = [
  { val: '', label: '전체' },
  { val: 'ok', label: '성공' },
  { val: '4xx', label: '4xx' },
  { val: '5xx', label: '5xx' },
  { val: 'error', label: '전송 실패' },
]

/**
 * 하단 콘솔 — 실제로 나간 요청과 받은 응답을 시간순으로 펼쳐 본다.
 *
 * 데이터는 실행 이력(executions)과 같은 것을 쓴다. 'API 이력'(⌘5)이 "무엇이 언제 실행됐나"를
 * 목록으로 훑는 화면이라면, 콘솔은 작업 중인 화면을 떠나지 않고 방금 나간 요청의 헤더·바디를
 * 바로 까보는 용도다 — 브라우저 devtools 의 Network 패널과 같은 자리.
 *
 * secret 값은 서버가 저장 시점에 이미 {{이름}} 으로 마스킹하므로 여기서 추가 처리하지 않는다.
 */
export function ConsoleDrawer({ open, onClose, version, workspaceId }: {
  open: boolean
  onClose: () => void
  /** 현재 프로젝트 — 다른 프로젝트의 실행이 섞이지 않게 */
  workspaceId: string
  /** 요청이 실행될 때마다 증가 — 콘솔을 자동 갱신하는 신호 */
  version: number
}) {
  const [rows, setRows] = useState<Row[]>([])
  const [filter, setFilter] = useState<Filter>('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  // 요청(나간 것) / 서버 로그(우리 서버에서 난 일) — 원인이 어느 쪽인지 가르는 게 추적의 시작이다.
  const [tab, setTab] = useState<Tab>('requests')
  const [logs, setLogs] = useState<LogEntry[]>([])
  const h = useResizable('ah:consoleHeight', 420, 160, 800, 'y')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const qs = new URLSearchParams({ limit: '80', workspaceId })
      if (filter) qs.set('status', filter)
      setRows(await fetchArray<Row>(`/api/executions?${qs}`))
      setLoadError(null)
    } catch (e) {
      // 작업을 막지는 않되(보조 도구), 못 불러온 걸 '기록 없음' 으로 보여주지는 않는다.
      // 에러를 추적하라고 만든 화면이 자기 실패를 숨기면 그게 제일 나쁘다.
      setLoadError(errorText(e))
    }
    finally { setLoading(false) }
  }, [filter, workspaceId])

  const loadLogs = useCallback(async () => {
    setLoading(true)
    try {
      setLogs(await fetchArray<LogEntry>('/api/logs?limit=200'))
      setLoadError(null)
    } catch (e) {
      setLoadError(errorText(e))
    }
    finally { setLoading(false) }
  }, [])

  useEffect(() => {
    // 닫으면 들고 있던 실행 80건(응답 본문 포함)과 로그를 내려놓는다 — 다시 열면 새로 받는다.
    // 화면에서 안 보이는데 수 MB 를 계속 쥐고 있었다(codex 점검).
    if (!open) { setRows([]); setLogs([]); return }
    if (tab === 'requests') load(); else loadLogs()
  }, [open, tab, load, loadLogs, version])

  // 열려 있을 때 Esc 로 닫기 — 모달이 아니므로 포커스는 가두지 않는다.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <section className="flex shrink-0 flex-col border-t border-border bg-surface" aria-label={i18nText('uiConsole')} style={{ height: h.size }}>
      {/* 위로 끌어 키운다 — 펼친 요청/응답이 길어 고정 높이로는 늘 모자랐다 */}
      <div
        role="separator" aria-orientation="horizontal" aria-label={i18nText('uiConsoleHeightAdjustment')}
        title={i18nText('uiDragToAdjustConsoleHeight')}
        className="group relative -mt-px h-1.5 shrink-0 cursor-row-resize"
        onMouseDown={e => h.startDrag(e, -1)}
      >
        <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-transparent transition-colors group-hover:bg-accent/50" />
      </div>
      <div className="flex shrink-0 items-center gap-2 border-b border-border/70 px-3 py-1.5">
        {([['requests', i18nText('jsxRequest')], ['server', i18nText('jsxServerLog')]] as const).map(([val, label]) => (
          <button
            key={val}
            type="button"
            aria-pressed={tab === val}
            title={val === 'requests' ? i18nText('jsxRequestsActuallyMadeAndResponsesReceived') : i18nText('jsxWhatHappenedOnThePostqServerExecutionScheduleError')}
            className={`rounded-[var(--radius-sm)] px-2 py-0.5 text-ui-md font-bold transition-colors ${
              tab === val ? 'bg-accent/15 text-accent' : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setTab(val)}
          >
            {label}
          </button>
        ))}
        <span className={`ml-2 flex items-center gap-0.5 ${tab === 'requests' ? '' : 'hidden'}`}>
          {FILTERS.map(f => (
            <button
              key={f.label}
              type="button"
              aria-pressed={filter === f.val}
              className={`rounded-[var(--radius-sm)] px-1.5 py-0.5 text-ui-sm transition-colors ${
                filter === f.val ? 'bg-accent/15 text-accent' : 'text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => setFilter(f.val)}
            >
              {localizeKorean(f.label)}
            </button>
          ))}
        </span>
        <span className="ml-auto text-ui-sm text-faint-foreground">
          {loading ? i18nText('jsxLoading') : i18nText('dynamicGun', { v0: String(tab === 'requests' ? rows.length : logs.length) })}
        </span>
        <ToolButton icon="refresh" aria-label={i18nText('uiRefresh')} type="button" className="rounded-[var(--radius-sm)] px-1.5 py-0.5 text-ui-sm text-muted-foreground hover:text-foreground"
          onClick={() => (tab === 'requests' ? load() : loadLogs())} />
        {/* 비울 것이 있을 때만 낸다 — 빈 목록 옆의 [지우기] 는 누를 일이 없다. */}
        {tab === 'server' && logs.length > 0 && (
          <ToolButton icon="clear" aria-label={i18nText('uiClear')} type="button" title={i18nText('uiClearsOnlyTheListOnThisScreenLeavesLog')}
            className="rounded-[var(--radius-sm)] px-1.5 py-0.5 text-ui-sm text-muted-foreground hover:text-foreground"
            onClick={async () => { await fetch('/api/logs', { method: 'DELETE' }).catch(() => {}); loadLogs() }} />
        )}
        {/* Esc 로 닫힌다는 사실이 코드 주석에만 있었다 — 단축키는 툴팁이 아니라 화면에 글자로 적는다. */}
        <kbd className="rounded-[var(--radius-sm)] border border-border px-1 text-ui-meta font-normal text-faint-foreground">Esc</kbd>
        <ToolButton icon="close" type="button" aria-label={i18nText('uiCloseConsole')} title={i18nText('uiCloseConsoleEsc')} className="ah-action rounded-[var(--radius-sm)] px-1.5 py-0.5 text-ui-lg leading-none text-muted-foreground hover:text-foreground" onClick={onClose} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto font-mono text-ui-sm">
        {/* 실패는 목록이 비었을 때만이 아니라 언제나 보여야 한다 — 이전 결과가 남아 있으면
            갱신이 실패한 줄 모르고 낡은 목록을 지금 상태로 읽는다. */}
        {loadError && (
          <div className="font-sans">
            <LoadFailed
              what={tab === 'requests' ? i18nText('jsxRunHistory') : i18nText('jsxServerLog')}
              detail={loadError}
              onRetry={() => (tab === 'requests' ? load() : loadLogs())}
            />
            {(tab === 'requests' ? rows.length : logs.length) > 0 && (
              <p className="px-3 pb-2 text-ui-sm text-faint-foreground">{i18nText('uiBelowAreThePreviousResultsBeforeRenewal')}</p>
            )}
          </div>
        )}
        {tab === 'server' ? (
          <>
            {logs.length === 0 && !loading && !loadError && (
              <p className="px-3 py-6 text-center font-sans text-ui-md text-faint-foreground">
                {i18nText('uiThereAreNoServerRecordsAPIExecutionScheduleAnd')}
              </p>
            )}
            {logs.map(l => (
              <details key={l.id} className="border-b border-border/50 last:border-b-0">
                <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1 hover:bg-surface-2">
                  <span className={`w-10 shrink-0 font-bold ${
                    l.level === 'error' ? 'text-method-delete' : l.level === 'warn' ? 'text-method-put' : 'text-badge-new-fg'
                  }`}>{l.level === 'error' ? 'ERR' : l.level === 'warn' ? 'WARN' : 'INFO'}</span>
                  <span className="shrink-0 font-sans text-ui-sm text-foreground">{l.scope}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{l.message}</span>
                  <span className="w-16 shrink-0 text-right text-faint-foreground">{kstTime(l.at)}</span>
                </summary>
                <div className="mx-3 mb-2 flex flex-col gap-1">
                  <span className="flex items-center gap-2">
                    {l.href && (
                      <a href={l.href} className="text-ui-sm font-medium text-accent hover:text-accent-hover"
                        title={i18nText('uiGoToTheScreenWhereThisLogAppears')}>{i18nText('uiGoToSite')}</a>
                    )}
                    <ToolButton icon="copy" aria-label={i18nText('uiCopy')} type="button" className="text-ui-sm font-medium text-muted-foreground hover:text-foreground"
                      onClick={() => copyText(logText(l))} />
                    {/* 에러는 그대로 AI 에 붙여넣을 수 있게 — 원인 분석까지가 로그의 목적이다 */}
                    <ToolButton icon="ai" aria-label={i18nText('uiCopyAIPrompt')} type="button" className="text-ui-sm font-medium text-accent hover:text-accent-hover"
                      title={i18nText('uiCopyItToThePromptToAskForCause')}
                      onClick={() => copyText(aiPrompt(l))} />
                  </span>
                  {l.detail && (
                    <pre className="ah-console max-h-56 overflow-auto whitespace-pre-wrap break-all text-muted-foreground">{l.detail}</pre>
                  )}
                </div>
              </details>
            ))}
          </>
        ) : (
        <>
        {rows.length === 0 && !loading && !loadError && (
          <p className="px-3 py-6 text-center font-sans text-ui-md text-faint-foreground">
            {i18nText('uiThereIsNoExecutionHistoryYetWhenYouRun')}
          </p>
        )}
        {rows.map(({ execution: e, requestName }) => {
          const ok = !e.error && e.responseStatus != null && e.responseStatus < 400
          const isOpen = expanded === e.id
          return (
            <div key={e.id} className="border-b border-border/50 last:border-b-0">
              {/* 복사 버튼이 행 <button> 안에 있었다 — 버튼 중첩은 유효하지 않은 HTML 이라
                  클릭이 어느 쪽으로 갈지 보장되지 않는다. group 을 감싸는 div 로 올리고
                  복사 버튼은 형제로 뺀다(전역 이력 행도 같은 문제였다). */}
              <div className="group/row flex w-full items-center gap-2 transition-colors hover:bg-surface-2">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  className="flex min-w-0 flex-1 items-center gap-2 py-1 pl-3 text-left focus-visible:outline focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-accent"
                  onClick={() => setExpanded(isOpen ? null : e.id)}
                >
                  <span aria-hidden className={`shrink-0 text-ui-meta text-faint-foreground transition-transform ${isOpen ? 'rotate-90' : ''}`}>▶</span>
                  <span className={`w-12 shrink-0 font-bold ${methodText(e.resolved.method)}`}>{e.resolved.method}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground" title={e.resolved.url}>{e.resolved.url}</span>
                </button>
                <CopyButton compact
                  value={e.resolved.url}
                  title={i18nText('uiCopyRequestAddress')}
                  className="opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100"
                />
                <span className="shrink-0 font-sans text-ui-sm text-faint-foreground">{requestName ?? i18nText('jsxDeleted')}</span>
                <span className={`w-10 shrink-0 text-right font-bold ${ok ? 'text-badge-new-fg' : 'text-method-delete'}`}>
                  {e.error ? 'ERR' : e.responseStatus}
                </span>
                <span className="w-14 shrink-0 text-right text-faint-foreground">{e.durationMs != null ? `${e.durationMs}ms` : '—'}</span>
                <span className="w-20 shrink-0 whitespace-nowrap pr-3 text-right text-faint-foreground">{kstTime(e.executedAt)}</span>
              </div>

              {isOpen && (
                <div className="flex flex-col gap-1.5 bg-background/40 px-3 pb-2.5 pt-1">
                  {e.error && (
                    <>
                      <Block label={i18nText('uiTransmissionError')} text={e.error} tone="error" />
                      {/* 실패한 요청은 그 자리에서 AI 로 넘어갈 수 있어야 한다 */}
                      <ToolButton icon="ai" aria-label={i18nText('uiCopyAIPrompt')}
                        type="button"
                        className="self-start text-ui-sm font-medium text-accent hover:text-accent-hover"
                        title={i18nText('uiCopyRequestResponseAndErrorTogetherToCauseAnalysis')}
                        onClick={() => copyText([
                          i18nText('jsxBelowIsARecordOfFailedRequestsSentTo'),
                          i18nText('jsxPleaseTellMeTheCauseAndSolution'), '',
                          `${e.resolved.method} ${e.resolved.url}`,
                          `오류: ${e.error}`,
                          `요청 헤더:\n${kvText(e.resolved.headers) || i18nText('jsxDoesnTExist')}`,
                          e.resolved.body ? `요청 바디:\n${e.resolved.body}` : '',
                        ].filter(Boolean).join('\n'))}
                       />
                    </>
                  )}
                  <Block label={i18nText('uiRequestHeader')} text={kvText(e.resolved.headers)} />
                  <Block label={i18nText('uiQueryParameters')} text={kvText(e.resolved.params)} />
                  {e.resolved.body && <Block label={i18nText('dynamicRequestBody', { v0: String(e.resolved.bodyType) })} text={pretty(e.resolved.body)} />}
                  <Block label={i18nText('uiResponseHeader')} text={e.responseHeaders ? Object.entries(e.responseHeaders).map(([k, v]) => `${k}: ${v}`).join('\n') : ''} />
                  <Block label={i18nText('uiResponseBody')} text={pretty(e.responseBody ?? '') + (e.truncated ? i18nText('jsxTruncated') : '')} />
                </div>
              )}
            </div>
          )
        })}
        </>
        )}
      </div>
    </section>
  )
}

/**
 * JSON 이면 들여쓰기해서 보여준다 — 서버가 내려주는 한 줄짜리 JSON 은 콘솔에서 읽을 수가 없다.
 * 파싱 실패하면(HTML 에러 페이지·평문 등) 원문 그대로.
 */
function pretty(text: string): string {
  const t = text.trim()
  if (!t || (t[0] !== '{' && t[0] !== '[')) return text
  try { return JSON.stringify(JSON.parse(t), null, 2) } catch { return text }
}

/** 로그 한 건을 사람이 읽는 텍스트로 — 복사·붙여넣기용 */
function logText(l: LogEntry): string {
  return [
    `[${l.level.toUpperCase()}] ${l.scope}`,
    l.message,
    l.detail ? `\n${l.detail}` : '',
  ].filter(Boolean).join('\n')
}

/** AI 에게 그대로 물어볼 수 있는 프롬프트 — 로그만 던지면 맥락이 없어 답이 부실하다 */
function aiPrompt(l: LogEntry): string {
  return [
    '아래는 postq 의 서버 로그입니다.',
    '원인과 해결 방법을 알려주세요. 추측이면 추측이라고 명시해 주세요.',
    '',
    logText(l),
  ].join('\n')
}

/** 활성화된 항목만 'key: value' 로 — 꺼둔 항목은 실제로 나가지 않았으므로 콘솔에 넣지 않는다. */
function kvText(items: { key: string; value: string; enabled?: boolean }[]): string {
  return items.filter(i => i.enabled !== false && i.key).map(i => `${i.key}: ${i.value}`).join('\n')
}

/**
 * 값이 없으면 아예 렌더하지 않는다 — '(없음)' 블록이 드로어 높이를 먹어
 * 정작 볼 내용(응답 바디)이 스크롤 밖으로 밀려났다.
 * 복사 버튼은 hover 시에만 — 상시 노출은 라벨 줄을 시끄럽게 만든다.
 */
function Block({ label, text, tone }: { label: string; text: string; tone?: 'error' }) {
  if (!text.trim()) return null
  return (
    <div className="group/blk flex flex-col gap-0.5">
      <span className="flex items-center gap-2 ah-label">
        {label}
        <ToolButton icon="copy" aria-label={i18nText('uiCopy')}
          type="button"
          className="font-sans text-ui-meta font-medium normal-case tracking-normal text-accent opacity-0 transition-opacity hover:text-accent-hover group-hover/blk:opacity-100 focus-visible:opacity-100"
          onClick={() => copyText(text)}
         />
      </span>
      <pre className={`ah-console max-h-56 overflow-auto whitespace-pre-wrap break-all !py-1.5 !leading-[17px] ${tone === 'error' ? 'text-method-delete' : 'text-muted-foreground'}`}>
        {text}
      </pre>
    </div>
  )
}
