import { KEYS, readJson, writeJson } from './localStore'

// 개인 환경 오버라이드 — 브라우저 localStorage 에만 저장(서버/팀에 안 올라감).
// 구조: { [environmentId]: { [key]: value } }. 실행 시 선택 환경의 개인 값을 서버로 함께 전송.

const KEY = KEYS.personalVars

type Store = Record<string, Record<string, string>>

function read(): Store {
  return readJson<Store>(KEY, {})
}
function write(s: Store) {
  // 프라이빗 모드에서 던지면 개인값 저장 한 번이 화면을 죽인다
  writeJson(KEY, s)
}

export function getPersonalVars(environmentId: string | null): Record<string, string> {
  if (!environmentId) return {}
  return read()[environmentId] ?? {}
}

export function setPersonalVar(environmentId: string, key: string, value: string) {
  const s = read()
  const env = { ...(s[environmentId] ?? {}) }
  if (value === '') delete env[key]
  else env[key] = value
  s[environmentId] = env
  write(s)
}
