'use client'
import { t as i18nText } from '@/i18n'
import { ToolButton } from './ToolButton'
import { DiagnosticsSettings } from './DiagnosticsSettings'
import dynamic from 'next/dynamic'
import { useCallback, useState } from 'react'
import { useFocusTrap } from '@/lib/useFocusTrap'
const AiHub = dynamic(() => import('./AiHub').then(m => m.AiHub), { loading: () => <p role="status" className="p-4 text-ui-sm text-muted-foreground">{i18nText('uiLoadingSettings')}</p> })
const CookieManager = dynamic(() => import('./CookieManager').then(m => m.CookieManager), { loading: () => <p role="status" className="p-4 text-ui-sm text-muted-foreground">{i18nText('uiLoadingSettings')}</p> })
const DisplaySettings = dynamic(() => import('./DisplaySettings').then(m => m.DisplaySettings), { loading: () => <p role="status" className="p-4 text-ui-sm text-muted-foreground">{i18nText('uiLoadingSettings')}</p> })
const EnvironmentModal = dynamic(() => import('./EnvironmentModal').then(m => m.EnvironmentModal), { loading: () => <p role="status" className="p-4 text-ui-sm text-muted-foreground">{i18nText('uiLoadingSettings')}</p> })
import { ImportButton, ExportButton } from './ImportButton'
import { SHORTCUTS } from './ShortcutHelp'
import packageInfo from '../../package.json'
import type { EnvironmentRow } from '@/lib/ui-types'
import { useT, type TranslationKey } from '@/i18n'
import { localizeKorean } from '@/i18n'

/**
 * 설정 — 관리하는 것들을 한 자리로 모은다.
 *
 * 환경/변수는 헤더에, 쿠키·Claude 연결·표시 설정은 톱니
 * 메뉴에 흩어져 있었다. 성격이 같은데(가끔 열어 설정하고 닫는다) 사는 곳이 셋이라
 * 무엇이 어디 있는지 외워야 했고, 그만큼 레일이 길어져 매일 쓰는 화면이 밀렸다.
 *
 * 왼쪽 목록 + 오른쪽 내용의 2단. 각 칸은 원래 모달이던 컴포넌트를 embedded 로 넣은
 * 것이라 기능은 그대로다 — 자리만 옮겼다.
 *
 * 스케줄은 여기 있다가 좌측 레일의 [스케줄] 화면으로 갔다 — 마지막 실행 결과를 매일 보는 곳이라
 * '가끔 열어 설정하고 닫는' 칸이 아니다. 두 곳에 두면 어디서 고친 것이 어디 보이는지 헷갈린다.
 */
export type SettingsTab = 'env' | 'cookies' | 'ai' | 'display' | 'diagnostics' | 'shortcuts' | 'data' | 'about'

const TABS: { key: SettingsTab; label: TranslationKey; hint: TranslationKey }[] = [
  { key: 'env', label: 'environmentsVariables', hint: 'environmentsHint' },
  { key: 'display', label: 'displayTheme', hint: 'displayHint' },
  { key: 'shortcuts', label: 'shortcuts', hint: 'shortcutsHint' },
  { key: 'cookies', label: 'cookies', hint: 'cookiesHint' },
  { key: 'data', label: 'data', hint: 'dataHint' },
  { key: 'ai', label: 'aiMcp', hint: 'aiHint' },
  { key: 'diagnostics', label: 'diagnostics', hint: 'diagnosticsHint' },
  { key: 'about', label: 'about', hint: 'aboutHint' },
]

