'use client'
import { ToolButton } from './ToolButton'
import { useEffect, useRef, useState } from 'react'

/**
 * 트리 행의 넘침 메뉴(⋯).
 *
 * 폴더 행에 라벨 없는 아이콘 6개가 붙어 있었다. 304px 짜리 행에서 172px — 절반 이상을
 * 덮어 폴더 이름이 그만큼 잘렸고, 아이콘만으로는 열쇠가 인증인지 비밀번호인지 알 수 없어
 * 결국 하나씩 눌러 보게 된다. 자주 쓰는 둘(요청 추가·동기화)만 남기고 나머지는 여기로
 * 넣는다 — 글자로 적히니 눌러 보지 않아도 안다.
 *
 * 삭제처럼 되돌릴 수 없는 것은 confirm 을 받는다. 메뉴는 한 번 클릭으로 실행되는 자리라
 * 트리의 '두 번 눌러 삭제' 처럼 손이 미끄러질 여지를 두면 안 된다.
 */
export type RowMenuItem = {
  label: string
  hint?: string
  danger?: boolean
  /** 누르면 확인 문구를 한 번 띄운다. 되돌릴 수 없는 것에만. */
  confirm?: string
  disabled?: boolean
  onClick: () => void
}

export function RowMenu({ label, items, className = '', compact = false }: {
  label: string
  items: RowMenuItem[]
  className?: string
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey) }
  }, [open])

  return (
    <div ref={ref} className={`relative flex ${className}`}>
      <ToolButton icon="more"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        className="flex h-6 px-1 text-ui-sm items-center justify-center rounded-[var(--radius-sm)] text-faint-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        // 클릭으로 열 때 포커스를 직접 준다. macOS 계열 웹뷰는 버튼 클릭에 포커스를
        // 주지 않아 focus-within 이 안 걸리고, Esc·Tab 도 메뉴를 떠난 자리에서 눌리게 된다.
        onClick={e => { e.stopPropagation(); e.currentTarget.focus(); setOpen(o => !o) }}
       />

      {open && (
        <div
          role="menu"
          // 트리는 세로로 스크롤되는 좁은 패널이라 아래로 열면 마지막 폴더에서 잘린다.
          // 오른쪽 위 기준으로 붙이고, 넘치면 패널이 스크롤되게 둔다.
          className="absolute right-0 top-full z-50 mt-1 w-48 rounded-[var(--radius-md)] border border-border bg-surface py-1 text-left shadow-[var(--shadow-card)]"
          onClick={e => e.stopPropagation()}
        >
          {items.map(it => (
            <MenuRow key={it.label} item={it} onDone={() => setOpen(false)} />
          ))}
        </div>
      )}
    </div>
  )
}

function MenuRow({ item, onDone }: { item: RowMenuItem; onDone: () => void }) {
  const [armed, setArmed] = useState(false)
  const armedLabel = item.confirm ?? '한 번 더 누르면 실행됩니다'
  return (
    <button
      type="button"
      role="menuitem"
      disabled={item.disabled}
      className={`flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left transition-colors hover:bg-surface-2 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
        armed ? 'bg-method-delete/10' : ''
      }`}
      onClick={() => {
        if (item.confirm && !armed) { setArmed(true); return }
        onDone(); item.onClick()
      }}
    >
      <span className={`text-ui-md font-medium ${armed || item.danger ? 'text-method-delete' : 'text-foreground'}`}>
        {armed ? armedLabel : item.label}
      </span>
      {!armed && item.hint && <span className="text-ui-meta leading-tight text-faint-foreground">{item.hint}</span>}
    </button>
  )
}
