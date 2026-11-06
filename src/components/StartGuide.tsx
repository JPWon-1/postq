'use client'
import { t as i18nText } from '@/i18n'
import { useState } from 'react'
import { ImportButton } from './ImportButton'

export type StartActions = {
  /** '예시' 폴더에 공개 엔드포인트 요청을 만들어 연다. 실행은 사용자가 [실행] 을 눌러야 한다. */
  onExample: () => Promise<void>
  onBlank: () => Promise<void>
  /** 빈 요청을 만들어 열고 주소창에 커서를 둔다. */
  onCurl: () => Promise<void>
  onImported: () => void
  /** 컬렉션의 폴더 만들기 폼을 OpenAPI 주소 칸까지 펼쳐 연다. */
  onOpenApi: () => void
}

const SECONDARY = 'flex h-8 items-center gap-1.5 rounded-[var(--radius-sm)] border border-border bg-transparent px-3 text-ui-md font-medium text-foreground transition-colors hover:bg-surface-2 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'

/**
 * 요청이 하나도 없는 프로젝트의 첫 화면.
 *
 * 예전엔 여기에 '이어서 하기' 가 떠서 '최근 실행·즐겨찾기·오늘 실패·스펙 변경 — 0' 네 줄이
 * 화면에서 가장 넓은 자리를 차지했다. 처음 온 사람에게는 이어서 할 것이 없다 — 시작할 길을 보여준다.
 * 요청이 하나라도 생기면 '이어서 하기' 로 돌아간다.
 */
export function StartGuide({ workspaceId, actions }: { workspaceId: string; actions: StartActions }) {
  const [busy, setBusy] = useState<null | 'example' | 'blank' | 'curl'>(null)
  const run = (kind: 'example' | 'blank' | 'curl', fn: () => Promise<void>) => async () => {
    if (busy) return
    setBusy(kind)
    try { await fn() } finally { setBusy(null) }
  }
  return (
    <div className="mx-auto flex min-h-full max-w-xl items-center px-6 py-10" data-testid="start-guide">
      <section aria-labelledby="start-guide-title" className="w-full space-y-4 p-4">
        <div className="space-y-3">
          <h1 id="start-guide-title" className="text-ui-lg font-semibold text-foreground">{i18nText('uiGettingStarted')}</h1>
          <p className="text-ui-md text-muted-foreground">{i18nText('uiGetStartedByCreatingARequestOrImportingA')}</p>
        </div>

        <div className="space-y-2">
          <button
            type="button"
            disabled={busy !== null}
            onClick={run('example', actions.onExample)}
            className="h-9 rounded-[var(--radius-sm)] bg-accent-solid px-4 text-ui-md font-semibold text-accent-solid-foreground transition-colors hover:bg-accent-solid-hover disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {busy === 'example' ? i18nText('jsxMaking') : i18nText('jsxOpenExampleRequest')}
          </button>

        </div>

        <div className="space-y-2">

          <div className="flex flex-wrap gap-2">
            <button type="button" className={SECONDARY} disabled={busy !== null} onClick={run('blank', actions.onBlank)}>
              {busy === 'blank' ? i18nText('jsxMaking') : i18nText('jsxEmptyRequest')}
            </button>
            <button type="button" className={SECONDARY} disabled={busy !== null} onClick={run('curl', actions.onCurl)}>
              {busy === 'curl' ? i18nText('jsxMaking') : i18nText('jsxCurlPaste')}
            </button>
            <ImportButton workspaceId={workspaceId} onImported={actions.onImported} big />
            <button type="button" className={SECONDARY} onClick={actions.onOpenApi}>{i18nText('uiAddAsOpenAPIAddress')}</button>
          </div>

        </div>
        <p className="text-ui-sm text-faint-foreground">{i18nText('uiKSearchForRequestsAndCommandsFromAnywhere')}</p>
      </section>
    </div>
  )
}
