'use client'
import { t as i18nText } from '@/i18n'
import { useCallback, useEffect, useRef, useState } from 'react'
import { readJson, writeJson } from '@/lib/localStore'
import { requestsByFolder } from '@/lib/requestsByFolder'
import { methodText } from '@/lib/methodStyle'
import { displayName, groupOf } from '@/lib/requestGroups'
import { filterActions, filterEntries, tokenize, type PaletteAction, type PaletteEntry } from '@/lib/paletteFilter'
import { useFocusTrap } from '@/lib/useFocusTrap'
import { errorText, fetchArray } from '@/lib/fetchJson'
import { LoadFailed } from './LoadFailed'
import type { FolderRow, RequestRow } from '@/lib/ui-types'

export type { PaletteAction } from '@/lib/paletteFilter'


type Item = { kind: 'action'; action: PaletteAction } | { kind: 'request'; entry: PaletteEntry }

/**
 * ⌘/Ctrl+K 커맨드 팔레트 (Raycast/Linear/VSCode 패턴).
 * 명령(뷰 이동·환경 전환·테마·관리 모달)과 전체 요청을 한 검색창에서 필터한다.
 * 명령이 위, 요청이 아래. ↑↓ 이동(구역 넘나듦) · Enter 실행/열기 · Esc 닫기.
 */
