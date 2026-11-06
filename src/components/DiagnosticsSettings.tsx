'use client'
import { t as i18nText } from '@/i18n'
import { kstFull } from '@/lib/datetime'
import { useCallback, useEffect, useState } from 'react'
import { CopyButton } from './CopyButton'
import { SkeletonRows } from './Skeleton'
type Snapshot = { at: string; pid: number; parentPid: number; uptimeSeconds: number; node: string; memory: { rss: number; heapUsed: number; heapTotal: number; external: number; arrayBuffers: number }; heapLimit: number; eventLoopDelayMs: number; scope: string }
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`
export function DiagnosticsSettings() {
  const [value, setValue] = useState<Snapshot | null>(null)
  const [error, setError] = useState('')
  // 조회 중임을 화면에 남긴다 — 없으면 응답 전까지 버튼 한 개만 있는 빈 칸으로 보이고,
  // [새로고침] 을 연타하면 요청이 겹쳐 늦게 온 옛 스냅샷이 최신 값을 덮는다.
  const [loading, setLoading] = useState(true)
  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    try { const res = await fetch('/api/diagnostics', { signal }); if (!res.ok) throw Error(i18nText('dynamicDiagnosticQueryFailed', { v0: String(res.status) })); setValue(await res.json()); setError('') }
    catch (e) { if (!signal?.aborted) setError(e instanceof Error ? e.message : i18nText('dynamicDiagnosticQueryFailed2')) }
    finally { if (!signal?.aborted) setLoading(false) }
  }, [])
  useEffect(() => { const controller = new AbortController(); void refresh(controller.signal); return () => controller.abort() }, [refresh])
  return <div className="min-h-0 overflow-auto p-4 text-ui-md">
    <div className="mb-4 flex items-center gap-3"><button className="ah-btn" disabled={loading} onClick={() => void refresh()}>{loading ? i18nText('jsxViewing') : i18nText('jsxRefresh')}</button>{value && <CopyButton value={JSON.stringify(value, null, 2)} title={i18nText('uiCopyDiagnosticInformation')} />}</div>
    {error && <p role="alert" className="text-method-delete">{error}</p>}
    {loading && !value && !error && <SkeletonRows rows={8} />}
    {value && <><p className="mb-3 text-muted-foreground">{value.scope}</p><dl className="grid grid-cols-2 gap-3">
      <dt>{i18nText('uiMeasurementTime')}</dt><dd>{kstFull(Date.parse(value.at))}</dd>
      <dt>{i18nText('uiProcessPIDParentPID')}</dt><dd>{value.pid} / {value.parentPid}</dd>
      <dt>{i18nText('uiUptime')}</dt><dd>{Math.floor(value.uptimeSeconds / 60)}{i18nText('uiMinutes')} {value.uptimeSeconds % 60}{i18nText('uiSeconds')}</dd>
      <dt>{i18nText('uiTotalResidentMemoryRSS')}</dt><dd>{mb(value.memory.rss)}</dd>
      <dt>{i18nText('uiJSHeapUsageLimits')}</dt><dd>{mb(value.memory.heapUsed)} / {mb(value.heapLimit)}</dd>
      <dt>{i18nText('uiExternalMemory')}</dt><dd>{mb(value.memory.external)}</dd>
      <dt>{i18nText('uiEventLoopDelaySingleMeasurement')}</dt><dd>{value.eventLoopDelayMs} ms</dd>
      <dt>{i18nText('uiServerRuntime')}</dt><dd>{value.node}</dd></dl>
      <p className="mt-4 text-ui-sm text-muted-foreground">{i18nText('uiCheckWhetherTheMemoryContinuesToIncreaseWithRepeated')}</p></>}
    <p className="mt-4 text-ui-sm text-muted-foreground">{i18nText('uiDesktopServerLogsAreStoredInLogsInThe')}</p>
  </div>
}
