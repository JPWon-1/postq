import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStarterRequest, DEFAULT_FOLDER } from './starterRequest'

type Folder = { id: string; name: string; specSourceType: 'none' | 'url'; specSourceUrl: string | null }

/** /api/folders·/api/requests 만 흉내 내는 가짜 서버. 만든 폴더와 요청을 기록한다. */
function fakeServer(folders: Folder[]) {
  const createdFolders: { name: string }[] = []
  const createdRequests: { folderId: string; name?: string }[] = []
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    if (input.startsWith('/api/folders?')) return json(folders)
    if (input === '/api/folders' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { name: string }
      createdFolders.push(body)
      return json({ id: 'new-folder', name: body.name, specSourceType: 'none', specSourceUrl: null })
    }
    if (input === '/api/requests' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { folderId: string; name?: string }
      createdRequests.push(body)
      return json({ id: 'r1', ...body })
    }
    return new Response('not found', { status: 404 })
  }))
  return { createdFolders, createdRequests }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('createStarterRequest(blank) — 빈 요청이 들어갈 폴더', () => {
  it('OpenAPI 연동 폴더만 있으면 거기 넣지 않고 내 요청 폴더를 만든다', async () => {
    const s = fakeServer([{ id: 'openapi', name: 'Petstore', specSourceType: 'url', specSourceUrl: 'https://x/openapi.json' }])
    await createStarterRequest('ws', 'blank')
    expect(s.createdFolders).toEqual([expect.objectContaining({ name: DEFAULT_FOLDER })])
    expect(s.createdRequests[0].folderId).toBe('new-folder')
  })

  it('예시 폴더에도 넣지 않는다', async () => {
    const s = fakeServer([{ id: 'ex', name: '예시', specSourceType: 'none', specSourceUrl: null }])
    await createStarterRequest('ws', 'blank')
    expect(s.createdRequests[0].folderId).toBe('new-folder')
  })

  it('이미 있는 내 요청 폴더가 있으면 그 폴더를 쓴다 — 앞에 다른 직접 만든 폴더가 있어도', async () => {
    const s = fakeServer([
      { id: 'openapi', name: 'Petstore', specSourceType: 'url', specSourceUrl: 'https://x/openapi.json' },
      { id: 'other', name: '테스트', specSourceType: 'none', specSourceUrl: null },
      { id: 'mine', name: DEFAULT_FOLDER, specSourceType: 'none', specSourceUrl: null },
    ])
    await createStarterRequest('ws', 'blank')
    expect(s.createdFolders).toEqual([])
    expect(s.createdRequests[0].folderId).toBe('mine')
  })

  it('내 요청 폴더가 없으면 직접 만든 일반 폴더 중 첫 번째에 넣는다', async () => {
    const s = fakeServer([
      { id: 'openapi', name: 'Petstore', specSourceType: 'url', specSourceUrl: 'https://x/openapi.json' },
      { id: 'plain', name: '테스트', specSourceType: 'none', specSourceUrl: null },
    ])
    await createStarterRequest('ws', 'blank')
    expect(s.createdFolders).toEqual([])
    expect(s.createdRequests[0].folderId).toBe('plain')
  })
})
