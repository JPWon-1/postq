import { decideExecution, isWriteMethod, type ExecutionPolicy, type ExecutionSource } from './executionPolicy'
import { extractPathParameters, extractVariables, type RequestInput, type VarMap } from './variables'

export type RunRow = {
  requestId: string; name: string; method: string
  state: 'waiting' | 'running' | 'passed' | 'failed' | 'skipped'
  status: number | null; durationMs: number | null; error: string | null
  missingVariables: string[]; ok: boolean; url?: string; responseBody?: string
  denialReason?: string
  assertions: { passed: number; total: number; results?: unknown[] }
}
export type RunPlan = {
  rows: RunRow[]; writeCount: number
  inputs: { name: string; value: string; secret: boolean; supplied: boolean }[]
}

/** Collect references before execution; generated values and request defaults need no prompt. */
export function collectRunInputs(items: { input: RequestInput; vars: VarMap; generated?: string[] }[], team: VarMap): RunPlan['inputs'] {
  const names = new Set<string>()
  for (const { input, vars, generated = [] } of items) {
    for (const name of [...extractVariables(input), ...extractPathParameters(input.url)]) {
      if (!generated.includes(name) && (!vars[name]?.value || team[name])) names.add(name)
    }
  }
  return [...names].map(name => ({ name, value: team[name]?.secret ? '' : team[name]?.value ?? '', secret: team[name]?.secret ?? false, supplied: !!team[name]?.value }))
}

export function planRunRows(rows: { id: string; name: string; method: string; aiExecutionAllowed?: boolean }[], policy?: ExecutionPolicy, includeWrites = false, source: ExecutionSource = 'flow'): RunRow[] {
  return rows.map(row => {
    const decision = decideExecution({ policy, method: row.method, source, aiExecutionAllowed: row.aiExecutionAllowed })
    const denialReason = decision.allowed ? undefined : decision.reason
    const error = denialReason ? `정책으로 건너뜀 — ${denialReason}` : !includeWrites && isWriteMethod(row.method) ? '쓰기 요청 제외 — 실행하려면 쓰기 포함을 선택하세요.' : null
    return { requestId: row.id, name: row.name, method: row.method, state: error ? 'skipped' : 'waiting', error, denialReason, status: null, durationMs: null, missingVariables: [], assertions: { passed: 0, total: 0 }, ok: false }
  })
}
