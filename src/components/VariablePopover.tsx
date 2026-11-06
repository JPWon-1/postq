'use client'
import { t as i18nText } from '@/i18n'
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CopyButton } from './CopyButton'
import { VariableValueInput } from './VariableValueInput'
import { getPersonalVars } from '@/lib/personalVars'
import { defaultVariableScope, saveVariable, type VariableEditScope, type VariableEditTarget } from '@/lib/variableEditing'

type Context = VariableEditTarget
export const VariableEditContext = createContext<Context | null>(null)

export function VariablePopover({ name, value = '', secret = false, source, sourceLabel, children }: {
  name: string; value?: string; secret?: boolean; source?: string; sourceLabel?: string; children: ReactNode
}) {
  const instanceId = useId()
  const ctx = useContext(VariableEditContext)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value)
  const [scope, setScope] = useState<VariableEditScope>('env')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const busy = useRef(false)
  const show = () => {
    if (!ctx || open) return
    window.dispatchEvent(new CustomEvent('postq:variable-popover', { detail: instanceId }))
    const rect = trigger.current?.getBoundingClientRect()
    if (rect) setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 376)), top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 360)) })
    const personal = getPersonalVars(ctx.environmentId)[name]
    setScope(defaultVariableScope(source, ctx.environmentId, name))
    setDraft(personal ?? value); setError(''); setOpen(true)
  }
  const close = () => { if (!busy.current) { setOpen(false); trigger.current?.focus() } }
  useEffect(() => {
    if (!open) return
    const outside = (e: PointerEvent) => { if (!panel.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) close() }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  useEffect(() => {
    const other = (event: Event) => { if ((event as CustomEvent).detail !== instanceId && !busy.current) setOpen(false) }
    window.addEventListener('postq:variable-popover', other)
    return () => window.removeEventListener('postq:variable-popover', other)
  }, [instanceId])
  useEffect(() => { setOpen(false) }, [ctx?.workspaceId, ctx?.environmentId])
  const save = async () => {
    if (!ctx || busy.current) return
    busy.current = true; setSaving(true); setError('')
    try {
      await saveVariable(ctx, name, draft, scope, secret)
      setOpen(false)
    } catch (e) { setError(e instanceof Error ? e.message : i18nText('dynamicSaveFailed2')) }
    finally { busy.current = false; setSaving(false) }
  }
  return <>
    <button ref={trigger} data-variable-name={name} type="button" aria-label={i18nText('dynamicVariableValue', { v0: String(name) })} aria-expanded={open} className="min-w-0 text-left" onClick={show} onMouseEnter={show}>{children}</button>
    {open && createPortal(<div ref={panel} role="dialog" aria-label={i18nText('dynamicEditVariable', { v0: String(name) })} className="fixed z-[100] w-[360px] max-w-[calc(100vw-16px)] rounded-lg border border-border bg-surface p-3 text-ui-md text-foreground shadow-lg" style={position}
      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void save() } }}>
      <p className="mb-2 break-all font-semibold">{name} · {sourceLabel ?? source ?? i18nText('jsxNotRegistered')}</p>
      <label className="block">{i18nText('uiStorageRange')}<select aria-label={i18nText('uiVariableStorageRange')} className="ah-input my-2 w-full" value={scope} disabled={saving} onChange={e => setScope(e.target.value as VariableEditScope)}>
        <option value="env" disabled={!ctx?.environmentId}>{i18nText('uiCurrentEnvironment')}{!source ? i18nText('jsxAddTo') : ''}</option><option value="all">{i18nText('uiGlobalAllProjects2')}</option><option value="project">{i18nText('uiProjectCommon')}</option><option value="personal" disabled={!ctx?.environmentId}>{i18nText('uiMyPersonalValues')}</option>
      </select></label>
      {secret && !value && <p className="mb-2 text-ui-sm">{i18nText('uiExistingSecretValuesAreNotDisclosedOnTheServer')}</p>}
      <VariableValueInput aria-label={i18nText('uiVariableEditValue')} value={draft} secret={secret || scope === 'personal'} disabled={saving} onChange={e => setDraft(e.target.value)} />
      {!secret && scope !== 'personal' && <CopyButton value={draft} title={i18nText('dynamicCopyValue', { v0: String(name) })} />}
      <p className="mt-2 text-ui-sm text-faint-foreground">{i18nText('uiEnterSaveShiftEnterLineBreakEscCancel')}</p>
      {error && <p role="alert" className="my-2 text-method-delete">{error}</p>}
      <div className="mt-3 flex justify-end gap-2"><button type="button" className="ah-btn px-3" disabled={saving} onClick={close}>{i18nText('uiCancel')}</button><button type="button" className="ah-btn-primary" disabled={saving} onClick={() => void save()}>{i18nText('uiSave')}</button></div>
    </div>, document.body)}
  </>
}
