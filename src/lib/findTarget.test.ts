import { describe, expect, it } from 'vitest'
import { selectFindTarget } from './findTarget'

describe('find region selection', () => {
  const request = { value: 'request', top: 100, interaction: 0 }
  const response = { value: 'response', top: 500, interaction: 0 }
  it('uses screen order without interaction, regardless of registration order', () => {
    expect(selectFindTarget([response, request])).toBe('request')
  })
  it('uses the most recent click or focus, then lets the other region take over', () => {
    expect(selectFindTarget([request, { ...response, interaction: 1 }])).toBe('response')
    expect(selectFindTarget([{ ...request, interaction: 2 }, { ...response, interaction: 1 }])).toBe('request')
  })
  it('does not resurrect a remembered region excluded by visibility or modal scope', () => {
    expect(selectFindTarget([{ value: 'modal', top: 200, interaction: 0 }])).toBe('modal')
    expect(selectFindTarget([request])).toBe('request')
    expect(selectFindTarget([])).toBeUndefined()
  })
})
