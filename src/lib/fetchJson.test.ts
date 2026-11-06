import { afterEach, describe, expect, it, vi } from 'vitest'
import { errorText, fetchArray, fetchJson, HttpError } from './fetchJson'

const respond = (body: string, init: { status?: number; statusText?: string } = {}) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {
    status: init.status ?? 200,
    statusText: init.statusText ?? '',
    headers: { 'content-type': 'application/json' },
  })))
}

afterEach(() => { vi.unstubAllGlobals() })

describe('fetchJson', () => {
  it('200 이면 본문을 준다', async () => {
    respond(JSON.stringify({ a: 1 }))
    await expect(fetchJson('/x')).resolves.toEqual({ a: 1 })
  })

  // 이게 핵심이다 — 500 의 {error} 를 그대로 돌려주면 받는 쪽이 데이터로 착각한다.
  it('실패면 던진다 — 조용히 오류 본문을 돌려주지 않는다', async () => {
    respond(JSON.stringify({ error: '데이터소스에 연결할 수 없습니다' }), { status: 500 })
    await expect(fetchJson('/x')).rejects.toThrow('데이터소스에 연결할 수 없습니다')
  })

  it('상태 코드도 함께 남긴다', async () => {
    respond(JSON.stringify({ error: '없음' }), { status: 404 })
    await expect(fetchJson('/x')).rejects.toMatchObject({ status: 404 })
  })

  it('message 필드도 이유로 인정한다', async () => {
    respond(JSON.stringify({ message: '권한 없음' }), { status: 403 })
    await expect(fetchJson('/x')).rejects.toThrow('권한 없음')
  })

  // 프록시가 HTML 로그인 페이지를 주는 경우가 실제로 있다.
  it('JSON 이 아닌 오류 본문도 앞부분을 살린다', async () => {
    respond('<html>Login required</html>', { status: 502 })
    await expect(fetchJson('/x')).rejects.toThrow(/Login required/)
  })

  it('본문이 비어도 상태는 남는다', async () => {
    respond('', { status: 503, statusText: 'Service Unavailable' })
    await expect(fetchJson('/x')).rejects.toThrow(/503/)
  })
})

describe('fetchArray', () => {
  it('배열이면 그대로', async () => {
    respond(JSON.stringify([1, 2]))
    await expect(fetchArray<number>('/x')).resolves.toEqual([1, 2])
  })

  // 200 인데 배열이 아니면, 그대로 상태에 넣었을 때 렌더 도중에 터진다 —
  // 그때는 어느 요청이 원인인지 알 수 없다. 여기서 멈추는 편이 낫다.
  it('200 인데 배열이 아니면 던진다', async () => {
    respond(JSON.stringify({ error: 'oops' }))
    await expect(fetchArray('/x')).rejects.toThrow(/목록을 기대했는데/)
  })

  it('null 도 배열이 아니다', async () => {
    respond('null')
    await expect(fetchArray('/x')).rejects.toThrow(/null/)
  })

  it('실패는 이유를 그대로 전한다', async () => {
    respond(JSON.stringify({ error: '워크스페이스 없음' }), { status: 404 })
    await expect(fetchArray('/x')).rejects.toThrow('워크스페이스 없음')
  })

  it('어느 주소였는지 메시지에 남는다 — 여러 개를 동시에 부를 때 필요하다', async () => {
    respond(JSON.stringify({}))
    await expect(fetchArray('/api/requests?folderId=abc')).rejects.toThrow(/folderId=abc/)
  })
})

describe('errorText', () => {
  it('HttpError 는 메시지를 그대로', () => {
    expect(errorText(new HttpError(500, '서버 오류'))).toBe('서버 오류')
  })
  it('일반 Error 도', () => {
    expect(errorText(new Error('연결 실패'))).toBe('연결 실패')
  })
  // catch 로 들어오는 게 Error 가 아닐 수 있다(문자열 throw 등).
  it('Error 가 아니어도 문자열을 만든다', () => {
    expect(errorText('그냥 문자열')).toBe('그냥 문자열')
    expect(errorText(undefined)).toBe('undefined')
  })
})
