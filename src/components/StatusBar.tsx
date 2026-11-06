'use client'
import { t as i18nText } from '@/i18n'
import { ToolButton } from './ToolButton'
import { useEffect, useState } from 'react'

/**
 * 하단 상태바 — 얇은 한 줄(24px). Postman 처럼 셋으로 나눈다.
 *
 *   왼쪽   사이드바 토글 · 콘솔
 *   가운데 지금 할 일 힌트(예: '✦ 요청 보내기 ⌘↩')
 *   오른쪽 연결 상태 · DB 파일 · 전역 변수 · 쿠키 · 단축키 · 오른쪽 패널 토글
 *
 * 표시하는 값은 전부 실제 상태다: 연결은 /api/health(DB 계층까지 확인)를 30초 폴링한 결과.
 * "항상 Connected" 같은 장식은 두지 않는다 — 상태바가 거짓말하면 아무도 안 본다.
 * (지금 화면·프로젝트·환경 이름은 사이드바 탭·앱 바·탭 줄에 이미 보여서 여기서 뺐다)
 */
export function StatusBar({ hint, sidebarOpen, onToggleSidebar, onOpenShortcuts, onToggleConsole, consoleOpen, onOpenGlobals, onOpenCookies, rightOpen, onToggleRight }: {
  hint?: React.ReactNode
  sidebarOpen?: boolean
  onToggleSidebar?: () => void
  onOpenShortcuts?: () => void
  onToggleConsole?: () => void
  consoleOpen?: boolean
  onOpenGlobals?: () => void
  onOpenCookies?: () => void
  rightOpen?: boolean
  /** 오른쪽 패널을 쓸 수 있는 화면에서만 준다 */
  onToggleRight?: () => void
}) {
  const [health, setHealth] = useState<'checking' | 'ok' | 'down'>('checking')
  const [latency, setLatency] = useState<number | null>(null)
  const [dbFile, setDbFile] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    // 앞 확인이 안 끝났으면 또 보내지 않는다 — 서버가 느릴 때 30초마다 요청이 겹겹이 쌓였다(codex 점검).
    // 창이 가려져 있으면 건너뛴다. 끝나지 않는 요청은 10초에 끊는다.
    let inFlight = false
    const ping = async () => {
      if (inFlight || document.hidden) return
      inFlight = true
      const t0 = performance.now()
      try {
        const res = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(10_000) })
        if (!alive) return
        setHealth(res.ok ? 'ok' : 'down')
        setLatency(Math.round(performance.now() - t0))
        // 어느 DB 를 보고 있는지. 못 읽으면 그냥 표시를 안 한다 —
        // 표시가 없는 것과 '틀린 표시' 는 다르다.
        const body = await res.json().catch(() => null) as { db?: string } | null
        if (alive && body?.db) setDbFile(body.db)
      } catch {
        if (alive) { setHealth('down'); setLatency(null) }
      } finally { inFlight = false }
    }
    ping()
    const t = setInterval(ping, 30_000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  const dot = health === 'ok' ? 'bg-badge-new-fg' : health === 'down' ? 'bg-method-delete' : 'bg-faint-foreground'
  const label = health === 'ok' ? i18nText('connected') : health === 'down' ? i18nText('serverUnavailable') : i18nText('checking')

  return (
    <footer className="ah-statusbar" aria-label={i18nText('uiStatusBar')}>
      {onToggleSidebar && (
        <ToolButton icon="panelLeft"
          type="button"
          data-testid="toggle-rail"
          className="ah-status-seg"
          title={sidebarOpen ? i18nText('jsxHideSidebarE') : i18nText('jsxShowSidebarE')}
          aria-label={sidebarOpen ? i18nText('jsxHideTheSidebar') : i18nText('jsxShowSidebar')}
          aria-pressed={!!sidebarOpen}
          onClick={onToggleSidebar}
        >

        </ToolButton>
      )}
      {onToggleConsole && (
        <ToolButton icon="terminal" aria-label={i18nText('uiConsole')} aria-pressed={!!consoleOpen} onClick={onToggleConsole} />
      )}

      <span className="flex min-w-0 flex-1 items-center justify-center truncate px-3 text-faint-foreground">{hint}</span>

      <Seg
        title={health === 'ok' ? i18nText('dynamicApiHealthResponseMsCheckEvery30Seconds', { v0: String(latency) }) : i18nText('jsxCheckApiHealthEvery30Seconds')}
        tone={health === 'down' ? 'error' : undefined}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} aria-hidden />
        {label}
        {health === 'ok' && latency != null && <span className="font-mono text-faint-foreground">{latency}ms</span>}
      </Seg>
      {/* 어느 DB 를 보고 있는지. 서버를 DB_PATH 없이 띄우면 조용히 다른 파일로 떨어져
          '프로젝트가 사라졌다' 로 보인다 — 그때 여기만 보면 바로 안다. */}
      {dbFile && (
        <Seg title={i18nText('uiDBFileThisScreenIsReadingIfDifferentRelaunch')}>
          <span className="font-mono">{dbFile}</span>
        </Seg>
      )}
      {onOpenGlobals && <ToolButton icon="variables" aria-label={i18nText('uiGlobalVariable')} onClick={onOpenGlobals} />}
      {onOpenCookies && <ToolButton icon="cookie" aria-label={i18nText('uiCookies')} onClick={onOpenCookies} />}
      <ToolButton icon="keyboard" aria-label={i18nText('uiViewShortcutKeys')} onClick={onOpenShortcuts} />
      {onToggleRight && (
        <ToolButton icon="panelRight"
          type="button"
          data-testid="toggle-right-panel"
          className={`ah-status-seg ${rightOpen ? 'text-foreground' : ''}`}
          title={rightOpen ? i18nText('jsxCollapseRightPanel') : i18nText('jsxExpandRightPanelCodeVariables')}
          aria-label={rightOpen ? i18nText('jsxCollapseRightPanel') : i18nText('jsxExpandRightPanel')}
          aria-pressed={!!rightOpen}
          onClick={onToggleRight}
        >

        </ToolButton>
      )}
    </footer>
  )
}

/** 상태바 한 칸 — onClick 이 있으면 버튼으로 렌더해서 키보드로도 닿게 한다. */
function Seg({ children, title, onClick, tone, active }: {
  children: React.ReactNode
  title: string
  onClick?: () => void
  tone?: 'error' | 'muted'
  active?: boolean
}) {
  const cls = `ah-status-seg ${tone === 'error' ? 'text-method-delete' : tone === 'muted' ? 'text-faint-foreground' : ''} ${active ? 'bg-accent/15 text-accent' : ''}`
  if (onClick) {
    return <button type="button" className={cls} title={title} onClick={onClick}>{children}</button>
  }
  return <span className={cls} title={title}>{children}</span>
}
