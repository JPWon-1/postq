'use client'
import { t as i18nText } from '@/i18n'
import { ToolButton } from './ToolButton'
import { kstFull } from '@/lib/datetime'
import { useState } from 'react'
import { diffLines, diffStats } from '@/lib/lineDiff'
import { compareExecutions, type DiffSection, type FieldDiff } from '@/lib/execDiff'
import { useFocusTrap } from '@/lib/useFocusTrap'
import type { ExecutionRow } from '@/lib/ui-types'

function label(e: ExecutionRow): string {
  const status = e.error ? 'ERR' : e.responseStatus != null ? String(e.responseStatus) : '—'
  return `$${status} · ${kstFull(e.executedAt)}`
}

/** 없는 값은 '(없음)' 으로 — 빈칸이면 '빈 문자열' 인지 '항목 자체가 없는지' 알 수 없다. */
function Value({ text, side }: { text: string; side: 'a' | 'b' }) {
  const tone = side === 'a' ? 'text-method-delete' : 'text-badge-new-fg'
  return (
    <span className={`min-w-0 flex-1 break-all font-mono text-ui-sm ${text ? tone : 'text-faint-foreground'}`}>
      {text || i18nText('jsxDoesnTExist')}
    </span>
  )
}

function FieldRow({ f }: { f: FieldDiff }) {
  return (
    <div className={`flex flex-col gap-0.5 rounded-[var(--radius-sm)] px-2 py-1 ${f.same ? '' : 'bg-badge-changed-bg/25'}`}>
      <span className="flex items-baseline gap-1.5">
        <span className="font-mono text-ui-meta font-semibold text-foreground">{f.key}</span>
        {f.onlyIn && (
          <span className="rounded-[var(--radius-sm)] bg-badge-changed-bg px-1 text-ui-meta font-bold text-badge-changed-fg">
            {f.onlyIn === 'a' ? i18nText('jsxAOnly') : i18nText('jsxBOnly')}
          </span>
        )}
      </span>
      {f.same ? (
        <span className="break-all font-mono text-ui-sm text-muted-foreground">{f.a || i18nText('jsxDoesnTExist')}</span>
      ) : (
        <>
          <span className="flex gap-1.5"><span className="w-3 shrink-0 text-center text-ui-meta font-bold text-method-delete">A</span><Value text={f.a} side="a" /></span>
          <span className="flex gap-1.5"><span className="w-3 shrink-0 text-center text-ui-meta font-bold text-badge-new-fg">B</span><Value text={f.b} side="b" /></span>
        </>
      )}
    </div>
  )
}

function TextDiff({ a, b }: { a: string; b: string }) {
  const lines = diffLines(a, b)
  const stats = diffStats(lines)
  if (stats.added === 0 && stats.removed === 0) {
    return <p className="px-2 py-2 text-ui-sm text-faint-foreground">{i18nText('uiSame')}</p>
  }
  return (
    <pre className="overflow-x-auto px-1 font-mono text-ui-sm leading-relaxed">
      {lines.map((l, i) => (
        <div
          key={i}
          className={
            l.type === 'add' ? 'bg-badge-new-bg/40 text-badge-new-fg'
              : l.type === 'del' ? 'bg-method-delete/10 text-method-delete'
                : 'text-muted-foreground'
          }
        >
          <span className="mr-1.5 inline-block w-3 select-none text-center text-faint-foreground">
            {l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}
          </span>
          {l.text || ' '}
        </div>
      ))}
    </pre>
  )
}

function Section({ s, showSame }: { s: DiffSection; showSame: boolean }) {
  // 기본은 '다른 게 있는 섹션만 펼침'. [전부 보기] 를 켜면 전부 편다 —
  // 켰는데 접힌 채로 있으면 버튼이 한 일이 화면에 없어 안 먹은 것처럼 보인다.
  // (호출부에서 showSame 을 key 에 넣어 다시 마운트시킨다)
  const [open, setOpen] = useState(showSame || s.changed > 0)
  const fields = showSame ? s.fields : s.fields.filter(f => !f.same)
  const textDiffers = s.text != null && s.text.a !== s.text.b
  const showText = s.text != null && (showSame || textDiffers)
  // 볼 게 없으면 아예 안 그린다 — 빈 제목만 늘어놓으면 훑는 데 방해가 된다.
  if (fields.length === 0 && !showText) return null

  return (
    <section className="border-b border-border/70 last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        onClick={() => setOpen(o => !o)}
      >
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden
          className={`shrink-0 text-faint-foreground transition-transform ${open ? 'rotate-90' : ''}`}>
          <path d="M3 1.5 7 5l-4 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="text-ui-md font-semibold text-foreground">{s.title}</span>
        {s.changed > 0 ? (
          <span className="rounded-full bg-badge-changed-bg px-1.5 text-ui-meta font-bold text-badge-changed-fg">{s.changed}</span>
        ) : (
          <span className="text-ui-meta text-faint-foreground">{i18nText('uiEquivalence')}</span>
        )}
      </button>
      {open && (
        <div className="flex flex-col gap-0.5 pb-2">
          {fields.map(f => <FieldRow key={f.key} f={f} />)}
          {showText && (
            <div className="mt-1 border-t border-border/50 pt-1">
              <p className="px-2 pb-0.5 ah-label">{i18nText('uiBody')}</p>
              <TextDiff a={s.text!.a} b={s.text!.b} />
            </div>
          )}
        </div>
      )}
    </section>
  )
}

