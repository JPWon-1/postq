/**
 * 첫 요청을 한 번에 만든다 — 폴더를 먼저 만들고, 이름을 짓고, [+] 를 찾아야 하던 단계를 줄인다.
 *
 * - 'blank'   : '내 요청' 폴더 → 직접 만든 일반 폴더 중 첫 번째 → 없으면 '내 요청' 폴더를 만들어 '새 요청' 을 넣는다.
 *               OpenAPI 연동 폴더(specSourceType 'url')와 '예시' 폴더에는 넣지 않는다. 예전엔 folders[0] 에
 *               넣어서, 연동만 해 두고 요청이 0개인 프로젝트에선 빈 요청이 스펙 폴더 안에 섞였다.
 * - 'example' : '예시' 폴더에 공개 엔드포인트(GET httpbin.org/get) 요청을 넣는다.
 *               만들기만 한다 — 바깥 주소로 나가는 건 사용자가 [실행] 을 눌렀을 때뿐이다.
 */
import { fetchArray, fetchJson } from './fetchJson'
import type { FolderRow, RequestRow } from './ui-types'

export const EXAMPLE_FOLDER = '예시'
export const EXAMPLE_REQUEST = { name: '예시 — 공개 테스트 API (GET)', method: 'GET', url: 'https://httpbin.org/get' }
export const DEFAULT_FOLDER = '내 요청'
export const BLANK_REQUEST_NAME = '새 요청'

async function folderFor(workspaceId: string, kind: 'blank' | 'example'): Promise<string> {
  const folders = await fetchArray<FolderRow>(`/api/folders?workspaceId=${encodeURIComponent(workspaceId)}`)
  const plain = folders.filter(f => f.specSourceType !== 'url' && f.name !== EXAMPLE_FOLDER)
  const found = kind === 'example'
    ? folders.find(f => f.name === EXAMPLE_FOLDER)
    : plain.find(f => f.name === DEFAULT_FOLDER) ?? plain[0]
  if (found) return found.id
  const created = await fetchJson<FolderRow>('/api/folders', {
    method: 'POST',
    body: JSON.stringify({ name: kind === 'example' ? EXAMPLE_FOLDER : DEFAULT_FOLDER, specSourceType: 'none', specSourceUrl: null, workspaceId }),
  })
  return created.id
}

export async function createStarterRequest(workspaceId: string, kind: 'blank' | 'example'): Promise<RequestRow> {
  const folderId = await folderFor(workspaceId, kind)
  const body = kind === 'example'
    ? { folderId, ...EXAMPLE_REQUEST }
    : { folderId, name: BLANK_REQUEST_NAME }
  return fetchJson<RequestRow>('/api/requests', { method: 'POST', body: JSON.stringify(body) })
}

/**
 * 다음에 열리는 그 요청의 주소창에 커서를 둔다 — [curl 붙여넣기] 를 누른 뒤 바로 ⌘V 하게.
 * 요청 패널은 탭이 열린 뒤에야 그려지므로, 표시만 남겨 두고 패널이 뜰 때 가져간다.
 */
let pendingUrlFocus: string | null = null
export function focusUrlWhenOpened(requestId: string) { pendingUrlFocus = requestId }
export function takeUrlFocus(requestId: string): boolean {
  if (pendingUrlFocus !== requestId) return false
  pendingUrlFocus = null
  return true
}
