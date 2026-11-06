import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Tailwind 의 이름 있는 group 짝 검사.
 *
 * `group-hover/hrow:` 를 쓰면서 `group/hrow` 를 선언한 조상이 없으면, 그 스타일은
 * 영원히 걸리지 않는다 — 빌드도 통과하고 화면에도 요소는 있는데 hover 로 안 나타난다.
 * 전역 이력의 [복사] 버튼이 그 상태로 opacity-0 인 채 존재만 하고 있었다(눌러도 반응
 * 없어 보임). 타입도 린트도 못 잡는 종류라 여기서 막는다.
 *
 * (선언과 사용이 서로 다른 파일에 있을 수 있어 저장소 전체를 한 덩어리로 본다.)
 */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) sourceFiles(p, out)
    else if (/\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

describe('Tailwind 이름 있는 group', () => {
  const all = sourceFiles('src').map(f => readFileSync(f, 'utf8')).join('\n')

  const used = new Set(
    [...all.matchAll(/group-(?:hover|focus-within|focus|active)\/([a-zA-Z0-9_-]+)/g)].map(m => m[1]))
  const declared = new Set(
    [...all.matchAll(/["'\s]group\/([a-zA-Z0-9_-]+)/g)].map(m => m[1]))

  it('쓰이는 group 이름은 모두 어딘가에서 선언돼 있다', () => {
    const missing = [...used].filter(n => !declared.has(n)).sort()
    expect(missing, `group/${missing.join(', group/')} 선언이 없어 hover 가 영영 안 걸립니다`).toEqual([])
  })

  it('검사가 실제로 이름을 찾고 있다 — 정규식이 죽으면 위 테스트가 조용히 통과한다', () => {
    expect(used.size).toBeGreaterThan(3)
    expect(declared.size).toBeGreaterThan(3)
  })
})
