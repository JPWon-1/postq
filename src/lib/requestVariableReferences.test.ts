import { describe, expect, it } from 'vitest'
import { requestVariableReferences } from './requestVariableReferences'
import type { RequestInput } from './variables'
const input: RequestInput = { method: 'POST', url: '{{host}}/v1', params: [{ key: '{{queryKey}}', value: '{{query}}', enabled: true }], headers: [{ key: 'X-Own', value: '{{header}}', enabled: true }, { key: 'X-Off', value: '{{off}}', enabled: false }], bodyType: 'json', body: '{"value":{{body|json}}}' }
describe('request variable references', () => {
  it('includes effective inherited headers, auth and script inputs; excludes disabled and overridden values', () => {
    expect(requestVariableReferences(input, { auth: { type: 'inherit' }, folderAuth: { type: 'bearer', token: '{{token}}' }, folderHeaders: [{ key: 'x-own', value: '{{shadowed}}', enabled: true }, { key: 'X-Shared', value: '{{shared}}', enabled: true }] }, [{ name: 'derived', op: 'hmacSha256', input: '{{scriptInput}}', key: '{{scriptKey}}' }], [{ name: 'out', source: 'header', path: '{{postHeader}}' }])).toEqual(['host', 'queryKey', 'query', 'shared', 'header', 'body', 'token', 'scriptInput', 'scriptKey', 'postHeader'])
  })
  it('uses explicit request auth instead of folder auth and omits inactive body', () => {
    expect(requestVariableReferences({ ...input, params: [], headers: [], bodyType: 'none' }, { auth: { type: 'basic', username: '{{user}}', password: '{{password}}' }, folderAuth: { type: 'bearer', token: '{{unused}}' } })).toEqual(['host', 'user', 'password'])
  })
  it('deduplicates Unicode names and keeps built-ins visible as calculated variables', () => {
    expect(requestVariableReferences({ ...input, url: '{{주소}}/{{$uuid}}/{{주소}}', params: [], headers: [], body: '' })).toEqual(['주소', '$uuid'])
  })
})
