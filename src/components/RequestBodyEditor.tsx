'use client'
import { t as i18nText } from '@/i18n'
import { useEffect, useRef, type TextareaHTMLAttributes } from 'react'
import { JsonView } from './JsonView'
import { TextSearchControls, useTextSearch } from './TextSearch'

export function RequestBodyEditor({ json, errorAt = null, editorRef, fit = false, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  json: boolean
  /** Bounded split panes supply the available height; standalone forms keep their minimum. */
  fit?: boolean
  /** 바깥의 [정리] 버튼이 되돌리기를 살린 채 값을 바꿀 수 있게 본체를 넘긴다. */
  editorRef?: { current: HTMLTextAreaElement | null }
  /** JSON 문법이 틀어진 원문 위치(0-based). 그 자리를 빨갛게 짚어 준다. null 이면 표시 없음. */
  errorAt?: number | null
}) {
  const editor = useRef<HTMLTextAreaElement>(null)
  const backdrop = useRef<HTMLDivElement>(null)
  const value = String(props.value ?? '')
  const search = useTextSearch(value)
  useEffect(() => {
    const ta = editor.current
    const match = search.matches[search.current]
    // Do not move the selection underneath someone editing with find still open.
    if (!ta || !match || document.activeElement === ta) return
    const style = getComputedStyle(ta)
    ta.scrollTop = Math.max(0, value.slice(0, match.start).split('\n').length * parseFloat(style.lineHeight) - ta.clientHeight / 2)
    const column = match.start - value.lastIndexOf('\n', match.start - 1) - 1
    ta.scrollLeft = Math.max(0, column * parseFloat(style.fontSize) * 0.6 - ta.clientWidth / 2)
    ta.setSelectionRange(match.start, match.end)
    if (backdrop.current) { backdrop.current.scrollTop = ta.scrollTop; backdrop.current.scrollLeft = ta.scrollLeft }
  }, [value, search.matches, search.current])
  /**
   * Tab 으로 들여쓴다.
   *
   * textarea 의 기본 Tab 은 다음 컨트롤로 포커스를 옮긴다 — JSON 을 손으로 맞추다가 Tab 을
   * 누르면 엉뚱한 버튼으로 튀었다. 코드 편집기에서는 Tab 이 들여쓰기라 그쪽 습관을 따른다.
   *
   * 키보드만 쓰는 사람이 편집기에 갇히지 않도록 Escape 로 빠져나갈 길을 남긴다(아래 Escape 처리).
   */
  /**
   * 값을 바꾸되 ⌘Z 로 되돌릴 수 있게 한다.
   *
   * React state 로 값을 갈아끼우면 브라우저가 쌓아 둔 undo 기록이 끊긴다 — [정리] 한 번에
   * 주석이 사라졌는데 되돌릴 수도 없던 게 이 때문이다. execCommand('insertText') 는
   * 사용자가 직접 친 것과 같은 취급이라 기록에 남는다(오래된 API 지만 이 용도로는 이것뿐이다).
   */
  const replaceRange = (ta: HTMLTextAreaElement, from: number, to: number, text: string) => {
    ta.focus()
    ta.setSelectionRange(from, to)
    if (!document.execCommand('insertText', false, text)) {
      // 지원하지 않는 환경이면 값이라도 바꾼다(되돌리기는 포기).
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(ta, ta.value.slice(0, from) + text + ta.value.slice(to))
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }

  const indent = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = editor.current
    if (!ta) return
    e.preventDefault()
    const { selectionStart: from, selectionEnd: to, value: v } = ta
    const lineStart = v.lastIndexOf('\n', from - 1) + 1
    const multi = v.slice(from, to).includes('\n')
    let next: string, caret: [number, number]
    if (multi || e.shiftKey) {
      // 여러 줄이거나 내어쓰기면 줄 단위로 다룬다.
      let end = v.indexOf('\n', to); if (end === -1) end = v.length
      const block = v.slice(lineStart, end)
      const lines = block.split('\n').map(l => e.shiftKey ? l.replace(/^ {1,2}/, '') : '  ' + l)
      const replaced = lines.join('\n')
      next = v.slice(0, lineStart) + replaced + v.slice(end)
      caret = [lineStart, lineStart + replaced.length]
    } else {
      next = v.slice(0, from) + '  ' + v.slice(to)
      caret = [from + 2, from + 2]
    }
    // 바뀐 구간만 바꾼다 — 전체를 갈아끼우면 ⌘Z 한 번에 통째로 되돌아간다.
    const head = multi || e.shiftKey ? lineStart : from
    const tail = multi || e.shiftKey ? (v.indexOf('\n', to) === -1 ? v.length : v.indexOf('\n', to)) : to
    replaceRange(ta, head, tail, next.slice(head, tail === v.length ? next.length : next.length - (v.length - tail)))
    requestAnimationFrame(() => ta.setSelectionRange(caret[0], caret[1]))
  }

  /**
   * ⌘/ — 선택한 줄(들)에 // 주석을 토글한다. 코드 에디터의 기본 습관이다.
   *
   * 요청 화면에만 있었고, 거기선 React 상태로 값을 통째로 갈아끼워 ⌘Z 로 되돌릴 수 없었다
   * ([정리] 에서 두 번 고친 버그가 세 번째 자리에 남아 있었다). 편집기 안으로 옮겨 replaceRange 로
   * 바꾼 구간만 친 것처럼 넣는다 — 되돌리기가 살고, 시나리오 바디에서도 똑같이 된다.
   */
  const toggleComment = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = editor.current
    if (!ta) return
    e.preventDefault()
    const { selectionStart, selectionEnd, value } = ta
    const from = value.lastIndexOf('\n', selectionStart - 1) + 1
    let to = value.indexOf('\n', selectionEnd)
    if (to === -1) to = value.length
    const lines = value.slice(from, to).split('\n')
    // 내용 있는 줄이 모두 // 로 시작하면 해제, 아니면 추가 — 한 번에 토글.
    const commented = lines.filter(l => l.trim()).every(l => l.trimStart().startsWith('//'))
    const next = lines.map(l => {
      if (!l.trim()) return l
      if (commented) return l.replace(/^(\s*)\/\/ ?/, '$1')
      const pad = l.slice(0, l.length - l.trimStart().length)
      return pad + '// ' + l.slice(pad.length)
    }).join('\n')
    replaceRange(ta, from, to, next)
    requestAnimationFrame(() => ta.setSelectionRange(from, from + next.length))
  }

  const lineNumbers = useRef<HTMLDivElement>(null)
  return <div ref={search.regionRef} className={`flex flex-1 flex-col gap-2 ${fit ? 'min-h-0' : 'min-h-[260px]'}`} onKeyDownCapture={e => {
    if (e.key === 'Escape' && search.query) { search.setQuery(''); e.preventDefault(); e.stopPropagation() }
  }}>
    <div className="flex shrink-0 flex-wrap items-center gap-2 text-ui-sm">
      <TextSearchControls search={search} label={i18nText('uiRequestBodySearch')} />
    </div>
    <div data-request-editor-box className={`relative flex-1 overflow-hidden rounded-[var(--radius-sm)] border border-border bg-surface focus-within:ring-2 focus-within:ring-accent/25 ${fit ? 'min-h-0' : 'min-h-[220px]'}`}>
      <div ref={lineNumbers} aria-hidden className="pointer-events-none absolute inset-y-0 left-0 z-10 w-10 overflow-hidden border-r border-border bg-surface py-2.5 text-right font-mono text-ui-lg leading-relaxed text-faint-foreground">{value.split('\n').map((_, i) => <div key={i} className="pr-2">{i + 1}</div>)}</div>
      {(json || search.query) && <div ref={backdrop} aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        {/* 문법이 틀어진 자리를 빨갛게 짚는다. 배지로 'JSON 오류' 라고만 알리면 어디가 문제인지
            눈으로 훑어야 한다 — 긴 바디에서는 그게 제일 오래 걸린다.
            글자 수가 바뀌면 안 된다(입력칸과 한 글자씩 겹쳐 있다). 그래서 색만 입힌다. */}
        {!search.query && errorAt !== null && errorAt < value.length ? (
          <pre className="m-0 min-h-full w-max min-w-full whitespace-pre p-2.5 pl-12 font-mono text-ui-lg leading-relaxed">
            <JsonView text={value.slice(0, errorAt)} className="m-0 inline whitespace-pre p-0 font-mono text-ui-lg leading-relaxed" />
            <span style={{ background: 'color-mix(in srgb, var(--method-delete) 30%, transparent)', borderBottom: '2px solid var(--method-delete)' }}>{value.slice(errorAt, errorAt + 1)}</span>
            <JsonView text={value.slice(errorAt + 1) + '\n'} className="m-0 inline whitespace-pre p-0 font-mono text-ui-lg leading-relaxed" />
          </pre>
        ) : (
          <JsonView text={value + '\n'} matches={search.matches} current={search.current} plain={!json} className="m-0 min-h-full w-max min-w-full whitespace-pre p-2.5 pl-12 font-mono text-ui-lg leading-relaxed" />
        )}
      </div>}
      <textarea {...props} ref={el => { editor.current = el; if (editorRef) editorRef.current = el }} wrap="off" spellCheck={false}
        onKeyDown={e => {
          if (e.key === 'Tab') { indent(e); return }
          if ((e.metaKey || e.ctrlKey) && e.key === '/') { toggleComment(e); return }
          props.onKeyDown?.(e)
        }} className="absolute inset-0 h-full w-full resize-none border-0 bg-transparent p-2.5 pl-12 font-mono text-ui-lg leading-relaxed outline-none" style={{ color: (json || search.query) ? 'transparent' : 'var(--foreground)', caretColor: 'var(--foreground)' }} onScroll={e => { if (lineNumbers.current) lineNumbers.current.scrollTop = e.currentTarget.scrollTop; if (backdrop.current) { backdrop.current.scrollTop = e.currentTarget.scrollTop; backdrop.current.scrollLeft = e.currentTarget.scrollLeft } }} />
    </div>
  </div>
}
