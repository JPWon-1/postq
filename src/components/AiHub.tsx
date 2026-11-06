'use client'
import { t as i18nText, localizeKorean } from '@/i18n'
import { ToolButton } from './ToolButton'
import { useEffect, useState } from 'react'
import { ModalFrame } from './ModalFrame'
import { useToast } from './Toast'
import { copyText } from '@/lib/clipboard'

const TOOLS: { name: string; desc: string }[] = [
  { name: 'search_requests', desc: '저장된 요청 템플릿 검색' },
  { name: 'execute_request', desc: '요청 실행 — 환경/공통헤더 적용, 이력 기록, 실패 원인 해설' },
  { name: 'run_scenario', desc: 'API 체인 시나리오 자동 실행 + 스텝별 결과' },
  { name: 'get_history', desc: '실행 이력 조회' },
  { name: 'get_workspace_info', desc: '프로젝트·환경·폴더 설명 조회' },
]

const PROMPTS = [
  '주문 생성을 개발 환경에서 실행하고, 실패하면 최근 이력과 비교해서 원인 분석해줘',
  '로그인 → 주문조회 시나리오 돌려보고 어디서 끊기는지 알려줘',
  '주문 취소 관련 요청을 찾아서 개발 환경으로 실행해줘',
]

function CopyRow({ label, value }: { label: string; value: string }) {
  const toast = useToast()
  return (
    <div className="group flex min-w-0 items-start gap-2 rounded-[var(--radius-md)] border border-border bg-surface-2/60 px-3 py-2.5">
      <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-ui-md text-foreground">{value}</code>
      <button
        type="button"
        className="shrink-0 rounded-[var(--radius-sm)] bg-accent-solid px-2.5 py-1 text-ui-sm font-semibold text-accent-solid-foreground transition-transform hover:scale-105 active:scale-95"
        onClick={async () => { const ok = await copyText(value); toast(ok ? 'success' : 'error', ok ? i18nText('dynamicCopied', { v0: String(label) }) : i18nText('jsxCopyFailedYourBrowserMayHaveBlockedTheClipboard')) }}
      >
        {i18nText('uiCopy')}
      </button>
    </div>
  )
}

