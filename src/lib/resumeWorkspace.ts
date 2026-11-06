import { isFailedExecution } from './executionOutcome'
import type { ExecutionRow, RequestRow } from './ui-types'

export type ResumeExecution = { execution: ExecutionRow; requestName: string | null; folderName: string | null }
export function recentRequests(rows: ResumeExecution[], limit = 10): ResumeExecution[] {
  const seen = new Set<string>()
  return [...rows].sort((a, b) => b.execution.executedAt - a.execution.executedAt).filter(row => {
    const id = row.execution.requestId
    if (!row.requestName || seen.has(id)) return false
    seen.add(id)
    return true
  }).slice(0, limit)
}
export function kstDayStart(now: number): number {
  const day = 86400000, offset = 9 * 3600000
  return Math.floor((now + offset) / day) * day - offset
}
export function todayFailures(rows: ResumeExecution[], now: number): ResumeExecution[] {
  const start = kstDayStart(now)
  return recentRequests(rows.filter(({ execution: e }) => e.executedAt >= start && e.executedAt < start + 86400000 && isFailedExecution(e)), Infinity)
}
export function restoreTabs(saved: unknown, available: RequestRow[]) {
  const value = saved as { ids?: unknown; activeId?: unknown } | null
  const ids = Array.isArray(value?.ids) ? value.ids.filter((id): id is string => typeof id === 'string') : []
  const byId = new Map(available.map(r => [r.id, r]))
  const tabs = [...new Set(ids)].flatMap(id => byId.has(id) ? [byId.get(id)!] : [])
  const activeId = tabs.some(t => t.id === value?.activeId) ? value!.activeId as string : tabs[0]?.id ?? null
  return { tabs, activeId }
}
export function relativeTime(time: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - time) / 60000))
  if (minutes < 1) return '방금 전'
  if (minutes < 60) return `${minutes}분 전`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}시간 전`
  return `${Math.floor(minutes / 1440)}일 전`
}
