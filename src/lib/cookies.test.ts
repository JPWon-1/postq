import { describe, expect, it } from 'vitest'
import { buildCookieHeader, cookieMatchesHost, isExpired, parseSetCookie } from './cookies'

describe('parseSetCookie', () => {
  it('name=value + 속성 파싱, Domain 없으면 요청 호스트', () => {
    const c = parseSetCookie('SESSIONID=abc123; Path=/; HttpOnly', 'api.example.com')!
    expect(c).toMatchObject({ name: 'SESSIONID', value: 'abc123', domain: 'api.example.com', path: '/', expires: null })
  })
  it('요청 호스트가 속하지 않는 Domain 은 거부하고 host-only 로', () => {
    // 크로스호스트 주입 차단: 응답이 무관한 Domain 을 줘도 요청 호스트로 고정
    expect(parseSetCookie('a=1; Domain=evil.com', 'api.example.com')!.domain).toBe('api.example.com')
    expect(parseSetCookie('a=1; Domain=example.com', 'other.org')!.domain).toBe('other.org')
  })
  it('Domain 속성은 앞 점 제거하고 소문자', () => {
    expect(parseSetCookie('a=1; Domain=.Example.com', 'x.example.com')!.domain).toBe('example.com')
  })
  it('Max-Age → 만료 epoch 계산', () => {
    const c = parseSetCookie('a=1; Max-Age=3600', 'h')!
    expect(c.expires).toBeGreaterThan(Date.now() + 3_500_000)
  })
  it('name 없으면 null', () => {
    expect(parseSetCookie('; Path=/', 'h')).toBeNull()
  })
})

describe('cookieMatchesHost', () => {
  it('정확 일치 + 도메인 서픽스', () => {
    expect(cookieMatchesHost('example.com', 'example.com')).toBe(true)
    expect(cookieMatchesHost('example.com', 'api.example.com')).toBe(true)
    expect(cookieMatchesHost('other.com', 'api.example.com')).toBe(false)
  })
})

describe('buildCookieHeader', () => {
  it('매칭 도메인 + 미만료만 Cookie 헤더로', () => {
    const jar = [
      { name: 'sid', value: 'A', domain: 'example.com', expires: null },
      { name: 'old', value: 'B', domain: 'example.com', expires: Date.now() - 1000 },
      { name: 'other', value: 'C', domain: 'nope.com', expires: null },
    ]
    expect(buildCookieHeader(jar, 'api.example.com')).toBe('sid=A')
  })
  it('같은 이름은 마지막 값 우선', () => {
    const jar = [
      { name: 'sid', value: 'old', domain: 'example.com', expires: null },
      { name: 'sid', value: 'new', domain: 'api.example.com', expires: null },
    ]
    expect(buildCookieHeader(jar, 'api.example.com')).toBe('sid=new')
  })
})

describe('isExpired', () => {
  it('Max-Age=0/과거 만료는 삭제 대상', () => {
    expect(isExpired({ name: 'a', value: '', domain: 'h', path: '/', expires: Date.now() - 1 })).toBe(true)
    expect(isExpired({ name: 'a', value: '1', domain: 'h', path: '/', expires: null })).toBe(false)
  })
})

import { parseCookieString } from './cookies'

describe('parseCookieString', () => {
  it('브라우저 Cookie 문자열을 개별 쿠키로', () => {
    expect(parseCookieString('SID=abc; theme=dark; _ga=GA1.2.3')).toEqual([
      { name: 'SID', value: 'abc' }, { name: 'theme', value: 'dark' }, { name: '_ga', value: 'GA1.2.3' },
    ])
  })
  it('값에 = 포함 보존, 개행 구분 허용', () => {
    expect(parseCookieString('token=a=b=c\nx=1')).toEqual([{ name: 'token', value: 'a=b=c' }, { name: 'x', value: '1' }])
  })
  it('빈 조각/이름없음 무시', () => {
    expect(parseCookieString('; =v; ok=1;')).toEqual([{ name: 'ok', value: '1' }])
  })
})

describe('공용 접미사로는 하위 전체를 잡을 수 없다', () => {
  it('Domain=com 은 채택되지 않고 host-only 로 떨어진다', () => {
    // 예전엔 그대로 채택됐고, 그 뒤 모든 .com 요청에 이 쿠키가 실려 나갔다.
    const c = parseSetCookie('sid=SECRET; Domain=com', 'staging.example.com')
    expect(c?.domain).toBe('staging.example.com')
  })

  it('이미 jar 에 들어 있어도 전송 단계에서 막힌다', () => {
    const leaked = { name: 'sid', value: 'SECRET', domain: 'com', expires: null }
    expect(buildCookieHeader([leaked], 'totally-unrelated.com')).toBe('')
    // 정확히 그 이름의 호스트라면(비현실적이지만) host-only 로는 성립한다
    expect(buildCookieHeader([leaked], 'com')).toBe('sid=SECRET')
  })

  it('2라벨 공용 접미사도 막는다', () => {
    expect(parseSetCookie('a=1; Domain=co.kr', 'shop.co.kr')?.domain).toBe('shop.co.kr')
    expect(cookieMatchesHost('co.kr', 'other.co.kr')).toBe(false)
  })

  it('정상 도메인은 그대로 동작한다', () => {
    expect(parseSetCookie('a=1; Domain=example.com', 'shop.example.com')?.domain).toBe('example.com')
    expect(cookieMatchesHost('example.com', 'shop.example.com')).toBe(true)
    // localhost 는 host-only 로 계속 동작한다(점이 없어도 정확히 일치하므로)
    expect(cookieMatchesHost('localhost', 'localhost')).toBe(true)
  })
})

describe('Cookie 헤더 조립', () => {
  it('같은 이름이면 더 구체적인 도메인이 이긴다', () => {
    // 주석엔 그렇게 적혀 있었지만 실제로는 '배열의 마지막' 이었다 — DB 순서에 따라
    // 광역 쿠키가 호스트 전용 쿠키를 덮을 수 있었다.
    const broad = { name: 'sid', value: 'broad', domain: 'example.com', expires: null }
    const exact = { name: 'sid', value: 'exact', domain: 'api.example.com', expires: null }
    expect(buildCookieHeader([broad, exact], 'api.example.com')).toBe('sid=exact')
    expect(buildCookieHeader([exact, broad], 'api.example.com')).toBe('sid=exact')
  })

  it('값에 섞인 개행·세미콜론은 헤더를 쪼개지 못한다', () => {
    const bad = { name: 'sid', value: 'a\r\nX-Evil: 1', domain: 'x.com', expires: null }
    expect(buildCookieHeader([bad], 'x.com')).toBe('sid=aX-Evil: 1')
  })
})

describe('Max-Age 가 비어 있으면', () => {
  it('삭제 지시로 읽지 않는다', () => {
    // Number('') 는 0 이라 '지금 만료' 가 됐다. 값이 없는 건 지시가 없는 것이다.
    expect(parseSetCookie('a=1; Max-Age=', 'x.com')?.expires).toBeNull()
  })
})
