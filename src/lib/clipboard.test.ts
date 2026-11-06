import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyText } from './clipboard'

/**
 * `http://<서버>:3000` 으로 열면 보안 컨텍스트가 아니라 navigator.clipboard 가 아예 없다.
 */
afterEach(() => vi.unstubAllGlobals())

function stubDocument(execResult: boolean | (() => never)) {
  const el: Record<string, unknown> = { style: {}, setAttribute: () => {}, select: () => {}, setSelectionRange: () => {} }
  vi.stubGlobal('document', {
    createElement: () => el,
    body: { appendChild: () => {}, removeChild: () => {} },
    execCommand: typeof execResult === 'function' ? execResult : () => execResult,
  })
  return el
}

describe('복사', () => {
  it('Clipboard API 가 있으면 그걸 쓴다', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    expect(await copyText('hello')).toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('http 로 열려 clipboard 가 아예 없어도 복사된다', async () => {
    // 이게 이 모듈을 만든 이유다 — 예전엔 여기서 TypeError 만 나고 아무 일도 없었다.
    vi.stubGlobal('navigator', {})
    const el = stubDocument(true)
    expect(await copyText('hello')).toBe(true)
    expect(el.value).toBe('hello')
  })

  it('Clipboard API 가 거부해도 옛 방식으로 한 번 더 시도한다', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: async () => { throw new Error('denied') } } })
    stubDocument(true)
    expect(await copyText('hello')).toBe(true)
  })

  it('둘 다 안 되면 false — 부르는 쪽이 실패를 말할 수 있게', async () => {
    vi.stubGlobal('navigator', {})
    stubDocument(false)
    expect(await copyText('hello')).toBe(false)
  })

  it('옛 방식이 던져도 false 를 돌려준다(예외를 밖으로 안 낸다)', async () => {
    vi.stubGlobal('navigator', {})
    stubDocument(() => { throw new Error('boom') })
    await expect(copyText('hello')).resolves.toBe(false)
  })
})
