import { writeFile } from 'node:fs/promises'
const [flowId, environmentId, output = 'scenario-result.json'] = process.argv.slice(2)
if (!flowId || !environmentId) { console.error('usage: run-scenario.mjs <scenarioId> <environmentId> [result.json]'); process.exit(2) }
try {
  const base = process.env.POSTQ_URL
  if (!base) throw new Error('POSTQ_URL을 설정하세요')
  const response = await fetch(`${base.replace(/\/$/, '')}/api/flows/${encodeURIComponent(flowId)}/run`, {
    method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ environmentId, executedBy: 'CI 자동 점검' }), signal: AbortSignal.timeout(600000),
  })
  if (!response.ok) throw new Error(`점검 서버 응답 ${response.status}`)
  const run = await response.json()
  if (!Array.isArray(run.steps) || !run.steps.length || !(run.stoppedAt === null || Number.isInteger(run.stoppedAt))) throw new Error('시나리오 실행 결과가 올바르지 않습니다')
  const steps = run.steps.map(s => ({ name: s.name, status: s.execution?.responseStatus ?? null, passed: s.execution?.checkPassed === true && !s.error, executionId: s.execution?.id ?? null }))
  const passed = run.stoppedAt === null && steps.every(s => s.passed)
  // No request bodies, runtime variables, tokens or response data in CI artifacts.
  await writeFile(output, JSON.stringify({ scenarioId: flowId, environmentId, passed, steps }, null, 2))
  console.log(`시나리오 ${steps.length}단계 · ${passed ? '통과' : '실패'} · ${output}`)
  process.exitCode = passed ? 0 : 1
} catch (error) { console.error(error instanceof Error ? error.message : '점검 실패'); process.exitCode = 2 }
