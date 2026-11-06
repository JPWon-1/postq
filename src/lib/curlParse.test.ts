import { describe, expect, it } from 'vitest'
import { parseCurl } from './curlParse'
import { kvToText, textToKV } from './bulkKV'

describe('parseCurl', () => {
  it('메서드/헤더/JSON 바디/쿼리 분리까지 파싱한다', () => {
    const r = parseCurl(`curl -X POST 'https://api.example.com/orders?dryRun=true' \\
  -H 'Authorization: Bearer abc' \\
  -H "Content-Type: application/json" \\
  -d '{"memberCode":"M123"}'`)!
    expect(r.input.method).toBe('POST')
    expect(r.input.url).toBe('https://api.example.com/orders')
    expect(r.input.params).toEqual([{ key: 'dryRun', value: 'true', enabled: true }])
    expect(r.input.headers).toEqual([
      { key: 'Authorization', value: 'Bearer abc', enabled: true },
      { key: 'Content-Type', value: 'application/json', enabled: true },
    ])
    expect(r.input.bodyType).toBe('json')
    expect(r.input.body).toBe('{"memberCode":"M123"}')
  })

  it('-d 만 있으면 POST 로 추론, 없으면 GET', () => {
    expect(parseCurl(`curl https://x.com -d 'a=1'`)!.input.method).toBe('POST')
    expect(parseCurl(`curl https://x.com`)!.input.method).toBe('GET')
  })

  it('작은따옴표 안 이스케이프(  }} 변수 포함 URL)는 그대로 둔다', () => {
    const r = parseCurl(`curl '{{baseUrl}}/path?q=1'`)!
    expect(r.input.url).toBe('{{baseUrl}}/path?q=1')
    expect(r.input.params).toEqual([])
  })

  it('-u 는 Basic 인증 헤더로 변환한다', () => {
    const r = parseCurl(`curl -u admin:pw https://x.com`)!
    expect(r.input.headers[0]).toEqual({
      key: 'Authorization', value: `Basic ${Buffer.from('admin:pw').toString('base64')}`, enabled: true,
    })
  })

  it('curl 이 아니거나 URL 없으면 null', () => {
    expect(parseCurl('wget https://x.com')).toBeNull()
    expect(parseCurl('curl -X POST')).toBeNull()
  })

  it('멀티라인 백슬래시 + --data-urlencode 다중 결합', () => {
    const r = parseCurl(`curl https://x.com \\\n --data-urlencode 'a=1' --data-urlencode 'b=2'`)!
    expect(r.input.body).toBe('a=1&b=2')
    expect(r.input.bodyType).toBe('raw')
  })
})

describe('bulkKV', () => {
  it('KV ↔ 텍스트 왕복 (비활성은 // 접두)', () => {
    const items = [
      { key: 'Authorization', value: 'Bearer {{token}}', enabled: true },
      { key: 'X-Debug', value: '1', enabled: false },
    ]
    const text = kvToText(items)
    expect(text).toBe('Authorization: Bearer {{token}}\n//X-Debug: 1')
    expect(textToKV(text)).toEqual(items)
  })

  it('Bulk 를 거쳐도 설명이 살아남는다', () => {
    // 이 형식엔 설명 자리가 없어서, 돌아올 때 통째로 사라졌다. 스펙에서 가져온 파라미터
    // 설명은 손으로 쓴 게 아니라 다시 채울 방법도 마땅치 않다.
    const prev = [
      { key: 'page', value: '1', enabled: true, description: '페이지 번호(1부터)' },
      { key: 'size', value: '20', enabled: true, description: '한 페이지 개수' },
    ]
    const back = textToKV(kvToText(prev), prev)
    expect(back).toEqual(prev)
  })

  it('값을 고쳐도 설명은 그대로, 이름을 바꾸면 따라오지 않는다', () => {
    const prev = [{ key: 'page', value: '1', enabled: true, description: '페이지 번호' }]
    expect(textToKV('page: 5', prev)).toEqual([
      { key: 'page', value: '5', enabled: true, description: '페이지 번호' },
    ])
    // 이름이 바뀌었으면 다른 항목으로 본다 — 남의 설명이 따라붙는 게 더 나쁘다
    expect(textToKV('offset: 5', prev)).toEqual([{ key: 'offset', value: '5', enabled: true }])
  })

  it('이전 목록을 안 주면 예전과 똑같이 동작한다', () => {
    expect(textToKV('a: 1')).toEqual([{ key: 'a', value: '1', enabled: true }])
  })

  it('값에 콜론 포함(URL) 안전, 빈 줄/빈 키 무시', () => {
    const kv = textToKV('url: https://a.b/c\n\n: no-key\nsolo')
    expect(kv).toEqual([
      { key: 'url', value: 'https://a.b/c', enabled: true },
      { key: 'solo', value: '', enabled: true },
    ])
  })
})
