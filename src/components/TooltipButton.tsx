'use client'
import { useEffect, useId, useLayoutEffect, useRef, useState, type ComponentPropsWithRef } from 'react'
import { createPortal } from 'react-dom'

/** 즉시 표시되는 공통 버튼 툴팁. 포털을 써서 탭·트리의 overflow에도 잘리지 않는다. */
export function TooltipButton({ title, children, onMouseEnter, onMouseLeave, onFocus, onBlur, onClick, ...props }: ComponentPropsWithRef<'button'>) {
  const id = useId()
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const tooltip = useRef<HTMLDivElement>(null)
  const label = props['aria-label'] ?? title
  const hide = () => setAnchor(null)
  const show = (button: HTMLButtonElement) => {
    window.dispatchEvent(new CustomEvent('postq:tooltip', { detail: id }))
    setAnchor(button)
  }

  useEffect(() => {
    if (!anchor) return
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setAnchor(null) }
    const close = () => setAnchor(null)
    const other = (event: Event) => { if ((event as CustomEvent<string>).detail !== id) close() }
    window.addEventListener('postq:tooltip', other)
    window.addEventListener('keydown', key)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('postq:tooltip', other)
      window.removeEventListener('keydown', key)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [anchor, id])

  useLayoutEffect(() => {
    if (!anchor || !tooltip.current) return
    const rect = anchor.getBoundingClientRect()
    const tip = tooltip.current
    const left = Math.max(8, Math.min(rect.left + rect.width / 2 - tip.offsetWidth / 2, window.innerWidth - tip.offsetWidth - 8))
    const top = rect.bottom + tip.offsetHeight + 14 <= window.innerHeight ? rect.bottom + 6 : Math.max(8, rect.top - tip.offsetHeight - 6)
    tip.style.left = `${left}px`
    tip.style.top = `${top}px`
  }, [anchor, label])

  return <>
    <button {...props}
      aria-describedby={[props['aria-describedby'], anchor && label ? id : undefined].filter(Boolean).join(' ') || undefined}
      onMouseEnter={event => { show(event.currentTarget); onMouseEnter?.(event) }}
      onMouseLeave={event => { if (!event.currentTarget.matches(':focus-visible')) hide(); onMouseLeave?.(event) }}
      onFocus={event => { show(event.currentTarget); onFocus?.(event) }}
      onBlur={event => { hide(); onBlur?.(event) }}
      onClick={event => { hide(); onClick?.(event) }}
    >{children}</button>
    {anchor && label && createPortal(<div ref={tooltip} id={id} role="tooltip"
      className="pointer-events-none fixed z-[10000] max-w-[min(360px,calc(100vw-16px))] break-words rounded-[var(--radius-sm)] border border-border bg-surface px-2 py-1 text-ui-sm text-foreground shadow-[var(--shadow-card)]"
    ><span>{label}</span>{title && title !== label && <span className="mt-1 block text-faint-foreground">{title}</span>}</div>, document.body)}
  </>
}
