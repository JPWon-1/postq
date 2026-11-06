/**
 * '이 실행은 실패인가' — 이미 읽어 온 행에 쓰는 판정. 서버와 화면이 **같은 함수**를 쓴다.
 *
 * 규칙은 lib/failedExecution.ts 의 SQL 과 같다(그쪽 주석에 이유가 있다):
 *  - 전송 오류가 있으면 실패
 *  - 응답 확인 조건이 있으면 그 결과가 판정이다 — '404 를 기대' 한 요청이 404 로 오면 성공이다
 *  - 조건이 없으면(null) HTTP 코드로 본다(400 이상이면 실패)
 *
 * 이 파일은 순수 함수만 둔다. failedExecution.ts 는 drizzle·스키마를 끌고 와서, 화면 코드가 거기서
 * 가져오면 서버 코드가 번들에 섞인다. 그래서 화면마다 조건을 다시 써 왔고 — 그게 갈리는 원인이었다
 * (같은 실행이 이력 패널에선 초록, API 이력에선 빨강).
 */
export function isFailedRow(
  row: { error: string | null; checkPassed: boolean | null; status: number | null },
): boolean {
  if (row.error !== null) return true
  if (row.checkPassed === false) return true
  if (row.checkPassed === null && row.status != null && row.status >= 400) return true
  return false
}

/** 실행 행 모양(ExecutionRow 등)에서 바로 판정한다. undefined 는 '모름' 으로 친다. */
export function isFailedExecution(e: {
  error?: string | null; checkPassed?: boolean | null; responseStatus?: number | null
}): boolean {
  return isFailedRow({ error: e.error ?? null, checkPassed: e.checkPassed ?? null, status: e.responseStatus ?? null })
}
