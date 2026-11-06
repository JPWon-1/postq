'use client'
import { memo, useMemo, type CSSProperties, type ReactNode } from 'react'
import type { TextMatch } from '@/lib/textSearch'

// JSON 신택스 하이라이팅 — 외부 의존 없이 정규식 토크나이저로 span 을 입힌다.
// 색은 globals.css 의 --json-* 토큰(라이트/다크 각각)을 쓴다.

const TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\b(?:true|false)\b|\bnull\b/g

// 이 크기를 넘으면 평문으로 떨어진다. 예전엔 20만이었는데, 그 경계가 실사용 한복판이라
// 같은 화면인데 어떤 결과는 색이 있고 어떤 결과는 흰 글자로 나왔다 — 사용자가 먼저 알아챘다.
// 색이 없어지는 건 '큰 응답' 이라는 신호이지 버그가 아니므로, 한계를 올리되 꺼졌으면 말한다.
const MAX_HIGHLIGHT_CHARS = 600_000

/**
 * // 로 시작하는 줄 주석을 먼저 떼어 낸다.
 *
 * 이 앱은 ⌘/ 로 줄을 잠시 빼 두는 방식을 쓰는데, 주석이 본문과 같은 색으로 보이면
 * '지금 무엇이 빠져 있는지' 를 눈으로 세어야 한다. 음영을 깔아 한눈에 구분되게 한다.
 * 문자열 안의 //("http://…")는 주석이 아니므로 건너뛴다.
 */
function splitComments(text: string): { text: string; comment: boolean }[] {
  const out: { text: string; comment: boolean }[] = []
  let buf = ''
  let inString = false
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (inString) {
      if (c === '\\') { buf += text.slice(i, i + 2); i += 2; continue }
      if (c === '"') inString = false
      buf += c; i++; continue
    }
    if (c === '"') { inString = true; buf += c; i++; continue }
    if (c === '/' && text[i + 1] === '/') {
      let j = i
      while (j < text.length && text[j] !== '\n') j++
      if (buf) { out.push({ text: buf, comment: false }); buf = '' }
      out.push({ text: text.slice(i, j), comment: true })
      i = j
      continue
    }
    buf += c; i++
  }
  if (buf) out.push({ text: buf, comment: false })
  return out
}

type Segment = { text: string; style?: CSSProperties }
function tokenize(text: string): Segment[] {
  const out: Segment[] = []
  let last = 0
  for (const m of text.matchAll(TOKEN)) {
    const i = m.index!
    if (i > last) out.push({ text: text.slice(last, i) })
    const [whole, str, colon] = m
    const color = str !== undefined ? (colon ? 'var(--json-key)' : 'var(--json-string)')
      : whole === 'null' ? 'var(--json-null)' : /^(true|false)$/.test(whole) ? 'var(--json-boolean)' : 'var(--json-number)'
    out.push({ text: str ?? whole, style: { color } })
    if (colon) out.push({ text: colon })
    last = i + whole.length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

// Consume the syntax segments once. A match crossing tokens gets one mark with
// the original colored spans inside, without reparsing partial JSON strings.
function highlight(segments: Segment[], matches: TextMatch[], current: number): ReactNode[] {
  let segmentIndex = 0, offset = 0, position = 0, key = 0
  const take = (end: number) => {
    const nodes: ReactNode[] = []
    while (position < end && segmentIndex < segments.length) {
      const segment = segments[segmentIndex]
      const length = Math.min(end - position, segment.text.length - offset)
      const text = segment.text.slice(offset, offset + length)
      nodes.push(segment.style ? <span key={key++} style={segment.style}>{text}</span> : text)
      position += length; offset += length
      if (offset === segment.text.length) { segmentIndex++; offset = 0 }
    }
    return nodes
  }
  const out: ReactNode[] = []
  matches.forEach((match, index) => {
    out.push(take(match.start))
    out.push(<mark key={`match-${index}`} data-current-match={index === current ? 'true' : undefined}
      style={{ color: 'inherit', background: 'color-mix(in srgb, var(--accent) 22%, transparent)',
        outline: index === current ? '2px solid var(--accent)' : undefined, outlineOffset: 1 }}>{take(match.end)}</mark>)
  })
  out.push(take(Infinity))
  return out
}

/** 하이라이팅이 꺼질 크기인지 — 화면이 '왜 색이 없나' 에 답할 수 있게 밖으로 낸다. */
export function isTooBigToHighlight(text: string): boolean {
  return text.length > MAX_HIGHLIGHT_CHARS
}

export const JsonView = memo(function JsonView({ text, className, matches = [], current = -1, plain = false }: {
  text: string; className?: string; matches?: TextMatch[]; current?: number; plain?: boolean
}) {
  const segments = useMemo(() => plain || isTooBigToHighlight(text) ? [{ text }] : splitComments(text).flatMap(part => part.comment
    ? [{ text: part.text, style: { color: 'var(--faint-foreground)', background: 'color-mix(in srgb, var(--muted-foreground) 16%, transparent)', borderRadius: 3 } }]
    : tokenize(part.text)), [text, plain])
  return <pre className={className}>{highlight(segments, matches, current)}</pre>
})
