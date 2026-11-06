'use client'
import { t as i18nText } from '@/i18n'
import { ToolButton } from './ToolButton'
import { renderVarHighlight } from './VariableText'
import { useEffect, useState } from 'react'
import { useFocusTrap } from '@/lib/useFocusTrap'
import { displayName, groupRequests } from '@/lib/requestGroups'
import type { FolderRow, RequestRow } from '@/lib/ui-types'

export function ScenarioRequestPicker({ folders, requests, onPick, onPickMany, onClose }: {
  onPickMany?: (requests: RequestRow[]) => void
  folders: FolderRow[]; requests: RequestRow[]
  onPick: (request: RequestRow) => void; onClose: () => void
}) {
  const ref = useFocusTrap<HTMLDivElement>(true)
  const [query, setQuery] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const selectedRequests = selectedIds.map(id => requests.find(r => r.id === id)).filter((r): r is RequestRow => !!r)
  useEffect(() => {
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [onClose])
  const term = query.trim().toLowerCase()
  const matches = folders.map(folder => ({ folder, items: requests.filter(r => r.folderId === folder.id && `${folder.name} ${r.name} ${r.method} ${r.url}`.toLowerCase().includes(term)) })).filter(f => f.items.length)
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={i18nText('uiSelectScenarioRequest')} className="flex h-[75vh] w-[min(960px,94vw)] flex-col overflow-hidden rounded-[var(--radius-lg)] border border-border bg-surface shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-border p-3">
          <h2 className="font-semibold">{i18nText('uiRequestToAddToStep')}</h2>
          <ToolButton icon="close" type="button" className="ah-action ml-auto ah-btn-icon" aria-label={i18nText('uiClose')} onClick={onClose} />
        </div>
        <div className="flex min-h-0 flex-1 flex-col p-3">
          <input autoFocus aria-label={i18nText('uiRequestSearch')} className="ah-input mb-3" placeholder={i18nText('uiSearchForFolderRequestNameOrURL')} value={query} onChange={e => setQuery(e.target.value)} />
          <div className="min-h-0 flex-1 overflow-auto">
            {matches.map(({ folder, items }) => <details key={`${folder.id}:${!!term}`} open={term ? true : undefined} className="mb-2 rounded-[var(--radius-sm)] border border-border">
              <summary className="cursor-pointer px-3 py-2 text-ui-md font-semibold">{folder.name} <span className="text-faint-foreground">({items.length})</span></summary>
              {groupRequests(items).map(({ group, items: children }) => {
                const rows = children.map(r => <div key={r.id} className="flex items-center gap-1 pl-3 hover:bg-surface-2">
                  {onPickMany && <label className="flex shrink-0 items-center gap-1"><input type="checkbox" aria-label={i18nText('dynamicSelect', { v0: String(r.name) })} checked={selectedIds.includes(r.id)} onChange={e => setSelectedIds(ids => e.target.checked ? [...ids, r.id] : ids.filter(id => id !== r.id))} />{selectedIds.includes(r.id) && <span className="text-ui-meta text-accent">{selectedIds.indexOf(r.id) + 1}</span>}</label>}
                  <button type="button" className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-surface-2 focus-visible:outline-accent" onClick={() => {
                    // 체크로 고른 것이 있으면 '선택 모드' 다 — 행을 눌러도 바로 추가하지 않고
                    // 선택을 토글한다. 예전엔 그 행 하나만 추가하고 모달을 닫아, 공들여 고른
                    // 나머지 선택이 아무 말 없이 버려졌다.
                    if (onPickMany && selectedIds.length) {
                      setSelectedIds(ids => ids.includes(r.id) ? ids.filter(id => id !== r.id) : [...ids, r.id])
                      return
                    }
                    onPick(r)
                  }}>
                  <span className="w-12 shrink-0 font-mono text-ui-sm text-accent">{r.method}</span>
                  <span className="min-w-0 flex-1"><span className="block text-ui-md">{displayName(r.name)}</span><span className="block truncate font-mono text-ui-sm text-faint-foreground">{renderVarHighlight(r.url)}</span></span>
                  <span className="text-ui-sm text-accent">{onPickMany && selectedIds.length ? (selectedIds.includes(r.id) ? i18nText('jsxSelected') : i18nText('jsxSelect')) : i18nText('jsxAdd2')}</span>
                </button></div>)
                return group ? <details key={group} open={term ? true : undefined} className="ml-4 border-t border-border"><summary className="cursor-pointer p-2 text-ui-md">{group}</summary>{rows}</details> : <div key="ungrouped">{rows}</div>
              })}
            </details>)}
            {!matches.length && <p className="p-6 text-center text-muted-foreground">{requests.length ? i18nText('jsxNoSearchResults') : i18nText('jsxThereAreNoSavedRequestsCreateOrImportA')}</p>}
          </div>
          {onPickMany && <div className="mt-2 flex shrink-0 flex-wrap items-center gap-2 border-t border-border pt-3">
            <span className="text-ui-sm text-muted-foreground">{selectedRequests.length}{i18nText('uiSelectAndAddInSelectedOrder')}</span>
            {selectedIds.length > 0 && <button type="button" className="text-ui-sm text-accent" onClick={() => setSelectedIds([])}>{i18nText('uiDeselect')}</button>}
            <button type="button" disabled={!selectedRequests.length} className="ml-auto rounded-[var(--radius-sm)] bg-accent-solid px-3 py-2 text-ui-md font-semibold text-accent-solid-foreground disabled:opacity-40" onClick={() => onPickMany(selectedRequests)}>{i18nText('uiSelected')} {selectedRequests.length}{i18nText('uiAddItemSuffix')}</button>
          </div>}
        </div>
      </div>
    </div>
  )
}
