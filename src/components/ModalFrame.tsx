'use client'
import { t as i18nText } from '@/i18n'
import { ToolButton } from './ToolButton'
import { useFocusTrap } from '@/lib/useFocusTrap'

/**
 * 모달의 껍데기 — 어둡게 깔리는 배경, 가운데 상자, 포커스 가두기, Esc·바깥클릭 닫기.
 *
 * 같은 코드가 화면마다 복사돼 있었다. 그 자체로도 문제지만, 설정을 한 다이얼로그로
 * 모으려니 진짜 문제가 됐다 — 각자 `fixed inset-0` 을 들고 있어 설정 안에 넣으면
 * 배경이 두 겹으로 깔리고 포커스 가두기가 서로 싸운다.
 *
 * embedded 로 열면 껍데기 없이 내용만 낸다. 그러면 같은 컴포넌트를 혼자 띄울 수도,
 * 설정의 한 칸으로 넣을 수도 있다.
 */
export function ModalFrame({ embedded = false, label, width = 'w-[min(960px,94vw)]', onClose, children }: {
  embedded?: boolean
  label: string
  /** 단독으로 뜰 때의 폭. embedded 면 무시된다(설정 다이얼로그가 정한다). */
  width?: string
  onClose: () => void
  children: React.ReactNode
}) {
  // embedded 면 가두지 않는다 — 바깥(설정 다이얼로그)이 이미 가두고 있고,
  // 둘이 겹치면 Tab 이 어느 쪽에 갇힐지 알 수 없게 된다.
  const trapRef = useFocusTrap<HTMLDivElement>(!embedded, onClose)

  if (embedded) return <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>

  return (
    <div
      className="animate-overlay-in fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`animate-dialog-in flex max-h-[85vh] ${width} flex-col overflow-hidden rounded-[var(--radius-lg)] border border-border/60 bg-surface shadow-[var(--shadow-card)]`}
        onClick={e => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}

/**
 * 모달 머리줄. 제목과 그 줄에 붙는 조작(환경 고르기 등)을 담고, 닫기는 오른쪽 끝.
 * embedded 면 닫기 버튼을 내지 않는다 — 설정 다이얼로그의 닫기가 이미 있고,
 * 두 개가 나란히 있으면 어느 것이 무엇을 닫는지 알 수 없다.
 */
export function ModalHeader({ title, embedded = false, onClose, children }: {
  title: string
  embedded?: boolean
  onClose?: () => void
  children?: React.ReactNode
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border/70 px-4 py-3">
      <h2 className="text-ui-lg font-bold text-foreground">{title}</h2>
      {children}
      {!embedded && onClose && (
        <ToolButton icon="close"
          type="button"
          aria-label={i18nText('uiClose')}
          className="ah-action ml-auto flex h-6 w-auto px-1.5 items-center justify-center rounded-[var(--radius-sm)] text-faint-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          onClick={onClose}
         />
      )}
    </div>
  )
}
