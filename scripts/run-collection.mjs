import { writeFile } from 'node:fs/promises'
const args = process.argv.slice(2)
const includeWrites = args.includes('--include-writes')
const [folderId, environmentId, output = 'junit.xml'] = args.filter(a => a !== '--include-writes')
if (!folderId) {
  console.error('usage: run-collection.sh <folderId> [environmentId] [out.xml] [--include-writes]')
  process.exit(2)
}
try {
  const base = process.env.POSTQ_URL ?? 'http://localhost:3000'
  const response = await fetch(`${base.replace(/\/$/, '')}/api/folders/${encodeURIComponent(folderId)}/run`, {
    method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ includeWrites, ...(environmentId ? { environmentId } : {}) }), signal: AbortSignal.timeout(600_000),
  })
  if (!response.ok) throw new Error(`점검 서버 응답 ${response.status}`)
  const result = await response.json()
  if (!Number.isInteger(result.summary?.total) || result.summary.total < 1 || !Number.isInteger(result.summary?.failed) || typeof result.junit !== 'string') throw new Error('실행 결과가 없거나 올바르지 않습니다')
  await writeFile(output, result.junit)
  console.log(`점검 ${result.summary.total}건 · 실패 ${result.summary.failed}건 · 건너뜀 ${result.summary.skipped ?? 0}건 · JUnit: ${output}`)
  process.exitCode = result.summary.failed > 0 ? 1 : 0
} catch (error) {
  console.error(error instanceof Error ? error.message : '점검 실패')
  process.exitCode = 2
}
