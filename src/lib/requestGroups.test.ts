import { describe, expect, it } from 'vitest'
import { displayName, groupOf, groupRequests } from './requestGroups'

describe('groupOf / displayName', () => {
  it('마지막 " / " 기준으로 그룹과 이름을 나눈다', () => {
    expect(groupOf('Customer - Order / 회원 주문 목록 조회')).toBe('Customer - Order')
    expect(displayName('Customer - Order / 회원 주문 목록 조회')).toBe('회원 주문 목록 조회')
  })

  it('다단계 프리픽스는 앞부분 전체가 그룹이 된다', () => {
    expect(groupOf('Admin / 온라인 주문 / 일괄 취소')).toBe('Admin / 온라인 주문')
    expect(displayName('Admin / 온라인 주문 / 일괄 취소')).toBe('일괄 취소')
  })

  it('구분자가 없으면 그룹 없음', () => {
    expect(groupOf('주문 생성')).toBeNull()
    expect(displayName('주문 생성')).toBe('주문 생성')
  })

  it('슬래시가 공백 없이 붙은 경우(" / " 아님)는 구분자가 아니다', () => {
    expect(groupOf('GET /orders/{id}')).toBeNull()
  })
})

describe('groupRequests', () => {
  const r = (name: string) => ({ name })

  it('그룹 등장 순서를 유지하며 묶는다', () => {
    const grouped = groupRequests([
      r('A / 하나'), r('B / 둘'), r('A / 셋'), r('단독'),
    ])
    expect(grouped.map(g => g.group)).toEqual(['A', 'B', null])
    expect(grouped[0].items.map(i => i.name)).toEqual(['A / 하나', 'A / 셋'])
    expect(grouped[2].items.map(i => i.name)).toEqual(['단독'])
  })

  it('빈 목록은 빈 결과', () => {
    expect(groupRequests([])).toEqual([])
  })
})
