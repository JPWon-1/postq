'use client'
import { t as i18nText } from '@/i18n'
import { useEffect, useRef, useState } from 'react'
import type { KV } from '@/lib/variables'
import { KVEditor } from './KVEditor'
import { HEADER_SUGGEST } from '@/lib/headerSuggestions'
import { useToast } from './Toast'
import { kstTime } from '@/lib/datetime'
import { appendCapped, capLine, LINE_MAX, LOG_MAX } from '@/lib/logBuffer'
import { errorText } from '@/lib/fetchJson'

type Line = { text: string; ts: number }

// SSE/스트리밍 뷰어 — /api/sse 프록시(서버가 헤더 붙여 연결)로 text/event-stream·chunked NDJSON 등을
// 실시간으로 흘려 본다. EventSource 가 커스텀 헤더를 못 붙이는 한계를 프록시로 우회.
export function SsePanel() {
  const toast = useToast()
  const [url, setUrl] = useState('https://')
  const [headers, setHeaders] = useState<KV[]>([])
  const [showHeaders, setShowHeaders] = useState(false)
  const [status, setStatus] = useState<'closed' | 'connecting' | 'open'>('closed')
  /*
   * 줄과 '버린 개수' 를 한 상태로 묶는다.
   *
   * 예전엔 setLines 의 업데이터 '안에서' setDropped 를 불렀다. 업데이터는 순수해야 하는데
   * 부수효과를 넣은 것이라, React 가 업데이터를 두 번 돌리는 개발 모드에서 개수가 두 배가 됐다 —
   * 100줄을 버리고 '200줄을 버렸습니다' 라고 말했다. 몇 줄을 놓쳤는지 알려주는 것이 이 문구의
   * 존재 이유인데, 그 숫자가 틀리면 없느니만 못하다.
   */
  const [log, setLog] = useState<{ lines: Line[]; dropped: number }>({ lines: [], dropped: 0 })
  const { lines, dropped } = log
  const abortRef = useRef<AbortController | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight) }, [lines])
  useEffect(() => () => abortRef.current?.abort(), [])

  const stop = () => abortRef.current?.abort()

  // 최근 LOG_MAX 줄만 들고 있는다 — 끊지 않고 흘려 보는 화면이라 상한이 없으면 스스로 굳는다.
  const push = (fresh: Line[]) => setLog(s => {
    const { next, dropped: d } = appendCapped(s.lines, fresh)
    return { lines: next, dropped: s.dropped + d }
  })

  const connect = async () => {
    if (status !== 'closed') { stop(); return }
    const controller = new AbortController()
    abortRef.current = controller
    setStatus('connecting'); setLog({ lines: [], dropped: 0 })
    try {
      const res = await fetch('/api/sse', {
        method: 'POST',
        body: JSON.stringify({ url, headers: headers.filter(h => h.key.trim()) }),
        signal: controller.signal,
      })
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => null)
        toast('error', i18nText('dynamicConnectionFailed', { v0: String(err?.error ?? res.status) }))
        setStatus('closed'); return
      }
      setStatus('open')
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        // 라인 단위로 방출(SSE data: 줄·NDJSON 모두 대응). 빈 줄(이벤트 구분)은 생략.
        const parts = buf.split('\n')
        buf = parts.pop() ?? ''
        const fresh = parts.map(t => capLine(t.replace(/\r$/, ''))).filter(t => t.trim() !== '')
        // 줄바꿈 없이 계속 오는 스트림이면 buf 가 끝없이 자란다 — 줄 상한을 넘으면 그만큼 끊어 한 줄로 내보낸다.
        if (buf.length > LINE_MAX) { fresh.push(capLine(buf)); buf = '' }
        if (fresh.length) push(fresh.map(t => ({ text: t, ts: Date.now() })))
      }
      if (buf.trim()) push([{ text: capLine(buf.trim()), ts: Date.now() }])
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        toast('error', i18nText('dynamicStreamError', { v0: String(errorText(e)) }))
      }
    } finally {
      setStatus('closed')
      abortRef.current = null
    }
  }

  const dot = status === 'open' ? 'bg-badge-new-fg' : status === 'connecting' ? 'bg-badge-changed-fg animate-pulse' : 'bg-faint-foreground'

  return (
    <div className="ah-view">
      <div className="ah-toolbar items-center">
        <span className="flex shrink-0 items-center gap-1.5">
          <span className={`h-2 w-2 rounded-full ${dot}`} />
          <span className="text-ui-sm font-medium text-muted-foreground">
            {status === 'open' ? i18nText('jsxConnected') : status === 'connecting' ? i18nText('jsxConnecting') : i18nText('jsxNotConnected')}
          </span>
        </span>
        <input
          aria-label={i18nText('uiStreamURL')}
          className="h-8 min-w-0 flex-1 rounded-[var(--radius-sm)] border border-border bg-surface px-2.5 font-mono text-ui-md text-foreground outline-none focus-visible:border-accent"
          placeholder="https://api.example.com/events (text/event-stream)"
          value={url}
          onChange={e => setUrl(e.target.value)}
          disabled={status !== 'closed'}
        />
        <button
          type="button"
          className="shrink-0 rounded-[var(--radius-sm)] border border-border px-2.5 py-1.5 text-ui-md font-medium text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => setShowHeaders(s => !s)}
        >
          {i18nText('uiHeader')}{headers.filter(h => h.key.trim()).length > 0 ? ` (${headers.filter(h => h.key.trim()).length})` : ''}
        </button>
        <button
          type="button"
          className={`h-8 shrink-0 rounded-[var(--radius-sm)] px-4 text-ui-md font-semibold transition-colors ${
            status === 'closed' ? 'bg-accent-solid text-accent-solid-foreground hover:bg-accent-solid-hover' : 'border border-border text-muted-foreground hover:text-foreground'
          }`}
          onClick={connect}
        >
          {status === 'closed' ? i18nText('jsxConnection') : i18nText('jsxDisconnect')}
        </button>
      </div>

      {showHeaders && (
        <div className="rounded-[var(--radius-md)] border border-border bg-surface p-2">
          <KVEditor items={headers} onChange={setHeaders} suggest={HEADER_SUGGEST} />
        </div>
      )}

      <div ref={logRef} className="ah-view-body p-3 font-mono text-ui-md">
        {lines.length === 0 && <p className="px-2 py-6 text-center text-faint-foreground">{i18nText('uiWhenYouConnectYourStreamEventsWillAppearHere')}{i18nText('variablePlaceholder')} {i18nText('uiNotSupportedEnterCompletedURL')}</p>}
        {dropped > 0 && (
          <p className="px-1 py-1 text-ui-sm text-faint-foreground">
            {i18nText('uiInFront')} {dropped.toLocaleString()}{i18nText('uiTheLineWasAbandonedRecent')} {LOG_MAX.toLocaleString()}{i18nText('uiJustLeaveALine')}
          </p>
        )}
        {lines.map((m, i) => (
          <div key={i} className="flex gap-2 border-b border-border/70 px-1 py-1 last:border-b-0">
            <span className="shrink-0 text-faint-foreground">{kstTime(m.ts)}</span>
            <span className="shrink-0 font-bold text-method-get">↓</span>
            <span className="min-w-0 break-all text-foreground">{m.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
