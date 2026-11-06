import { describe, expect, it } from 'vitest'
import { validateAgainstSchema } from './schemaValidate'

const components = {
  schemas: {
    Order: {
      type: 'object',
      required: ['id', 'status'],
      properties: {
        id: { type: 'integer' },
        status: { type: 'string', enum: ['ACTIVE', 'USED'] },
        discount: { $ref: '#/components/schemas/Discount' },
        tags: { type: 'array', items: { type: 'string' } },
        memo: { type: 'string', nullable: true },
      },
    },
    Discount: { type: 'object', required: ['amount'], properties: { amount: { type: 'integer' } } },
  },
}
const schema = { $ref: '#/components/schemas/Order' }

describe('validateAgainstSchema', () => {
  it('스펙과 일치하면 ok', () => {
    const r = validateAgainstSchema(JSON.stringify({
      id: 1, status: 'ACTIVE', discount: { amount: 500 }, tags: ['a'], memo: null,
    }), schema, components)
    expect(r.ok).toBe(true)
    expect(r.issues).toEqual([])
  })

  it('필수 필드 누락을 잡는다', () => {
    const r = validateAgainstSchema(JSON.stringify({ id: 1 }), schema, components)
    expect(r.ok).toBe(false)
    expect(r.issues.some(i => i.path === 'status' && i.message.includes('필수'))).toBe(true)
  })

  it('타입 불일치를 잡는다 (중첩 $ref 포함)', () => {
    const r = validateAgainstSchema(JSON.stringify({ id: '1', status: 'ACTIVE', discount: { amount: 'x' } }), schema, components)
    expect(r.issues.some(i => i.path === 'id' && i.message.includes('타입'))).toBe(true)
    expect(r.issues.some(i => i.path === 'discount.amount')).toBe(true)
  })

  it('enum 벗어남을 잡는다', () => {
    const r = validateAgainstSchema(JSON.stringify({ id: 1, status: 'CANCELLED' }), schema, components)
    expect(r.issues.some(i => i.path === 'status' && i.message.includes('enum'))).toBe(true)
  })

  it('nullable 필드의 null 은 허용, 아닌 필드의 null 은 불일치', () => {
    expect(validateAgainstSchema(JSON.stringify({ id: 1, status: 'USED', memo: null }), schema, components).ok).toBe(true)
    const r = validateAgainstSchema(JSON.stringify({ id: null, status: 'USED' }), schema, components)
    expect(r.issues.some(i => i.path === 'id' && i.message.includes('null'))).toBe(true)
  })

  it('배열 원소 타입 검사', () => {
    const r = validateAgainstSchema(JSON.stringify({ id: 1, status: 'USED', tags: ['a', 3] }), schema, components)
    expect(r.issues.some(i => i.path === 'tags[1]')).toBe(true)
  })

  it('스키마/바디 없거나 JSON 아니면 스킵(ok)', () => {
    expect(validateAgainstSchema('{}', undefined).skipped).toBeTruthy()
    expect(validateAgainstSchema(null, schema, components).skipped).toBeTruthy()
    expect(validateAgainstSchema('plain text', schema, components).skipped).toBe('JSON 응답 아님')
  })

  it('oneOf/anyOf 는 관대하게 통과(오탐 방지)', () => {
    const poly = { oneOf: [{ type: 'string' }, { type: 'integer' }] }
    expect(validateAgainstSchema(JSON.stringify({ x: true }), poly).ok).toBe(true)
  })
})
