'use client'
import { t as i18nText } from '@/i18n'
import { useEffect, useRef, useState } from 'react'
import { formatSnippet, type SnippetLanguage } from './preparedSnippet'
import type { RequestInput } from './variables'
import { copyText } from './clipboard'
import { fetchJson, errorText } from './fetchJson'
import { ModalFrame, ModalHeader } from '@/components/ModalFrame'
import { useToast } from '@/components/Toast'

type Prepared = { snippet: RequestInput; hasSecrets: boolean; authError: string | null }

/** Only the server resolves variables, inherited headers, authentication and cookies. */
export function useRequestSnippet(requestId: string, payload: unknown, active: boolean, revision: number) {
  const toast = useToast()
  const [cookieRevision, setCookieRevision] = useState(0)
  useEffect(() => {
    const refresh = () => setCookieRevision(v => v + 1)
    window.addEventListener('postq:cookies-updated', refresh)
    window.addEventListener('focus', refresh)
    return () => { window.removeEventListener('postq:cookies-updated', refresh); window.removeEventListener('focus', refresh) }
  }, [])
  const serialized = JSON.stringify(payload)
  const [result, setResult] = useState<{ key: string; value: Prepared } | null>(null)
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null)
  const [choice, setChoice] = useState<{ language: SnippetLanguage; value: Prepared; payload: string } | null>(null)
  const sequence = useRef(0)
  const key = `${requestId}:${serialized}:${revision}:${cookieRevision}`
  const load = (body: string, revealSecrets = false, signal?: AbortSignal) => fetchJson<Prepared>(`/api/requests/${requestId}/preview`, {
    method: 'POST', body: JSON.stringify({ ...JSON.parse(body), purpose: 'snippet', revealSecrets }), signal,
  }).then(value => { if (value.authError) throw new Error(value.authError); return value })
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void load(serialized, false, controller.signal).then(value => {
        if (!controller.signal.aborted) { setResult({ key, value }); setFailure(null) }
      }).catch(e => { if (!controller.signal.aborted) setFailure({ key, message: errorText(e) }) })
    }, 180)
    return () => { clearTimeout(timer); controller.abort() }
    // serialized captures every input; no request is sent when only function identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, active])
  useEffect(() => {
    if (!active) setChoice(null)
    return () => { sequence.current++ }
  }, [active])
  const write = async (language: SnippetLanguage, value: Prepared) => {
    const ok = await copyText(formatSnippet(language, value.snippet))
    toast(ok ? 'success' : 'error', ok ? i18nText('dynamicCopied', { v0: String(language === 'curl' ? 'cURL' : language) }) : i18nText('dynamicCopyFailedCheckClipboardPermissions'))
  }
  const copy = async (language: SnippetLanguage) => {
    const current = ++sequence.current
    try {
      // Refresh on every explicit copy, including cookie changes since the passive preview.
      const value = await load(serialized)
      if (current !== sequence.current) return
      setResult({ key, value }); setFailure(null)
      if (value.hasSecrets) setChoice({ language, value, payload: serialized })
      else await write(language, value)
    } catch (e) { if (current === sequence.current) toast('error', i18nText('dynamicFailedToCopyCode', { v0: String(errorText(e)) })) }
  }
  const confirm = async (reveal: boolean) => {
    if (!choice) return
    const selected = choice
    const current = ++sequence.current
    setChoice(null)
    try {
      const value = reveal ? await load(selected.payload, true) : selected.value
      if (current === sequence.current) await write(selected.language, value)
    }
    catch (e) { toast('error', i18nText('dynamicFailedToCopyCode', { v0: String(errorText(e)) })) }
  }
  return {
    prepared: result?.key === key ? result.value.snippet : undefined,
    error: failure?.key === key ? failure.message : result?.key === key ? undefined : i18nText('dynamicCalculatingTheRequestToSend'),
    copy,
    dialog: choice && <ModalFrame label={i18nText('uiConfirmSecretValueCopy')} onClose={() => setChoice(null)} width="w-[min(520px,94vw)]">
      <ModalHeader title={i18nText('uiConfirmSecretValueCopy')} onClose={() => setChoice(null)} />
      <p className="p-4 text-ui-md">{i18nText('uiContainsAuthenticationCookieOrVariableReferencesCopyingTheActual')}</p>
      <div className="flex flex-wrap justify-end gap-2 p-4"><button className="ah-btn" onClick={() => setChoice(null)}>{i18nText('uiCancel')}</button><button className="ah-btn" onClick={() => void confirm(false)}>{i18nText('uiCopyByVariableReference')}</button><button className="ah-btn" onClick={() => void confirm(true)}>{i18nText('uiCopyAsActualValue')}</button></div>
    </ModalFrame>,
  }
}
