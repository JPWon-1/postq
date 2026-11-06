import { describe, it, expect } from 'vitest'
import { parseBinaryBody } from './binary'
import { toCurl } from './curl'
import { toFetch, toAxios, toPythonRequests } from './codegen'
import type { RequestInput } from './variables'
describe('binary snippets', () => {
  const input: RequestInput = { method: 'POST', url: 'https://example.com/file', params: [], headers: [], bodyType: 'binary', body: JSON.stringify({ filename: "a'b.bin", contentType: 'image/png', dataBase64: 'AAH/gA0K' }) }
  it('references a file instead of serializing the wrapper or payload', () => {
    for (const code of [toCurl(input, {}).command, toFetch(input, {}), toAxios(input, {}), toPythonRequests(input, {})]) {
      expect(code).toContain('image/png')
      expect(code).not.toContain('AAH/gA0K')
      expect(code).not.toContain('dataBase64')
    }
    expect(toCurl(input, {}).command).toContain("--data-binary '@a'\\''b.bin'")
    expect(toFetch(input, {})).toContain("readFileSync('a\\'b.bin')")
    expect(toAxios(input, {})).toContain("readFileSync('a\\'b.bin')")
    expect(toPythonRequests(input, {})).toContain('Path("a\'b.bin").read_bytes()')
  })
  it('keeps explicit MIME and distinguishes empty files from missing attachments', () => {
    expect(toCurl({ ...input, headers: [{ key: 'Content-Type', value: 'custom/type', enabled: true }] }, {}).command).not.toContain('image/png')
    expect(parseBinaryBody('{"dataBase64":""}').dataBase64).toBe('')
    expect(parseBinaryBody('{"filename":"file.bin"}').dataBase64).toBeNull()
    expect(parseBinaryBody('invalid').contentType).toBe('application/octet-stream')
  })
})