export function CommandPalette({ workspaceId, open, actions, onClose, onPick }: {
  workspaceId: string
  open: boolean
  actions: PaletteAction[]
  onClose: () => void
  onPick: (r: RequestRow) => void
}) {
  const [entries, setEntries] = useState<PaletteEntry[]>([])
  const [q, setQ] = useState('')
  const [scope, setScope] = useState<'all' | 'requests' | 'commands'>('all')
  const [recentIds, setRecentIds] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const sequence = useRef(0)
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  // onClose 를 넘겨 팔레트 내 어디에 포커스가 있어도(결과 목록 포함) Esc 로 닫고,
  // 하위 모달 위에서 열렸을 때 전파를 막아 동시 닫힘을 방지한다. 초기 포커스는 트랩이 입력창에 준다.
  const trapRef = useFocusTrap<HTMLDivElement>(open, onClose)

  // 못 불러온 이유. 없으면 서버가 죽어도 '검색 결과 없음' 으로 보인다 —
  // 예전엔 catch 조차 없어서 500 이 오면 .map 이 터지고 조용히 빈 목록으로 남았다.
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const seq = ++sequence.current
    setLoading(true)
    try {
      const fs = await fetchArray<FolderRow>(`/api/folders?workspaceId=${encodeURIComponent(workspaceId)}`)
      // 폴더마다 부르지 않고 한 번에 받아 묶는다 — 이름만 쓰므로 slim 으로 충분하다.
      const byFolder = await requestsByFolder(workspaceId, { slim: true })
      const all = await Promise.all(fs.map(async f => {
        const rs = byFolder[f.id] ?? []
        return rs.map(r => ({ request: r, folderName: f.name }))
      }))
      if (seq !== sequence.current) return
      setEntries(all.flat())
      setLoadError(null)
    } catch (e) {
      if (seq !== sequence.current) return
      setEntries([])
      setLoadError(errorText(e))
    } finally { if (seq === sequence.current) setLoading(false) }
  }, [workspaceId])

  useEffect(() => {
    if (open) { shownKey.current = null; movedRef.current = false; setQ(''); setScope('all'); setCursor(0); setEntries([]); setRecentIds(readJson<string[]>(`ah:paletteRecent:${workspaceId}`, [])); load() }
    return () => { sequence.current++ }
  }, [open, load])

  const tokens = tokenize(q)
  const actionMatches = scope === 'requests' ? [] : filterActions(actions, tokens)
  const requestMatches = scope === 'commands' ? [] : filterEntries(tokens.length ? entries : [...entries].sort((a, b) => {
    const rank = (id: string) => { const i = recentIds.indexOf(id); return i < 0 ? Number.MAX_SAFE_INTEGER : i }
    return rank(a.request.id) - rank(b.request.id)
  }), tokens)

  const items: Item[] = [
    ...requestMatches.map(entry => ({ kind: 'request', entry }) as Item),
    ...actionMatches.map(action => ({ kind: 'action', action }) as Item),
  ]
  const clampedCursor = Math.max(0, Math.min(cursor, items.length - 1))

  // 늦게 온 요청 목록이 커서 밑의 항목을 바꾸지 않게 한다. 요청이 명령보다 위에 오므로, 목록을
  // 부르는 사이 '설정' 을 쳐서 명령을 보고 있다가 목록이 도착하면 커서 0 이 요청으로 바뀌었다 —
  // 그때 Enter 를 누르면 보던 것과 다른 것이 열렸다. 목록이 바뀌면 보던 항목을 다시 찾아 커서를 옮긴다.
  const keyOf = (it: Item) => it.kind === 'action' ? `a:${it.action.id}` : `r:${it.entry.request.id}`
  const shownKey = useRef<string | null>(null)
  const movedRef = useRef(false)
  const seenEntries = useRef(entries)
  useEffect(() => {
    if (seenEntries.current !== entries) {
      seenEntries.current = entries
      // 사용자가 무엇을 보고 있을 때만(검색어를 쳤거나 화살표로 옮겼을 때) 붙잡는다. 열자마자
      // 아무것도 안 했는데 목록이 늦게 오면, 빈 목록일 때 첫 줄이던 명령에 커서가 묶여
      // 최근 요청이 맨 위로 와도 Enter 가 명령을 실행했다.
      const i = shownKey.current && (q || movedRef.current) ? items.findIndex(it => keyOf(it) === shownKey.current) : -1
      if (i >= 0 && i !== clampedCursor) { setCursor(i); return }
    }
    shownKey.current = items[clampedCursor] ? keyOf(items[clampedCursor]) : null
  })

  const activate = (it: Item) => {
    if (it.kind === 'action') it.action.run()
    else {
      const next = [it.entry.request.id, ...recentIds.filter(id => id !== it.entry.request.id)].slice(0, 12)
      writeJson(`ah:paletteRecent:${workspaceId}`, next)
      onPick(it.entry.request)
    }
    onClose()
  }

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [clampedCursor, q])

  if (!open) return null
  return (
    <div
      className="animate-overlay-in fixed inset-0 z-[90] flex items-start justify-center bg-black/40 backdrop-blur-sm pt-[12vh]"
      onClick={onClose}
    >
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-label={i18nText('uiCommandPalette')}
        className="animate-dialog-in flex max-h-[60vh] w-[min(600px,calc(100vw-24px))] flex-col overflow-hidden rounded-[var(--radius-lg)] border border-border/60 bg-surface shadow-[var(--shadow-card)]"
        onClick={e => e.stopPropagation()}
      >
        <input
          aria-label={i18nText('uiCommandRequestSearch')}
          className="border-b border-border bg-transparent px-4 py-3 text-ui-lg text-foreground outline-none placeholder:text-faint-foreground"
          placeholder={i18nText('uiCommandRequestSearchEnvironmentSwitchingViewMovementTheme')}
          value={q}
          onChange={e => { setQ(e.target.value); setCursor(0) }}
          onKeyDown={e => {
            // Esc 는 트랩(useFocusTrap onEscape)이 컨테이너 레벨에서 처리 — autoFocus 제거로 포커스 복원도 정상화.
            if (e.key === 'ArrowDown') { e.preventDefault(); movedRef.current = true; setCursor(c => Math.min(c + 1, items.length - 1)) }
            if (e.key === 'ArrowUp') { e.preventDefault(); movedRef.current = true; setCursor(c => Math.max(c - 1, 0)) }
            if (e.key === 'Enter' && items[clampedCursor]) { e.preventDefault(); activate(items[clampedCursor]) }
          }}
        />
        <div className="flex items-center gap-1 border-b border-border/70 px-3 py-2" aria-label={i18nText('uiSearchFor')}>
          {(['all', 'requests', 'commands'] as const).map(s => <button key={s} type="button" aria-pressed={scope === s} className={`rounded-full px-3 py-1 text-ui-sm ${scope === s ? 'bg-accent/15 text-accent' : 'text-muted-foreground hover:bg-surface-2'}`} onClick={() => { setScope(s); setCursor(0) }}>{s === 'all' ? i18nText('jsxAll') : s === 'requests' ? i18nText('jsxRequestOnly') : i18nText('jsxCommandOnly')}</button>)}
          {q && <button type="button" className="ml-auto text-ui-sm text-accent" onClick={() => { setQ(''); setCursor(0) }}>{i18nText('uiClearSearchTerm')}</button>}
        </div>
        <div ref={listRef} className="flex-1 overflow-y-auto p-1.5">
          {/* 못 불러온 것과 안 맞는 것은 다른 화면이어야 한다 — 둘 다 '없음' 으로 보이면
              서버가 죽은 줄 모르고 요청을 다시 만들게 된다 */}
          {loadError && (
            <LoadFailed what={i18nText('uiRequestList')} detail={loadError} onRetry={load} />
          )}
          {loading && <p role="status" className="px-3 py-2 text-ui-sm text-faint-foreground">{i18nText('uiLoadingRequestList')}</p>}
          {!loading && !loadError && items.length === 0 && (
            <p className="px-3 py-6 text-center text-ui-lg text-faint-foreground">
              {i18nText('uiThereAreNoMatchingCommandsRequests')}
            </p>
          )}

          {requestMatches.length > 0 && <SectionLabel>{tokens.length ? i18nText('jsxRequest') : i18nText('jsxRequestRecentSelection')}</SectionLabel>}
          {requestMatches.map((entry, j) => {
            const r = entry.request
            const group = groupOf(r.name)
            const idx = j
            const active = idx === clampedCursor
            return (
              <button
                key={r.id}
                type="button"
                data-active={active}
                className={`flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-3 py-2 text-left transition-colors ${
                  active ? 'bg-accent/20 ring-1 ring-inset ring-accent/40' : 'hover:bg-surface-2'
                }`}
                onMouseEnter={() => setCursor(idx)}
                onClick={() => activate({ kind: 'request', entry })}
              >
                <span className={`w-[46px] shrink-0 font-mono text-ui-sm font-bold ${methodText(r.method)}`}>
                  {r.method}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui-lg text-foreground">{displayName(r.name)}</span>
                  <span className="block truncate font-mono text-ui-sm text-faint-foreground">
                    {entry.folderName}{group ? ` · ${group}` : ''} · {r.url}
                  </span>
                </span>
              </button>
            )
          })}
          {actionMatches.length > 0 && <SectionLabel>{i18nText('uiCommand')}</SectionLabel>}
          {actionMatches.map((a, i) => {
            const active = requestMatches.length + i === clampedCursor
            return (
              <button
                key={a.id}
                type="button"
                data-active={active}
                className={`flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-3 py-2 text-left transition-colors ${
                  active ? 'bg-accent/20 ring-1 ring-inset ring-accent/40' : 'hover:bg-surface-2'
                }`}
                onMouseEnter={() => setCursor(requestMatches.length + i)}
                onClick={() => activate({ kind: 'action', action: a })}
              >
                <span className="w-[46px] shrink-0 text-ui-meta font-semibold uppercase tracking-wide text-faint-foreground">
                  {a.badge}
                </span>
                <span className="min-w-0 flex-1 truncate text-ui-lg text-foreground">{a.label}</span>
                {a.hint && <span className="shrink-0 text-ui-sm text-faint-foreground">{a.hint}</span>}
              </button>
            )
          })}

        </div>
        <div className="flex items-center gap-3 border-t border-border/70 px-4 py-2 text-ui-sm text-faint-foreground">
          <span><kbd className="rounded-[var(--radius-sm)] border border-border px-1">↑↓</kbd> {i18nText('uiMove')}</span>
          <span><kbd className="rounded-[var(--radius-sm)] border border-border px-1">Enter</kbd> {i18nText('uiRun')}</span>
          <span><kbd className="rounded-[var(--radius-sm)] border border-border px-1">Esc</kbd> {i18nText('uiClose')}</span>
        </div>
      </div>
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-3 pb-1 pt-2 text-ui-meta font-semibold uppercase tracking-wide text-faint-foreground first:pt-1">
      {children}
    </p>
  )
}
