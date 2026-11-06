import { describe, expect, it } from 'vitest'
import { explainStatus, explainTransportError } from './httpExplain'

describe('explainTransportError', () => {
  it('노드 에러 코드를 원인+확인사항으로 번역한다', () => {
    expect(explainTransportError('ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:9999')!.title)
      .toContain('연결을 거부')
    expect(explainTransportError('ENOTFOUND: getaddrinfo ENOTFOUND api.nope.com')!.title)
      .toContain('DNS')
    expect(explainTransportError('TimeoutError: The operation was aborted due to timeout')!.title)
      .toContain('시간 초과')
    expect(explainTransportError('TypeError: Invalid URL')!.hints.join(' ')).toContain('{{변수}}')
    expect(explainTransportError('BlockedHost: 메타데이터 주소')!.title).toContain('차단')
  })

  it('모르는 에러는 null (원문 그대로 표시)', () => {
    expect(explainTransportError('SomethingWeird: ???')).toBeNull()
  })
})

describe('explainStatus', () => {
  it('주요 코드는 한국어 설명 + 확인 힌트', () => {
    expect(explainStatus(401).label).toContain('인증 실패')
    expect(explainStatus(401).hint).toContain('Authorization')
    expect(explainStatus(404).hint).toContain('경로')
    expect(explainStatus(200).label).toContain('성공')
  })

  it('정의 없는 코드는 클래스 기본 설명', () => {
    expect(explainStatus(418).label).toContain('클라이언트 오류')
    expect(explainStatus(599).label).toContain('서버 오류')
  })
})
