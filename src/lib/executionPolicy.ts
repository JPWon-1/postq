/** Pure policy decision shared by every execution entry point and the UI. */
export const executionPolicies = ['open', 'confirm-writes', 'read-only'] as const
export type ExecutionPolicy = typeof executionPolicies[number]
export type ExecutionSource = 'ui' | 'mcp' | 'schedule' | 'flow'
export const sourceLabels: Record<ExecutionSource, string> = { ui: '사람 화면', mcp: 'MCP', schedule: '스케줄', flow: '플로우' }
export function isExecutionPolicy(v: unknown): v is ExecutionPolicy {
  return executionPolicies.includes(v as ExecutionPolicy)
}
export function isWriteMethod(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.trim().toUpperCase())
}
export function decideExecution(input: {
  policy?: ExecutionPolicy; method: string; source: ExecutionSource
  aiExecutionAllowed?: boolean; confirmed?: boolean
}): { allowed: true } | { allowed: false; reason: string; confirmationRequired?: boolean } {
  if (!isWriteMethod(input.method)) return { allowed: true }
  if (input.policy === 'read-only') return { allowed: false, reason: '읽기 전용 환경에서 쓰기 요청이 차단되었습니다.' }
  if (input.policy === 'confirm-writes' && input.source !== 'ui') {
    return { allowed: false, reason: input.source === 'flow'
      ? '쓰기 확인이 필요한 환경이라 시나리오에서는 실행되지 않음 — 요청 화면에서 확인 후 실행'
      : '쓰기 확인이 필요한 환경입니다. 사람이 요청 화면에서 확인 후 실행해야 합니다.' }
  }
  if (input.source === 'mcp' && !input.aiExecutionAllowed) {
    return { allowed: false, reason: 'AI 실행 허용이 꺼진 요청입니다. 사람이 요청 설정에서 허용해야 실행할 수 있습니다.' }
  }
  if (input.policy === 'confirm-writes' && input.confirmed !== true) {
    return { allowed: false, reason: '쓰기 요청이 아직 확인되지 않아 실행되지 않았습니다.', confirmationRequired: true }
  }
  return { allowed: true }
}

/** OpenAPI's scalar query/header types; unknown or composite schemas are left alone. */
export function parameterTypeError(contract: import('./apiContract').ApiContract | null | undefined, input: import('./variables').RequestInput): string | undefined {
  if (!contract) return
  let query: URLSearchParams
  try { query = new URL(input.url).searchParams } catch { return }
  for (const p of input.params) if (p.enabled && p.key) query.set(p.key, p.value)
  for (const [path, field] of Object.entries(contract.fields)) {
    const match = /^요청 (query|header)\.([^.[\]]+)$/.exec(path)
    if (!match) continue
    const [, location, name] = match
    const value = location === 'query' ? query.get(name) : input.headers.find(h => h.enabled && h.key.toLowerCase() === name.toLowerCase())?.value
    if (value == null) continue
    const valid = field.type === 'integer' ? /^[+-]?\d+$/.test(value) && Number.isSafeInteger(Number(value))
      : field.type === 'number' ? value.trim() !== '' && Number.isFinite(Number(value))
      : field.type === 'boolean' ? /^(true|false)$/.test(value)
      : true
    if (!valid) return `${location} 파라미터 '${name}'의 값이 ${field.type} 형식이 아니어서 실행되지 않았습니다.`
  }
}

/** Runtime data cannot retarget a saved request, including protocol/port/userinfo changes. */
export function executionTargetError(before: string, after: string): string | undefined {
  if (before === after) return
  try {
    const a = new URL(before), b = new URL(after)
    if (/[{}]/.test(a.host) || a.origin !== b.origin || a.username !== b.username || a.password !== b.password) {
      return '실행 입력으로 URL 호스트·프로토콜·포트·자격증명을 변경할 수 없습니다. 저장된 환경을 선택하세요.'
    }
  } catch { return '저장된 URL 호스트를 확인할 수 없어 실행 입력의 URL 변경이 거부되었습니다.' }
}