export function SettingsDialog({ workspaceId, environments, activeEnvironmentId, onEnvironmentChange, initialTab = 'env', onClose, onEnvSaved, onDataImported }: {
  workspaceId: string
  environments: EnvironmentRow[]
  activeEnvironmentId?: string | null
  onEnvironmentChange?: (id: string) => void
  initialTab?: SettingsTab
  onClose: () => void
  onEnvSaved: () => void
  onDataImported?: () => void
}) {
  const t = useT()
  const [tab, setTab] = useState<SettingsTab>(initialTab)

  // 저장하지 않은 편집이 있는 칸은 개수를 여기로 알려 온다(환경·변수). Esc·바깥 클릭·[✕] 은
  // 셋 다 같은 '닫기' 라, 셋 다 확인 없이 닫으면 입력값이 말없이 사라진다.
  // 확인 문구는 이 앱이 탭을 닫을 때 쓰는 것과 같은 방식(window.confirm)을 따른다.
  const [dirtyTabs, setDirtyTabs] = useState<Partial<Record<SettingsTab, number>>>({})
  const markDirty = useCallback((key: SettingsTab, count: number) => {
    setDirtyTabs(prev => (prev[key] ?? 0) === count ? prev : { ...prev, [key]: count })
  }, [])
  const guardedClose = useCallback(() => {
    const pending = Object.values(dirtyTabs).reduce((a, b) => a + (b ?? 0), 0)
    if (pending > 0 && !window.confirm(t('unsavedClose', { count: pending }))) return
    onClose()
  }, [dirtyTabs, onClose, t])

  const markEnvDirty = useCallback((c: number) => markDirty('env', c), [markDirty])

  // 항목을 바꾸면 그 칸은 언마운트돼 편집이 사라진다. 닫을 때만 묻고 옮길 때는 안 물어서,
  // 변수 값을 고치다 '표시' 를 눌렀다 돌아오면 말없이 비어 있었다(codex 리뷰).
  const switchTab = (next: SettingsTab) => {
    if (next === tab) return
    const pending = dirtyTabs[tab] ?? 0
    if (pending > 0 && !window.confirm(t('unsavedSwitch', { count: pending }))) return
    setDirtyTabs(prev => ({ ...prev, [tab]: 0 }))
    setTab(next)
  }

  const trapRef = useFocusTrap<HTMLDivElement>(true, guardedClose)

  return (
    <div
      className="animate-overlay-in fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={guardedClose}
    >
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('settings')}
        className="animate-dialog-in flex h-[85vh] flex-col sm:flex-row w-[min(1040px,95vw)] overflow-hidden rounded-[var(--radius-lg)] border border-border/60 bg-surface shadow-[var(--shadow-card)]"
        onClick={e => e.stopPropagation()}
      >
        {/* 왼쪽 목록 */}
        <nav
          aria-label={t('settingsItems')}
          className="flex w-full shrink-0 flex-row gap-0.5 overflow-auto border-b sm:w-56 sm:flex-col sm:border-b-0 sm:border-r border-border/50 bg-background/40 p-3"
        >
          <p className="ah-label hidden px-2.5 sm:block pb-1.5 pt-1">{t('settings')}</p>
          {TABS.map(item => (
            <button
              key={item.key}
              type="button"
              data-testid={`settings-${item.key}`}
              aria-current={tab === item.key}
              className={`flex shrink-0 flex-col items-start gap-0.5 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
                tab === item.key ? 'bg-surface-2 text-foreground' : 'text-muted-foreground hover:bg-surface-2'
              }`}
              onClick={() => switchTab(item.key)}
            >
              <span className="text-ui-md font-medium">{t(item.label)}</span>
              <span className="hidden text-ui-meta leading-tight sm:block text-faint-foreground">{t(item.hint)}</span>
            </button>
          ))}
        </nav>

        {/* 오른쪽 내용 */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-6 py-4">
            <h2 className="text-xl font-semibold text-foreground">{t(TABS.find(item => item.key === tab)!.label)}</h2>
            <ToolButton icon="close"
              type="button"
              aria-label={t('closeSettings')}
              className="ah-action ml-auto flex h-6 w-auto px-1.5 items-center justify-center rounded-[var(--radius-sm)] text-faint-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              onClick={guardedClose}
             />
          </div>

          {/* 탭을 바꾸면 이전 칸은 언마운트된다 — 편집 중이던 값이 남아 다음에 열었을 때
              저장한 줄 알았던 것이 보이는 편이 더 나쁘다. */}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {tab === 'shortcuts' && <div className="overflow-auto px-6 py-4"><h3 className="mb-3 text-lg font-semibold">{i18nText('uiKeyboard')}</h3>{SHORTCUTS.map(([keys, label]) => <div key={keys} className="flex items-center justify-between gap-6 border-b border-border py-3 text-ui-md"><span>{localizeKorean(label)}</span><kbd className="shrink-0 rounded border border-border px-2 py-1 font-mono text-muted-foreground">{keys}</kbd></div>)}</div>}
            {tab === 'data' && <div className="px-6 py-4"><h3 className="mb-4 text-lg font-semibold">{i18nText('uiFile')}</h3><div className="flex items-center justify-between gap-5 border-b border-border py-3"><div><h4>{i18nText('uiImport')}</h4><p className="mt-1 text-ui-md text-faint-foreground">{i18nText('uiReadExportedDataOrAPIClientFiles')}</p></div><ImportButton workspaceId={workspaceId} onImported={onDataImported ?? onEnvSaved} /></div><div className="flex items-center justify-between gap-5 border-b border-border py-3"><div><h4>{i18nText('uiExportBackup')}</h4><p className="mt-1 text-ui-md text-faint-foreground">{i18nText('uiSaveTheCurrentDataAsAFile')}</p></div><ExportButton /></div></div>}
            {tab === 'about' && <div className="space-y-5 px-8 py-8"><h3 className="text-2xl font-semibold">postq</h3><p className="text-muted-foreground">{i18nText('uiPrivateLocalAPIClient')}</p><div className="flex justify-between border-b border-border py-4"><span>{i18nText('uiVersion')}</span><span>{packageInfo.version}</span></div><div className="flex justify-between border-b border-border py-4"><span>{i18nText('uiLicense')}</span><span>MIT</span></div></div>}
            {tab === 'diagnostics'  && <DiagnosticsSettings />}
            {tab === 'env' && (
              <EnvironmentModal
                embedded
                workspaceId={workspaceId}
                environments={environments}
                activeEnvironmentId={activeEnvironmentId}
                onActivate={onEnvironmentChange}
                onClose={onClose}
                onSaved={onEnvSaved}
                onDirtyChange={markEnvDirty}
              />
            )}
            {tab === 'cookies' && (
              <CookieManager embedded workspaceId={workspaceId} environments={environments} onClose={onClose} />
            )}
            {tab === 'ai' && <AiHub embedded onClose={onClose} />}
            {tab === 'display' && <DisplaySettings embedded workspaceId={workspaceId} onClose={onClose} />}
          </div>
        </div>
      </div>
    </div>
  )
}
