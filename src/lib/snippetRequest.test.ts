import { describe, expect, it } from 'vitest'
import { prepareSnippet, type SnippetContext } from './snippetRequest'
import { toCurl } from './curl'
import { toFetch, toAxios, toPythonRequests } from './codegen'
import type { RequestInput } from './variables'

const request: RequestInput = { method: 'POST', url: 'https://example.test/file?key=old', headers: [], params: [], bodyType: 'none', body: '' }
const vars = { token: { value: 'NEVER-PRINT-TOKEN', secret: true }, password: { value: 'NEVER-PRINT-PASSWORD', secret: true }, version: { value: '2', secret: false } }
const generators = [(ctx: SnippetContext) => toCurl(request, vars, ctx).command, (ctx: SnippetContext) => toFetch(request, vars, ctx), (ctx: SnippetContext) => toAxios(request, vars, ctx), (ctx: SnippetContext) => toPythonRequests(request, vars, ctx)]
describe('실행과 같은 폴더 헤더·인증 병합', () => {
  it('활성 요청 헤더만 대소문자 무시로 폴더 헤더를 덮는다', () => {
    const { redacted } = prepareSnippet({ ...request, headers: [{ key: 'x-shared', value: 'request', enabled: true }, { key: 'X-Disabled', value: 'ignored', enabled: false }] }, vars, {
      folderHeaders: [{ key: 'X-Shared', value: 'folder', enabled: true }, { key: 'X-Disabled', value: '{{version}}', enabled: true }, { key: 'X-Off', value: 'off', enabled: false }],
    })
    expect(redacted.headers.filter(h => h.enabled)).toEqual([{ key: 'x-shared', value: 'request', enabled: true }, { key: 'X-Disabled', value: '2', enabled: true }])
  })
  it('상속 Bearer를 모든 언어에 반영하고 비밀값은 참조로 남긴다', () => {
    for (const generate of generators) {
      const code = generate({ auth: { type: 'inherit' }, folderAuth: { type: 'bearer', token: '{{token}}' }, folderHeaders: [{ key: 'X-Version', value: '{{version}}', enabled: true }] })
      expect(code).toContain('Bearer {{token}}')
      expect(code).toContain('X-Version')
      expect(code).not.toContain('NEVER-PRINT')
    }
  })
  it('명시적인 none·요청 인증·Authorization 헤더 우선순위를 지킨다', () => {
    expect(prepareSnippet(request, vars, { auth: { type: 'none' }, folderAuth: { type: 'bearer', token: '{{token}}' } }).redacted.headers).toEqual([])
    const ctx: SnippetContext = { auth: { type: 'basic', username: 'name', password: '{{password}}' }, folderAuth: { type: 'bearer', token: '{{token}}' }, folderHeaders: [{ key: 'Authorization', value: 'Bearer {{token}}', enabled: true }] }
    expect(prepareSnippet(request, vars, ctx).auth).toBeUndefined()
    expect(toCurl(request, vars, ctx).command).not.toContain('--user')
  })
  it('Basic 참조를 미리 base64로 가리지 않고 실행할 때 인코딩한다', () => {
    const ctx: SnippetContext = { auth: { type: 'inherit' }, folderAuth: { type: 'basic', username: 'name', password: '{{password}}' } }
    for (const generate of generators) { expect(generate(ctx)).toContain('{{password}}'); expect(generate(ctx)).not.toContain('NEVER-PRINT') }
    expect(toCurl(request, vars, ctx).command).toContain("--user 'name:{{password}}'")
    expect(toFetch(request, vars, ctx)).toContain('Buffer.from("name:{{password}}"')
    expect(toPythonRequests(request, vars, ctx)).toContain('base64.b64encode')
  })
  it('API key는 URL에 넣되 요청 params가 최종적으로 우선한다', () => {
    const ctx: SnippetContext = { auth: { type: 'inherit' }, folderAuth: { type: 'apikey', key: 'key', value: '{{token}}', in: 'query' } }
    expect(toCurl(request, vars, ctx).command).toContain('key={{token}}')
    expect(toCurl({ ...request, params: [{ key: 'key', value: 'override', enabled: true }] }, vars, ctx).command).toContain('key=override')
    for (const generate of generators) expect(generate(ctx)).not.toContain('NEVER-PRINT')
  })
  it('OAuth 토큰 요청은 코드로만 생성하고 본문·Basic 클라이언트 인증을 구분한다', () => {
    for (const clientAuth of ['body', 'basic'] as const) {
      const ctx: SnippetContext = { auth: { type: 'inherit' }, folderAuth: { type: 'oauth2cc', tokenUrl: 'https://example.test/token', clientId: 'client', clientSecret: '{{password}}', scope: 'read', clientAuth } }
      for (const generate of generators) {
        const code = generate(ctx)
        expect(code).toContain('client_credentials')
        expect(code).toContain('access_token')
        expect(code).toContain('{{password}}')
        expect(code).not.toContain('NEVER-PRINT')
      }
      expect(toCurl(request, vars, ctx).command.includes('--user')).toBe(clientAuth === 'basic')
    }
  })
  it('서버에서 비운 저장된 비밀 인증은 재입력 참조로 나타낸다', () => {
    for (const generate of generators) expect(generate({ auth: { type: 'inherit' }, folderAuth: { type: 'bearer', token: '', hasStoredSecret: true } })).toContain('Bearer {{bearerToken}}')
  })
  it('리터럴 인증과 자격증명 헤더도 노출하지 않는다', () => {
    for (const generate of generators) expect(generate({ auth: { type: 'bearer', token: 'literal-secret' } })).not.toContain('literal-secret')
    const code = toCurl(request, {}, { folderHeaders: [{ key: 'Authorization', value: 'Bearer literal-secret', enabled: true }] }).command
    expect(code).toContain('Bearer {{header_Authorization}}')
    expect(code).not.toContain('literal-secret')
  })
})
