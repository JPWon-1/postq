'use client'
import { t as i18nText } from '@/i18n'
import { useMemo, useState } from 'react'
import { JsonView } from './JsonView'
import { TextSearchControls, useTextSearch } from './TextSearch'

/** Read-only response/request body controls. Finding preserves the full source and syntax colors. */
export function BodyInspector({ text, label, tall = false }: { text: string; label: string; tall?: boolean }) {
  const [raw, setRaw] = useState(false)
  const [wrap, setWrap] = useState(true)
  const formatted = useMemo(() => {
    if (raw) return text
    try { return JSON.stringify(JSON.parse(text), null, 2) } catch { return text }
  }, [text, raw])
  const search = useTextSearch(formatted)
  return <div ref={search.regionRef} className="min-w-0 overflow-hidden rounded-[var(--radius-sm)] border border-border bg-surface-2">
    <div className="flex flex-wrap items-center gap-2 border-b border-border/70 p-2">
      <TextSearchControls search={search} label={i18nText('dynamicBodySearch', { v0: String(label) })} />
      <button type="button" aria-pressed={raw} className={`rounded-[var(--radius-sm)] px-1.5 py-1 text-ui-sm ${raw ? 'bg-accent/15 text-accent' : 'text-muted-foreground'}`} onClick={() => setRaw(v => !v)}>{i18nText('uiOriginalText')}</button>
      <button type="button" aria-pressed={wrap} className={`rounded-[var(--radius-sm)] px-1.5 py-1 text-ui-sm ${wrap ? 'bg-accent/15 text-accent' : 'text-muted-foreground'}`} onClick={() => setWrap(v => !v)}>{i18nText('uiLineBreak')}</button>
    </div>
    <div ref={search.contentRef}><JsonView text={formatted} matches={search.matches} current={search.current} className={`${tall ? 'max-h-[70vh]' : 'max-h-[360px]'} overflow-auto p-3 font-mono text-ui-sm leading-relaxed ${wrap ? 'whitespace-pre-wrap break-words [overflow-wrap:anywhere]' : 'whitespace-pre'}`} /></div>
  </div>
}
