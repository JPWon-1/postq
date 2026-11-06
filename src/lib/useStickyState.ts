'use client'
import { useEffect, useRef, useState } from 'react'
import { read, write } from './localStore'

/**
 * 사용자가 고른 값을 화면을 떠났다 와도 기억한다.
 *
 * 좌측 레일의 화면들은 `mode === 'x' && <Panel/>` 로 조건부 마운트된다. 다른 화면에
 * 갔다 오면 컴포넌트가 죽었다 다시 태어나므로, useState 에 든 선택이 전부 기본값으로
 * 돌아간다. 실측으로 확인한 것만:
 *
 *   실시간 탭     SSE 로 바꿔도 → WebSocket
 *   이력 필터     직접 친 값이 → 빈칸
 *
 * 데이터·로딩·에러는 다시 받으면 그만이라 여기 쓰지 않는다. '사용자가 고른 것' 만 담는다.
 *
 * 복원은 마운트 뒤에 한다 — 첫 렌더에서 읽으면 서버 렌더와 어긋나 화면이 번쩍인다.
 */
export function useStickyState<T extends string | number | boolean>(
  key: string,
  initial: T,
  /** 저장된 문자열이 쓸 수 있는 값인지. 아니면 무시하고 기본값을 쓴다. */
  accept?: (v: string) => boolean,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(initial)
  // 복원이 끝나기 전에 저장하지 않는다 — 안 그러면 마운트 직후 기본값이 저장돼
  // 사용자가 예전에 고른 값을 덮어쓴다.
  const restored = useRef(false)

  useEffect(() => {
    const stored = read(key)
    if (stored !== null && (!accept || accept(stored))) {
      setValue(parseAs(stored, initial))
    }
    restored.current = true
    // key 가 바뀌면 다시 복원한다. initial/accept 는 매 렌더 새로 만들어질 수 있어 뺀다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const set = (next: T) => {
    setValue(next)
    if (restored.current) write(key, String(next))
  }
  return [value, set]
}

/** 저장은 문자열로만 된다 — 기본값의 생김새를 보고 원래 타입으로 되돌린다. */
function parseAs<T extends string | number | boolean>(stored: string, sample: T): T {
  if (typeof sample === 'number') {
    const n = Number(stored)
    return (Number.isFinite(n) ? n : sample) as T
  }
  if (typeof sample === 'boolean') return (stored === 'true') as T
  return stored as T
}
