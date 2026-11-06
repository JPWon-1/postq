'use client'
import type { ReactNode } from 'react'

/**
 * 좁은 칸에 들어간 긴 값을, 마우스를 올리면 통째로 보여준다.
 *
 * 표 한 칸에 URL 을 넣으면 절반이 잘린다. 입력칸이라 스크롤은 되지만 그건 커서를
 * 끝까지 끌고 가야 보이는 것이고, 눈으로 한 번에 확인할 방법이 없다.
 * baseUrl 처럼 뒤쪽이 스테이지/운영을 가르는 값에서 특히 곤란하다.
 *
 * 편집 중에는 안 띄운다 — 지금 치고 있는 자리를 카드가 덮으면 그게 더 나쁘다.
 *
 * 클릭도 먹지 않는다(pointer-events:none). 처음엔 값을 끌어 복사하라고 살려 뒀는데,
 * 그러면 카드가 덮은 자리를 누를 수 없다 — 표에서는 바로 아래 줄이 그 자리다.
 * 값은 입력칸 자체에서 선택해 복사할 수 있으니 카드는 보여주기만 한다.
 */
export function ValueHover({ value, secret = false, minLength = 22, children }: {
  value: string
  /** 시크릿은 화면에 안 띄운다 — 잘려 보이는 게 문제가 아니라 안 보이는 게 정상이다 */
  secret?: boolean
  /** 이 길이 미만이면 카드를 안 띄운다 — 짧은 값에 카드가 뜨면 성가시기만 하다 */
  minLength?: number
  children: ReactNode
}) {
  const show = !secret && value.length >= minLength
  return (
    <span className="group/val relative block">
      {children}
      {show && (
        <span
          role="tooltip"
          className="pointer-events-none absolute left-0 top-full z-50 mt-0.5 hidden w-max max-w-lg break-all rounded-[var(--radius-md)] border border-border bg-surface px-2 py-1.5 font-mono text-ui-sm leading-relaxed text-foreground shadow-[var(--shadow-card)] group-hover/val:block group-focus-within/val:!hidden"
        >
          {value}
        </span>
      )}
    </span>
  )
}
