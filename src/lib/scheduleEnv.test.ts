import { describe, expect, it } from 'vitest'
import { baseHost, isProdLike } from './scheduleEnv'
import type { EnvironmentRow } from './ui-types'

const env = (name: string, baseUrl?: string): EnvironmentRow => ({
  id: 'x', name,
  variables: baseUrl ? [{ id: 'v', key: 'baseUrl', value: baseUrl, secret: false }] : [],
})

// 운영 판별은 '주기 실행을 걸기 전에 한 번 더 물어볼지'를 정하는 안전 장치라,
// 실제로 쓰는 이름들이 확실히 걸리는지 고정해 둔다.
describe('isProdLike', () => {
  it('운영으로 읽히는 이름을 잡는다', () => {
    for (const n of ['운영', '운영 환경', 'prod', 'PROD', 'production', 'Live', '팀-운영'])
      expect(isProdLike(env(n)), n).toBe(true)
  })

  it('운영이 아닌 환경은 잡지 않는다 — 매번 확인 창이 뜨면 아무도 안 읽는다', () => {
    for (const n of ['스테이지', 'staging', 'dev', '개발', '도커', 'local', 'QA'])
      expect(isProdLike(env(n)), n).toBe(false)
  })

  it('환경이 지정되지 않으면 false', () => {
    expect(isProdLike(undefined)).toBe(false)
  })
})

describe('baseHost', () => {
  it('baseUrl 에서 호스트만 뽑는다', () => {
    expect(baseHost(env('운영', 'https://api.example.com/x'))).toBe('api.example.com')
  })

  it('URL 이 아니면 원문을 그대로 — 표시용이라 던지지 않는다', () => {
    expect(baseHost(env('개발', '{{host}}'))).toBe('{{host}}')
  })

  it('baseUrl 이 없으면 null', () => {
    expect(baseHost(env('개발'))).toBeNull()
  })
})
