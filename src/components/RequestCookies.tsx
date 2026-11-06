'use client'
import { t as i18nText } from '@/i18n'
import { ToolButton } from './ToolButton'
import { useCallback, useEffect, useState } from 'react'
import { useToast } from './Toast'
import { kstMinute } from '@/lib/datetime'
import { errorText, fetchArray } from '@/lib/fetchJson'
import { cookieMatchesHost } from '@/lib/cookies'
import { copyText } from '@/lib/clipboard'

type Cookie = { id: string; domain: string; name: string; expires: number | null }

/**
 * 요청의 [Cookies] 탭 — 이 요청이 실행될 때 붙는 쿠키를 그 자리에서 보고, 넣고, 지운다.
 *
 * 쿠키 jar 는 [설정 → 쿠키] 에만 있어서, 로그인 세션이 왜 붙는지(안 붙는지) 보려면 요청을 떠나
 * 도메인·환경을 다시 골라야 했다. 여기서는 이 요청의 호스트와 지금 환경으로 이미 좁혀져 있다.
 * 저장 범위는 실행 때와 같다 — (프로젝트, 환경). 환경을 안 골랐으면 '공용'.
 */
export function RequestCookies({ workspaceId, environmentId, environmentName, host, hasCookieHeader, onCount }: {
  workspaceId: string
  environmentId: string | null
  environmentName: string | null
  /** 변수를 채운 주소의 호스트. 아직 못 정하면 null */
  host: string | null
  /** 요청 헤더에 Cookie 가 이미 있으면 jar 는 안 붙는다(실행 규칙) */
  hasCookieHeader: boolean
  onCount?: (n: number) => void
}) {
  const toast = useToast()
  const env = environmentId ?? ''
  const [rows, setRows] = useState<Cookie[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [paste, setPaste] = useState('')
  const [adding, setAdding] = useState(false)

  const load = useCallback(async () => {
    try {
      const all = await fetchArray<Cookie>(`/api/cookies?workspaceId=${encodeURIComponent(workspaceId)}&environmentId=${encodeURIComponent(env)}`)
      setRows(all); setLoadError(null)
    } catch (e) {
      setLoadError(errorText(e)); setRows(null)
    }
  }, [workspaceId, env])
  useEffect(() => { void load() }, [load])

  const now = Date.now()
  const matching = host && rows ? rows.filter(c => cookieMatchesHost(c.domain, host)) : []
  const live = matching.filter(c => c.expires === null || c.expires > now)
  useEffect(() => { onCount?.(hasCookieHeader ? 0 : live.length) }, [live.length, hasCookieHeader, onCount])

  const add = async () => {
    if (!host || !paste.trim() || adding) return
    setAdding(true)
    try {
      const res = await fetch('/api/cookies', { method: 'POST', body: JSON.stringify({ domain: host, cookieString: paste, workspaceId, environmentId: env }) })
      const d = await res.json().catch(() => null) as { error?: string; added?: number } | null
      if (!res.ok) { toast('error', d?.error ?? `추가하지 못했습니다 (${res.status})`); return }
      toast('success', i18nText('dynamicCookiesWerePlacedInTheyWillBeAttachedFrom', { v0: String(d?.added ?? 0), v1: String(host) }))
      window.dispatchEvent(new Event('postq:cookies-updated'))
      setPaste(''); void load()
    } catch (e) {
      toast('error', i18nText('dynamicFailedToAdd', { v0: String(errorText(e)) }))
    } finally { setAdding(false) }
  }

  const remove = async (ids: string[]) => {
    try {
      const results = await Promise.all(ids.map(id => fetch(`/api/cookies?id=${encodeURIComponent(id)}&workspaceId=${encodeURIComponent(workspaceId)}&environmentId=${encodeURIComponent(env)}`, { method: 'DELETE' })))
      const failed = results.filter(r => !r.ok).length
      if (failed) toast('error', i18nText('dynamicFailedToDelete2', { v0: String(failed) }))
    } catch (e) {
      toast('error', i18nText('dynamicFailedToErase', { v0: String(errorText(e)) }))
    } finally { window.dispatchEvent(new Event('postq:cookies-updated')); void load() }
  }

  const copy = async (label: string, value: string) => {
    const ok = await copyText(value)
    toast(ok ? 'success' : 'error', ok ? i18nText('dynamicCopied', { v0: String(label) }) : i18nText('dynamicCopyFailed'))
  }

  const scopeName = environmentName ? i18nText('dynamicEnvironment', { v0: String(environmentName) }) : i18nText('dynamicPublicNoEnvironment')

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-ui-md">
        <span className="font-semibold text-foreground">{host ?? i18nText('jsxIDonTKnowTheHostYet')}</span>
        <span className="text-muted-foreground">· {scopeName} {i18nText('uiCookies')}</span>
        {!host && <span className="text-ui-sm text-faint-foreground">{i18nText('uiYouCanTellWhichDomainItIsOnlyWhen')}</span>}
      </div>

      {hasCookieHeader && (
        <p className="rounded-[var(--radius-sm)] border border-method-put/40 bg-method-put/10 px-3 py-2 text-ui-md text-method-put">
          {i18nText('uiSinceCookiesAreDirectlyIncludedInHeadersTheCookies')}
        </p>
      )}

      <section className="flex flex-col gap-1.5">
        <h3 className="ah-label">{i18nText('uiCookiesAttachedToThisRequest')} {rows && host ? i18nText('dynamicundefined2', { v0: String(live.length) }) : ''}</h3>
        {loadError ? (
          <p role="alert" className="text-ui-md text-method-delete">{i18nText('uiFailedToLoadCookies')} {loadError} <button type="button" className="ah-btn-inline" onClick={() => void load()}>{i18nText('uiTryAgain')}</button></p>
        ) : rows === null ? (
          <p className="text-ui-md text-faint-foreground">{i18nText('uiLoading')}</p>
        ) : matching.length === 0 ? (
          <p className="text-ui-md text-faint-foreground">
            {host ? i18nText('jsxNotYetWhenYouIssueALoginRequestThe') : '—'}
          </p>
        ) : (
          <table className="w-full text-ui-md">
            <tbody>
              {matching.map(c => {
                const expired = c.expires !== null && c.expires <= now
                return (
                  <tr key={c.id} className={`border-b border-border/50 last:border-b-0 ${expired ? 'opacity-50' : ''}`}>
                    <td className="py-1.5 pr-3 font-mono font-semibold text-foreground">{c.name}</td>
                    <td className="px-2 py-1.5 font-mono text-faint-foreground">{c.domain}</td>
                    {/* 값은 서버가 안 내려준다 — 쿠키 값은 로그인 세션 그 자체다 */}
                    <td className="px-2 py-1.5 font-mono text-faint-foreground" title={i18nText('uiCookieValuesDoNotComeDownToTheScreen')}>••••</td>
                    <td className="px-2 py-1.5 text-ui-sm text-faint-foreground">{expired ? i18nText('jsxExpired') : c.expires ? i18nText('dynamicUntil', { v0: String(kstMinute(c.expires)) }) : i18nText('jsxSession')}</td>
                    <td className="py-1.5 text-right">
                      <button type="button" aria-label={i18nText('dynamicDeleteCookie', { v0: String(c.name) })} className="ah-action rounded-[var(--radius-sm)] px-1.5 py-0.5 text-ui-sm text-muted-foreground transition-colors hover:bg-surface-2 hover:text-method-delete" onClick={() => void remove([c.id])}>{i18nText('uiDelete')}</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        {matching.length > 1 && (
          <button type="button" className="self-start text-ui-sm text-method-delete/80 hover:text-method-delete" onClick={() => void remove(matching.map(c => c.id))}>
            {i18nText('uiThisDomainCookie')} {matching.length}{i18nText('uiDeleteAllLogOut')}
          </button>
        )}
      </section>

      <section className="flex flex-col gap-1.5">
        <h3 className="ah-label">{i18nText('uiPasteWriteFromABrowserSessionThatIsAlready')}</h3>
        <p className="text-ui-sm text-faint-foreground">{i18nText('uiDevToolsNetworkRequestCookieHeaderValueOr')} <code className="font-mono">document.cookie</code> {i18nText('uiPasteItAsIs')}</p>
        <div className="flex gap-1.5">
          <input
            aria-label={i18nText('uiCookieString')}
            className="min-w-0 flex-1 ah-input font-mono"
            placeholder="SID=abc; token=xyz"
            value={paste}
            disabled={!host}
            onChange={e => setPaste(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void add() }}
          />
          <button type="button" disabled={!host || adding || !paste.trim()} className="ah-btn-primary shrink-0 px-3 py-1 disabled:opacity-50" onClick={() => void add()}>
            {adding ? i18nText('jsxInserting') : i18nText('dynamicPutIn', { v0: String(host ?? i18nText('jsxDomain')) })}
          </button>
        </div>
      </section>

      <section className="flex flex-col gap-1.5">
        <h3 className="ah-label">{i18nText('uiSessionSyncGetItAsABrowserExtension')}</h3>
        <p className="text-ui-sm leading-relaxed text-faint-foreground">
          {i18nText('uiOfRepository')} <code className="font-mono">extension/</code> {i18nText('uiAfterUploadingTheFolderAsAnUnzippedExtensionTo')}
        </p>
        <dl className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1 text-ui-md">
          {([
            [i18nText('jsxDomain'), host ?? ''],
            [i18nText('jsxWorkspace'), workspaceId],
            [i18nText('jsxEnvironment'), env],
            [i18nText('jsxPostqAddress'), typeof window !== 'undefined' ? window.location.origin : ''],
          ] as const).map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="truncate font-mono text-foreground">{value || <span className="text-faint-foreground">{i18nText('uiEmptyCommon')}</span>}</dd>
              <dd>{value && <ToolButton icon="copy" type="button" aria-label={i18nText('dynamicCopy', { v0: String(label) })} className="rounded-[var(--radius-sm)] px-1.5 py-0.5 text-ui-sm text-muted-foreground hover:bg-surface-2 hover:text-foreground" onClick={() => void copy(label, value)} />}</dd>
            </div>
          ))}
        </dl>
        <ToolButton icon="refresh" aria-label={i18nText('uiRefreshAfterSending')} type="button" className="self-start text-ui-sm text-accent" onClick={() => void load()} />
      </section>
    </div>
  )
}
