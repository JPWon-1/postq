'use client'
import { t as i18nText } from '@/i18n'
import { ToolButton, type ToolIconName } from './ToolButton'
import { useEffect, useRef, useState, type ComponentProps } from 'react'
import { copyText } from '@/lib/clipboard'

/**
 * 값 하나를 복사하는 작은 버튼.
 *
 * 주소·경로처럼 "눈으로 읽고 끝나는 게 아니라 다른 데 붙여넣어야 하는" 값 옆에 둔다.
 * 화면에 보이는데 선택이 안 되거나(truncate·title 로만 표시) 드래그가 번거로운 곳이 많아
 * 매번 개발자도구를 열게 됐다.
 *
 * 복사 후 잠깐 '복사됨' 으로 바뀐다 — 눌렸는지 모르면 두 번 세 번 누르게 된다.
 */
export function CopyButton({ value, label = '복사', title, className = '', compact = false }: {
  value: string
  compact?: boolean
  label?: string
  title?: string
  className?: string
}) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle')
  const generation = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    generation.current++; setState('idle')
    return () => { generation.current++; if (timer.current) clearTimeout(timer.current) }
  }, [value])

  return (
    <>
    <CopyControl compact={compact} icon={state === 'done' ? 'check' : state === 'failed' ? 'alert' : 'copy'}
      type="button"
      data-testid="copy-button"
      title={title ?? `복사: ${value}`}
      aria-label={title ?? label}
      className={`shrink-0 rounded-[var(--radius-sm)] border border-border px-1.5 py-0.5 text-ui-meta font-medium transition-colors ${
        state === 'done' ? 'border-badge-new-fg/50 text-badge-new-fg'
          : state === 'failed' ? 'border-method-delete/50 text-method-delete'
          : 'text-muted-foreground hover:border-accent hover:text-accent'
      } ${className}`}
      onClick={async e => {
        // 행 클릭(선택·펼치기)과 겹치는 자리에 놓이는 경우가 많다 — 전파를 끊는다.
        e.stopPropagation()
        e.preventDefault()
        // 예전엔 실패를 조용히 삼켰다. 눌러도 아무 일이 없으면 사람은 자기 손을 의심하고
        // 두 번 세 번 누른다 — 안 됐다고 말해 주는 편이 낫다.
        const seq = ++generation.current
        if (timer.current) clearTimeout(timer.current)
        let ok = false
        try { ok = await copyText(value) } catch { ok = false }
        if (seq !== generation.current) return
        setState(ok ? 'done' : 'failed')
        timer.current = setTimeout(() => { if (seq === generation.current) setState('idle') }, ok ? 1200 : 2500)
      }}
    >
      {!compact && (state === 'done' ? i18nText('jsxCopied') : state === 'failed' ? i18nText('jsxCopyFailed') : label)}
    </CopyControl>
    <span className="sr-only" role="status">{state === 'done' ? i18nText('jsxCopiedToClipboard') : state === 'failed' ? i18nText('jsxCopyFailedClickAgainToTry') : ''}</span>
    </>
  )
}

function CopyControl({ compact, icon, ...props }: ComponentProps<'button'> & { compact: boolean; icon: ToolIconName; 'aria-label': string }) {
  return compact ? <ToolButton icon={icon} {...props} /> : <button {...props} />
}
