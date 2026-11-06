'use client'
import { t as i18nText } from '@/i18n'
import { ToolButton } from './ToolButton'
import { useEffect, useRef, useState } from 'react'
import type { RequestRow } from '@/lib/ui-types'
import { methodText } from '@/lib/methodStyle'


/** 글자를 유지하는 새 요청 버튼. 보조 동작은 ToolButton으로 표시한다. */
const TAB_ICON_BTN = 'flex h-7 gap-1 px-2 text-ui-sm whitespace-nowrap shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-faint-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent'

/**
 * 열린 요청 탭 줄 — Postman 처럼 '메서드(색, 작게) + 이름' 탭, 활성 탭은 위쪽 강조선.
 * 오른쪽에 [+](새 요청) 와 [▾](열린 탭 목록). 환경 고르기·실행/문서 전환은 page 가 같은 줄 오른쪽에 붙인다.
 */
export function RequestTabs({ tabs, activeId, dirty, onSelect, onClose, onNew, previewId, onPin }: {
  previewId?: string | null
  onPin?: (id: string) => void
  tabs: RequestRow[]
  activeId: string | null
  dirty: Record<string, boolean>
  onSelect: (id: string) => void
  onClose: (id: string) => void
  /** [+] — 새 요청을 만들어 연다 */
  onNew?: () => void
}) {
  const tabRefs = useRef(new Map<string, HTMLDivElement>())
  const [listOpen, setListOpen] = useState(false)
  useEffect(() => {
    if (!listOpen) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setListOpen(false) }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [listOpen])
  useEffect(() => {
    if (activeId) tabRefs.current.get(activeId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeId, tabs.length])
  return (
    <div className="flex h-10 min-w-[300px] flex-1 items-stretch">
      {tabs.length > 0 && (
      <div
        role="tablist"
        aria-label={i18nText('uiOpenRequest')}
        className="flex min-w-0 items-stretch overflow-x-auto [scrollbar-width:none]"
      >
      {tabs.map((t, index) => {
        const active = t.id === activeId
        return (
          <div
            key={t.id}
            ref={el => { if (el) tabRefs.current.set(t.id, el); else tabRefs.current.delete(t.id) }}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onDoubleClick={() => onPin?.(t.id)}
            onClick={() => onSelect(t.id)}
            onKeyDown={e => {
              if (e.target !== e.currentTarget) return
              const next = e.key === 'ArrowRight' ? (index + 1) % tabs.length
                : e.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length
                : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null
              if (next !== null) {
                e.preventDefault(); onSelect(tabs[next].id); tabRefs.current.get(tabs[next].id)?.focus()
              } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(t.id) }
              else if (e.key === 'Delete') { e.preventDefault(); onClose(t.id) }
            }}
            onMouseDown={e => { if (e.button === 1) { e.preventDefault(); onClose(t.id) } }}
            className={`group relative flex w-[200px] min-w-[180px] shrink cursor-pointer items-center gap-1.5 border-r border-border pl-3 pr-1.5 text-ui-md transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
              active
                ? 'bg-background text-foreground'
                : 'text-muted-foreground hover:bg-surface-2/60 hover:text-foreground'
            }`}
          >
            {active && <span aria-hidden className="absolute inset-x-0 top-0 h-0.5 bg-accent" />}
            <span className={`shrink-0 font-mono text-ui-meta font-bold leading-none ${methodText(t.method)}`}>
              {t.method === 'DELETE' ? 'DEL' : t.method}
            </span>
            <span className={`min-w-0 flex-1 truncate ${previewId === t.id ? 'italic' : ''}`} title={t.name}>{t.name}</span>
            {dirty[t.id] && (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-badge-changed-fg group-hover:hidden" title={i18nText('uiUnsavedEdits')} aria-label={i18nText('uiUnsavedEdits')} />
            )}
            <ToolButton icon="close"
              type="button"
              aria-label={i18nText('dynamicCloseTab', { v0: String(t.name) })}
              className={`ah-action flex h-6 w-auto px-1.5 shrink-0 items-center justify-center rounded-[4px] text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${active ? '' : 'opacity-60 group-hover:opacity-100'}`}
              onClick={e => { e.stopPropagation(); onClose(t.id) }}
             />
          </div>
        )
      })}
      </div>
      )}
      <div className="flex shrink-0 items-center gap-0.5 px-1.5">
        {onNew && (
          <button type="button" aria-label={i18nText('uiNewRequest')} title={i18nText('uiCreateANewRequest')} className={TAB_ICON_BTN} onClick={onNew}>
            <svg width="13" height="13" viewBox="0 0 12 12" fill="none" aria-hidden><path d="M6 1.5v9M1.5 6h9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg><span>{i18nText('uiNewRequest')}</span>
          </button>
        )}
      </div>
      <span className="flex-1" />
      {tabs.length > 0 && (
        <div className="relative flex shrink-0 items-center px-1">
          <ToolButton icon="tabs" type="button" aria-label={i18nText('uiOpenTabList')} title={i18nText('uiOpenTabList')} aria-expanded={listOpen} className={TAB_ICON_BTN} onClick={() => setListOpen(v => !v)} />
          {listOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setListOpen(false)} />
              <div role="menu" aria-label={i18nText('uiOpenTab')} className="absolute right-0 top-full z-50 mt-1 max-h-[360px] w-[300px] overflow-y-auto rounded-[var(--radius-md)] border border-border bg-surface p-1 shadow-[var(--shadow-card)]">
                {tabs.map(t => (
                  <button
                    key={t.id}
                    type="button"
                    role="menuitem"
                    className={`flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-ui-md hover:bg-surface-2 ${t.id === activeId ? 'text-foreground' : 'text-muted-foreground'}`}
                    onClick={() => { onSelect(t.id); setListOpen(false) }}
                  >
                    <span className={`w-9 shrink-0 font-mono text-ui-meta font-bold ${methodText(t.method)}`}>{t.method === 'DELETE' ? 'DEL' : t.method}</span>
                    <span className="min-w-0 flex-1 truncate">{t.name}</span>
                    {dirty[t.id] && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-badge-changed-fg" aria-hidden />}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** 집중 모드 토글(⌘\\) — 탭 줄 오른쪽 끝 묶음에 둔다. */
export function FocusToggle({ focusMode, onToggle }: { focusMode: boolean; onToggle: () => void }) {
  return (
    <ToolButton icon={focusMode ? "unfocus" : "focus"}
      type="button"
      title={focusMode ? i18nText('jsxTurnOffFocusModeCtrl') : i18nText('jsxFocusModeCollapseSidePanelCtrl')}
      aria-label={focusMode ? i18nText('jsxTurnOffFocusMode') : i18nText('jsxFocusMode')}
      aria-pressed={focusMode}
      className={`${TAB_ICON_BTN} ${focusMode ? 'text-accent' : ''}`}
      onClick={onToggle}
     />
  )
}
