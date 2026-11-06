'use client'
import { t as i18nText, localizeKorean } from '@/i18n'
import { useEffect, useState } from 'react'
import { ModalFrame, ModalHeader } from './ModalFrame'
import { fetchJson } from '@/lib/fetchJson'
import { maskCredentialHeaders } from '@/lib/scrub'
import { kstFull } from '@/lib/datetime'
import type { RequestRow } from '@/lib/ui-types'

const fields = { aiExecutionAllowed: 'AI 실행 허용', name: '이름', method: '메서드', url: '주소', headers: '헤더', params: '쿼리 파라미터', vars: '경로·요청 입력값', bodyType: '바디 형식', body: '바디', auth: '인증', description: '설명', assertions: '응답 확인 조건', preSteps: '요청 전 처리', postSteps: '응답 후 처리', tags: '태그', settings: '실행 옵션' } as const
export function ReviewTemplateSave({ requestId, baseline, candidate, onClose, onSave }: {
  requestId: string; baseline?: number; candidate: Record<string, unknown>
  onClose: () => void; onSave: (updatedAt: number) => Promise<boolean>
}) {
  const [current, setCurrent] = useState<RequestRow | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [reviewed, setReviewed] = useState(false)
  const load = () => fetchJson<RequestRow>(`/api/requests/${requestId}`).then(row => { setCurrent(row); setReviewed(false) }).catch(() => setError(i18nText('dynamicFailedToReadStoredRequestPleaseOpenTheWindow')))
  useEffect(() => { void load() }, [requestId]) // eslint-disable-line react-hooks/exhaustive-deps
  const keys = (Object.keys(fields) as (keyof typeof fields)[]).filter(key => current && JSON.stringify(current[key]) !== JSON.stringify(candidate[key]))
  const display = (key: keyof typeof fields, value: unknown) => {
    // 비교는 원본끼리 한다(위 keys). 화면에만 가린다 — 안내가 '비교에서 제외' 라고 말했지만
    // 사실과 반대였다. 자격증명이 바뀐 것도 팀 공용에 반영되는 변경이라 비교에서 빼면 안 된다.
    // 그래서 값만 가리고, 양쪽이 '(비밀값)' 으로 같아 보여도 다르다는 것을 문구로 알린다.
    if (key === 'auth') return JSON.stringify({ ...(value as object ?? {}), note: '비밀값은 가려서 보여줍니다 — 양쪽이 같아 보여도 값은 다릅니다' }, (k, v) => /token|password|secret|apiKey|clientSecret/i.test(k) ? i18nText('dynamicSecretValue') : v, 2)
    // 헤더도 같은 이유로 가린다. 예전엔 가리기만 하고 안내가 없어 auth 보다 더 헷갈렸다.
    if (key === 'headers' && Array.isArray(value)) value = maskCredentialHeaders(value)
    return typeof value === 'string' ? value || '(비어 있음)' : JSON.stringify(value ?? null, null, 2)
  }
  async function save() {
    if (!current || !reviewed) return
    setBusy(true)
    try {
      if (await onSave(current.updatedAt!)) onClose()
      else { setError(i18nText('dynamicFailedToSaveCheckBackForTheLatestContent')); await load() }
    } finally { setBusy(false) }
  }
  return <ModalFrame label={i18nText('uiConfirmChangesToSavedRequests')} onClose={() => { if (!busy) onClose() }}>
    <ModalHeader title={i18nText('uiReflectedInSavedRequests')} onClose={() => { if (!busy) onClose() }} />
    <div className="min-h-0 overflow-auto p-4">
      <p className="mb-4 text-ui-md text-muted-foreground">{i18nText('uiInputsUsedForExecutionAreNotAutomaticallySharedJust')}</p>
      {error && <p role="alert" className="mb-3 text-method-delete">{error}</p>}
      {!current && !error && <p role="status">{i18nText('uiCheckingLatestRequests')}</p>}
      {current && <>
        {current.updatedAt !== baseline && <p role="alert" className="mb-4 rounded-[var(--radius-sm)] border border-method-put p-3">{i18nText('uiThereAreOtherChanges')} {kstFull(current.updatedAt!)}<br />{i18nText('uiTheOneOnTheLeftBelowIsTheLatest')}</p>}
        {keys.length === 0 && <p className="py-6">{i18nText('uiItSLikeASavedRequest')}</p>}
        {keys.map(key => <section key={key} className="mb-3 rounded-[var(--radius-sm)] border border-border p-3">
          <h3 className="mb-2 font-semibold">{localizeKorean(fields[key])}</h3>
          <div className="grid gap-3 sm:grid-cols-2">{[[i18nText('jsxSavedRequests'), current[key]], [i18nText('jsxMyChange'), candidate[key]]].map(([label, value]) => <div key={String(label)}><p className="text-ui-sm text-muted-foreground">{String(label)}</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-ui-sm">{display(key, value)}</pre></div>)}</div>
        </section>)}
        {keys.length > 0 && <label className="flex items-center gap-2 py-3 text-ui-sm"><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)} />{i18nText('reviewChangesPrefix')} {keys.length}{i18nText('reviewChangesSuffix')}</label>}
      </>}
    </div>
    <div className="flex justify-end gap-2 border-t border-border p-3">
      <button disabled={busy} className="rounded-[var(--radius-sm)] border border-border px-3 py-2" onClick={onClose}>{i18nText('uiContinueEditing')}</button>
      <button disabled={busy || !reviewed || !keys.length} className="rounded-[var(--radius-sm)] bg-accent-solid px-3 py-2 text-accent-solid-foreground disabled:opacity-40" onClick={save}>{busy ? i18nText('jsxSaving') : i18nText('jsxSave')}</button>
    </div>
  </ModalFrame>
}
