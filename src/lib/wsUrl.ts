/**
 * WebSocket 주소 검증.
 *
 * `new WebSocket(url)` 은 스펙상 http/https 스킴을 ws/wss 로 조용히 바꾸고, 그 밖의
 * 스킴에서만 예외를 던진다. 그래서 `http://…` 를 넣으면 예외가 안 나고 `ws://…` 로
 * 연결을 시도하다 정보 없는 실패로 끝났다 — 사용자가 보는 건 "오류 발생"뿐이었다.
 * 붙이기 전에 여기서 걸러 무엇이 잘못됐는지 말해 준다.
 *
 * @returns 문제가 있으면 사용자에게 보여줄 문구, 없으면 null
 */
export function schemeProblem(url: string): string | null {
  const raw = url.trim()
  if (!raw) return '주소를 입력하세요'

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return `주소 형식이 올바르지 않습니다: ${raw}`
  }

  if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') return null
  // http/https 는 가장 흔한 오입력이라 따로 짚어 준다 — 바꿔야 할 게 스킴 한 군데뿐이다.
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    const suggested = raw.replace(/^http/, 'ws')
    return `WebSocket 주소는 ws:// 또는 wss:// 여야 합니다 — ${suggested} 를 의도했나요?`
  }
  return `지원하지 않는 스킴입니다: ${parsed.protocol}// (ws:// 또는 wss:// 를 쓰세요)`
}
