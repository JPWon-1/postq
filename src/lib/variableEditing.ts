import { getPersonalVars, setPersonalVar } from './personalVars'
import { fetchArray } from './fetchJson'
import type { EnvironmentRow } from './ui-types'

export type VariableEditScope = 'env' | 'all' | 'project' | 'personal'
export type VariableEditTarget = { workspaceId: string; environmentId: string | null; onSaved: () => void }
export type EditableVariable = { id?: string; key: string; value: string; secret: boolean }
export const VARIABLE_SCOPE_LABELS: Record<VariableEditScope, string> = { env: '현재 환경', all: '전역', project: '프로젝트 공통', personal: '내 개인 값' }
export function defaultVariableScope(source: string | undefined, environmentId: string | null, name: string): VariableEditScope {
  if (getPersonalVars(environmentId)[name] !== undefined) return 'personal'
  if (source === '전역') return 'all'
  if (source === '프로젝트') return 'project'
  return environmentId ? 'env' : 'all'
}

/** 팝오버와 인라인 표가 같은 저장·충돌·비밀값 보존 규칙을 사용한다. */
export async function saveVariable(target: VariableEditTarget, name: string, value: string, scope: VariableEditScope, secret: boolean) {
  if (scope === 'personal') {
    if (!target.environmentId) throw new Error('현재 환경을 먼저 선택하세요')
    setPersonalVar(target.environmentId, name, value)
  } else {
    const env = scope === 'env'
    if (env && !target.environmentId) throw new Error('현재 환경을 먼저 선택하세요')
    const workspaceId = scope === 'all' ? '*' : target.workspaceId
    const url = env ? `/api/environments/${encodeURIComponent(target.environmentId!)}` : `/api/global-vars?workspaceId=${encodeURIComponent(workspaceId)}`
    let rows: EditableVariable[]
    let payload: Record<string, unknown>
    if (env) {
      const environments = await fetchArray<EnvironmentRow>(`/api/environments?workspaceId=${encodeURIComponent(target.workspaceId)}`)
      const data = environments.find(row => row.id === target.environmentId)
      if (!data || !Array.isArray(data.variables)) throw new Error('환경을 불러오지 못했습니다')
      rows = data.variables
      payload = { name: data.name, executionPolicy: data.executionPolicy, ifUpdatedAt: data.updatedAt }
    } else {
      rows = await fetchArray<EditableVariable>(url)
      payload = { workspaceId }
    }
    const previous = rows.find(row => row.key === name)
    payload.variables = [...rows.filter(row => row.key !== name), { ...previous, key: name, value, secret: previous?.secret ?? secret }]
    const response = await fetch(env ? url : '/api/global-vars', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    if (!response.ok) throw new Error(response.status === 409 ? '다른 변경이 저장되었습니다. 다시 확인 후 저장하세요.' : `저장 실패 (${response.status})`)
  }
  target.onSaved()
  window.dispatchEvent(new Event('postq:variables-updated'))
}
