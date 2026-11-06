'use client'
import { t as i18nText } from '@/i18n'
import { stepCount, localizeKorean } from '@/i18n'
import { ToolButton } from './ToolButton'
import { useState } from 'react'
import { useFocusTrap } from '@/lib/useFocusTrap'
import { previewFlow, type PreviewRequest, type VarOrigin } from '@/lib/flowPreview'
import type { FlowStep } from '@/lib/flowChain'

/**
 * 실행 전에 값의 흐름을 보여준다.
 *
 * 지금까지는 돌려 봐야 알았다. 3단계 시나리오에서 2단계가 터지면 로그를 뒤져
 * "1단계가 뽑기로 한 token 이 실제로는 이름이 달랐네" 를 알아낸다 — 그런데 그건
 * 실행 전에 알 수 있는 것이다. 어떤 값을 쓰는지, 그게 앞 단계가 만드는 것인지,
 * 아무도 만들지 않는 것인지, 순서가 뒤집혔는지.
 *
 * 값 자체는 응답을 받아야 알지만, '연결이 이어져 있는가' 는 값 없이도 판정된다.
 * 그리고 실수는 대개 값이 아니라 연결에서 난다.
 */

function OriginTag({ o }: { o: VarOrigin }) {
  const map: Record<VarOrigin['kind'], { text: string; cls: string }> = {
    stepVar: { text: '이 단계 입력값', cls: 'bg-accent/15 text-accent' },
    extract: { text: '', cls: 'bg-badge-new-bg text-badge-new-fg' },
    auto: { text: '', cls: 'bg-badge-new-bg text-badge-new-fg' },
    env: { text: '환경·공통값', cls: 'bg-surface-2 text-muted-foreground' },
    missing: { text: '없음 — 그대로 전송됨', cls: 'bg-method-delete/15 text-method-delete' },
    later: { text: '', cls: 'bg-method-delete/15 text-method-delete' },
  }
  const base = map[o.kind]
  const text = o.kind === 'extract' ? i18nText('dynamicSelectedByLevel', { v0: String(o.step + 1), v1: String(o.path) })
    : o.kind === 'auto' ? i18nText('dynamicStepResponse', { v0: String(o.step + 1) })
      : o.kind === 'later' ? i18nText('dynamicStageNotYetExecuted', { v0: String(o.step + 1) })
        : localizeKorean(base.text)
  return <span className={`shrink-0 rounded-[var(--radius-sm)] px-1.5 py-px text-ui-meta font-medium ${base.cls}`}>{text}</span>
}

