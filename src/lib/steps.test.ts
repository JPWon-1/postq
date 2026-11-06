import { describe, expect, it } from 'vitest'
import { preStepSecret } from '@/lib/steps'

describe('preStepSecret', () => {
  it('hmac은 기본 secret, 그 외 기본 아님, 명시 플래그 우선', () => {
    expect(preStepSecret({ name: 's', op: 'hmacSha256' })).toBe(true)
    expect(preStepSecret({ name: 'u', op: 'uuid' })).toBe(false)
    expect(preStepSecret({ name: 's', op: 'hmacSha256', secret: false })).toBe(false)
    expect(preStepSecret({ name: 'u', op: 'uuid', secret: true })).toBe(true)
  })
})
