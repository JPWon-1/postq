'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { read, write } from './localStore'

// VSCode/Postman 스타일 드래그 리사이즈. growDirection: 마우스가 오른쪽(또는 아래)으로
// 움직일 때 패널이 커지면 1, 반대로 움직일 때 커지면 -1.
// axis: 'x'=가로 폭(기본), 'y'=세로 높이 조절.
/**
 * max 는 상수로 줄 수도 있고, 창 크기를 받아 계산할 수도 있다.
 *
 * 상수로 두면 창을 아무리 넓혀도 거기서 멈춘다. 사이드바가 그랬다 — 상한이
 * 460px 이라, 2000px 짜리 창에서도 목록이 460px 에서 딱 멈추고 요청 이름이
 * 잘린 채였다. 끝까지 당겨 놓으면 아무리 끌어도 안 움직이니 '크기 조절이 없다' 로 보인다.
 */
type MaxSize = number | ((viewport: number) => number)

export function useResizable(storageKey: string, defaultSize: number, min: number, maxInput: MaxSize, axis: 'x' | 'y' = 'x') {
  const [size, setSize] = useState(defaultSize)
  const sizeRef = useRef(defaultSize)

  // 창 크기 — 서버에서는 알 수 없으니 붙은 뒤에 잰다.
  const [viewport, setViewport] = useState(0)
  useEffect(() => {
    const measure = () => setViewport(axis === 'x' ? window.innerWidth : window.innerHeight)
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [axis])

  // 아직 못 쟀으면(viewport 0) 넉넉히 열어 둔다 — 저장해 둔 폭을 '범위 밖' 이라며
  // 버리고 기본값으로 되돌리면, 새로고침할 때마다 폭이 리셋된 것처럼 보인다.
  const max = typeof maxInput === 'number' ? maxInput : (viewport > 0 ? maxInput(viewport) : Number.MAX_SAFE_INTEGER)

  useEffect(() => {
    const stored = Number(read(storageKey))
    // 범위를 벗어나면 무시하지 않고 가둔다. 무시하면 창을 줄였다 늘린 뒤 저장값을 잃는다.
    if (stored > 0) {
      const next = Math.min(max, Math.max(min, stored))
      setSize(next); sizeRef.current = next
    }
  }, [storageKey, min, max])

  // 창이 줄어 상한이 내려가면 지금 폭도 따라 내려와야 한다 — 안 그러면 패널이 화면을 넘는다.
  useEffect(() => {
    setSize(s => Math.min(max, Math.max(min, s)))
  }, [min, max])

  useEffect(() => { sizeRef.current = size }, [size])

  // 드래그 중인 정리 함수 — 언마운트될 때 남은 리스너와 body 스타일을 되돌리기 위해 들고 있는다.
  const endDragRef = useRef<(() => void) | null>(null)
  useEffect(() => () => endDragRef.current?.(), [])

  const startDrag = useCallback((e: React.MouseEvent, growDirection: 1 | -1) => {
    e.preventDefault()
    window.getSelection()?.removeAllRanges()
    const start = axis === 'x' ? e.clientX : e.clientY
    const startSize = sizeRef.current
    const prevUserSelect = document.body.style.userSelect
    const prevCursor = document.body.style.cursor
    document.body.style.userSelect = 'none'
    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize'

    const onMove = (ev: MouseEvent) => {
      // 버튼을 이미 뗐는데도 여기 들어오는 경우가 있다 — 브라우저 탭바처럼 페이지 밖에서
      // 놓으면 mouseup 이 창에 안 온다. 그러면 손을 뗐는데 패널이 커서를 계속 따라다니고,
      // 아무 데나 한 번 클릭해야 풀린다. buttons 로 알아채고 그 자리에서 끝낸다.
      if (ev.buttons === 0) { onUp(); return }
      window.getSelection()?.removeAllRanges()
      const delta = ((axis === 'x' ? ev.clientX : ev.clientY) - start) * growDirection
      setSize(Math.min(max, Math.max(min, startSize + delta)))
    }
    const onUp = () => {
      endDragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = prevUserSelect
      document.body.style.cursor = prevCursor
      write(storageKey, String(sizeRef.current))   // write 는 저장 실패를 스스로 삼킨다
    }
    endDragRef.current = onUp
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [min, max, storageKey, axis])

  // width 별칭은 기존 사용처(page.tsx) 호환용
  return { size, width: size, startDrag }
}
