import { describe, expect, it } from 'vitest'
import { ko } from './ko'
import { en } from './en'

describe('translations', () => {
  it('has matching keys and interpolation variables', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ko).sort())
    for (const key of Object.keys(ko) as (keyof typeof ko)[]) {
      if (/\{\{|\{[가-힣]/.test(ko[key])) continue // Literal API variable examples, not interpolation slots.
      const variables = (value: string) => [...value.matchAll(/(?<!\{)\{([a-zA-Z0-9_]+)\}(?!\})/g)].map(match => match[1]).sort()
      expect(variables(en[key]), key).toEqual(variables(ko[key]))
    }
  })
})
