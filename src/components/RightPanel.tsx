'use client'
import { t as i18nText } from '@/i18n'
import { ToolButton } from './ToolButton'
import type { SnippetContext } from '@/lib/snippetRequest'
import { useEffect, useState } from 'react'
import type { RequestInput, VarMap } from '@/lib/variables'
import { KEYS, read, write } from '@/lib/localStore'
import { useResizable } from '@/lib/useResizable'
import { RequestVariablesPanel } from './RequestVariablesPanel'
import { formatSnippet, type SnippetLanguage } from '@/lib/preparedSnippet'

export type LiveRequest = { referencedVariables?: string[]; scriptVariables?: string[]; varScopes?: Record<string, import('@/lib/variableEditing').VariableEditScope | 'request'>; prepared?: RequestInput; copyCode?: (language: SnippetLanguage) => Promise<void>; varSources?: Record<string, string>; context?: SnippetContext; snippetError?: string; requestId: string; name: string; draft: RequestInput; vars: VarMap; envName: string | null }
export type RightTab = 'code' | 'variables'
const TABS = [
  { key: 'code', text: '코드', label: '코드 스니펫' },
  { key: 'variables', text: '변수', label: '변수' },
] as const
const LANGUAGES = { curl: 'cURL', fetch: 'JavaScript · fetch', axios: 'JavaScript · axios', python: 'Python · requests' }
type Language = keyof typeof LANGUAGES

export function RightPanel({ live, tab, onTab, onSettings }: {
  live: LiveRequest | null; tab: RightTab | null; onTab: (tab: RightTab | null) => void; onSettings: (tab: 'env' | 'ai') => void
}) {
  const width = useResizable(KEYS.rightWidth, 320, 240, viewport => Math.min(560, viewport * .4))
  const [language, setLanguage] = useState<Language>('curl')
  useEffect(() => { const saved = read(KEYS.snippetLang); if (saved && saved in LANGUAGES) setLanguage(saved as Language) }, [])
  const code = live?.prepared ? formatSnippet(language, live.prepared) : ''
  if (!live) return null
  return <aside aria-label={i18nText('uiRequestAssistantPanel')} className="flex min-h-0 shrink-0 border-l border-border bg-surface">
    {tab && <div role="separator" aria-label={i18nText('uiResizeRightPanel')} aria-orientation="vertical" onMouseDown={e => width.startDrag(e, -1)} className="w-1 shrink-0 cursor-col-resize hover:bg-accent" />}
    {tab && <section style={{ width: width.size }} className="flex min-w-0 flex-col" aria-label={TABS.find(t => t.key === tab)?.label}>
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-border px-4 text-ui-md font-semibold text-foreground">
        {tab === 'variables' ? i18nText('jsxVariablesForThisRequest') : i18nText('jsxCodeSnippet')}<ToolButton icon="close" aria-label={i18nText('uiCloseRightPanel')} className="ah-action px-2 text-faint-foreground" onClick={() => onTab(null)} />
      </header>
      {tab === 'code' ? <>
          <div className="flex items-center gap-2 p-3"><select aria-label={i18nText('uiCodeLanguage')} className="h-8 min-w-0 flex-1 rounded border border-border bg-background px-2 text-ui-md text-foreground" value={language} onChange={e => { setLanguage(e.target.value as Language); write(KEYS.snippetLang, e.target.value) }}>{Object.entries(LANGUAGES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><ToolButton icon="copy" className="ah-btn" aria-label={i18nText('uiCopyCodeSnippet')} title={i18nText('uiCopyCodeSnippet')} disabled={!live.prepared || !!live.snippetError} onClick={() => void live.copyCode?.(language)} /></div>
          <div data-testid="live-code-snippet" className="min-h-0 flex-1 overflow-auto pb-4 font-mono text-[12px] leading-6 text-foreground"><pre className="min-w-max">{(live?.snippetError ? '' : code).split('\n').map((line, i) => <div key={i} className="flex hover:bg-surface-2"><span aria-hidden className="sticky left-0 w-10 shrink-0 select-none bg-surface pr-3 text-right text-faint-foreground">{i + 1}</span><code className="pr-4">{line || ' '}</code></div>)}</pre></div>
          <p className="border-t border-border px-4 py-3 text-ui-sm leading-relaxed text-faint-foreground">{live?.snippetError ?? i18nText('jsxIncludesHeadersAuthenticationAndCookiesSuchAsRunningPreviews')}</p>
        </> : <RequestVariablesPanel key={`${live.requestId}:${live.envName}`} live={live} onSettings={() => onSettings('env')} />}

    </section>}
    <nav aria-label={i18nText('uiRightPanel')} className="flex w-10 shrink-0 flex-col items-center gap-2 border-l border-border py-2">{TABS.map(t => <ToolButton icon={t.key === "code" ? "code" : "variables"} key={t.key} aria-label={t.label} title={t.label} aria-pressed={tab === t.key} onClick={() => onTab(tab === t.key ? null : t.key)} className={`flex h-9 w-12 items-center justify-center rounded text-ui-sm hover:bg-surface-2 ${tab === t.key ? 'bg-surface-2 text-accent' : 'text-faint-foreground'}`} />)}</nav>
  </aside>
}
