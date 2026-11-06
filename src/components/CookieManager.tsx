'use client'
import { t as i18nText } from '@/i18n'
import { ToolButton } from './ToolButton'
import { useCallback, useEffect, useState } from 'react'
import { useToast } from './Toast'
import { ModalFrame } from './ModalFrame'
import type { EnvironmentRow } from '@/lib/ui-types'
import { kstMinute } from '@/lib/datetime'
import { errorText, fetchArray } from '@/lib/fetchJson'

type Cookie = { id: string; domain: string; name: string; value: string; path: string; expires: number | null; environmentId: string | null }

// 쿠키 jar 뷰어/관리 — 서버가 보관 중인 세션 쿠키를 도메인/환경별로 확인·삭제.
export function CookieManager({ workspaceId, environments, onClose, embedded = false, active = true, initialDomain = '' }: {
  workspaceId: string; environments: EnvironmentRow[]; onClose: () => void
  /** 설정 다이얼로그 안에 놓일 때 — 배경·닫기 없이 내용만 낸다 */
  embedded?: boolean
  active?: boolean
  initialDomain?: string
}) {
  const toast = useToast()
  const [envId, setEnvId] = useState('')
  const [domain, setDomain] = useState(initialDomain)
  const [rows, setRows] = useState<Cookie[]>([])
  // 못 불러온 것과 '쿠키가 없다' 는 다른 화면이어야 한다. 여기서 헷갈리면 남아 있는
  // 세션 쿠키를 없는 줄 알고 로그인을 다시 하거나, 왜 인증이 붙는지 못 찾는다.
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(async () => {
    // 예전엔 res.ok 도 catch 도 없었다. 500 이면 오류 객체가 그대로 rows 에 들어가
    // rows.map 에서 터졌고, 화면이 통째로 날아갔다(처리되지 않은 rejection 도 났다).
    try {
      setRows(await fetchArray<Cookie>(`/api/cookies?workspaceId=${encodeURIComponent(workspaceId)}&environmentId=${encodeURIComponent(envId)}`))
      setLoadError(null)
    } catch (e) {
      setLoadError(errorText(e))
      setRows([])
    }
  }, [workspaceId, envId])
  useEffect(() => { load() }, [load])

  const [addDomain, setAddDomain] = useState('')
  const [addCookies, setAddCookies] = useState('')
  const [adding, setAdding] = useState(false)
  const paste = async () => {
    if (!addDomain.trim() || !addCookies.trim()) return
    setAdding(true)
    try {
      const res = await fetch('/api/cookies', { method: 'POST', body: JSON.stringify({
        domain: addDomain, cookieString: addCookies, workspaceId, environmentId: envId,
      }) })
      const d = await res.json()
      if (!res.ok) { toast('error', d.error ?? '추가 실패'); return }
      toast('success', i18nText('dynamicCookiesAddedAutomaticallyAppliedToRequests', { v0: String(d.added), v1: String(addDomain) }))
      window.dispatchEvent(new Event('postq:cookies-updated'))
      setAddCookies(''); load()
    } catch (e) {
      // 서버 오류는 알리면서 연결 실패는 조용했다 — 누르고도 아무 일이 없는 것처럼 보인다.
      toast('error', i18nText('dynamicRequestFailed', { v0: String(errorText(e)) }))
    } finally { setAdding(false) }
  }
  // 삭제가 실패해도 목록만 다시 불러서, 지워지지 않은 쿠키가 그대로 남은 채 아무 말이
  // 없었다. 실패했다고 말한다 — 지운 줄 알고 넘어가면 왜 인증이 계속 붙는지 못 찾는다.
  const del = async (id: string) => {
    try {
      // 서버는 id 와 함께 스코프(프로젝트·환경)를 본다 — 안 넘기면 '기본' 프로젝트 공용 스코프로 보고
      // 0건을 지운 채 성공한다. 기본이 아닌 프로젝트나 환경 쿠키는 지워지지 않았다.
      const res = await fetch(`/api/cookies?id=${encodeURIComponent(id)}&workspaceId=${encodeURIComponent(workspaceId)}&environmentId=${encodeURIComponent(envId)}`, { method: 'DELETE' })
      if (!res.ok) toast('error', i18nText('dynamicDeletionFailedServerResponse', { v0: String(res.status) }))
    } catch (e) { toast('error', i18nText('dynamicFailedToDelete', { v0: String(errorText(e)) })) }
    finally { window.dispatchEvent(new Event('postq:cookies-updated')); load() }
  }
  const clearAll = async () => {
    // '모두 지웠습니다' 를 결과와 상관없이 띄우고 있었다. 안 지워졌는데 지웠다고 하는 건
    // 조용한 실패보다 나쁘다 — 사람이 그 말을 믿고 다음 단계로 넘어간다.
    try {
      const res = await fetch(`/api/cookies?workspaceId=${encodeURIComponent(workspaceId)}&environmentId=${encodeURIComponent(envId)}`, { method: 'DELETE' })
      if (res.ok) toast('info', i18nText('dynamicIDeletedAllCookies'))
      else toast('error', i18nText('dynamicFailedToClearServerResponse', { v0: String(res.status) }))
    } catch (e) { toast('error', i18nText('dynamicFailedToErase', { v0: String(errorText(e)) })) }
    finally { window.dispatchEvent(new Event('postq:cookies-updated')); load() }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (active && e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, active])

  return (
    <ModalFrame embedded={embedded} label={i18nText('uiCookieManagement')} width="w-[640px]" onClose={onClose}>
        <div className="flex shrink-0 items-center gap-2 border-b border-border/70 px-4 py-3">
          {!embedded && <h2 className="text-ui-lg font-bold text-foreground">{i18nText('uiCookieJar')}</h2>}
          <select aria-label={i18nText('uiCookieEnvironmentScope')} className="ml-1 rounded-[var(--radius-sm)] border border-border bg-surface px-2 py-1 text-ui-lg text-foreground outline-none focus-visible:border-accent" value={envId} onChange={e => setEnvId(e.target.value)}>
            <option value="">{i18nText('uiPublicNoEnvironment')}</option>
            {environments.map(env => <option key={env.id} value={env.id}>{env.name}</option>)}
          </select>
          <input aria-label={i18nText('uiCookieDomainFilter')} placeholder={i18nText('uiDomainFilter')} value={domain} onChange={e => setDomain(e.target.value)} className="ah-input min-w-0 flex-1" />
          {/* 지울 것이 없을 때는 내지 않는다 — 빈 목록 옆의 빨간 [전체 삭제] 는
              누를 수도 없는 위험을 상시 보여줄 뿐이다. */}
          {rows.length > 0 && (
            <button type="button" className="rounded-[var(--radius-sm)] border border-border px-2 py-1 text-ui-md text-method-delete/80 transition-colors hover:border-method-delete/50 hover:text-method-delete focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" onClick={clearAll}>{i18nText('uiDeleteAll')}</button>
          )}
          {!embedded && <ToolButton icon="close" type="button" aria-label={i18nText('uiClose')} className="ah-action ml-auto flex h-6 w-auto px-1.5 items-center justify-center rounded-[var(--radius-sm)] text-faint-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" onClick={onClose} />}
        </div>
        <p className="border-b border-border/70 px-4 py-2 text-ui-sm leading-relaxed text-faint-foreground">
          {i18nText('uiWhenALoginRequestIsExecutedTheResponseSet')}
        </p>
        {/* 브라우저에서 복사한 쿠키 붙여넣기 (Postman 쿠키 관리자 대응) */}
        <div className="flex flex-col gap-1.5 border-b border-border bg-surface-2/40 px-4 py-2.5">
          <p className="ah-label">
            {i18nText('uiPasteCookieGetASessionFromASiteYou')} <span className="font-normal normal-case tracking-normal text-faint-foreground">{i18nText('uiCookieHeaderOrDocumentCookieValueInDevTools')}</span>
          </p>
          <div className="flex gap-1.5">
            <input
              aria-label={i18nText('uiCookieDomain')}
              className="ah-hint-sans w-52 rounded-[var(--radius-sm)] border border-border bg-surface px-2 py-1 font-mono text-ui-md text-foreground outline-none focus-visible:border-accent"
              placeholder={i18nText('uiDomainEGApiExampleCom')}
              value={addDomain}
              onChange={e => setAddDomain(e.target.value)}
            />
            <input
              aria-label={i18nText('uiCookieString')}
              className="min-w-0 flex-1 ah-input font-mono"
              placeholder="SID=abc; token=xyz"
              value={addCookies}
              onChange={e => setAddCookies(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') paste() }}
            />
            <button type="button" disabled={adding || !addDomain.trim() || !addCookies.trim()} className="ah-action shrink-0 rounded-[var(--radius-sm)] bg-accent-solid px-3 py-1 text-ui-md font-semibold text-accent-solid-foreground hover:bg-accent-solid-hover disabled:opacity-50" onClick={paste}>
              {i18nText('uiAdd')}
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loadError
            ? <p role="alert" className="px-4 py-8 text-center text-ui-lg text-method-delete">{i18nText('uiFailedToLoadCookies')} {loadError}</p>
            : rows.length === 0 && <p className="px-4 py-8 text-center text-ui-lg text-faint-foreground">{i18nText('uiThereAreNoCookiesSavedWhenYouRunA')}</p>}
          <table className="w-full text-ui-md">
            <tbody>
              {rows.filter(c => !domain || c.domain.includes(domain)).map(c => (
                <tr key={c.id} className="border-b border-border/50 last:border-b-0">
                  <td className="px-3 py-1.5 font-mono text-faint-foreground">{c.domain}</td>
                  <td className="px-2 py-1.5 font-mono font-semibold text-foreground">{c.name}</td>
                  {/* 값은 서버가 안 내려준다 — 쿠키 값은 로그인 세션 그 자체라서다.
                      어느 쿠키인지는 도메인·이름으로 알아보고, 지우는 데도 값은 필요 없다. */}
                  <td className="px-2 py-1.5 font-mono text-faint-foreground" title={i18nText('uiCookieValuesDoNotComeDownToTheScreen')}>••••</td>
                  <td className="px-2 py-1.5 text-ui-sm text-faint-foreground">{c.expires ? kstMinute(c.expires) : i18nText('jsxSession')}</td>
                  <td className="px-2 py-1.5 text-right"><button type="button" className="ah-action rounded-[var(--radius-sm)] px-1.5 py-0.5 text-ui-sm text-muted-foreground transition-colors hover:bg-surface-2 hover:text-method-delete focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent" onClick={() => del(c.id)}>{i18nText('uiDelete')}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
    </ModalFrame>
  )
}

/** 쿠키 값은 가져오지 않고 서버가 반환한 공용 쿠키의 도메인만 나열한다. */
export function CookieSidebar({ workspaceId, onOpen }: { workspaceId: string; onOpen: (domain?: string) => void }) {
  const [domains, setDomains] = useState<string[]>([])
  const [error, setError] = useState(false)
  useEffect(() => {
    let current = true
    fetchArray<Cookie>(`/api/cookies?workspaceId=${encodeURIComponent(workspaceId)}&environmentId=`)
      .then(rows => { if (current) { setDomains([...new Set(rows.map(row => row.domain))].sort()); setError(false) } })
      .catch(() => { if (current) setError(true) })
    return () => { current = false }
  }, [workspaceId])
  return <div className="px-2 pb-2">
    <button className="ah-sidebar-row text-accent" onClick={() => onOpen()}>{i18nText('uiOpenCookieStore')}</button>
    {error && <p className="px-2 py-1 text-method-delete">{i18nText('uiFailedToLoadCookieList')}</p>}
    {domains.map(domain => <button key={domain} className="ah-sidebar-row" onClick={() => onOpen(domain)}>{domain}</button>)}
  </div>
}
