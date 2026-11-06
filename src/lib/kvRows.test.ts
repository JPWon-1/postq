import { describe, expect, it } from 'vitest'
import { applyKVEdit, shouldShowPhantom } from './kvRows'
import type { KV } from './variables'

const kv = (key: string, value = '', enabled = true): KV => ({ key, value, enabled })

describe('shouldShowPhantom', () => {
  it('행이 없으면 phantom을 보여준다', () => {
    expect(shouldShowPhantom([])).toBe(true)
  })
  it('마지막 행이 채워져 있으면 phantom을 보여준다', () => {
    expect(shouldShowPhantom([kv('a', '1')])).toBe(true)
    expect(shouldShowPhantom([kv('', 'value-only')])).toBe(true)
  })
  it('마지막 행이 비어 있으면 phantom을 더 만들지 않는다', () => {
    expect(shouldShowPhantom([kv('a', '1'), kv('')])).toBe(false)
  })
})

describe('applyKVEdit', () => {
  it('기존 행 수정은 그 행만 바꾸고 행 수를 유지한다 (phantom 미커밋)', () => {
    const items = [kv('a', '1'), kv('b', '2')]
    const next = applyKVEdit(items, 0, { value: 'edited' })
    expect(next).toHaveLength(2)
    expect(next[0]).toEqual(kv('a', 'edited'))
    expect(next[1]).toEqual(kv('b', '2'))
  })

  it('기존 행의 enabled 토글도 행 수를 유지한다', () => {
    const items = [kv('a', '1')]
    const next = applyKVEdit(items, 0, { enabled: false })
    expect(next).toHaveLength(1)
    expect(next[0].enabled).toBe(false)
  })

  it('phantom 행(index === items.length) 타이핑 시에만 새 행이 커밋된다', () => {
    const items = [kv('a', '1')]
    const next = applyKVEdit(items, 1, { key: 'b' })
    expect(next).toHaveLength(2)
    expect(next[1]).toEqual({ key: 'b', value: '', enabled: true })
  })

  it('빈 목록에서 phantom 타이핑은 첫 행을 만든다', () => {
    const next = applyKVEdit([], 0, { value: 'v' })
    expect(next).toEqual([{ key: '', value: 'v', enabled: true }])
  })

  it('원본 배열을 변경하지 않는다', () => {
    const items = [kv('a', '1')]
    applyKVEdit(items, 0, { value: 'x' })
    applyKVEdit(items, 1, { key: 'b' })
    expect(items).toEqual([kv('a', '1')])
  })
})
