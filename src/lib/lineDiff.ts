export type DiffLine = { type: 'same' | 'add' | 'del'; text: string }

// 너무 큰 입력은 LCS(O(n*m)) 비용이 커 단순 비교로 폴백(성능 방어).
const MAX_CELLS = 4_000_000

/**
 * 두 텍스트의 라인 단위 diff(LCS 기반). del = a 에만, add = b 에만, same = 공통.
 * 실행 이력 비교('어제는 됐는데 오늘 응답 달라짐')에 쓴다.
 */
export function diffLines(a: string, b: string): DiffLine[] {
  const aLines = a.split('\n'), bLines = b.split('\n')
  const n = aLines.length, m = bLines.length

  if (n * m > MAX_CELLS) {
    // 폴백: 공통 접두/접미만 same 으로, 가운데는 del 전부 + add 전부(대략적)
    const out: DiffLine[] = []
    aLines.forEach(t => out.push({ type: 'del', text: t }))
    bLines.forEach(t => out.push({ type: 'add', text: t }))
    return out
  }

  // dp[i][j] = aLines[i:], bLines[j:] 의 LCS 길이
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = aLines[i] === bLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) { out.push({ type: 'same', text: aLines[i] }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: aLines[i] }); i++ }
    else { out.push({ type: 'add', text: bLines[j] }); j++ }
  }
  while (i < n) out.push({ type: 'del', text: aLines[i++] })
  while (j < m) out.push({ type: 'add', text: bLines[j++] })
  return out
}

/** diff 요약 카운트. */
export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  return {
    added: lines.filter(l => l.type === 'add').length,
    removed: lines.filter(l => l.type === 'del').length,
  }
}
