'use client'
import { t as i18nText } from '@/i18n'

/**
 * "못 불러왔다" 를 "없다" 와 갈라 보여준다.
 *
 * 목록을 부르는 코드가 대부분 `catch { setRows([]) }` 였다. 그러면 네트워크가 끊겨도
 * 화면은 '아직 없습니다 — 추가해 보세요' 라고 말한다. 사용자는 원래 비어 있는 줄 알고
 * 넘어가거나, 있는 걸 다시 만들어 중복을 쌓는다.
 * (추적의 서버 로그가 정확히 이 모양으로 몇 달을 죽어 있었다)
 *
 * 빈 것과 못 부른 것은 다른 화면을 보여줘야 한다 — 하나는 안내, 하나는 고장이다.
 */
export function LoadFailed({ what, detail, onRetry }: {
  /** 무엇을 못 불러왔는지 — '스케줄', '쿠키' 처럼 사용자가 아는 말로 */
  what: string
  detail?: string | null
  onRetry?: () => void
}) {
  return (
    <div
      role="status"
      className="mx-1 my-2 flex flex-wrap items-start gap-2 rounded-[var(--radius-sm)] border border-method-delete/30 bg-method-delete/5 px-3 py-2"
    >
      <span aria-hidden className="shrink-0 pt-px font-bold text-method-delete">✗</span>
      <div className="min-w-0 flex-1 text-ui-sm leading-relaxed text-muted-foreground">
        <p className="font-medium text-method-delete">{what} {i18nText('uiLookupFailed')}</p>
        {detail && <details className="mt-1">
          <summary className="cursor-pointer select-none text-ui-meta">{i18nText('uiViewErrorDetails')}</summary>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-ui-meta [overflow-wrap:anywhere]">{detail}</pre>
        </details>}
      </div>
      {onRetry && (
        <button
          type="button"
          className="shrink-0 rounded-[var(--radius-sm)] border border-method-delete/40 px-2 py-0.5 text-ui-sm font-medium text-method-delete transition-colors hover:bg-method-delete/10"
          onClick={onRetry}
        >
          {i18nText('uiTryAgain')}
        </button>
      )}
    </div>
  )
}
