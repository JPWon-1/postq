import { t as i18nText } from '@/i18n'
import type { ReactNode } from 'react'

// URL/텍스트의 {{변수}}·{경로파라미터} 토큰을 색으로 구분해 렌더(하이라이트 백드롭용).
// {{var}}: 해석 가능하면 accent, 미등록이면 경고색(method-put). {param}: 경로 파라미터(method-patch).
const VAR_TOKEN = /(\{\{\s*[\w.$-]+\s*(?:\|\s*json\s*)?\}\}|\{[\w.$-]+\})/g
export function renderVarHighlight(text: string, isResolvable: (name: string) => boolean = () => true): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0, k = 0, m: RegExpExecArray | null
  VAR_TOKEN.lastIndex = 0
  while ((m = VAR_TOKEN.exec(text)) !== null) {
    if (m.index > last) out.push(<span key={k++}>{text.slice(last, m.index)}</span>)
    const tok = m[0]
    if (tok.startsWith('{{')) {
      const name = tok.replace(/[{}]/g, '').split('|')[0].trim()
      out.push(<span key={k++} title={i18nText('dynamicVariable', { v0: String(name) })} className={isResolvable(name) ? 'rounded bg-accent/10 text-accent' : 'rounded bg-method-put/10 text-method-put'}>{tok}</span>)
    } else {
      out.push(<span key={k++} className="text-method-patch">{tok}</span>)  // {경로파라미터}
    }
    last = m.index + tok.length
  }
  if (last < text.length) out.push(<span key={k++}>{text.slice(last)}</span>)
  return out
}
