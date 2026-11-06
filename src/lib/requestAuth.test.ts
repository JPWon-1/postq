import { describe, expect, it, vi } from 'vitest'
import { _clearTokenCache, buildAuthorization, maskAuthorization, maskAuthSecrets, resolveEffectiveAuth, sanitizeFolderAuth, type AuthConfig } from '@/lib/requestAuth'
import type { VarMap } from '@/lib/variables'

const vars: VarMap = { token: { value: 'T-123', secret: true }, secret: { value: 'S-xyz', secret: true } }
const okToken = (body: object) => vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }))

describe('buildAuthorization', () => {
  it('none → 헤더 없음', async () => {
    expect(await buildAuthorization({ type: 'none' }, {})).toEqual({})
  })

  it('bearer — {{token}} 치환', async () => {
    expect((await buildAuthorization({ type: 'bearer', token: '{{token}}' }, vars)).authorization).toBe('Bearer T-123')
  })

  it('basic — base64(user:pass)', async () => {
    expect((await buildAuthorization({ type: 'basic', username: 'u', password: 'p' }, {})).authorization).toBe(`Basic ${btoa('u:p')}`)
  })

  it('oauth2cc — 토큰 fetch + Bearer 주입(body) + secret 치환 + 캐시', async () => {
    _clearTokenCache()
    const fetchImpl = okToken({ access_token: 'AT-1', expires_in: 3600 })
    const cfg: AuthConfig = { type: 'oauth2cc', tokenUrl: 'https://idp/token', clientId: 'cid', clientSecret: '{{secret}}', scope: 'read', clientAuth: 'body' }
    const r = await buildAuthorization(cfg, vars, fetchImpl as unknown as typeof fetch)
    expect(r.authorization).toBe('Bearer AT-1')
    const body = String(fetchImpl.mock.calls[0][1]!.body)
    expect(body).toContain('grant_type=client_credentials')
    expect(body).toContain('client_secret=S-xyz')  // {{secret}} 치환됨
    // 캐시: 재호출은 fetch 안 함
    await buildAuthorization(cfg, vars, fetchImpl as unknown as typeof fetch)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('oauth2cc — basic 헤더 인증', async () => {
    _clearTokenCache()
    const fetchImpl = okToken({ access_token: 'AT-2' })
    await buildAuthorization({ type: 'oauth2cc', tokenUrl: 'https://idp/t2', clientId: 'cid', clientSecret: 'sec', clientAuth: 'basic' }, {}, fetchImpl as unknown as typeof fetch)
    const headers = fetchImpl.mock.calls[0][1]!.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Basic ${btoa('cid:sec')}`)
  })

  it('oauth2cc — 다른 clientSecret 은 캐시 재사용 안 함(토큰 탈취 방지)', async () => {
    _clearTokenCache()
    const fetchA = okToken({ access_token: 'A-TOKEN' })
    await buildAuthorization({ type: 'oauth2cc', tokenUrl: 'https://idp/tk', clientId: 'C', clientSecret: 'secretA', scope: 'S' }, {}, fetchA as unknown as typeof fetch)
    // 같은 tokenUrl/clientId/scope 지만 secret 다름 → 캐시 미스 → 자기 토큰 발급
    const fetchB = okToken({ access_token: 'B-TOKEN' })
    const r = await buildAuthorization({ type: 'oauth2cc', tokenUrl: 'https://idp/tk', clientId: 'C', clientSecret: 'secretB', scope: 'S' }, {}, fetchB as unknown as typeof fetch)
    expect(r.authorization).toBe('Bearer B-TOKEN')
    expect(fetchB).toHaveBeenCalledTimes(1)
  })

  it('oauth2cc — 리다이렉트 응답은 차단(SSRF)', async () => {
    _clearTokenCache()
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }))
    const r = await buildAuthorization({ type: 'oauth2cc', tokenUrl: 'https://idp/redir', clientId: 'C', clientSecret: 's' }, {}, fetchImpl as unknown as typeof fetch)
    expect(r.error).toContain('리다이렉트')
  })

  it('oauth2cc — 토큰 발급 실패 시 error', async () => {
    _clearTokenCache()
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }))
    const r = await buildAuthorization({ type: 'oauth2cc', tokenUrl: 'https://idp/t3', clientId: 'c', clientSecret: 's' }, {}, fetchImpl as unknown as typeof fetch)
    expect(r.error).toContain('토큰 발급 실패')
  })

  it('oauth2cc — 토큰 URL 이 메타데이터면 차단', async () => {
    _clearTokenCache()
    const r = await buildAuthorization({ type: 'oauth2cc', tokenUrl: 'http://169.254.169.254/token', clientId: 'c', clientSecret: 's' }, {})
    expect(r.error).toContain('메타데이터')
  })

  it('oauth2cc — 필수값 없으면 error', async () => {
    expect((await buildAuthorization({ type: 'oauth2cc', tokenUrl: '', clientId: '', clientSecret: '' }, {})).error).toContain('필요')
  })
})

describe('maskAuthorization', () => {
  it('스킴만 남기고 마스킹', () => {
    expect(maskAuthorization('Bearer SECRET-TOKEN')).toBe('Bearer ***')
    expect(maskAuthorization('Basic abc123==')).toBe('Basic ***')
  })
})

describe('maskAuthSecrets (export 자격증명 마스킹)', () => {
  it('리터럴 secret 은 공란, 비-secret 구성·{{var}} 참조는 보존', () => {
    expect(maskAuthSecrets({ type: 'bearer', token: 'literal-abc' })).toEqual({ type: 'bearer', token: '' })
    expect(maskAuthSecrets({ type: 'bearer', token: '{{token}}' })).toEqual({ type: 'bearer', token: '{{token}}' })
    expect(maskAuthSecrets({ type: 'basic', username: 'u', password: 'pw' })).toEqual({ type: 'basic', username: 'u', password: '' })
    expect(maskAuthSecrets({ type: 'oauth2cc', tokenUrl: 'x', clientId: 'c', clientSecret: 'sekret', scope: 'read', clientAuth: 'body' }))
      .toEqual({ type: 'oauth2cc', tokenUrl: 'x', clientId: 'c', clientSecret: '', scope: 'read', clientAuth: 'body' })
    expect(maskAuthSecrets({ type: 'none' })).toEqual({ type: 'none' })
  })
})

describe('resolveEffectiveAuth (폴더 인증 상속)', () => {
  const folderBearer: AuthConfig = { type: 'bearer', token: 'F' }
  it('요청이 inherit 이 아니면 요청 인증 우선(폴더 무시)', () => {
    const req: AuthConfig = { type: 'bearer', token: 'R' }
    expect(resolveEffectiveAuth(req, folderBearer)).toEqual(req)
  })
  it('요청이 inherit 이면 폴더 인증 사용', () => {
    expect(resolveEffectiveAuth({ type: 'inherit' }, folderBearer)).toEqual(folderBearer)
  })
  it('요청 inherit + 폴더 none → none', () => {
    expect(resolveEffectiveAuth({ type: 'inherit' }, { type: 'none' })).toEqual({ type: 'none' })
  })
  it('요청 inherit + 폴더 없음(null) → none', () => {
    expect(resolveEffectiveAuth({ type: 'inherit' }, null)).toEqual({ type: 'none' })
  })
  it('요청 none/null 은 그대로 none', () => {
    expect(resolveEffectiveAuth({ type: 'none' }, folderBearer)).toEqual({ type: 'none' })
    expect(resolveEffectiveAuth(null, folderBearer)).toEqual({ type: 'none' })
  })
  it('폴더가 inherit(비정상)이어도 상속받지 않고 none', () => {
    expect(resolveEffectiveAuth({ type: 'inherit' }, { type: 'inherit' } as AuthConfig)).toEqual({ type: 'none' })
  })
})

describe('sanitizeFolderAuth', () => {
  it('bearer/basic/oauth2cc 필드만 추림', () => {
    expect(sanitizeFolderAuth({ type: 'bearer', token: 't', junk: 1 })).toEqual({ type: 'bearer', token: 't' })
    expect(sanitizeFolderAuth({ type: 'basic', username: 'u', password: 'p' })).toEqual({ type: 'basic', username: 'u', password: 'p' })
    expect(sanitizeFolderAuth({ type: 'oauth2cc', tokenUrl: 'x', clientId: 'c', clientSecret: 's', clientAuth: 'basic' }))
      .toEqual({ type: 'oauth2cc', tokenUrl: 'x', clientId: 'c', clientSecret: 's', scope: '', clientAuth: 'basic' })
  })
  it('폴더는 inherit 불가 → none', () => {
    expect(sanitizeFolderAuth({ type: 'inherit' })).toEqual({ type: 'none' })
  })
  it('무효/누락 입력 → none, 필드는 문자열 강제', () => {
    expect(sanitizeFolderAuth(null)).toEqual({ type: 'none' })
    expect(sanitizeFolderAuth('nope')).toEqual({ type: 'none' })
    expect(sanitizeFolderAuth({ type: 'bearer' })).toEqual({ type: 'bearer', token: '' })
    expect(sanitizeFolderAuth({ type: 'bearer', token: 42 })).toEqual({ type: 'bearer', token: '' })
    expect(sanitizeFolderAuth({ type: 'oauth2cc', tokenUrl: 'x', clientId: 'c', clientSecret: 's' }).type).toBe('oauth2cc')
  })
})
