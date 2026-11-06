'use client'
import { t as i18nText } from '@/i18n'
import { useEffect, useState } from 'react'
import { methodPill, methodText } from '@/lib/methodStyle'
import type { ExecutionRow, RequestRow } from '@/lib/ui-types'
import { AUTH_LABEL } from '@/lib/requestAuth'
import { displayName } from '@/lib/requestGroups'
import { ResponseExamples, prettyJson } from './ResponseExamples'
import { fetchArray } from '@/lib/fetchJson'

// 요청 하나의 읽기 전용 명세 뷰 — 컬렉션의 '문서 모드'와 공유 문서 페이지가 함께 쓴다.
// (원래 /docs 전용이던 렌더를 컴포넌트로 뽑아 중복 제거)



export function RequestDocView({ r, defaultExamplesOpen = false }: { r: RequestRow; defaultExamplesOpen?: boolean }) {
  const [examples, setExamples] = useState<ExecutionRow[] | null>(null)
  const [open, setOpen] = useState(defaultExamplesOpen)
  // 늦게 온 응답이 이기지 않게 한다.
  //
  // 요청을 바꾸면 examples 를 null 로 되돌려 새로 받는데, 그 사이 앞 요청의 응답이
  // 도착하면 그대로 들어앉는다. 그러면 examples 가 null 이 아니라 다시 받지도 않고,
  // **이전 요청의 예시가 지금 요청 문서 밑에 붙은 채로 남는다**. 문서를 보는 사람은
  // 그게 이 API 의 응답이라고 읽는다 — 화면에 아무 이상이 없어 알아챌 방법도 없다.
  useEffect(() => {
    if (!open || examples !== null) return
    let alive = true
    fetchArray<ExecutionRow>(`/api/requests/${r.id}/examples`)
      .then(rows => { if (alive) setExamples(rows) })
      // 예시는 문서의 곁다리라 실패해도 문서를 막지 않는다 — 빈 목록으로 둔다.
      .catch(() => { if (alive) setExamples([]) })
    return () => { alive = false }
  }, [open, examples, r.id])
  // 다른 요청으로 바뀌면 예시를 새로 불러온다(문서 모드에서 탭 전환 시 이전 요청 예시가 남지 않게).
  useEffect(() => { setExamples(null) }, [r.id])

  const params = (r.params ?? []).filter(p => p.enabled && p.key)
  const headers = (r.headers ?? []).filter(h => h.enabled && h.key)
  const rows: { key: string; where: string; value: string; description?: string }[] = [
    ...params.map(p => ({ key: p.key, where: 'query', value: p.value, description: p.description })),
    ...headers.map(h => ({ key: h.key, where: 'header', value: h.value, description: h.description })),
  ]
  const hasBody = r.bodyType && r.bodyType !== 'none' && (r.body ?? '').trim() !== ''

  return (
    <section id={`req-${r.id}`} className="scroll-mt-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`shrink-0 rounded-[var(--radius-sm)] border px-2 py-0.5 font-mono text-ui-sm font-bold ${methodPill(r.method)}`}>{r.method}</span>
        <h3 className="text-[16px] font-semibold text-foreground">{displayName(r.name)}</h3>
        {(r.tags ?? []).map(t => <span key={t} className="rounded-full bg-surface-2 px-2 py-0.5 text-ui-meta text-faint-foreground">{t}</span>)}
      </div>
      <p className="mt-1.5 break-all rounded-[var(--radius-sm)] border border-border bg-surface-2/50 px-2.5 py-1.5 font-mono text-ui-md text-muted-foreground">{r.url}</p>
      {r.description && (
        <p className="mt-2 whitespace-pre-wrap text-ui-lg leading-relaxed text-muted-foreground">{r.description}</p>
      )}

      {rows.length > 0 && (
        <div className="mt-4">
          <h4 className="text-ui-sm font-bold uppercase tracking-wide text-faint-foreground">{i18nText('uiParameters')}</h4>
          <div className="mt-1.5 overflow-x-auto rounded-[var(--radius-sm)] border border-border">
            <table className="w-full min-w-[520px] border-collapse text-ui-md">
              <thead>
                <tr className="border-b border-border bg-surface-2 text-left text-ui-meta font-semibold uppercase tracking-wide text-faint-foreground">
                  <th className="px-2.5 py-1.5">{i18nText('uiName')}</th>
                  <th className="px-2.5 py-1.5">{i18nText('uiLocation')}</th>
                  <th className="px-2.5 py-1.5">{i18nText('uiExampleValue')}</th>
                  <th className="px-2.5 py-1.5">{i18nText('uiDescription')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((kv, i) => (
                  <tr key={i} className="border-b border-border/50 last:border-b-0">
                    <td className="px-2.5 py-1.5 font-mono text-foreground">{kv.key}</td>
                    <td className="px-2.5 py-1.5"><span className="rounded-[var(--radius-sm)] bg-surface-2 px-1.5 py-0.5 font-mono text-ui-meta text-faint-foreground">{kv.where}</span></td>
                    <td className="px-2.5 py-1.5 font-mono text-muted-foreground">{kv.value || <span className="text-faint-foreground">—</span>}</td>
                    <td className="px-2.5 py-1.5 text-faint-foreground">{kv.description || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {r.auth && r.auth.type !== 'none' && (
        <p className="mt-3 text-ui-md text-muted-foreground">{i18nText('uiCertification')} <span className="font-semibold text-foreground">{AUTH_LABEL[r.auth.type]}</span></p>
      )}

      {hasBody && (
        <div className="mt-4">
          <h4 className="text-ui-sm font-bold uppercase tracking-wide text-faint-foreground">{i18nText('uiRequestBody')} <span className="font-normal normal-case text-faint-foreground">({r.bodyType})</span></h4>
          <pre className="mt-1.5 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-[var(--radius-sm)] border border-border bg-surface-2 p-2.5 font-mono text-ui-md leading-relaxed text-muted-foreground">{prettyJson(r.body)}</pre>
        </div>
      )}

      <div className="mt-4">
        <button
          type="button"
          className="text-ui-md font-medium text-accent hover:text-accent-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          onClick={() => setOpen(o => !o)}
        >
          {i18nText('uiSampleResponse')} {open ? i18nText('jsxHide') : i18nText('jsxView')}
        </button>
        {open && <div className="mt-2"><ResponseExamples examples={examples} /></div>}
      </div>
    </section>
  )
}
