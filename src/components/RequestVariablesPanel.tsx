'use client'
import { t as i18nText } from '@/i18n'
import type { TranslationKey } from '@/i18n'
import { useContext, useEffect, useRef, useState } from 'react'
import type { LiveRequest } from './RightPanel'
import { VariableEditContext } from './VariablePopover'
import { VariableValueInput } from './VariableValueInput'
import { TooltipButton } from './TooltipButton'
import { ToolButton } from './ToolButton'
import { getPersonalVars } from '@/lib/personalVars'
import { fetchArray } from '@/lib/fetchJson'
import type { EnvironmentRow } from '@/lib/ui-types'
import { saveVariable, type EditableVariable, type VariableEditScope } from '@/lib/variableEditing'
import { requestVariableReferences } from '@/lib/requestVariableReferences'

type Scope = VariableEditScope | 'request' | 'dynamic' | 'script' | 'undefined'
type Row = { name: string; value: string; secret: boolean; scope: Scope }
const BADGES: Record<Scope, [string, TranslationKey]> = {
  env: ['E', 'currentEnvironment'], all: ['G', 'globalScope'], personal: ['P', 'personalValue'], project: ['W', 'projectShared'],
  request: ['R', 'requestVariableScope'], dynamic: ['D', 'dynamicVariableScope'], script: ['S', 'scriptVariableScope'], undefined: ['!', 'undefinedScope'],
}
const EDIT_SCOPE_KEYS: Record<VariableEditScope, TranslationKey> = {
  env: 'currentEnvironment', all: 'globalScope', project: 'projectShared', personal: 'personalValue',
}
const SCOPES: VariableEditScope[] = ['env', 'all', 'project', 'personal']

export function RequestVariablesPanel({ live, onSettings }: { live: LiveRequest; onSettings: () => void }) {
  const context = useContext(VariableEditContext)
  const [definitions, setDefinitions] = useState<Row[]>([])
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const refresh = () => setRevision(value => value + 1)
    window.addEventListener('postq:variables-updated', refresh)
    return () => window.removeEventListener('postq:variables-updated', refresh)
  }, [])
  useEffect(() => {
    if (!context) return
    let alive = true
    const { workspaceId, environmentId } = context
    setDefinitions([]); setError('')
    void Promise.all([
      fetchArray<EditableVariable>('/api/global-vars?workspaceId=*'),
      fetchArray<EditableVariable>(`/api/global-vars?workspaceId=${encodeURIComponent(workspaceId)}`),
      fetchArray<EnvironmentRow>(`/api/environments?workspaceId=${encodeURIComponent(workspaceId)}`),
    ]).then(([all, project, environments]) => {
      if (!alive) return
      const rows = (values: EditableVariable[], scope: VariableEditScope): Row[] => values.map(value => ({ name: value.key, value: value.value, secret: value.secret, scope }))
      setDefinitions([
        ...rows(environments.find(env => env.id === environmentId)?.variables ?? [], 'env'),
        ...rows(all, 'all'), ...rows(project, 'project'),
        ...Object.entries(getPersonalVars(environmentId)).map(([name, value]): Row => ({ name, value, secret: true, scope: 'personal' })),
      ])
    }).catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : i18nText('dynamicFailedToLoadVariable')) })
    return () => { alive = false }
  }, [context?.workspaceId, context?.environmentId, revision])
  const names = live.referencedVariables ?? requestVariableReferences(live.draft, live.context)
  const used = names.map((name): Row => {
    const variable = live.vars[name]
    const source = live.varSources?.[name]
    const scope = name.startsWith('$') && variable ? 'dynamic' : live.scriptVariables?.includes(name) ? 'script'
      : live.varScopes?.[name] ?? (variable ? source === '개인' ? 'personal' : source === '전역' ? 'all' : source === '프로젝트' ? 'project' : source === '요청' ? 'request' : 'env' : 'undefined')
    return { name, scope, value: variable?.value ?? '', secret: variable?.secret ?? false }
  })
  const table = (rows: Row[], label: string) => <div role="table" aria-label={label} className="min-w-0">
    <div role="row" className="grid grid-cols-[minmax(112px,.9fr)_minmax(0,1.5fr)] gap-2 border-b border-border pb-2 text-ui-sm text-faint-foreground"><span role="columnheader">{i18nText('uiVariable2')}</span><span role="columnheader">{i18nText('uiValue')}</span></div>
    {rows.map(row => <VariableRow key={`${context?.workspaceId}:${context?.environmentId}:${row.scope}:${row.name}`} row={row} />)}
  </div>
  return <div className="min-h-0 flex-1 overflow-auto p-3 text-ui-md">
    <p className="mb-3 text-ui-sm text-faint-foreground">{live.envName ?? i18nText('jsxNoEnvironment')}</p>
    {used.length ? table(used, i18nText('jsxVariablesForThisRequest')) : <p className="py-4 text-muted-foreground">{i18nText('uiThereAreNoVariablesUsedByThisRequest')}</p>}
    <details className="mt-4 border-t border-border pt-3">
      <summary className="cursor-pointer text-ui-md text-muted-foreground">{i18nText('uiAllVariables')}</summary>
      {error && <p role="alert" className="my-2 text-method-delete">{error}</p>}
      {SCOPES.map(scope => <section key={scope} className="mt-4" aria-label={i18nText(EDIT_SCOPE_KEYS[scope])}>
        <h4 className="mb-2 text-ui-sm font-semibold text-muted-foreground">{i18nText(EDIT_SCOPE_KEYS[scope])}</h4>
        {definitions.some(row => row.scope === scope) ? table(definitions.filter(row => row.scope === scope), `${i18nText(EDIT_SCOPE_KEYS[scope])} ${i18nText('uiVariable2')}`) : <p className="text-ui-sm text-faint-foreground">{i18nText('uiNoVariables')}</p>}
      </section>)}
    </details>
    <ToolButton icon="settings" aria-label={i18nText('uiEnvironmentVariableManagement2')} className="mt-4" onClick={onSettings} />
  </div>
}

