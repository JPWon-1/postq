'use client'
import { t as i18nText, localizeKorean } from '@/i18n'
import { useEffect, useLayoutEffect, useState } from 'react'
import { readThemePref, setThemePref, type ThemePref } from '@/lib/theme'

function IconSun() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <circle cx="7" cy="7" r="2.6" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7 0.9v1.5M7 11.6v1.5M13.1 7h-1.5M2.4 7H0.9M11.3 2.7l-1.1 1.1M3.8 10.2l-1.1 1.1M11.3 11.3l-1.1-1.1M3.8 3.8 2.7 2.7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}
function IconMoon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M12 9A5.4 5.4 0 1 1 5 2a4.3 4.3 0 0 0 7 7Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}
function IconSystem() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <rect x="1.5" y="2.5" width="11" height="7.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5 12.2h4M7 10v2.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

const ITEMS: { pref: ThemePref; label: string; icon: React.ReactNode }[] = [
  { pref: 'light', label: '라이트', icon: <IconSun /> },
  { pref: 'system', label: '시스템', icon: <IconSystem /> },
  { pref: 'dark', label: '다크', icon: <IconMoon /> },
]

// 3-way 세그먼트 선택: 라이트 / 시스템 / 다크. system 은 OS 를 따르고 OS 변경도 실시간 반영.
export function ThemeToggle() {
  const [pref, setPref] = useState<ThemePref>('system')

  // 첫 페인트 전에 저장 pref 로 보정 — useEffect 면 light/dark 저장 사용자에게
  // '시스템' 세그먼트가 순간 활성으로 보이는 플래시가 생긴다(마크업 불변이라 hydration 안전).
  useLayoutEffect(() => { setPref(readThemePref()) }, [])

  useEffect(() => {
    // OS 테마 변경 실시간 반영은 전역 ThemeWatcher(layout)가 담당 — 여기선 세그먼트 동기화만.
    // 팔레트 등에서 테마를 바꾸면 세그먼트도 따라 갱신
    const onPref = () => setPref(readThemePref())
    window.addEventListener('ah:themepref', onPref)
    return () => window.removeEventListener('ah:themepref', onPref)
  }, [])

  const choose = (p: ThemePref) => { setPref(p); setThemePref(p) }

  return (
    <div role="radiogroup" aria-label={i18nText('uiTheme')} className="flex w-fit items-center gap-0.5 rounded-full border border-border bg-surface-2/60 p-0.5">
      {ITEMS.map(it => {
        const active = pref === it.pref
        return (
          <button
            key={it.pref}
            type="button"
            role="radio"
            aria-checked={active}
            title={i18nText('dynamicTheme', { v0: localizeKorean(it.label) })}
            // title 만 두면 접근 이름이 title 폴백에 기대게 된다 — 이름 계산의 맨 마지막
            // 수단이라 스크린리더마다 처리가 갈린다. 아이콘뿐인 버튼은 이름을 직접 준다.
            aria-label={i18nText('dynamicTheme', { v0: localizeKorean(it.label) })}
            className={`flex h-8 items-center justify-center gap-1.5 px-3 text-ui-sm rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
              active ? 'bg-surface text-accent shadow-[var(--shadow-panel)]' : 'text-faint-foreground hover:text-foreground'
            }`}
            onClick={() => choose(it.pref)}
          >
            {it.icon}<span>{localizeKorean(it.label)}</span>
          </button>
        )
      })}
    </div>
  )
}
