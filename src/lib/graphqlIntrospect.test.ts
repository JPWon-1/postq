import { describe, expect, it } from 'vitest'
import { simplifySchema, typeRefToString } from './graphqlIntrospect'

describe('typeRefToString', () => {
  it('NON_NULL/LIST 래핑을 SDL 표기로', () => {
    expect(typeRefToString({ kind: 'SCALAR', name: 'String' })).toBe('String')
    expect(typeRefToString({ kind: 'NON_NULL', name: null, ofType: { kind: 'SCALAR', name: 'ID' } })).toBe('ID!')
    expect(typeRefToString({ kind: 'LIST', name: null, ofType: { kind: 'NON_NULL', name: null, ofType: { kind: 'OBJECT', name: 'User' } } })).toBe('[User!]')
  })
})

describe('simplifySchema', () => {
  it('data.__schema → 타입/필드, 내부 __ 타입 제외', () => {
    const intro = { data: { __schema: {
      queryType: { name: 'Query' }, mutationType: null,
      types: [
        { kind: 'OBJECT', name: 'Query', fields: [{ name: 'me', type: { kind: 'OBJECT', name: 'User' }, args: [] }] },
        { kind: 'OBJECT', name: 'User', fields: [{ name: 'id', type: { kind: 'NON_NULL', name: null, ofType: { kind: 'SCALAR', name: 'ID' } }, args: [] }] },
        { kind: 'OBJECT', name: '__Type', fields: [{ name: 'x', type: { kind: 'SCALAR', name: 'String' }, args: [] }] },
        { kind: 'SCALAR', name: 'String', fields: null },
      ],
    } } }
    const s = simplifySchema(intro)!
    expect(s.queryType).toBe('Query')
    expect(s.types.map(t => t.name)).toEqual(['Query', 'User'])   // __Type·SCALAR 제외
    expect(s.types[1].fields[0]).toEqual({ name: 'id', type: 'ID!', args: [] })
  })
  it('스키마 없으면 null', () => {
    expect(simplifySchema({ data: {} })).toBeNull()
  })
})
