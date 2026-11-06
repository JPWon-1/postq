'use client'
import { t as i18nText } from '@/i18n'
import { ToolButton } from './ToolButton'

/**
 * 즐겨찾기 토글 별.
 *
 * 켜지면 항상 보이고(그게 표시다), 꺼져 있으면 hover/포커스에서만 나타난다 —
 * 목록마다 회색 별이 줄줄이 서 있으면 그것 자체가 소음이다.
 * 행 안에 놓이는 경우가 많아 클릭 전파를 끊는다(행이 열리거나 선택되면 안 된다).
 */
export function FavoriteStar({ on, onToggle, label, className = '' }: {
  on: boolean
  onToggle: () => void
  /** 무엇에 대한 즐겨찾기인지 — 스크린리더가 별 여러 개를 구분할 수 있어야 한다 */
  label: string
  className?: string
}) {
  return (
    <ToolButton icon="star" filled={on}
      type="button"
      aria-pressed={on}
      aria-label={i18nText('dynamicFavorites', { v0: String(label), v1: String(on ? i18nText('jsxOff') : i18nText('jsxAdd')) })}
      title={on ? i18nText('jsxUnfavorite') : i18nText('jsxFavoritesTopOfList')}
      className={`shrink-0 rounded-[var(--radius-sm)] px-0.5 text-ui-sm leading-none transition-opacity ${
        on ? 'text-badge-changed-fg' : 'text-faint-foreground hover:text-foreground'
      } ${className}`}
      onClick={e => { e.stopPropagation(); e.preventDefault(); onToggle() }}
     />
  )
}
