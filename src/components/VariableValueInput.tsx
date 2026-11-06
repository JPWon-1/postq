'use client'
import { t as i18nText } from '@/i18n'
import { useLayoutEffect, useRef, useState, type TextareaHTMLAttributes } from 'react'

/** Long values stay fully visible, including when the containing panel is resized. */
export function VariableValueInput({ secret = false, initialRevealed = false, inlineReveal = false, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { secret?: boolean; initialRevealed?: boolean; inlineReveal?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [revealed, setRevealed] = useState(initialRevealed)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const resize = () => { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` }
    resize()
    let width = el.clientWidth
    const observer = new ResizeObserver(() => { if (width !== el.clientWidth) { width = el.clientWidth; resize() } })
    observer.observe(el)
    return () => observer.disconnect()
  }, [props.value, revealed])
  return <div className={`min-w-0 flex-1 ${inlineReveal ? 'flex items-center gap-1' : ''}`}>
    <textarea {...props} ref={ref} rows={1} spellCheck={false}
      className={`${inlineReveal ? 'min-w-0 flex-1' : 'w-full min-w-0'} resize-none overflow-hidden whitespace-pre-wrap break-all ${props.className ?? 'ah-input font-mono'}`}
      style={{ ...props.style, overflowWrap: 'anywhere', ...(secret && !revealed ? { WebkitTextSecurity: 'disc' } : {}) }} />
    {secret && <button type="button" className={`ah-action ${inlineReveal ? 'shrink-0' : ''}`} aria-pressed={revealed} onClick={() => setRevealed(v => !v)}>{revealed ? i18nText('jsxHide2') : i18nText('jsxView2')}</button>}
  </div>
}