// AI 협업 허브 — 각자의 Claude(Code/Desktop)를 postq 에 붙여 도구로 부리게 하는 온보딩.
// 앱은 LLM 을 호출하지 않는다(비용 0). 토큰은 사용자 본인 AI 가 쓴다.
export function AiHub({ onClose, embedded = false }: {
  onClose: () => void
  /** 설정 다이얼로그 안에 놓일 때 — 배경·닫기 없이 내용만 낸다 */
  embedded?: boolean
}) {
  const [origin, setOrigin] = useState('')
  // 서버에 MCP_TOKEN 을 정했는가 — 값은 내려오지 않는다(이 안내 경로는 토큰 검사 밖이다). 자리표시자만 넣는다.
  const [tokenRequired, setTokenRequired] = useState(false)
  useEffect(() => {
    setOrigin(window.location.origin)
    fetch('/api/mcp-info').then(r => r.ok ? r.json() : null).then(d => { if (d) setTokenRequired(d.tokenRequired === true) }).catch(() => {})
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // MCP_TOKEN 을 정한 서버면 연결 명령에 Bearer 헤더 자리를 붙인다 — 값은 서버를 띄운 사람이 채운다.
  const TOKEN_SLOT = '<MCP_TOKEN 값>'
  const headerFlag = tokenRequired ? ` --header "Authorization: Bearer ${TOKEN_SLOT}"` : ''
  const mcpCmd = `claude mcp add --transport http postq ${origin}/api/mcp/mcp${headerFlag}`
  // Claude Desktop 은 설정 파일에 서버를 적는다. 로컬 주소는 mcp-remote 로 잇는다(레포 없이 따라 할 수 있게).
  const desktopArgs = [`"-y"`, `"mcp-remote"`, `"${origin}/api/mcp/mcp"`, ...(tokenRequired ? [`"--header"`, `"Authorization: Bearer ${TOKEN_SLOT}"`] : [])]
  const desktopJson = `{ "mcpServers": { "postq": { "command": "npx", "args": [${desktopArgs.join(', ')}] } } }`

  return (
    <ModalFrame embedded={embedded} label={i18nText('uiWritingInClaude')} width="w-[min(680px,94vw)]" onClose={onClose}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* 히어로 */}
        <div className="relative overflow-hidden border-b border-border/70 px-8 pb-7 pt-8">
          <div
            className="pointer-events-none absolute inset-0 opacity-80"
            style={{ background: 'radial-gradient(120% 90% at 15% -10%, color-mix(in oklab, var(--accent) 22%, transparent), transparent 60%)' }}
          />
          <div className="relative">
            <div className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-2.5 py-0.5 text-ui-sm font-semibold text-accent">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" /> {i18nText('uiWrittenByClaudeMCP')}
            </div>
            <h2 className="ah-hint-sans font-display text-[30px] font-medium leading-tight tracking-tight text-foreground">
              {i18nText('uiConnectYourAIToPostq')}
            </h2>
            <p className="mt-1.5 max-w-lg text-ui-lg leading-relaxed text-muted-foreground">
              {i18nText('uiIfYouAddYourOwnClaudeCodeDesktopAI')} <b className="text-foreground">{i18nText('uiUseItAsATool')}</b> {i18nText('uiRequestExecutionHistoryAnalysisAndEvenScenariosThisApp')} <b className="text-foreground">{i18nText('uiThisServerHasNoAICostAnd')}</b>{i18nText('uiTheTokenCostWillBeDeductedFromEachConnected')}
            </p>
          </div>
        </div>

        {/* 설정 안에서는 내지 않는다 — 다이얼로그의 닫기와 둘이 되면 무엇을 닫는지 모른다 */}
        {!embedded && <ToolButton icon="close"
          type="button"
          aria-label={i18nText('uiClose')}
          className="ah-action absolute right-4 top-4 z-10 flex h-7 w-auto px-1.5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
          onClick={onClose}
         />}

        <div className="flex flex-col gap-6 px-8 py-6">
          {/* 연결 명령 */}
          <section>
            <h3 className="mb-2 text-ui-sm font-bold uppercase tracking-wide text-faint-foreground">{i18nText('ui1ConnectOnlyOnce')}</h3>
            <p className="mb-1.5 text-ui-md text-muted-foreground">{i18nText('uiClaudeCodeRunTheCommandBelowInTerminal')}</p>
            <CopyRow label={i18nText('uiMCPConnectCommand')} value={mcpCmd} />
            <p className="mb-1.5 mt-3 text-ui-md text-muted-foreground">{i18nText('uiClaudeDesktopOpenedByClickingSettingsDeveloperEditConfiguration')} <code className="font-mono">claude_desktop_config.json</code>{i18nText('uiEnterTheContentsBelowAndTurnClaudeDesktopOn')}</p>
            <CopyRow label={i18nText('uiClaudeDesktopSettings')} value={desktopJson} />
            <p className="mt-1.5 text-ui-md text-faint-foreground">{i18nText('uiItWillOnlyConnectWhileThisAppIsOn')}</p>
            {tokenRequired && (
              <p className="mt-1 text-ui-md text-muted-foreground">{i18nText('uiThisServerIs')} <code className="font-mono">MCP_TOKEN</code> {i18nText('uiRequires')} <code className="font-mono">{TOKEN_SLOT}</code> {i18nText('uiFillInTheSpacesWithTheValuesYouEntered')}</p>
            )}
          </section>

          {/* 도구 */}
          <section>
            <h3 className="mb-2 text-ui-sm font-bold uppercase tracking-wide text-faint-foreground">{i18nText('ui2ToolsThatAICanUse')}</h3>
            <div className="grid grid-cols-2 gap-2">
              {TOOLS.map(t => (
                <div key={t.name} className="rounded-[var(--radius-md)] border border-border bg-surface-2/40 p-2.5 transition-colors hover:border-accent/40">
                  <p className="font-mono text-ui-md font-semibold text-accent">{t.name}</p>
                  <p className="mt-0.5 text-ui-sm leading-relaxed text-muted-foreground">{localizeKorean(t.desc)}</p>
                </div>
              ))}
            </div>
          </section>

          {/* 예시 프롬프트 */}
          <section>
            <h3 className="mb-2 text-ui-sm font-bold uppercase tracking-wide text-faint-foreground">{i18nText('ui3TryItLikeThis')}</h3>
            <div className="flex flex-col gap-1.5">
              {PROMPTS.map((p, i) => (
                <div key={i} className="rounded-[var(--radius-md)] border border-dashed border-border px-3 py-2 text-ui-lg leading-relaxed text-foreground">
                  <span className="mr-1.5 text-accent">›</span>{localizeKorean(p)}
                </div>
              ))}
            </div>
          </section>

          <p className="rounded-[var(--radius-md)] bg-surface-2/60 px-3 py-2 text-ui-md leading-relaxed text-muted-foreground">
            {i18nText('uiWhenYouWantToPassItManuallyInThe')} <b className="text-foreground">{i18nText('uiAIPrompt')}</b> {i18nText('uiTheButtonCopiesTheRequestResponseErrorAsMarkdown')}
          </p>
        </div>
      </div>
    </ModalFrame>
  )
}