function VariableRow({ row }: { row: Row }) {
  const context = useContext(VariableEditContext)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(row.value)
  const [scope, setScope] = useState<VariableEditScope>('env')
  const [revealed, setRevealed] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const busy = useRef(false)
  const cancelled = useRef(false)
  const computed = row.scope === 'script' || row.scope === 'dynamic'
  const editable = !computed && !!context && !(row.scope === 'request' && !context.environmentId)
  const begin = () => {
    if (!editable || editing) return
    cancelled.current = false
    setDraft(row.value); setError('')
    setScope(row.scope === 'undefined' ? 'env' : row.scope === 'request' ? 'personal' : row.scope as VariableEditScope)
    setEditing(true)
  }
  const commit = async () => {
    if (!context || busy.current || cancelled.current || !editing) return
    if (draft === row.value && scope === row.scope) { setEditing(false); return }
    busy.current = true; setSaving(true); setError('')
    try {
      await saveVariable(context, row.name, draft, scope, row.secret)
      setEditing(false)
    } catch (reason) { setError(reason instanceof Error ? reason.message : i18nText('dynamicSaveFailed2')) }
    finally { busy.current = false; setSaving(false) }
  }
  return <div role="row" data-variable-row={row.name} className="grid min-w-0 grid-cols-[minmax(112px,.9fr)_minmax(0,1.5fr)] items-start gap-2 border-b border-border/60 py-2">
    <div role="cell" className="flex min-w-0 items-start gap-1.5 py-1">
      <TooltipButton aria-label={i18nText(BADGES[row.scope][1])} className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border bg-surface-2 font-mono text-ui-sm text-muted-foreground" onClick={begin}>{BADGES[row.scope][0]}</TooltipButton>
      <span className="min-w-0 break-all font-mono text-ui-sm text-foreground">{row.name}</span>
    </div>
    <div role="cell" className="min-w-0" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) void commit() }}
      onKeyDown={event => {
        if (!editing) return
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelled.current = true; setEditing(false); setError('') }
        else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); void commit() }
      }}>
      {editing ? <>
        <VariableValueInput aria-label={i18nText('dynamicValue3', { v0: String(row.name) })} autoFocus initialRevealed={revealed} value={draft} disabled={saving} secret={row.secret || scope === 'personal'} onChange={event => setDraft(event.target.value)} />
        <select aria-label={i18nText('dynamicStorageRange', { v0: String(row.name) })} className="ah-input mt-1 w-full text-ui-sm" value={scope} disabled={saving} onChange={event => setScope(event.target.value as VariableEditScope)}>
          {SCOPES.map(value => <option key={value} value={value} disabled={(value === 'env' || value === 'personal') && !context?.environmentId}>{i18nText(EDIT_SCOPE_KEYS[value])}</option>)}
        </select>
        {row.secret && !row.value && <p className="mt-1 text-ui-sm text-faint-foreground">{i18nText('uiStoredSecretValuesAreNotDisclosedPleaseEnterA')}</p>}
        <p className="mt-1 text-ui-sm text-faint-foreground">{saving ? i18nText('jsxSaving') : i18nText('jsxEnterSaveEscCancel')}</p>
      </> : computed ? <p className="py-1 text-ui-sm text-faint-foreground">{i18nText('uiComputeAtRunTime')}</p> : <div className="flex min-w-0 items-center gap-1">
        <button type="button" aria-label={i18nText('dynamicEditValue', { v0: String(row.name) })} disabled={!editable} onFocus={begin} onClick={begin} className="min-w-0 flex-1 truncate rounded px-1 py-1 text-left font-mono text-ui-sm text-muted-foreground hover:bg-surface-2 focus-visible:outline-accent">
          {row.scope === 'undefined' ? i18nText('jsxAddToCurrentEnvironment') : row.secret && !revealed ? '••••••••' : row.value || (row.secret ? i18nText('jsxStoredSecretValue') : i18nText('jsxEmptyValue'))}
        </button>
        {row.secret && <ToolButton icon="preview" aria-label={revealed ? i18nText('dynamicHide', { v0: String(row.name) }) : i18nText('dynamicView', { v0: String(row.name) })} aria-pressed={revealed} onClick={() => setRevealed(value => !value)} />}
      </div>}
      {error && <p role="alert" className="mt-1 break-words text-ui-sm text-method-delete">{error}</p>}
      {!editable && !computed && <p className="text-ui-sm text-faint-foreground">{i18nText('uiSelectAnEnvironmentToOverwriteWithYourPersonalValues')}</p>}
    </div>
  </div>
}
