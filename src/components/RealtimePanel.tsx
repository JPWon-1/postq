'use client'
import { t as i18nText } from '@/i18n'
import { useState } from 'react'
import { KEYS } from '@/lib/localStore'
import { useStickyState } from '@/lib/useStickyState'
import { WebSocketPanel } from './WebSocketPanel'
import { SsePanel } from './SsePanel'

/**
 * 실시간 프로토콜 묶음 — WebSocket / SSE(스트리밍). 요청/응답 모델과 달라 별도 모드.
 *
 * 두 패널을 항상 띄워 두고 안 보는 쪽만 숨긴다. 예전엔 탭에 따라 하나만 그려서,
 * 다른 탭을 잠깐 보고 돌아오면 연결이 끊기고 받아 둔 메시지도 사라졌다 —
 * 스트림을 오래 지켜보라고 만든 화면에서 제일 하면 안 되는 일이다.
 * (연결 정리는 각 패널의 unmount 정리가 그대로 맡는다. 모드를 떠나면 둘 다 닫힌다)
 */
export function RealtimePanel() {
  // 화면을 떠났다 와도 고른 탭이 남는다 — 조건부 마운트라 예전엔 매번 WebSocket 이었다.
  const [tab, setTab] = useStickyState<'ws' | 'sse'>(KEYS.realtimeTab, 'ws', v => v === 'ws' || v === 'sse')
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border bg-surface-2/50 px-3 py-1.5">
        {([['ws', 'WebSocket'], ['sse', i18nText('jsxSSEStreaming')]] as const).map(([k, label]) => (
          <button
            key={k}
            type="button"
            // 어느 쪽이 열려 있는지 색으로만 알렸다 — 읽어 주는 도구에는 아무 차이가 없었다.
            aria-pressed={tab === k}
            className={`rounded-[var(--radius-sm)] px-2.5 py-1 text-ui-md font-semibold transition-colors ${
              tab === k ? 'bg-accent/15 text-accent' : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setTab(k)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className={tab === 'ws' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}><WebSocketPanel /></div>
      <div className={tab === 'sse' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}><SsePanel /></div>
    </div>
  )
}
