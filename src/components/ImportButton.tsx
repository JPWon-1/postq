'use client'
import { t as i18nText } from '@/i18n'
import { ToolIcon } from './ToolButton'
import { useRef } from 'react'
import { useToast } from './Toast'
import { importKind } from '@/lib/importKind'

const BTN =
  'flex items-center gap-1 rounded-[var(--radius-sm)] bg-transparent px-1.5 py-1 text-ui-sm font-medium text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'

export const IMPORT_FORMATS = 'Postman 컬렉션·환경, postq 내보내기 파일(.json)'

/**
 * JSON 가져오기. 파일 내용으로 형식을 판별한다(importKind):
 * - `postq: 1` → postq 내보내기 (폴더/요청/환경 전체 복원)
 * - `info.schema` → Postman 컬렉션
 * - `values` 배열 → Postman 환경
 * - OpenAPI/Swagger 문서·그 밖 → 가져오지 않고 어디로 가야 하는지 알린다
 */
export function ImportButton({ workspaceId, onImported, big = false }: { workspaceId: string; onImported: () => void; big?: boolean; compact?: boolean }) {
  const toast = useToast()
  const fileRef = useRef<HTMLInputElement>(null)

  const handle = async (file: File) => {
    let json: unknown
    try { json = JSON.parse(await file.text()) } catch {
      toast('error', i18nText('dynamicImportFailedNotAValidJSONFileSelectThe'))
      return
    }
    const kind = importKind(json)
    if (kind === 'openapi') {
      toast('error', i18nText('dynamicOpenAPISwaggerDocumentsAreNotImportedHereIfYou'))
      return
    }
    if (kind === 'unknown') {
      toast('error', i18nText('dynamicItIsNotAPostqPostmanCollectionPostmanEnvironment'))
      return
    }
    try {
      const j = json as Record<string, unknown>
      let res: Response
      if (kind === 'postq') {
        res = await fetch('/api/import/postq', { method: 'POST', body: JSON.stringify({ ...j, workspaceId }) })
        const body = await res.json().catch(() => null)
        if (!res.ok || !body) { toast('error', i18nText('dynamicImportFailed', { v0: String(body?.error ?? res.status) })); return }
        toast('success', i18nText('dynamicImportCompletedFolderRequestEnvironment', { v0: String(body.folderCount), v1: String(body.requestCount), v2: String(body.environmentCount) }))
      } else {
        const isCollection = kind === 'collection'
        res = await fetch('/api/import/postman', {
          method: 'POST',
          body: JSON.stringify(isCollection ? { collection: j, workspaceId } : { environment: j, workspaceId }),
        })
        const body = await res.json().catch(() => null)
        if (!res.ok || !body) { toast('error', i18nText('dynamicImportFailed', { v0: String(body?.error ?? res.status) })); return }
        if (isCollection) {
          const s = body.summary ?? {}
          const notes: string[] = []
          if (s.withAuth) notes.push(i18nText('dynamicMappingToAuthenticationHeaders', { v0: String(s.withAuth) }))
          if (s.withScript) notes.push(i18nText('dynamicScriptsPreservedInDescriptionMigratedToSteps', { v0: String(s.withScript) }))
          if (s.withFileField) notes.push(i18nText('dynamicFileFieldsRequireReattachment', { v0: String(s.withFileField) }))
          const attention = s.withScript || s.withFileField
          toast(attention ? 'info' : 'success',
            i18nText('dynamicRetrievedRequests', { v0: String(body.requestCount), v1: String(notes.length ? ` — ${notes.join(', ')}` : '') }))
        } else {
          const count = (j.values as unknown[]).length
          const name = typeof j.name === 'string' && j.name ? `'${j.name}' ` : ''
          toast('success', i18nText('dynamicGetEnvironmentVariablesYouCanSelectFromTheEnvironment', { v0: String(name), v1: String(count) }))
        }
      }
      onImported()
    } catch (e) {
      toast('error', i18nText('dynamicImportFailed', { v0: String(e instanceof Error ? e.message : String(e)) }))
    }
  }

  return (
    <>
      <button
        type="button"
        aria-label={big ? undefined : i18nText('dynamicImportFile', { v0: String(IMPORT_FORMATS) })}
        title={i18nText('dynamicImportAutomaticallyDeterminesFormat', { v0: String(IMPORT_FORMATS) })}
        className={big
          // 빈 상태의 1순위([+ 새 요청])보다 크거나 진하면 두 버튼이 경쟁한다 — 같은 높이의 테두리 버튼.
          ? 'flex h-8 items-center gap-1.5 rounded-[var(--radius-sm)] border border-border bg-transparent px-3 text-ui-md font-medium text-foreground transition-colors hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
          : BTN}
        onClick={() => fileRef.current?.click()}
      >
        <ToolIcon name="import" /><span >{big ? i18nText('jsxImportFile') : i18nText('jsxImport')}</span>
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={e => { const f = e.target.files?.[0]; if (f) handle(f); e.target.value = '' }}
      />
    </>
  )
}

/** 전체 워크스페이스를 postq JSON 으로 다운로드한다 (secret 실값 제외). */
export function ExportButton() {
  return (
    <a
      href="/api/export"
      download
      aria-label={i18nText('uiExportEntireProjectJSONExcludingSecretValues')}
      title={i18nText('uiExportDownloadEntireJSONForFolderRequestEnvironmentExcluding')}
      className={BTN}
    >
      <ToolIcon name="export" /> {i18nText('uiExport')}
    </a>
  )
}
