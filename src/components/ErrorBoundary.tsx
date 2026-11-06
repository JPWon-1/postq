'use client'
import { t as i18nText } from '@/i18n'
import { Component, type ReactNode } from 'react'

// 전역 에러 바운더리 — 예기치 못한 렌더 크래시를 흰 화면 대신 복구 UI 로 잡는다.
// (에러 바운더리는 React 에서 클래스 컴포넌트로만 구현 가능)
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    // 콘솔에 남겨 디버깅 가능하게 (원격 로깅 붙일 자리)
    console.error('[postq] uncaught render error:', error)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-8 text-center">
          <span className="font-display text-[22px] leading-none text-muted-foreground">postq</span>
          <p className="text-ui-lg font-medium text-foreground">{i18nText('uiAnUnexpectedErrorOccurred')}</p>
          <p className="max-w-md break-words font-mono text-ui-sm text-faint-foreground">
            {String(this.state.error?.message ?? this.state.error)}
          </p>
          <div className="mt-1 flex items-center gap-2">
            <button
              type="button"
              className="rounded-[var(--radius-sm)] bg-accent-solid px-4 py-1.5 text-ui-lg font-semibold text-accent-solid-foreground transition-colors hover:bg-accent-solid-hover"
              onClick={() => this.setState({ error: null })}
            >
              {i18nText('uiTryAgain')}
            </button>
            <button
              type="button"
              className="text-ui-md text-muted-foreground underline underline-offset-2 hover:text-foreground"
              onClick={() => window.location.reload()}
            >
              {i18nText('uiRefresh')}
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
