import { KEYS, read, remove, write } from './localStore'

// 테마 3-way: light / dark / system. localStorage 'theme' 에 선택을 저장하고,
// system 이면 OS 설정을 따르며 OS 변경도 실시간 반영한다.

export type ThemePref = 'light' | 'dark' | 'system'

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function readThemePref(): ThemePref {
  if (typeof window === 'undefined') return 'system'
  // storage 접근 차단 환경(사이트 데이터 차단·구형 프라이빗 모드)에서 throw 가
  // 마운트 useEffect 로 전파돼 ErrorBoundary 가 앱을 덮는 것을 방지.
  try {
    const t = read(KEYS.theme)
    return t === 'light' || t === 'dark' ? t : 'system'
  } catch { return 'system' }
}

/**
 * 선택(pref)을 실제 적용 테마로 해소해 <html data-theme> 에 반영.
 * 전환 순간에는 모든 transition 을 일시 차단한다 — 수백 개 요소의 transition-colors 가
 * 제각각 타이밍으로 바뀌며 생기는 얼룩덜룩한 중간 상태(및 일부 레이어 재도색 지연)를 없애
 * 테마가 '한 번에' 바뀌게 한다(next-themes 와 동일 기법).
 */
export function applyTheme(pref: ThemePref) {
  const effective = pref === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : pref
  const style = document.createElement('style')
  style.appendChild(document.createTextNode('*,*::before,*::after{transition:none !important}'))
  document.head.appendChild(style)
  document.documentElement.setAttribute('data-theme', effective)
  // 강제 리플로우로 스타일 적용을 확정한 뒤 다음 프레임에 차단 해제
  void window.getComputedStyle(document.body).transition
  requestAnimationFrame(() => { document.head.removeChild(style) })
}

export function setThemePref(pref: ThemePref) {
  // storage 실패해도 화면 적용·동기화 이벤트는 항상 수행한다(저장만 안 될 뿐).
  if (pref === 'system') remove(KEYS.theme)
  else write(KEYS.theme, pref)
  applyTheme(pref)
  // 팔레트 등 다른 곳에서 바꿔도 세그먼트 토글이 동기화되도록 알린다.
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('ah:themepref', { detail: pref }))
}

/**
 * system 모드에서 OS 테마 변경(일몰 자동 전환 포함)을 실시간 반영하는 전역 워처.
 * layout 의 ThemeWatcher 가 1회 등록한다 — ThemeToggle(헤더)이 없는 화면(/docs·게이트)에서도
 * 계약("system 이면 OS 변경도 실시간 반영")이 지켜지게 한다. 해제 함수를 반환.
 */
export function initSystemThemeWatcher(): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const onChange = () => { if (readThemePref() === 'system') applyTheme('system') }
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}
