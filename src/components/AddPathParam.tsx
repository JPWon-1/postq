'use client'
import { t as i18nText } from '@/i18n'
import { useState } from 'react'

/**
 * [+ 경로 파라미터] — 이름만 넣으면 주소 경로 끝에 /{이름} 을 붙인다.
 * 쿼리는 표의 빈 줄에, 경로는 여기서 — 주소창에 직접 치는 것과 같은 결과다.
 */
export function AddPathParam({ onAdd }: { onAdd: (name: string) => void }) {
  const [name, setName] = useState('')
  const add = () => { if (name.trim()) { onAdd(name.trim()); setName('') } }
  return (
    <div className="flex items-center gap-1.5">
      <input aria-label={i18nText('uiNewRouteParameterName')} placeholder={i18nText('uiNewRouteParameterNameEGOrderId')}
        className="ah-input w-64 font-mono text-ui-sm" value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add() } }} />
      <button type="button" className="ah-btn px-2 py-1 text-ui-sm" disabled={!name.trim()} onClick={add}>{i18nText('uiAddToEndOfPath')}</button>
    </div>
  )
}
