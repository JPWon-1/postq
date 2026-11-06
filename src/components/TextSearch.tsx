'use client'
import { t as i18nText } from '@/i18n'
import { ToolButton } from './ToolButton'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { selectFindTarget } from '@/lib/findTarget'
import { findTextMatches, nextTextMatch } from '@/lib/textSearch'

// Inputs register their containing region; click and focus history share one clock.
// Filter by modal/visibility before choosing so a hidden tab never steals find.
const regions = new Map<HTMLInputElement, { region: { current: HTMLDivElement | null }; interaction: number }>()
let interaction = 0
function rememberRegion(event: Event) {
  if (!(event.target instanceof Node)) return
  for (const entry of regions.values()) {
    if (entry.region.current?.contains(event.target)) entry.interaction = ++interaction
  }
}
function focusBodySearch(event: KeyboardEvent) {
  if (event.defaultPrevented || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'f') return
  const visible = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
  const modal = Array.from(document.querySelectorAll('[aria-modal="true"]')).filter(visible).at(-1)
  const candidates = Array.from(regions, ([input, entry]) => ({ value: input, top: input.getBoundingClientRect().top, interaction: entry.interaction }))
    .filter(({ value }) => visible(value) && (!modal || modal.contains(value)))
  const input = selectFindTarget(candidates)
  if (!input) return
  event.preventDefault()
  event.stopPropagation()
  input.focus()
  input.select()
}

export function useTextSearch(text: string) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const result = useMemo(() => findTextMatches(text, query), [text, query])
  const current = result.matches.length ? Math.min(index, result.matches.length - 1) : -1
  const contentRef = useRef<HTMLDivElement>(null)
  const regionRef = useRef<HTMLDivElement>(null)
  useEffect(() => { setIndex(0) }, [text, query])
  useEffect(() => {
    contentRef.current?.querySelector('[data-current-match="true"]')?.scrollIntoView({ block: 'center', inline: 'nearest' })
  }, [current, result])
  return { query, setQuery, current, ...result, contentRef, regionRef,
    move: (direction: number) => setIndex(nextTextMatch(current, direction, result.matches.length)) }
}

export function TextSearchControls({ search, label }: { search: ReturnType<typeof useTextSearch>; label: string }) {
  const inputRef = useRef<HTMLInputElement>(null)
  // A newly rendered response must accept find before its first paint.
  useLayoutEffect(() => {
    const input = inputRef.current
    const region = search.regionRef
    if (!input) return
    if (regions.size === 0) {
      window.addEventListener('keydown', focusBodySearch, true)
      window.addEventListener('pointerdown', rememberRegion, true)
      window.addEventListener('focusin', rememberRegion, true)
    }
    regions.set(input, { region, interaction: 0 })
    return () => {
      regions.delete(input)
      if (regions.size === 0) {
        window.removeEventListener('keydown', focusBodySearch, true)
        window.removeEventListener('pointerdown', rememberRegion, true)
        window.removeEventListener('focusin', rememberRegion, true)
      }
    }
  }, [search.regionRef])
  return <>
    <input ref={inputRef} data-body-search aria-label={label} className="ah-input min-w-0 flex-1 text-ui-sm" placeholder={i18nText('uiFindInTextFCtrlF')}
      value={search.query} onChange={e => search.setQuery(e.target.value)} onKeyDownCapture={e => {
        if (e.key === 'Escape' && search.query) { e.preventDefault(); e.stopPropagation(); search.setQuery('') }
        if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); search.move(e.shiftKey ? -1 : 1) }
      }} />
    {search.query && <>
      <span role="status" aria-live="polite" className="text-ui-sm text-muted-foreground">
        {search.current + 1}/{search.matches.length}{search.capped ? i18nText('jsxShowTheFirst2000') : ''}
        {!search.matches.length && i18nText('jsxThereAreNoMatches')}
      </span>
      <ToolButton icon="back" type="button" className="ah-action ah-btn-icon" aria-label={i18nText('uiPreviousMatch')} disabled={!search.matches.length} onClick={() => search.move(-1)} />
      <ToolButton icon="forward" type="button" className="ah-action ah-btn-icon" aria-label={i18nText('uiNextMatch')} disabled={!search.matches.length} onClick={() => search.move(1)} />
      <ToolButton icon="clear" aria-label={i18nText('uiClearSearch')} onClick={() => search.setQuery('')} />
    </>}
  </>
}
