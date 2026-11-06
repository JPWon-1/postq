import { describe, expect, it } from 'vitest'
import { schemeProblem } from './ssrfGuard'

describe('schemeProblem', () => {
  it('http/https 는 통과', () => {
    expect(schemeProblem('http:')).toBeNull()
    expect(schemeProblem('https:')).toBeNull()
    expect(schemeProblem('HTTPS:')).toBeNull()
  })

  // 예전엔 fetch 가 그 스킴을 구현하지 않아서 '우연히' 막혔다 —
  // 우연에 기댄 방어는 런타임이 바뀌면 사라지고, 그때 아무도 모른다.
  it('그 밖의 스킴은 거절하고 이유를 준다', () => {
    for (const p of ['file:', 'ftp:', 'gopher:', 'data:', 'ws:', 'javascript:']) {
      const msg = schemeProblem(p)
      expect(msg, p).toBeTruthy()
      expect(msg, `${p} 는 이유에 스킴이 들어가야 한다`).toContain(p.slice(0, -1))
    }
  })

  it('무엇을 쓰면 되는지 알려준다 — 막는 것보다 이게 요점이다', () => {
    expect(schemeProblem('file:')).toContain('https://')
  })
})
