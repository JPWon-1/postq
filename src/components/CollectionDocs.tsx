'use client'
import { t as i18nText } from '@/i18n'
import { useCallback, useEffect, useState } from 'react'
import type { FolderRow, RequestRow } from '@/lib/ui-types'
import { displayName } from '@/lib/requestGroups'
import { errorText, fetchArray } from '@/lib/fetchJson'
import { KEYS, read, write } from '@/lib/localStore'
import { RequestDocView } from './RequestDocView'

type Scope = 'request' | 'folder' | 'all'

/**
 * 컬렉션 문서 뷰 — 구 /docs 의 "폴더별 전체 목록"을 되살린다.
 * 문서 모드가 열린 요청 하나만 보여주면 팀에 건넬 문서 화면이 없다.
 * 범위: 이 요청 / 이 폴더 / 전체.
 *
 * 기본은 '이 요청' 이다. 예전엔 '이 폴더' 였는데, 요청 하나를 고르고 [문서] 를 누른
 * 사람에게 폴더 141개를 펼쳐 보여주는 건 누른 것과 다른 걸 주는 셈이다.
 *
 * 그리고 고른 범위를 기억한다. 이 컴포넌트는 문서 모드일 때만 마운트되므로,
 * 실행 ↔ 문서 를 오갈 때마다 상태가 죽어 매번 기본값으로 되돌아갔다 — 범위를 바꿔 놔도
 * 탭을 한 번 오가면 원래대로였다.
 */
export function CollectionDocs({ workspaceId, activeRequest }: {
  workspaceId: string
  activeRequest: RequestRow | null
}) {
  const [scope, setScope] = useState<Scope>('request')
  // 마운트 뒤에 복원한다 — 서버 렌더와 어긋나면 첫 페인트가 번쩍인다.
  useEffect(() => {
    const stored = read(KEYS.docsScope)
    if (stored === 'request' || stored === 'folder' || stored === 'all') setScope(stored)
  }, [])
  const pickScope = (s: Scope) => { setScope(s); write(KEYS.docsScope, s) }
  const [folders, setFolders] = useState<FolderRow[]>([])
  const [reqs, setReqs] = useState<Record<string, RequestRow[]>>({})
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoaded(false)
    try {
      const fs = await fetchArray<FolderRow>(`/api/folders?workspaceId=${encodeURIComponent(workspaceId)}`)
      const map: Record<string, RequestRow[]> = {}
      const all = await fetchArray<RequestRow>(
        `/api/requests?workspaceId=${encodeURIComponent(workspaceId)}`)
      for (const f of fs) map[f.id] = []
      for (const r of all) (map[r.folderId] ??= []).push(r)
      setFolders(fs); setReqs(map)
      setLoadError(null)
    } catch (e) {
      // 못 불러온 걸 '문서화할 요청이 없습니다' 로 보여주면 문서가 사라진 줄 안다.
      setLoadError(errorText(e))
    } finally { setLoaded(true) }
  }, [workspaceId])
  useEffect(() => { load() }, [load])

  // 범위에 따라 보여줄 폴더/요청을 고른다.
  const visible = folders
    .map(f => {
      const list = reqs[f.id] ?? []
      if (scope === 'all') return { folder: f, list }
      if (scope === 'folder') return { folder: f, list: activeRequest && f.id === activeRequest.folderId ? list : [] }
      return { folder: f, list: activeRequest && f.id === activeRequest.folderId ? list.filter(r => r.id === activeRequest.id) : [] }
    })
    .filter(x => x.list.length > 0)

  const total = visible.reduce((n, x) => n + x.list.length, 0)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 border-b border-border pb-2">
        <span className="ah-label">{i18nText('uiDocumentRange')}</span>
        {([['request', i18nText('jsxThisRequest')], ['folder', i18nText('jsxThisFolder')], ['all', i18nText('jsxAll')]] as const).map(([val, label]) => (
          <button
            key={val}
            type="button"
            aria-pressed={scope === val}
            className={`rounded-[var(--radius-sm)] border px-2 py-0.5 text-ui-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
              scope === val ? 'border-accent bg-accent/15 text-accent' : 'border-border text-muted-foreground hover:border-border-strong hover:text-foreground'
            }`}
            onClick={() => pickScope(val)}
          >
            {label}
          </button>
        ))}
        {loaded && <span className="ml-auto text-ui-sm text-faint-foreground">{i18nText('uiRequest')} {total}{i18nText('uiCountSuffix')}</span>}
      </div>

      {!loaded && <p className="py-8 text-center text-ui-lg text-faint-foreground">{i18nText('uiLoading')}</p>}
      {loaded && total === 0 && (
        <p className="py-8 text-center text-ui-lg text-faint-foreground">
          {loadError
            ? i18nText('dynamicFailedToLoadDocumentItIsNotEmpty', { v0: String(loadError) })
            : activeRequest ? i18nText('jsxThereAreNoRequestsToDocumentInThisScope') : i18nText('jsxOpenTheRequestOnTheLeftAndYouWill')}
        </p>
      )}

      {visible.map(({ folder, list }) => (
        <section key={folder.id} className="flex flex-col gap-4">
          {scope !== 'request' && (
            <h2 className="border-b-2 border-border pb-1.5 text-[16px] font-bold text-foreground">
              {folder.name}
              <span className="ml-2 text-ui-sm font-normal text-faint-foreground">{list.length}{i18nText('uiCountSuffix')}</span>
            </h2>
          )}
          {list.map(r => (
            <div key={r.id} className="border-b border-border pb-4 last:border-b-0">
              <RequestDocView r={r} defaultExamplesOpen={scope === 'request'} />
            </div>
          ))}
        </section>
      ))}

      {loaded && total > 0 && (
        <p className="pt-1 text-ui-sm leading-relaxed text-faint-foreground">
          {i18nText('uiExampleResponseIsAfterExecution')} <b className="text-muted-foreground">{i18nText('uiFixedAsAnExample')}</b> {i18nText('uiOnlyTheExecutionYouPressedWillBeDisplayedThe')}{activeRequest ? displayName(activeRequest.name) : ''}{i18nText('uiGroupNameFormatsLikeLookGoodInDocuments')}
        </p>
      )}
    </div>
  )
}
