'use client'
import type { ReactNode } from 'react'

/** 한 패널 안에서 독립적으로 펼치는 작업 목록. 내용은 닫아도 보존한다. */
export function SidebarSection({ name, open, onToggle, children, testId, shortcut, active }: {
  name: string; open: boolean; onToggle: () => void; children: ReactNode; testId?: string; shortcut?: string; active?: boolean
}) {
  return <section className="min-h-0 shrink-0 border-t border-border" aria-label={name}>
    <button type="button" data-testid={testId} aria-expanded={open} aria-current={active} title={shortcut ? `${name} (${shortcut})` : name}
      className="flex h-7 w-full items-center gap-2 px-3 text-left ah-sidebar-heading text-muted-foreground hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      onClick={onToggle}>
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}><path d="m3.5 2 3 3-3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>{name}
    </button>
    <div className={open ? 'max-h-[32vh] overflow-y-auto text-ui-md' : 'hidden'}>{children}</div>
  </section>
}
