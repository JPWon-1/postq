import { describe, expect, it } from 'vitest'
import { toCurl } from './curl'
import type { RequestInput, VarMap } from './variables'

const vars: VarMap = {
  baseUrl: { value: 'https://api.example.com', secret: false },
  token: { value: 'REAL-SECRET', secret: true },
}

const base: RequestInput = {
  method: 'POST',
  url: '{{baseUrl}}/orders/issue',
  params: [{ key: 'dryRun', value: 'true', enabled: true }, { key: 'off', value: 'x', enabled: false }],
  headers: [{ key: 'Authorization', value: 'Bearer {{token}}', enabled: true }],
  bodyType: 'json',
  body: '{"memberCode":"M123"}',
}

describe('toCurl', () => {
  it('환경 변수 치환 + 활성 param/header + JSON Content-Type 자동 추가', () => {
    const { command } = toCurl(base, vars)
    expect(command).toContain(`curl -X POST 'https://api.example.com/orders/issue?dryRun=true'`)
    expect(command).not.toContain('off=')
    expect(command).toContain(`-H 'Content-Type: application/json'`)
    expect(command).toContain(`-d '{"memberCode":"M123"}'`)
  })

  it('secret 은 실값 대신 {{참조}} 유지 + 플래그로 알림', () => {
    const { command, hasSecretRef } = toCurl(base, vars)
    expect(command).toContain('Bearer {{token}}')
    expect(command).not.toContain('REAL-SECRET')
    expect(hasSecretRef).toBe(true)
  })

  it('secret 참조가 없으면 hasSecretRef=false', () => {
    const { hasSecretRef } = toCurl({ ...base, headers: [] }, vars)
    expect(hasSecretRef).toBe(false)
  })

  it('graphql — 실제 전송과 동일하게 application/json + {query} 래핑', () => {
    const gql: RequestInput = { ...base, headers: [], bodyType: 'graphql', body: '{ me { id } }' }
    const { command } = toCurl(gql, vars)
    expect(command).toContain(`-H 'Content-Type: application/json'`)
    expect(command).toContain(`-d '${JSON.stringify({ query: '{ me { id } }' })}'`)
  })

  it('작은따옴표가 든 바디를 셸 안전하게 이스케이프한다', () => {
    const { command } = toCurl({ ...base, body: `{"name":"O'Brien"}` }, vars)
    expect(command).toContain(`'{"name":"O'\\''Brien"}'`)
  })

  it('URL 파싱 불가(변수 미해석)여도 쿼리를 문자열로 조립한다', () => {
    const { command } = toCurl({ ...base, url: '{{unknownHost}}/path' }, {})
    expect(command).toContain('{{unknownHost}}/path?dryRun=true')
  })

  it('GET + body 없음 — -d 미출력', () => {
    const { command } = toCurl({ ...base, method: 'GET', bodyType: 'none', body: '' }, vars)
    expect(command).not.toContain('-d ')
    expect(command).not.toContain('Content-Type')
  })
})
