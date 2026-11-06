import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * "조용히 빈 목록" 금지.
 *
 * 이 앱에서 가장 위험한 버그 모양은 '고장난 것' 이 '원래 없는 것' 과 똑같이 보이는 것이다.
 * fetch 가 실패했는데 `catch { setRows([]) }` 로 넘기면 화면은 '아직 없습니다' 라고 말한다.
 * 사용자는 원래 비어 있는 줄 알고 넘어가거나, 있는 걸 다시 만들어 중복을 쌓는다.
 *
 * 실제로 겪은 것들:
 *  - 추적의 서버 로그: 컨테이너 패턴이 틀려 늘 0건인데 '결과 없음 — 날짜를 넓히세요'
 *  - 등록 목록: 못 불러오면 '없습니다 — 추가하세요' → 다시 추가해 중복
 *
 * 타입도 린트도 못 잡는 종류라 여기서 막는다. catch 에서 상태를 비우려면
 * 같은 블록에서 에러도 남겨야 한다(setXxxError / LoadFailed).
 */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) sourceFiles(p, out)
    else if (/\.tsx$/.test(name)) out.push(p)
  }
  return out
}

/** `catch { setRows([]) }` 처럼 에러를 남기지 않고 비우기만 하는 한 줄 catch */
const SILENT_EMPTY = /catch\s*(?:\([^)]*\))?\s*\{\s*(?:if\s*\([^)]*\)\s*)?set[A-Za-z]+\(\s*(?:\[\]|\{\})\s*\)\s*\}/g

describe('조용히 빈 목록 금지', () => {
  const files = sourceFiles('src/components')

  it('실패를 빈 값으로만 삼키는 catch 가 없다', () => {
    const hits: string[] = []
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      for (const m of src.matchAll(SILENT_EMPTY)) {
        // 앞뒤 200자에 에러 상태를 남기는 흔적이 있으면 통과
        const around = src.slice(Math.max(0, m.index - 250), m.index + 250)
        if (/set[A-Za-z]*Error\(|LoadFailed|toast\(/.test(around)) continue
        // localStorage 읽기는 예외다 — 값이 깨졌거나 없으면 '없음' 이 맞는 기본값이고,
        // '물어보지 못했다' 는 상태 자체가 존재하지 않는다(서버 왕복이 없으므로).
        if (/localStorage/.test(around)) continue
        hits.push(`${f.replace('src/components/', '')}: ${m[0].slice(0, 60)}`)
      }
    }
    expect(hits, `실패가 '없음' 으로 보입니다 — 에러 상태를 남기고 LoadFailed 로 알리세요:\n${hits.join('\n')}`)
      .toEqual([])
  })

  // GlobalHistory 가 이 모양이었다: try/finally 만 있고 catch 가 없어서, fetch 가 실패하면
  // setRows 가 안 돌아 이전 상태(빈 배열)가 남고 화면은 '이력이 없습니다' 라고 했다.
  // 덤으로 처리되지 않은 rejection 까지 났다.
  it('fetch 하는 try 에 catch 가 빠진 곳이 없다', () => {
    const hits: string[] = []
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      // try { … fetch … } finally  — 사이에 catch 가 없는 경우
      for (const m of src.matchAll(/try\s*\{([\s\S]{0,900}?)\}\s*(catch|finally)/g)) {
        if (m[2] === 'catch') continue
        if (!/fetch\(/.test(m[1])) continue
        hits.push(`${f.replace('src/components/', '')}: try{…fetch…} finally (catch 없음)`)
      }
    }
    expect(hits, `실패를 아무도 받지 않습니다 — catch 에서 에러 상태를 남기세요:\n${hits.join('\n')}`)
      .toEqual([])
  })

  it('검사가 실제로 파일을 읽고 있다 — 정규식이 죽으면 위 테스트가 조용히 통과한다', () => {
    expect(files.length).toBeGreaterThan(20)
    expect(SILENT_EMPTY.test('} catch { setRows([]) }')).toBe(true)
  })
})
