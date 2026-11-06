'use client'
import { t as i18nText, localizeKorean } from '@/i18n'
import { ToolButton } from './ToolButton'
import { useEffect } from 'react'
import { useModifierHint } from '@/lib/useModifierHint'

export const SHORTCUTS: [string, string][] = [
  ['⌘/Ctrl + K', '요청 퀵오픈 (전체 검색)'],
  ['⌘/Ctrl + 1~5', '항목·시나리오 섹션·이력·스케줄 섹션·실시간 포커스'],
  ['⌘/Ctrl + [ / ]', '프로젝트 이전/다음 전환'],
  ['⌘/Ctrl + ⇧ + [ / ]', '열린 요청 탭 이전/다음'],
  ['⌘/Ctrl + E', '컬렉션 목록 표시/숨기기'],
  ['⌘/Ctrl + B', '실행 이력 표시/숨기기'],
  ['⌘/Ctrl + \\', '집중 모드 (사이드 패널 접기)'],
  ['⌘/Ctrl + Enter', '현재 요청 실행'],
  ['⌘/Ctrl + ⇧ + C', '현재 요청 cURL 복사 (입력 중에는 기본 동작)'],
  ['⌘/Ctrl + S', '요청 변경 저장'],
  ['⌘/Ctrl + W', '데스크톱: 현재 요청 탭 닫기 (웹에서는 브라우저 동작)'],
  ['⌘/Ctrl + Alt + W', '요청 탭 닫기 대체 키 · 탭 포커스에서는 Delete'],
  ['Esc', '창·팔레트·이 도움말 닫기'],
]

// 상태바의 단축키 버튼으로 도움말을 연다. Option은 텍스트 편집에 양보한다.
// pinned=true 면 상태바에서 눌러 연 것 — 수식키를 놓아도 닫히지 않고 닫기 버튼이 붙는다.
export function ShortcutHelp({ pinned = false, onClose }: { pinned?: boolean; onClose?: () => void } = {}) {
  const show = useModifierHint()
  // 고정해 연 도움말도 Esc 로 닫는다 — ✕ 나 상태바를 다시 눌러야만 닫혔다(codex 점검).
  useEffect(() => {
    if (!pinned || !onClose) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pinned, onClose])
  if (!show && !pinned) return null
  return (
    <div className={`fixed bottom-8 left-1/2 z-[95] -translate-x-1/2 rounded-[var(--radius-lg)] border border-border bg-surface px-4 py-3 shadow-[var(--shadow-card)] ${pinned ? '' : 'pointer-events-none'}`}>
      <p className="flex items-center gap-3 pb-1.5 ah-label">
        {i18nText('uiShortcutKey')}
        {pinned && (
          <ToolButton icon="close" type="button" aria-label={i18nText('uiShortcutClose')} className="ah-action ml-auto rounded-[var(--radius-sm)] px-1 text-ui-sm normal-case tracking-normal text-muted-foreground hover:text-foreground" onClick={onClose} />
        )}
      </p>
      <div className="flex flex-col gap-1">
        {SHORTCUTS.map(([k, label]) => (
          <div key={k} className="flex items-center gap-3 text-ui-md">
            <kbd className="w-40 shrink-0 rounded-[var(--radius-sm)] border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-ui-sm text-muted-foreground">{k}</kbd>
            <span className="text-foreground">{localizeKorean(label)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
