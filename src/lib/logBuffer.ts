/**
 * 화면에 흘러가는 로그를 최근 N줄로 잘라 들고 있는다.
 *
 * WS/SSE 패널은 받은 줄을 그냥 배열에 계속 붙이고 있었다. 짧게 확인하고 끊으면
 * 아무 일도 없지만, 이 화면은 원래 '오래 켜 두고 보라'고 만든 것이다. 초당 수십 줄을
 * 미는 스트림에 30분 물려 두면 배열도 DOM 도 그만큼 자라고, 나중엔 스크롤조차 버벅인다.
 * 정작 필요한 순간에 못 쓰게 되는 셈이다.
 *
 * 오래된 쪽을 버린다 — 화면이 항상 맨 아래로 따라가므로 사람이 보고 있는 건 최근이다.
 * 대신 몇 줄을 버렸는지는 세어 돌려준다. 조용히 사라지면 '처음부터 다 보고 있다'고
 * 잘못 읽게 되고, 스트림 앞부분에 있던 단서를 못 찾고 헤매게 된다.
 */

/** 패널이 들고 있는 최대 줄 수. DOM 행 수이기도 해서 무작정 키울 수 없다. */
export const LOG_MAX = 2000

export function appendCapped<T>(prev: T[], items: T[], max = LOG_MAX): { next: T[]; dropped: number } {
  if (items.length === 0) return { next: prev, dropped: 0 }
  const all = prev.concat(items)
  if (all.length <= max) return { next: all, dropped: 0 }
  // 한 번에 들어온 양이 상한을 넘어도 최근 max 줄만 남는다.
  return { next: all.slice(all.length - max), dropped: all.length - max }
}

/**
 * 한 줄(메시지)의 최대 길이. 줄 수만 세면 2,000줄 × 수 MB 메시지가 그대로 쌓인다 —
 * 큰 JSON 을 미는 스트림이면 줄 수 상한이 메모리 상한이 되지 못한다(codex 점검).
 * 넘는 부분은 잘라 버리고 몇 글자를 버렸는지 적는다.
 */
export const LINE_MAX = 16 * 1024

export function capLine(text: string, max = LINE_MAX): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)} … (${(text.length - max).toLocaleString()}자 잘림)`
}
