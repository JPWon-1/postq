import { fetchArray } from './fetchJson'
import type { RequestRow } from './ui-types'

/**
 * 프로젝트의 요청을 한 번에 받아 폴더별로 묶는다.
 *
 * 여러 화면이 '폴더마다 /api/requests?folderId=…' 를 부르고 있었다. 폴더가 12개면
 * 12번이고, 그때마다 바디까지 통째로 왔다 — 이름과 개수만 쓰는 자리인데도.
 * 트리에서 985KB → 279KB 로 줄인 것과 같은 문제가 다섯 군데 더 있었다.
 *
 * slim 은 트리가 쓰는 칸만 받는다(바디·헤더·인증 제외). 전체가 필요한 화면은
 * slim: false 로 부른다 — 문서 화면은 바디를 보여줘야 한다.
 */
export async function requestsByFolder(
  workspaceId: string,
  /**
   * slim 을 기본값으로 두지 않는다. 바디가 필요한 화면이 조용히 slim 을 받으면
   * undefined.matchAll 로 렌더가 통째로 죽는다 — 시나리오 화면에서 실제로 그랬다.
   * 부르는 쪽이 '무엇이 필요한지' 를 적게 한다.
   */
  { slim }: { slim: boolean },
): Promise<Record<string, RequestRow[]>> {
  const qs = `workspaceId=${encodeURIComponent(workspaceId)}${slim ? '&slim=1' : ''}`
  const all = await fetchArray<RequestRow>(`/api/requests?${qs}`)
  const map: Record<string, RequestRow[]> = {}
  // 폴더가 비어 있어도 키는 있어야 한다 — 부르는 쪽이 `?? []` 를 잊으면 조용히 깨진다.
  for (const r of all) (map[r.folderId] ??= []).push(r)
  return map
}