/**
 * 두 실행을 비교한다. a=기준(이전), b=대상.
 *
 * 예전엔 응답 바디만 비교했다. "저번엔 됐는데 왜 지금은 안 되지" 의 답이 헤더 하나,
 * 환경 하나, URL 의 쿼리 한 글자인 경우가 많은데 그건 화면에 아예 안 나왔다 —
 * 바디가 다르다는 것까지만 알고 원인은 계속 못 찾는다.
 *
 * 요청·응답·실행 메타·검증을 전부 비교하되, 기본은 다른 것만 편다. 같은 값 수십 줄
 * 사이에서 다른 줄을 눈으로 찾는 건 비교 도구가 할 일을 사람에게 떠넘기는 것이다.
 */
export function ExecDiffModal({ a, b, onClose }: { a: ExecutionRow; b: ExecutionRow; onClose: () => void }) {
  const trapRef = useFocusTrap<HTMLDivElement>(true, onClose)
  const [showSame, setShowSame] = useState(false)
  const { sections, changed } = compareExecutions(a, b)

  return (
    <div className="animate-overlay-in fixed inset-0 z-[85] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-label={i18nText('uiRunComparison')}
        className="animate-dialog-in flex max-h-[85vh] w-[920px] max-w-full flex-col overflow-hidden rounded-[var(--radius-lg)] border border-border bg-surface shadow-[var(--shadow-card)]"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border/70 px-4 py-3">
          <h2 className="text-ui-lg font-bold text-foreground">{i18nText('uiRunComparison')}</h2>
          <span className={`rounded-full px-2 py-0.5 text-ui-sm font-semibold ${changed > 0 ? 'bg-badge-changed-bg text-badge-changed-fg' : 'bg-surface-2 text-faint-foreground'}`}>
            {changed > 0 ? i18nText('dynamicOtherItems', { v0: String(changed) }) : i18nText('jsxNoDifference')}
          </span>
          <button
            type="button"
            data-testid="diff-show-same"
            aria-pressed={showSame}
            title={i18nText('uiSeeAllTheSameItems')}
            className={`ml-auto rounded-[var(--radius-sm)] border px-2 py-0.5 text-ui-sm font-medium transition-colors ${
              showSame ? 'border-accent text-accent' : 'border-border text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setShowSame(v => !v)}
          >
            {showSame ? i18nText('jsxJustSomethingElse') : i18nText('jsxSeeAll')}
          </button>
          <ToolButton icon="close"
            type="button"
            aria-label={i18nText('uiClose')}
            className="ah-action flex h-6 w-auto px-1.5 items-center justify-center rounded-[var(--radius-sm)] text-faint-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            onClick={onClose}
           />
        </div>

        <div className="flex shrink-0 flex-col gap-1 border-b border-border/70 px-4 py-2.5 text-ui-md">
          <div className="flex items-center gap-2">
            <span className="w-4 shrink-0 text-center font-bold text-method-delete">A</span>
            <span className="truncate text-muted-foreground">{label(a)}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-4 shrink-0 text-center font-bold text-badge-new-fg">B</span>
            <span className="truncate text-muted-foreground">{label(b)}</span>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {changed === 0 && !showSame ? (
            <p className="px-4 py-8 text-center text-ui-md text-faint-foreground">
              {i18nText('uiTheTwoExecutionsAreExactlyTheSameThereIs')}
              <br />
              <span className="text-ui-sm">{i18nText('uiYouCanCheckTheValuesWithViewAll')}</span>
            </p>
          ) : (
            sections.map(s => <Section key={`${s.id}:${showSame}`} s={s} showSame={showSame} />)
          )}
        </div>
      </div>
    </div>
  )
}
