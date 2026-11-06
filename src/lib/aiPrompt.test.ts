import { describe, expect, it } from 'vitest'
import { buildAiPrompt } from './aiPrompt'
import type { RequestInput } from './variables'

const input: RequestInput = {
  method: 'POST',
  url: '{{baseUrl}}/orders/issue',
  params: [{ key: 'dryRun', value: 'true', enabled: true }, { key: 'off', value: 'x', enabled: false }],
  headers: [{ key: 'Authorization', value: 'Bearer {{token}}', enabled: true }],
  bodyType: 'json',
  body: '{"memberCode":"M1"}',
}

describe('buildAiPrompt', () => {
  it('실패면 원인 질문 + 요청/에러 포함, secret 은 참조로 유지', () => {
    const p = buildAiPrompt('주문 생성', input, { error: 'ECONNREFUSED: connect', status: null })
    expect(p).toContain('문제가 있다면')
    expect(p).toContain('POST {{baseUrl}}/orders/issue')
    expect(p).toContain('Authorization: Bearer {{token}}')
    expect(p).toContain('ECONNREFUSED')
    expect(p).not.toContain('off=') // 비활성 파라미터 제외
    expect(p).toContain('dryRun=true')
  })

  it('성공이면 상태+응답 바디 포함', () => {
    const p = buildAiPrompt('주문 생성', input, { status: 200, durationMs: 12, responseBody: '{"ok":true}' })
    expect(p).toContain('분석하고')
    expect(p).toContain('상태: **200**')
    expect(p).toContain('{"ok":true}')
  })

  it('4xx 는 실패로 취급', () => {
    const p = buildAiPrompt('x', input, { status: 401, responseBody: '{"error":"no token"}' })
    expect(p).toContain('문제가 있다면')
  })

  it('긴 바디도 생략 없이 포함한다', () => {
    const big = 'x'.repeat(10000)
    const p = buildAiPrompt('x', input, { status: 200, responseBody: big })
    expect(p).toContain(big)
    expect(p).not.toContain('생략')
  })
})

it('미실행 상태와 응답 헤더를 표시하고 쿠키는 가린다', () => {
  expect(buildAiPrompt('x', input, {})).toContain('아직 실행하지 않았습니다')
  const prompt = buildAiPrompt('x', input, { status: 200, responseHeaders: { 'Content-Type': 'application/json', 'Set-Cookie': 'secret-session' } })
  expect(prompt).toContain('Content-Type: application/json')
  expect(prompt).toContain('Set-Cookie: [가림]')
  expect(prompt).not.toContain('secret-session')
})