export function FlowPreviewPanel({ steps, requests, knownVars, unknownScope = null, onSelectStep }: {
  onSelectStep?: (index: number) => void
  steps: FlowStep[]
  requests: PreviewRequest[]
  /** 환경·전역·공통 입력값 이름. 값은 필요 없다 — 연결만 본다. */
  knownVars: string[]
  /**
   * 이름 목록을 못 읽은 스코프가 있으면 그 이름('전역 변수' 등).
   *
   * 못 읽은 채로 판정하면 그 스코프에만 있는 값이 전부 '어디에도 없음' 으로 잡힌다.
   * 없는 문제를 만들어내는 셈인데, 거짓 경고를 한 번 무시하고 나면 진짜 경고도 안 본다.
   * 그래서 개수 대신 '판정할 수 없다' 고 말한다.
   */
  unknownScope?: string | null
}) {
  const { steps: rows, problems } = previewFlow(steps, new Map(requests.map(r => [r.id, r])), new Set(knownVars))
  // 인라인으로 펼치면 단계가 셋만 돼도 500px 을 먹어 플로우차트와 편집기를 밀어낸다 —
  // 정작 고치러 온 자리가 화면 밖으로 나간다. 한 줄만 남기고 내용은 모달로 낸다.
  const [open, setOpen] = useState(false)
  // aria-modal 을 선언했으면 모달처럼 굴어야 한다 — Esc 로 닫히고, 포커스가 안으로 들어오고,
  // Tab 이 배경으로 새지 않고, 닫을 때 열었던 버튼으로 돌아간다. 앱의 다른 모달과 같은 훅.
  const dialogRef = useFocusTrap<HTMLDivElement>(open, () => setOpen(false))

  if (steps.length === 0) return null

  return (
    <section className="shrink-0 border-b border-border/70">
      <button
        type="button"
        data-testid="flow-preview-toggle"
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-1.5 text-left transition-colors hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        onClick={() => setOpen(o => !o)}
      >
        <h3 className="text-ui-md font-bold text-foreground">{i18nText('uiValueFlowPreview')}</h3>
        {unknownScope ? (
          <span
            className="rounded-full bg-method-put/15 px-2 py-px text-ui-meta font-bold text-method-put"
            title={i18nText('dynamicTheListCannotBeReadSoTheValuesMay', { v0: String(unknownScope) })}
          >
            {unknownScope}{i18nText('uiJudgmentOnHoldBecauseICouldnTReadIt')}
          </span>
        ) : problems.length > 0 ? (
          <span className="rounded-full bg-method-delete/15 px-2 py-px text-ui-meta font-bold text-method-delete">
            {i18nText('uiCheckBeforeExecution')} {problems.length}{i18nText('uiGun')}
          </span>
        ) : (
          <span className="text-ui-meta text-faint-foreground">{i18nText('uiNoProblemConnecting')}</span>
        )}
        <span className="ml-auto text-ui-meta text-faint-foreground">{i18nText('uiClickToLearnMoreDoNotExecute')}</span>
      </button>

      {open && (
        <div
          className="animate-overlay-in fixed inset-0 z-[85] flex items-center justify-center bg-black/50 p-4"
          onClick={() => setOpen(false)}
        >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={i18nText('uiValueFlowPreview')}
          tabIndex={-1}
          className="animate-dialog-in flex max-h-[85vh] w-[880px] max-w-full flex-col gap-1.5 overflow-y-auto rounded-[var(--radius-lg)] border border-border bg-surface p-4 shadow-[var(--shadow-card)]"
          onClick={e => e.stopPropagation()}
        >
          <p className="flex items-center gap-2 pb-1">
            <span className="text-ui-lg font-bold text-foreground">{i18nText('uiValueFlowPreview')}</span>
            <span className="text-ui-meta text-faint-foreground">{i18nText('uiVerifyWithoutExecuting')}</span>
            <kbd className="ml-auto rounded-[var(--radius-sm)] border border-border px-1 text-ui-meta font-normal text-faint-foreground">Esc</kbd>
            <ToolButton icon="close"
              type="button"
              aria-label={i18nText('uiClose')}
              className="ah-action flex h-6 w-auto px-1.5 items-center justify-center rounded-[var(--radius-sm)] text-faint-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
              onClick={() => setOpen(false)}
             />
          </p>
          {problems.length > 0 && (
            <ul className="flex flex-col gap-0.5 rounded-[var(--radius-sm)] border border-method-delete/30 bg-method-delete/5 px-2.5 py-1.5">
              {problems.map((p, i) => (
                <li key={i} className="text-ui-sm leading-relaxed text-method-delete">
                  <b>{stepCount(p.step + 1)}</b> — {p.message}
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-col gap-1">
            {rows.map(s => (
              <div key={s.index} role="button" tabIndex={0} aria-label={i18nText('dynamicStepSettings', { v0: String(s.index + 1), v1: String(s.name) })}
                className="cursor-pointer rounded-[var(--radius-sm)] border border-border/70 px-2.5 py-1.5 hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                onClick={() => { setOpen(false); onSelectStep?.(s.index) }}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(false); onSelectStep?.(s.index) } }}>

                <p className="flex items-baseline gap-1.5 pb-1">
                  <span className="shrink-0 rounded-full bg-surface-2 px-1.5 text-ui-meta font-bold text-muted-foreground">{s.index + 1}</span>
                  <span className="truncate text-ui-md font-semibold text-accent">{s.name}</span>
                  <span className="shrink-0 font-mono text-ui-meta text-faint-foreground">{s.method}</span>
                  {s.bodySource === 'prev' && <span className="shrink-0 text-ui-meta text-badge-new-fg">{i18nText('uiBodyPreviousResponse')}</span>}
                </p>

                <div className="grid gap-x-4 gap-y-1 md:grid-cols-2">
                  <div>
                    <p className="ah-label pb-0.5">{i18nText('uiValueReceived')} {s.consumes.length > 0 && s.consumes.length}</p>
                    {s.consumes.length === 0 ? (
                      <p className="text-ui-sm text-faint-foreground">{i18nText('uiNone')}</p>
                    ) : (
                      <ul className="flex flex-col gap-0.5">
                        {s.consumes.map(c => (
                          <li key={c.name} className="flex flex-wrap items-baseline gap-1.5">
                            <code className="font-mono text-ui-sm text-accent">{`{{${c.name}}}`}</code>
                            <span aria-hidden className="text-ui-meta text-faint-foreground">←</span>
                            <OriginTag o={c.origin} />
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div>
                    <p className="ah-label pb-0.5">{i18nText('uiValueToBePassed')} {s.produces.length > 0 && s.produces.length}</p>
                    {s.produces.length === 0 ? (
                      <p className="text-ui-sm text-faint-foreground">
                        {i18nText('uiNoExtractionRules')} <code className="font-mono text-muted-foreground">{`{{step${s.index + 1}Body}}`}</code> {i18nText('uiYouCanWriteTheEntireResponseAs')}
                      </p>
                    ) : (
                      <ul className="flex flex-col gap-0.5">
                        {s.produces.map(p => (
                          <li key={p.variable} className="flex flex-wrap items-baseline gap-1.5">
                            <code className="font-mono text-ui-sm text-badge-new-fg">{`{{${p.variable}}}`}</code>
                            <span className="font-mono text-ui-meta text-faint-foreground">{i18nText('uiReply')} {p.path}</span>
                            {p.usedBy.length > 0 ? (
                              <span className="text-ui-meta text-muted-foreground">→ {p.usedBy.map(n => i18nText('dynamicStage', { v0: String(n + 1) })).join(', ')}</span>
                            ) : (
                              <span className="text-ui-meta font-medium text-method-delete">{i18nText('uiThereIsNoPlaceToWrite')}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
        </div>
      )}
    </section>
  )
}
