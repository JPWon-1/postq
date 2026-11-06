'use client'
import { t as i18nText } from '@/i18n'
import { useEffect, useRef, useState } from 'react'
import { useToast } from './Toast'
import { schemeProblem } from '@/lib/wsUrl'
import { appendCapped, capLine, LOG_MAX } from '@/lib/logBuffer'
import { kstTime } from '@/lib/datetime'
import { errorText } from '@/lib/fetchJson'

type WsMsg = { dir: 'in' | 'out' | 'sys'; text: string; ts: number }

// WebSocket 클라이언트 — 서버 프록시 없이 브라우저가 직접 연결(WS 는 CORS 무관).
// 실시간 연결이라 요청/응답 모델과 달라 별도 모드로 둔다.
export function WebSocketPanel() {
  const toast = useToast()
  const [url, setUrl] = useState('wss://')
  const [status, setStatus] = useState<'closed' | 'connecting' | 'open'>('closed')
  /*
   * 줄과 '버린 개수' 를 한 상태로 묶는다.
   *
   * 예전엔 setLines 의 업데이터 '안에서' setDropped 를 불렀다. 업데이터는 순수해야 하는데
   * 부수효과를 넣은 것이라, React 가 업데이터를 두 번 돌리는 개발 모드에서 개수가 두 배가 됐다 —
   * 100줄을 버리고 '200줄을 버렸습니다' 라고 말했다. 몇 줄을 놓쳤는지 알려주는 것이 이 문구의
   * 존재 이유인데, 그 숫자가 틀리면 없느니만 못하다.
   */
  const [log, setLog] = useState<{ messages: WsMsg[]; dropped: number }>({ messages: [], dropped: 0 })
  const { messages, dropped } = log
  const [draft, setDraft] = useState('')
  const wsRef = useRef<WebSocket | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  // 최근 LOG_MAX 줄만 들고 있는다 — 오래 물려 두는 화면이라 무한히 쌓으면 나중에 못 쓴다.
  const push = (m: WsMsg) => setLog(s => {
    const { next, dropped: d } = appendCapped(s.messages, [m])
    return { messages: next, dropped: s.dropped + d }
  })
  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight) }, [messages])
  useEffect(() => () => wsRef.current?.close(), [])

  const connect = () => {
    if (status !== 'closed') { wsRef.current?.close(); return }
    // WebSocket 생성자는 http/https 를 스펙상 ws/wss 로 조용히 바꾼다 — 그래서 잘못된 스킴이
    // 예외로 잡히지 않고 엉뚱한 주소로 연결을 시도한 뒤 정보 없는 실패만 남았다. 앞단에서 본다.
    const bad = schemeProblem(url)
    if (bad) { toast('error', bad); return }
    try {
      const ws = new WebSocket(url)
      wsRef.current = ws
      setStatus('connecting')
      // 새 연결에서 '버린 개수' 만 0 으로 — 앞서 받아 둔 메시지는 그대로 둔다(원래 동작)
      setLog(s => ({ messages: s.messages, dropped: 0 }))
      push({ dir: 'sys', text: `연결 시도: ${url}`, ts: Date.now() })
      ws.onopen = () => { setStatus('open'); push({ dir: 'sys', text: '연결됨', ts: Date.now() }) }
      ws.onmessage = e => push({ dir: 'in', text: typeof e.data === 'string' ? capLine(e.data) : '[binary]', ts: Date.now() })
      // WebSocket onerror 는 스펙상 사유를 주지 않는다. 그렇다고 "브라우저 콘솔을 열어보라"고
      // 떠넘기면 앱 안에서 원인을 본다는 목적이 무너진다 — 아는 것만 쓰고, 곧 이어지는
      // onclose 가 종료 코드를 남긴다.
      ws.onerror = () => push({ dir: 'sys', text: '연결 실패 — 주소·네트워크·서버 핸드셰이크를 확인하세요', ts: Date.now() })
      ws.onclose = e => { setStatus('closed'); push({ dir: 'sys', text: `닫힘 (code ${e.code}${e.reason ? ` · ${e.reason}` : ''})`, ts: Date.now() }) }
    } catch (e) {
      // schemeProblem 이 앞에서 거르므로 여기까지 오는 건 드물다(혼합 콘텐츠 차단 등).
      setStatus('closed')
      toast('error', i18nText('dynamicFailedToStartConnection', { v0: String(errorText(e)) }))
    }
  }

  const send = () => {
    if (status !== 'open' || !draft) return
    wsRef.current?.send(draft)
    push({ dir: 'out', text: draft, ts: Date.now() })
    setDraft('')
  }

  const dot = status === 'open' ? 'bg-badge-new-fg' : status === 'connecting' ? 'bg-badge-changed-fg animate-pulse' : 'bg-faint-foreground'

  return (
    <div className="ah-view">
      <div className="ah-toolbar items-center">
        <span className="flex shrink-0 items-center gap-1.5">
          <span className={`h-2 w-2 rounded-full ${dot}`} />
          <span className="text-ui-sm font-medium text-muted-foreground">{status === 'open' ? i18nText('jsxConnected') : status === 'connecting' ? i18nText('jsxConnecting') : i18nText('jsxNotConnected')}</span>
        </span>
        <input
          aria-label={i18nText('uiWebSocketAddress')}
          className="h-8 min-w-0 flex-1 rounded-[var(--radius-sm)] border border-border bg-surface px-2.5 font-mono text-ui-md text-foreground outline-none focus-visible:border-accent"
          placeholder="wss://echo.example.com/socket"
          value={url}
          onChange={e => setUrl(e.target.value)}
          disabled={status !== 'closed'}
        />
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

      <div ref={logRef} className="ah-view-body p-3 font-mono text-ui-md">
        {messages.length === 0 && <p className="ah-hint-sans px-2 py-6 text-center text-faint-foreground">{i18nText('uiAfterConnectingAMessageWillAppearHere')}</p>}
        {dropped > 0 && (
          <p className="px-1 py-1 text-ui-sm text-faint-foreground">
            {i18nText('uiInFront')} {dropped.toLocaleString()}{i18nText('uiTheLineWasAbandonedRecent')} {LOG_MAX.toLocaleString()}{i18nText('uiJustLeaveALine')}
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className="flex gap-2 border-b border-border/70 px-1 py-1 last:border-b-0">
            <span className="shrink-0 text-faint-foreground">{kstTime(m.ts)}</span>
            <span className={`shrink-0 font-bold ${m.dir === 'in' ? 'text-method-get' : m.dir === 'out' ? 'text-method-post' : 'text-faint-foreground'}`}>
              {m.dir === 'in' ? '↓' : m.dir === 'out' ? '↑' : '·'}
            </span>
            <span className="min-w-0 break-all text-foreground">{m.text}</span>
          </div>
        ))}
      </div>

      <form className="flex shrink-0 items-center gap-2 border-t border-border/70 px-4 py-2" onSubmit={e => { e.preventDefault(); send() }}>
        <input
          aria-label={i18nText('uiMessageToSend')}
          className="min-w-0 flex-1 rounded-[var(--radius-sm)] border border-border bg-surface px-2.5 py-1.5 font-mono text-ui-lg text-foreground outline-none placeholder:text-faint-foreground focus-visible:border-accent disabled:opacity-50 ah-hint-sans"
          placeholder={status === 'open' ? i18nText('jsxAfterEnteringTheMessageEnter') : i18nText('jsxOnceConnectedYouCanEnter')}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          disabled={status !== 'open'}
        />
        <button type="submit" disabled={status !== 'open' || !draft} className="shrink-0 rounded-[var(--radius-sm)] bg-accent-solid px-4 py-1.5 text-ui-lg font-semibold text-accent-solid-foreground hover:bg-accent-solid-hover disabled:opacity-50">{i18nText('uiTransfer')}</button>
      </form>
    </div>
  )
}
