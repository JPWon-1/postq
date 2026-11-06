'use client'
import { t as i18nText } from '@/i18n'

// {{변수}} 자동완성 드롭다운 — 후보 렌더링만 담당하는 프레젠테이션 컴포넌트.
// 열림 여부/후보 계산은 lib/varAutocomplete.ts, 키보드 내비게이션은 부모(입력창) 쪽에서 처리한다.
// 부모는 relative 컨테이너로 감싸서 입력창 바로 아래에 붙인다.
export function VarSuggest({ matches, activeIndex, onPick }: {
  matches: string[]
  activeIndex: number
  onPick: (name: string) => void
}) {
  return (
    <ul
      role="listbox"
      aria-label={i18nText('uiVariableAutocompletion')}
      className="absolute left-0 top-full z-20 mt-1 max-h-48 w-64 overflow-y-auto rounded-[var(--radius-sm)] border border-border bg-surface py-1 shadow-[var(--shadow-card)]"
    >
      {matches.map((name, i) => (
        <li key={name} role="option" aria-selected={i === activeIndex}>
          <button
            type="button"
            className={`w-full px-2.5 py-1 text-left font-mono text-ui-md transition-colors ${
              i === activeIndex ? 'bg-accent/15 text-accent' : 'text-foreground hover:bg-surface-2'
            }`}
            // mousedown 에서 preventDefault — 입력창 blur 로 드롭다운이 먼저 닫히는 것을 막는다
            onMouseDown={e => { e.preventDefault(); onPick(name) }}
          >
            {'{{'}{name}{'}}'}
          </button>
        </li>
      ))}
    </ul>
  )
}
