import { describe, expect, it } from 'vitest'
import { kstDayStart, recentRequests, restoreTabs, todayFailures, type ResumeExecution } from './resumeWorkspace'
import { scoped } from './localStore'
import type { RequestRow } from './ui-types'
const execution = (requestId: string, executedAt: number, extra = {}): ResumeExecution => ({ requestName: requestId, folderName: 'folder', execution: { requestId, executedAt, responseStatus: 500, error: null, ...extra } } as ResumeExecution)
describe('resume workspace', () => {
  it('keeps only the newest execution per request, orders and limits to ten', () => {
    const rows = Array.from({ length: 12 }, (_, i) => execution(`r${i}`, i))
    rows.push(execution('r0', 100), execution('r0', 99), { ...execution('deleted', 101), requestName: null })
    expect(recentRequests(rows).map(r => r.execution.requestId)).toEqual(['r0', 'r11', 'r10', 'r9', 'r8', 'r7', 'r6', 'r5', 'r4', 'r3'])
    expect(recentRequests(rows)[0].execution.executedAt).toBe(100)
  })
  it('uses KST midnight, excludes next day and follows assertion/error outcomes', () => {
    const midnight = Date.parse('2026-10-06T15:00:00Z')
    expect(kstDayStart(midnight + 123)).toBe(midnight)
    const rows = [execution('yesterday', midnight - 1), execution('boundary', midnight), execution('next-day', midnight + 86400000), execution('expected404', midnight + 1, { responseStatus: 404, checkPassed: true }), execution('bad200', midnight + 2, { responseStatus: 200, checkPassed: false }), execution('network', midnight + 3, { responseStatus: null, error: 'timeout' }), execution('boundary', midnight + 4)]
    expect(todayFailures(rows, midnight + 100).map(r => r.execution.requestId)).toEqual(['boundary', 'network', 'bad200'])
  })
  it('retains a failed request even if it succeeded later today', () => {
    expect(todayFailures([execution('a', 100), execution('a', 200, { responseStatus: 200 })], 300)[0].execution.executedAt).toBe(100)
  })
  it('restores order and active tab while excluding deleted and duplicate requests', () => {
    const available = [{ id: 'a' }, { id: 'b' }] as RequestRow[]
    expect(restoreTabs({ ids: ['b', 'gone', 'a', 'b', 42], activeId: 'a' }, available)).toEqual({ tabs: [available[1], available[0]], activeId: 'a' })
    expect(restoreTabs({ ids: ['gone', 'b'], activeId: 'gone' }, available).activeId).toBe('b')
  })
  it('corrupt storage falls back safely and workspace keys are isolated', () => {
    for (const value of [null, 'broken', 3, { ids: {} }, { ids: [null] }]) expect(restoreTabs(value, [])).toEqual({ tabs: [], activeId: null })
    expect(scoped.requestTabs('a')).not.toBe(scoped.requestTabs('b'))
  })
})
