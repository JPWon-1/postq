'use client'
import { ToolButton } from './ToolButton'
import { useEffect, useState } from 'react'
import { setThemePref } from '@/lib/theme'
import { useT } from '@/i18n'

/**
 * 맨 위 앱 바 — 얇게(40px), 셋으로 나눈다.
 *
 *   왼쪽   제품명 + 프로젝트(워크스페이스) 고르기
 *   가운데 넓은 검색(⌘K) — 요청·명령을 한 칸에서 찾는다
 *   오른쪽: 현재 테마 아이콘 · 설정
 *
 * 화면 이동(컬렉션·시나리오·이력…)은 여기 두지 않는다 — 그건 왼쪽 사이드바 머리의 아이콘 탭이다.
 * 설정 버튼(톱니)은 예전 레일 맨 아래에 있던 것을 그대로 옮겼다(data-testid 도 그대로).
 */
export function AppHeader({ workspaceSlot, onOpenSearch, onOpenSettings, canBack = false, canForward = false }: {
  canBack?: boolean; canForward?: boolean
  workspaceSlot?: React.ReactNode
  /** 요청·명령 검색(⌘K). 단축키로만 열려서 처음 쓰는 사람은 있는 줄 몰랐다. */
  onOpenSearch?: () => void
  onOpenSettings?: () => void
}) {
  const t = useT()
  return (
    <header className="flex h-10 shrink-0 items-center gap-3 border-b border-border bg-surface px-3">
      <div className="flex min-w-0 flex-1 basis-0 items-center gap-2 lg:flex-[1_0_360px]">
        <span className="shrink-0 pr-1 font-display text-[13px] font-semibold leading-none tracking-[-0.02em] text-foreground">postq</span>
        <ToolButton icon="back" disabled={!canBack} aria-label={t('back')} onClick={() => window.history.back()} />
        <ToolButton icon="forward" disabled={!canForward} aria-label={t('forward')} onClick={() => window.history.forward()} />
        <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
        <div className="min-w-0">{workspaceSlot}</div>
      </div>

      {onOpenSearch ? (
        <button
          type="button"
          onClick={onOpenSearch}
          aria-label={`${t('searchCommand')} (⌘K)`}
          className="flex h-7 min-w-[140px] flex-[0_1_560px] items-center gap-2 rounded-[var(--radius-sm)] border border-border bg-background px-2.5 text-ui-md text-faint-foreground transition-colors hover:border-border-strong hover:text-muted-foreground"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0"><circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" /><path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          <span className="flex-1 truncate text-center">{t('searchCommand')}</span>
          <kbd className="shrink-0 rounded-[4px] border border-border px-1 font-mono text-ui-meta">⌘K</kbd>
        </button>
      ) : <span />}

      <div className="flex flex-1 basis-0 items-center justify-end gap-0.5 lg:flex-[1_0_360px]">
        <ThemeCycle />
        {onOpenSettings && (
          <ToolButton icon="settings" data-testid="rail-settings" aria-label={t('settings')} onClick={onOpenSettings} />
        )}
      </div>
    </header>
  )
}

/** 시스템 선택은 설정에 두고, 여기서는 실제 화면의 밝기를 바로 전환한다. */
function ThemeCycle() {
  const t = useT()
  const [effective, setEffective] = useState<'dark' | 'light'>('light')
  useEffect(() => {
    const sync = () => setEffective(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  const next = effective === 'dark' ? 'light' : 'dark'
  return <ToolButton icon={effective === 'dark' ? 'moon' : 'sun'} aria-label={t('changeTheme')} onClick={() => setThemePref(next)} />
}
