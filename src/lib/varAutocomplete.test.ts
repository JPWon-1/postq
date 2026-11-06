import { describe, expect, it } from 'vitest'
import { applyVariable, suggestVariables } from '@/lib/varAutocomplete'

const NAMES = ['baseUrl', 'token', 'memberCode']

describe('suggestVariables', () => {
  it('커서가 {{ba| 위치면 baseUrl 을 제안한다 (prefix 매칭)', () => {
    const s = suggestVariables('{{ba', 4, NAMES)
    expect(s.open).toBe(true)
    expect(s.query).toBe('ba')
    expect(s.start).toBe(0)
    expect(s.matches).toEqual(['baseUrl'])
  })

  it('{{만 치면 전체 변수 목록을 제안한다 (query 빈 문자열)', () => {
    const s = suggestVariables('https://x.com/{{', 16, NAMES)
    expect(s.open).toBe(true)
    expect(s.query).toBe('')
    expect(s.start).toBe(14)
    expect(s.matches).toEqual(NAMES)
  })

  it('이미 }}로 닫힌 {{baseUrl}} 뒤에서는 제안하지 않는다', () => {
    const text = '{{baseUrl}}/path'
    expect(suggestVariables(text, text.length, NAMES).open).toBe(false)
    // 커서가 정확히 }} 직후일 때도 미제안
    expect(suggestVariables('{{baseUrl}}', 11, NAMES).open).toBe(false)
  })

  it('여는 {{가 여러 개면 커서에 가장 가까운 것을 기준으로 한다', () => {
    const text = '{{baseUrl}}/users?token={{to'
    const s = suggestVariables(text, text.length, NAMES)
    expect(s.open).toBe(true)
    expect(s.query).toBe('to')
    expect(s.start).toBe(text.lastIndexOf('{{'))
    expect(s.matches).toEqual(['token'])
  })

  it('{{가 없으면 미제안', () => {
    expect(suggestVariables('https://x.com/plain', 10, NAMES).open).toBe(false)
    expect(suggestVariables('', 0, NAMES).open).toBe(false)
  })

  it('대소문자를 무시하고 매칭한다', () => {
    const s = suggestVariables('{{BASE', 6, NAMES)
    expect(s.open).toBe(true)
    expect(s.matches).toEqual(['baseUrl'])
  })

  it('변수명이 될 수 없는 문자가 섞이면 미제안 ({{foo bar 처럼)', () => {
    expect(suggestVariables('{{foo bar', 9, NAMES).open).toBe(false)
  })

  it('매칭되는 변수가 없으면 미제안', () => {
    expect(suggestVariables('{{zzz', 5, NAMES).open).toBe(false)
    expect(suggestVariables('{{ba', 4, []).open).toBe(false)
  })

  it('커서 뒤의 텍스트는 판단에 영향을 주지 않는다 (커서 앞 기준)', () => {
    // '{{ba|' 뒤에 다른 내용이 있어도 커서 앞만 본다
    const s = suggestVariables('{{ba and more', 4, NAMES)
    expect(s.open).toBe(true)
    expect(s.matches).toEqual(['baseUrl'])
  })
})

describe('applyVariable', () => {
  it('{{query 구간을 {{이름}}으로 치환하고 커서를 닫는 괄호 뒤로 옮긴다', () => {
    const r = applyVariable('{{ba/path', 4, 0, 'baseUrl')
    expect(r.text).toBe('{{baseUrl}}/path')
    expect(r.caret).toBe('{{baseUrl}}'.length)
  })

  it('커서 뒤에 남은 변수 조각과 }}가 있으면 중복되지 않게 흡수한다', () => {
    // '{{ba|se}}' 상태에서 baseUrl 선택 → '{{baseUrl}}'
    const r = applyVariable('{{base}} tail', 4, 0, 'baseUrl')
    expect(r.text).toBe('{{baseUrl}} tail')
  })

  it('문장 중간의 {{도 올바르게 치환한다', () => {
    const text = 'x={{to&y=1'
    const r = applyVariable(text, 6, 2, 'token')
    expect(r.text).toBe('x={{token}}&y=1')
    expect(r.caret).toBe('x={{token}}'.length)
  })
})
