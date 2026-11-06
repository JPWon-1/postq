import { describe, expect, it } from 'vitest'
import { schemeProblem } from './wsUrl'

describe('schemeProblem', () => {
  it('ws / wss 는 통과한다', () => {
    expect(schemeProblem('ws://localhost:9999/socket')).toBeNull()
    expect(schemeProblem('wss://echo.example.com/socket')).toBeNull()
  })

  it('앞뒤 공백은 무시한다 — 붙여넣기하면 흔히 딸려온다', () => {
    expect(schemeProblem('  wss://echo.example.com  ')).toBeNull()
  })

  it('빈 주소는 입력을 요구한다', () => {
    expect(schemeProblem('')).toBe('주소를 입력하세요')
    expect(schemeProblem('   ')).toBe('주소를 입력하세요')
  })

  // 이게 이 함수를 만든 이유다 — 생성자가 http 를 ws 로 바꿔 버려 예외가 안 났다.
  it('http/https 는 걸러내고 고칠 주소를 제안한다', () => {
    expect(schemeProblem('http://nope')).toContain('ws://nope')
    expect(schemeProblem('https://a.example.com/x')).toContain('wss://a.example.com/x')
  })

  it('그 밖의 스킴은 스킴을 짚어 준다', () => {
    expect(schemeProblem('ftp://host/f')).toContain('ftp://')
  })

  it('URL 로 파싱되지 않으면 형식 오류로 알린다', () => {
    expect(schemeProblem('localhost:9999')).toBeTruthy()
    expect(schemeProblem('그냥 글자')).toContain('주소 형식이 올바르지 않습니다')
  })
})
