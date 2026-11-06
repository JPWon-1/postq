import { describe, expect, it } from 'vitest'
import { toAxios, toFetch, toPythonRequests } from './codegen'
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
  body: '{"memberCode":"M123","force":true,"note":null}',
}

describe('toFetch', () => {
  it('환경 변수 치환 + 활성 param 만 URL 에 병합', () => {
    const code = toFetch(base, vars)
    expect(code).toContain(`fetch('https://api.example.com/orders/issue?dryRun=true'`)
    expect(code).not.toContain('off=')
    expect(code).toContain(`method: 'POST'`)
  })

  it('JSON 바디는 JSON.stringify(객체 리터럴) 관용구 + Content-Type 자동 추가', () => {
    const code = toFetch(base, vars)
    expect(code).toContain('body: JSON.stringify(')
    expect(code).toContain('"memberCode": "M123"')
    expect(code).toContain(`'Content-Type': 'application/json'`)
  })

  it('secret 은 실값 대신 {{참조}} 유지', () => {
    const code = toFetch(base, vars)
    expect(code).toContain('Bearer {{token}}')
    expect(code).not.toContain('REAL-SECRET')
  })

  it('바디 없음 — body/headers 블록 미출력', () => {
    const code = toFetch({ ...base, method: 'GET', bodyType: 'none', body: '', headers: [] }, vars)
    expect(code).not.toContain('body:')
    expect(code).not.toContain('headers:')
  })

  it('JSON 파싱 불가한 바디는 문자열 리터럴로 폴백', () => {
    const code = toFetch({ ...base, bodyType: 'raw', body: 'plain text' }, vars)
    expect(code).toContain(`body: 'plain text'`)
  })
})

describe('toAxios', () => {
  it('axios({method, url, headers, data}) 관용구', () => {
    const code = toAxios(base, vars)
    expect(code).toContain('axios({')
    expect(code).toContain(`method: 'post'`)
    expect(code).toContain(`url: 'https://api.example.com/orders/issue?dryRun=true'`)
    expect(code).toContain('data: {')
    expect(code).toContain('"memberCode": "M123"')
  })

  it('secret 은 실값 대신 {{참조}} 유지', () => {
    const code = toAxios(base, vars)
    expect(code).toContain('Bearer {{token}}')
    expect(code).not.toContain('REAL-SECRET')
  })

  it('바디 없으면 data 미출력', () => {
    const code = toAxios({ ...base, bodyType: 'none', body: '' }, vars)
    expect(code).not.toContain('data:')
  })
})

describe('toPythonRequests', () => {
  it('requests.request(method, url, headers=, json=) 관용구', () => {
    const code = toPythonRequests(base, vars)
    expect(code).toContain('import requests')
    expect(code).toContain('requests.request(')
    expect(code).toContain('"POST"')
    expect(code).toContain('"https://api.example.com/orders/issue?dryRun=true"')
    expect(code).toContain('headers={')
    expect(code).toContain('json={')
  })

  it('JSON 바디를 파이썬 리터럴로 변환(true→True, null→None)', () => {
    const code = toPythonRequests(base, vars)
    expect(code).toContain('"force": True')
    expect(code).toContain('"note": None')
  })

  it('secret 은 실값 대신 {{참조}} 유지', () => {
    const code = toPythonRequests(base, vars)
    expect(code).toContain('Bearer {{token}}')
    expect(code).not.toContain('REAL-SECRET')
  })

  it('JSON 파싱 불가한 바디는 data= 문자열로 폴백', () => {
    const code = toPythonRequests({ ...base, bodyType: 'raw', body: 'plain text' }, vars)
    expect(code).toContain('data="plain text"')
    expect(code).not.toContain('json=')
  })
})
