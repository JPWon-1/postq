import { fetchArray } from './fetchJson'

/**
 * 환경에 속하지 않는 변수의 두 단계.
 *   all     — 전역: 모든 프로젝트가 함께 쓴다 (토큰·공용 호스트)
 *   project — 프로젝트 공통: 이 프로젝트의 모든 환경이 함께 쓴다
 * 실행 때 서버(loadTeamVars)는 전역 < 프로젝트 < 환경 순으로 덮는다. 화면도 같은 순서로 합친다.
 */
export type SharedScope = 'all' | 'project'
export type SharedVar = { key: string; value: string; secret: boolean; scope: SharedScope }

/** 서버 스코프 id — '*' 는 모든 프로젝트 (varmap.ts 의 ALL_PROJECTS 와 같은 값). */
export const sharedScopeWorkspace = (scope: SharedScope, workspaceId: string) => (scope === 'all' ? '*' : workspaceId)

export const SHARED_SCOPE_LABEL: Record<SharedScope, string> = { all: '전역', project: '프로젝트' }

type Row = { key: string; value: string; secret: boolean }

/** 같은 키는 프로젝트가 이긴다. */
export function mergeShared(all: Row[], project: Row[]): SharedVar[] {
  const map = new Map<string, SharedVar>()
  for (const v of all) map.set(v.key, { ...v, scope: 'all' })
  for (const v of project) map.set(v.key, { ...v, scope: 'project' })
  return [...map.values()]
}

export async function fetchSharedVars(workspaceId: string): Promise<SharedVar[]> {
  const url = (ws: string) => `/api/global-vars?workspaceId=${encodeURIComponent(ws)}`
  const [all, project] = await Promise.all([fetchArray<Row>(url('*')), fetchArray<Row>(url(workspaceId))])
  return mergeShared(all, project)
}
