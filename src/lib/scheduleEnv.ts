import type { EnvironmentRow } from './ui-types'

/**
 * 이 환경이 '운영으로 보이는가' — 이름 기반 휴리스틱.
 *
 * 이름은 언제든 바뀔 수 있으니 이것만 믿게 두지 않는다: 화면에는 항상 baseUrl 호스트를
 * 함께 찍어서 사람이 직접 확인할 수 있게 하고, 여기서 true 면 확인 창을 한 번 더 띄운다.
 * (주기 실행은 한 번 걸리면 조용히 매 주기 나가므로 등록 시점이 마지막 방어선이다.)
 */
export function isProdLike(env: EnvironmentRow | undefined): boolean {
  if (!env) return false
  return /운영|prod|production|live/i.test(env.name)
}

/** 환경의 baseUrl 호스트 — '어디로 나가는지'를 한 줄로 보여주기 위한 값. */
export function baseHost(env: EnvironmentRow | undefined): string | null {
  const raw = env?.variables.find(v => v.key === 'baseUrl')?.value
  if (!raw) return null
  try { return new URL(raw).host } catch { return raw }
}
