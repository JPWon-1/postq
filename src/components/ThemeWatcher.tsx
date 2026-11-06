'use client'
import { useEffect } from 'react'
import { initSystemThemeWatcher } from '@/lib/theme'

/**
 * 전역 OS 테마 변경 워처 — layout 에 마운트되어 모든 라우트(문서/게이트 포함)에서
 * system 모드의 실시간 반영을 보장한다. UI 는 렌더하지 않는다.
 */
export function ThemeWatcher() {
  useEffect(() => initSystemThemeWatcher(), [])
  return null
}
