'use client'
import { useEffect, useState } from 'react'
import { useModifierHint } from '@/lib/useModifierHint'
import { useT, type TranslationKey } from '@/i18n'

export type WorkMode = 'collection' | 'scenario' | 'history' | 'schedule' | 'ws'

// 묶음 제목은 위치(인덱스)가 아니라 항목에 붙인다 — 항목 수가 바뀌어도 제목이 엉뚱한 곳에 붙지 않게.
type RailGroup = 'API 작업' | '실행 분석' | '실시간 연결'

const ITEMS: { mode: WorkMode; label: TranslationKey; group: RailGroup; icon: React.ReactNode }[] = [
  { mode: 'collection', label: 'collectionItems', group: 'API 작업', icon: (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden><path d="M3 5.5a1 1 0 0 1 1-1h3.5l1.5 1.8h7a1 1 0 0 1 1 1v8.2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5.5Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/></svg>
  ) },
  { mode: 'scenario', label: 'scenario', group: 'API 작업', icon: (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden><rect x="2.5" y="7.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4"/><rect x="12.5" y="7.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4"/><path d="M7.5 10h5" stroke="currentColor" strokeWidth="1.4"/></svg>
  ) },
  { mode: 'history', label: 'history', group: '실행 분석', icon: (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden><path d="M3 5h14M3 10h14M3 15h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
  ) },
  { mode: 'schedule', label: 'schedule', group: '실행 분석', icon: (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden><circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.4"/><path d="M10 6v4.2l2.8 1.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
  ) },
  { mode: 'ws', label: 'realtime', group: '실시간 연결', icon: (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden><path d="M2 10h4l2-4 4 8 2-4h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
  ) }
]

/** 항목·이력·실시간 탭. 시나리오와 스케줄은 같은 패널의 접힌 섹션으로 연다. */
export function LeftRail({ mode, onMode, orientation = 'horizontal' }: {
  mode: WorkMode
  onMode: (m: WorkMode) => void
  orientation?: 'horizontal' | 'vertical'
}) {
  const t = useT()
  const hint = useModifierHint()
  const [modKey, setModKey] = useState('⌘')
  useEffect(() => { if (!/Mac|iP(hone|ad|od)/.test(navigator.platform)) setModKey('Ctrl') }, [])
  const horizontal = orientation === 'horizontal'

  return (
    <nav
      className={horizontal
        ? 'relative flex h-9 shrink-0 items-center justify-center gap-1 px-2'
        : 'relative flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border bg-surface py-2'}
      aria-label={t('workModes')}
    >
      {ITEMS.filter(it => it.mode !== 'scenario' && it.mode !== 'schedule').map(it => {
        const i = ITEMS.indexOf(it)
        const active = mode === it.mode || (it.mode === 'collection' && (mode === 'scenario' || mode === 'schedule'))
        return (
          <button
            key={it.mode}
            type="button"
            // 라벨·단축키 표기가 바뀌어도 안 깨지는 테스트 훅.
            data-testid={`rail-${it.mode}`}
            title={`${t(it.label)} (${modKey}${i + 1})`}
            aria-label={`${t(it.label)} (${modKey}${i + 1})`}
            aria-current={active}
            className={`relative flex h-8 items-center justify-center rounded-[var(--radius-sm)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
              horizontal ? 'min-w-0 flex-1 gap-1 text-ui-sm whitespace-nowrap' : 'w-12 flex-col text-ui-meta'
            } ${active
              ? 'bg-surface-2 text-foreground'
              : 'text-faint-foreground hover:bg-surface-2/70 hover:text-muted-foreground'}`}
            onClick={() => onMode(it.mode)}
          >
            {it.icon}<span>{t(it.mode === 'collection' ? 'collection' : it.mode === 'ws' ? 'realtimeShort' : it.label)}</span>
            {active && <span aria-hidden className={horizontal ? 'absolute inset-x-2 -bottom-1 h-0.5 rounded-full bg-accent' : 'absolute inset-y-1.5 -left-1.5 w-0.5 rounded-full bg-accent'} />}
            {hint && (
              <span className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent-solid px-0.5 text-ui-meta font-bold leading-none text-accent-solid-foreground" aria-hidden>
                {i + 1}
              </span>
            )}
          </button>
        )
      })}
      {/* 수식키 홀드 미리보기 — 아이콘만 있으니 무엇이 열릴지 여기서 보여 준다 */}
      {hint && (
        <div className={`animate-rise-in absolute z-40 w-max rounded-[var(--radius-md)] border border-border bg-surface p-1.5 shadow-[var(--shadow-card)] ${horizontal ? 'left-2 top-full mt-1' : 'left-full top-2 ml-1.5'}`}>
          <p className="px-1.5 pb-1 text-ui-meta font-bold uppercase tracking-wide text-faint-foreground">{t('switchViewHint')}</p>
          {ITEMS.map((it, i) => (
            <div key={it.mode} className={`flex items-center gap-2 rounded-[var(--radius-sm)] px-1.5 py-0.5 text-ui-md ${mode === it.mode ? 'bg-accent/15 font-semibold text-accent' : 'text-muted-foreground'}`}>
              <kbd className="w-10 shrink-0 rounded-[var(--radius-sm)] border border-border bg-surface-2 px-1 py-0.5 text-center font-mono text-ui-meta text-faint-foreground">{modKey}{i + 1}</kbd>
              {t(it.label)}
            </div>
          ))}
        </div>
      )}
    </nav>
  )
}
