import { describe, expect, it } from 'vitest'
import { importKind } from './importKind'

describe('importKind — 가져오기 파일 형식 판별', () => {
  it('postq 내보내기', () => expect(importKind({ postq: 1, folders: [] })).toBe('postq'))
  it('Postman 컬렉션', () => expect(importKind({ info: { schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [] })).toBe('collection'))
  it('Postman 환경', () => expect(importKind({ name: 'stage', values: [], _postman_variable_scope: 'environment' })).toBe('environment'))
  // 예전엔 이게 변수 0개짜리 환경으로 들어가고 '성공' 으로 떴다
  it('OpenAPI 3 문서는 환경이 아니다', () => expect(importKind({ openapi: '3.0.0', info: { title: 'x' }, paths: {} })).toBe('openapi'))
  it('Swagger 2 문서는 환경이 아니다', () => expect(importKind({ swagger: '2.0', info: { title: 'x' }, paths: {} })).toBe('openapi'))
  it('모르는 모양은 받지 않는다', () => {
    expect(importKind({ foo: 1 })).toBe('unknown')
    expect(importKind([])).toBe('unknown')
    expect(importKind(null)).toBe('unknown')
    expect(importKind({ values: 'x' })).toBe('unknown')
  })
})
