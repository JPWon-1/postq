'use client'
import { useEffect, useRef } from 'react'

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])', 'summary', '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * 열린 트랩의 쌓임 순서. 맨 뒤가 맨 위 모달이다.
 * 포커스가 모달 밖(body)에 있을 때 오는 Esc 를 누가 받을지 정하는 데 쓴다.
 */
const openTraps: HTMLElement[] = []

/**
 * 모달용 focus trap — Tab/Shift+Tab 순환을 컨테이너에 가두고(배경 요청 패널로 새지 않게),
 * 열릴 때 모달 내부로 초기 포커스를 옮기며(ARIA dialog 표준), 닫힐 때 직전 포커스로 복귀시킨다.
 * onEscape 를 주면 컨테이너 안 어디에 포커스가 있어도 Esc 로 닫고, 전파를 막아(하위 모달 동시 닫힘 방지)
 * 스택 최상위 모달만 소비하게 한다. ref 를 모달 루트 요소에 붙인다.
 * active 가 false 이면 아무것도 하지 않는다(항상 렌더되는 모달은 open 을 넘긴다).
 *
 * 안쪽에서 Esc 를 먼저 쓰고 싶을 때(검색어 지우기, 인라인 입력 취소 등):
 * 그 요소에 `onKeyDownCapture` 로 받아 `e.preventDefault()` 를 부르면 이 트랩은 그 Esc 를 넘긴다.
 * React 의 보통 `onKeyDown` 은 앱 루트에 위임돼 이 컨테이너 리스너보다 '늦게' 돌기 때문에
 * bubble 로는 표시할 기회 자체가 없다 — 반드시 capture 여야 한다.
 */
export function useFocusTrap<T extends HTMLElement>(active: boolean, onEscape?: () => void) {
  const ref = useRef<T>(null)
  // onEscape 는 매 렌더 새 클로저일 수 있어 ref 로 최신화 — deps 를 [active] 로 고정해
  // 재실행 시 prevFocused 재캡처(복원 오작동)를 막는다.
  const escRef = useRef(onEscape)
  escRef.current = onEscape
  useEffect(() => {
    if (!active) return
    const container = ref.current
    if (!container) return
    const prevFocused = document.activeElement as HTMLElement | null
    // fieldset으로 비활성화된 입력과 접힌 details 내부는 실제 탭 순서에서 제외한다.
    const focusableNodes = () => Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter(el => !el.matches(':disabled') && el.checkVisibility({ visibilityProperty: true }))
    // 초기 포커스: 아직 포커스가 모달 밖(트리거 버튼 등)이면 내부 첫 포커스 요소로 옮긴다.
    if (!container.contains(document.activeElement)) {
      const firstFocusable = focusableNodes()[0]
      ;(firstFocusable ?? container).focus?.()
    }

    openTraps.push(container)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && escRef.current) {
        // 하위가 capture 단계에서 이미 소비한 Esc 는 여기서 다시 먹지 않는다 —
        // '입력만 무르려다 모달 전체가 닫히는' 삼킴을 막는다.
        // 아무도 표시하지 않았으면 종전대로 그냥 닫힌다(다른 모달의 기존 동작 유지).
        if (e.defaultPrevented) return
        e.stopPropagation(); escRef.current(); return
      }
      if (e.key !== 'Tab') return
      const nodes = focusableNodes()
      if (nodes.length === 0) return
      const first = nodes[0], last = nodes[nodes.length - 1]
      const activeEl = document.activeElement
      if (activeEl && !container.contains(activeEl)) { e.preventDefault(); first.focus() }
      else if (e.shiftKey && activeEl === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && activeEl === last) { e.preventDefault(); first.focus() }
    }
    // 포커스가 모달 밖에 있어도 Esc 는 맨 위 모달이 받는다. 데스크톱 앱(macOS WebKit)은 버튼을 눌러도
    // 포커스를 주지 않아서, 탭 버튼을 누른 뒤엔 포커스가 body 에 남고 컨테이너 리스너가 Esc 를 못 받았다.
    // 안에서 온 Esc 는 위 onKey 가 먼저 처리하고 전파를 끊으므로 두 번 닫히지 않는다.
    const onDocKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !escRef.current || e.defaultPrevented) return
      if (openTraps[openTraps.length - 1] !== container) return
      if (e.target instanceof Node && container.contains(e.target)) return
      e.stopPropagation(); escRef.current()
    }
    container.addEventListener('keydown', onKey)
    document.addEventListener('keydown', onDocKey)
    return () => {
      container.removeEventListener('keydown', onKey)
      document.removeEventListener('keydown', onDocKey)
      const i = openTraps.lastIndexOf(container)
      if (i >= 0) openTraps.splice(i, 1)
      if (prevFocused && typeof prevFocused.focus === 'function') prevFocused.focus()
    }
  }, [active])
  return ref
}
