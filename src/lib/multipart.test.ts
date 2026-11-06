import { describe, expect, it } from 'vitest'
import { buildFormData, parseMultipartBody } from './multipart'

describe('parseMultipartBody', () => {
  it('fields/files 파싱', () => {
    const spec = parseMultipartBody(JSON.stringify({ fields: [{ name: 'a', value: '1' }], files: [{ name: 'f', filename: 'x.txt', dataBase64: 'aGk=' }] }))
    expect(spec.fields).toEqual([{ name: 'a', value: '1' }])
    expect(spec.files[0].filename).toBe('x.txt')
  })
  it('잘못된 JSON은 빈 스펙', () => {
    expect(parseMultipartBody('nope')).toEqual({ fields: [], files: [] })
  })
})

describe('buildFormData', () => {
  it('필드와 파일을 FormData로 (파일은 Blob+filename)', async () => {
    const fd = buildFormData({ fields: [{ name: 'title', value: 'hello' }], files: [{ name: 'upload', filename: 'a.txt', contentType: 'text/plain', dataBase64: 'aGk=' }] })
    expect(fd.get('title')).toBe('hello')
    const file = fd.get('upload') as File
    expect(file).toBeInstanceOf(File)
    expect(file.name).toBe('a.txt')
    expect(await file.text()).toBe('hi') // aGk= = "hi"
  })
  it('data: URI 접두 제거하고 디코딩', async () => {
    const fd = buildFormData({ fields: [], files: [{ name: 'f', filename: 'b', dataBase64: 'data:text/plain;base64,aGk=' }] })
    expect(await (fd.get('f') as File).text()).toBe('hi')
  })
  it('name/filename 없는 파일은 스킵', () => {
    const fd = buildFormData({ fields: [], files: [{ name: '', filename: 'x', dataBase64: 'aGk=' }] })
    expect([...fd.keys()]).toEqual([])
  })
})
