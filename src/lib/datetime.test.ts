import { describe, it, expect } from 'vitest'
import { kstDay, kstFull, kstHm, kstMinute, kstMonthDay, kstTime, kstToday, NO_TIME } from './datetime'

describe('KST 시각 표시', () => {
  // 1970-01-01T00:00:00Z = KST 1970-01-01 09:00:00
  it('에폭 0 은 KST 9시', () => {
    expect(kstTime(0)).toBe('09:00:00')
    expect(kstDay(0)).toBe('1970-01-01')
    expect(kstFull(0)).toBe('1970-01-01 09:00:00')
    expect(kstMinute(0)).toBe('1970-01-01 09:00')
    expect(kstHm(0)).toBe('09:00')
    expect(kstMonthDay(0)).toBe('01-01 09:00')
  })

  it('UTC 15시를 넘기면 KST 는 다음 날이다 — 날짜가 같이 넘어가야 한다', () => {
    const utc = Date.UTC(2026, 7, 9, 15, 30, 0)  // 8/9 15:30Z = 8/10 00:30 KST
    expect(kstDay(utc)).toBe('2026-08-10')
    expect(kstTime(utc)).toBe('00:30:00')
  })

  it('기계 시간대가 어디든 같은 값이 나온다 — 로캘을 안 쓴다', () => {
    // toISOString 은 항상 UTC 기준이라 TZ 환경변수와 무관하다. 이게 이 방식을 고른 이유다.
    const before = process.env.TZ
    process.env.TZ = 'America/New_York'
    try { expect(kstTime(0)).toBe('09:00:00') } finally { process.env.TZ = before }
  })

  it('표현할 수 없는 값이면 던지지 않고 — 을 준다', () => {
    // Date 범위 밖(±8.64e15). 서버가 준 터무니없는 Max-Age 가 쿠키 만료로 들어오는 경로가 있다.
    // 여기서 RangeError 가 나면 렌더 중이라 화면 전체가 날아간다.
    expect(kstMinute(9e15)).toBe(NO_TIME)
    expect(kstMinute(Number.NaN)).toBe(NO_TIME)
    expect(kstDay(Number.POSITIVE_INFINITY)).toBe(NO_TIME)
    expect(() => kstFull(9e15)).not.toThrow()
  })

  it('kstToday 는 오늘(KST) 날짜다', () => {
    expect(kstToday()).toBe(kstDay(Date.now()))
    expect(kstToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
