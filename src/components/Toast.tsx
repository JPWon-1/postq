'use client'
import { ToolButton } from './ToolButton'
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { copyText } from '@/lib/clipboard'
import { useT } from '@/i18n'

type Toast = { id: number; kind: 'success' | 'error' | 'info'; message: string }

const ToastContext = createContext<(kind: Toast['kind'], message: string) => void>(() => {})

export function useToast() {
  return useContext(ToastContext)
}

const KIND_STYLE: Record<Toast['kind'], string> = {
  success: 'border-badge-new-fg/40 text-badge-new-fg',
  error: 'border-method-delete/40 text-method-delete',
  info: 'border-border-strong text-foreground',
}

const AUTO_DISMISS_MS = 4000

// error 는 조치가 필요한 경우가 많아(예: 낙관적 잠금 충돌) 자동 소멸하지 않고 수동 닫기.
// success/info 는 4초 후 자동 소멸하되, 마우스를 올리면 정지(읽을 시간 확보).
function ToastItem({ toast, onClose }: { toast: Toast; onClose: (id: number) => void }) {
  const t = useT()
  const [paused, setPaused] = useState(false)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (toast.kind === 'error' || paused) return
    const timer = setTimeout(() => onClose(toast.id), AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [toast.kind, toast.id, paused, onClose])

  return (
    <div
      role="status"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className={`animate-rise-in pointer-events-auto flex w-fit max-w-full items-center gap-2 rounded-[var(--radius-md)] border bg-surface px-3.5 py-2 text-ui-lg font-medium shadow-[var(--shadow-card)] ${KIND_STYLE[toast.kind]}`}
    >
      <span aria-hidden className="font-bold">
        {toast.kind === 'success' ? '✓' : toast.kind === 'error' ? '✗' : 'ℹ'}
      </span>
      <span className="break-all text-foreground">{toast.message}</span>
      {/*
        에러는 어디서 나든 그대로 AI 에 넘길 수 있어야 한다.
        토스트는 손에 안 잡히는 표면이라 — 읽고 닫으면 문구가 사라진다 — 지금까지는
        실패 사유를 다시 보려면 같은 동작을 반복해야 했다. 하단 콘솔에는 이미 붙어 있던
        기능인데, 정작 사람이 가장 많이 마주치는 에러 표면에만 빠져 있었다.
      */}
      {toast.kind === 'error' && (
        <button
          type="button"
          title={t('toastCopyError')}
          className="-my-0.5 shrink-0 rounded-[var(--radius-sm)] border border-border px-1.5 py-0.5 text-ui-meta font-medium text-muted-foreground transition-colors hover:border-accent hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          onClick={async () => {
            const prompt = [
              t('toastPrompt'),
              '',
              `${t('errorLabel')}: ${toast.message}`,
              `${t('screenLabel')}: ${location.pathname}${location.search}`,
            ].join('\n')
            try {
              await copyText(prompt)
              setCopied(true)
              setTimeout(() => setCopied(false), 1200)
            } catch { /* 클립보드 권한 없음 — 문구는 화면에 그대로 남아 있다 */ }
          }}
        >
          {copied ? t('toastCopied') : t('toastCopy')}
        </button>
      )}
      <ToolButton icon="close"
        type="button"
        aria-label={t('toastClose')}
        className="ah-action -mr-1 ml-1 flex h-6 w-auto px-1.5 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-faint-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        onClick={() => onClose(toast.id)}
       />
    </div>
  )
}

/**
 * Provider 바깥(그걸 렌더하는 page.tsx 자신)에서 띄울 때 쓴다. 요청 열기 실패처럼 page 가 직접 하는
 * 일은 useToast 를 못 써서 실패를 조용히 삼켰다. Provider 가 떠 있지 않으면 아무 일도 하지 않는다.
 */
let pushOutside: ((kind: Toast['kind'], message: string) => void) | null = null
export function toastOutside(kind: Toast['kind'], message: string) { pushOutside?.(kind, message) }

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)

  const remove = useCallback((id: number) => setToasts(ts => ts.filter(t => t.id !== id)), [])
  /** 한 번에 띄울 수 있는 최대 개수. error 는 자동으로 안 사라지므로 상한이 없으면 화면을 덮는다. */
  const MAX_TOASTS = 5

  const push = useCallback((kind: Toast['kind'], message: string) => {
    setToasts(ts => {
      // 같은 말이 연달아 나면 쌓지 않고 하나를 새로 띄운다.
      // 일괄 작업이 20건 실패하면 같은 문구가 20장 겹쳐 쌓였고, error 는 자동으로 안 사라지니
      // 스무 번을 손으로 닫아야 했다 — 그 사이 화면은 아무것도 못 쓴다.
      const rest = ts.filter(t => !(t.kind === kind && t.message === message))
      const next = [...rest, { id: nextId.current++, kind, message }]
      // 그래도 넘치면 오래된 것부터 버린다. 화면 크기는 유한하고, 서버 오류는 [콘솔]에도 남는다.
      return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next
    })
  }, [])

  useEffect(() => { pushOutside = push; return () => { if (pushOutside === push) pushOutside = null } }, [push])

  return (
    <ToastContext.Provider value={push}>
      {children}
      {/* 살아있는 영역(aria-live)은 메시지보다 먼저 DOM 에 있어야 한다.
          토스트 자체에 role="status" 만 있었는데, 그건 알릴 내용과 알릴 자리가 동시에
          생기는 모양이라 스크린리더가 놓치는 경우가 있다 — 이 앱은 저장·실패·복사를
          전부 토스트로만 알리므로, 놓치면 아무 피드백이 없는 것과 같다.
          컨테이너는 늘 떠 있으니 여기에 둔다. polite: 하던 일을 끊지 않고 이어서 읽는다. */}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed bottom-4 left-1/2 z-[100] flex w-full max-w-md -translate-x-1/2 flex-col items-center gap-2 px-4"
      >
        {toasts.map(t => <ToastItem key={t.id} toast={t} onClose={remove} />)}
      </div>
    </ToastContext.Provider>
  )
}
