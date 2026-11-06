import { describe, expect, it } from 'vitest'
import { isBlockedHost } from '@/lib/ssrfGuard'

describe('isBlockedHost — 메타데이터 차단', () => {
  it('링크로컬 169.254.x.x', () => {
    expect(isBlockedHost('169.254.169.254')).toBe(true)
    expect(isBlockedHost('169.254.0.1')).toBe(true)
  })
  it('DNS 이름 우회', () => {
    expect(isBlockedHost('metadata.google.internal')).toBe(true)
    expect(isBlockedHost('metadata.goog')).toBe(true)
  })
  it('십진/16진 인코딩 우회', () => {
    expect(isBlockedHost('2852039166')).toBe(true)       // = 169.254.169.254
    expect(isBlockedHost('0xA9FEA9FE')).toBe(true)        // = 169.254.169.254
  })
  it('IPv6 링크로컬 / mapped', () => {
    expect(isBlockedHost('[fd00:ec2::254]')).toBe(true)
    expect(isBlockedHost('fe80::1')).toBe(true)
    expect(isBlockedHost('::ffff:169.254.169.254')).toBe(true)
  })
  it('Alibaba 메타데이터', () => {
    expect(isBlockedHost('100.100.100.200')).toBe(true)
  })

  // 리뷰 확정 우회 — 반드시 실제 new URL 경로(파서 정규화형)로 검증한다.
  it('IPv4-mapped IPv6 (URL 파서가 만드는 16진형 포함)', () => {
    expect(isBlockedHost('::ffff:169.254.169.254')).toBe(true)
    expect(isBlockedHost('::ffff:a9fe:a9fe')).toBe(true)                          // 16진 매핑형
    expect(isBlockedHost(new URL('http://[::ffff:169.254.169.254]/').hostname)).toBe(true)  // 실경로
  })
  it('후행점 FQDN 우회', () => {
    expect(isBlockedHost('metadata.google.internal.')).toBe(true)
    expect(isBlockedHost(new URL('http://metadata.google.internal./x').hostname)).toBe(true)
    expect(isBlockedHost('169.254.169.254.')).toBe(true)
  })
})

describe('isBlockedHost — 기본 모드: 정당한 내부 대상 허용', () => {
  it('localhost/사설망은 막지 않는다(도구 특성)', () => {
    expect(isBlockedHost('localhost')).toBe(false)
    expect(isBlockedHost('127.0.0.1')).toBe(false)
    expect(isBlockedHost('10.0.0.5')).toBe(false)
    expect(isBlockedHost('192.168.1.10')).toBe(false)
    expect(isBlockedHost('host.docker.internal')).toBe(false)
    expect(isBlockedHost('api.internal.company.com')).toBe(false)
  })
})

describe('isBlockedHost — 하드닝(공개 egress) 모드: 사설망 전면 차단', () => {
  it('사설/loopback/링크로컬/CGNAT 차단', () => {
    expect(isBlockedHost('localhost', true)).toBe(true)
    expect(isBlockedHost('127.0.0.1', true)).toBe(true)
    expect(isBlockedHost('10.0.0.5', true)).toBe(true)
    expect(isBlockedHost('172.16.5.5', true)).toBe(true)
    expect(isBlockedHost('172.32.0.1', true)).toBe(false)  // 172.32 는 사설 아님
    expect(isBlockedHost('192.168.1.10', true)).toBe(true)
    expect(isBlockedHost('100.64.0.1', true)).toBe(true)   // CGNAT
    expect(isBlockedHost('0.0.0.0', true)).toBe(true)
  })
  it('IPv6 loopback/ULA 차단', () => {
    expect(isBlockedHost('::1', true)).toBe(true)
    expect(isBlockedHost('[fd12:3456::1]', true)).toBe(true)  // ULA
  })
  it('공인 주소는 하드닝 모드에서도 허용', () => {
    expect(isBlockedHost('api.stripe.com', true)).toBe(false)
    expect(isBlockedHost('8.8.8.8', true)).toBe(false)
    expect(isBlockedHost('52.1.2.3', true)).toBe(false)
  })
  it('메타데이터는 두 모드 모두 차단', () => {
    expect(isBlockedHost('169.254.169.254', false)).toBe(true)
    expect(isBlockedHost('169.254.169.254', true)).toBe(true)
  })
})
