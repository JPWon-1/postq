/**
 * 서버에서 JSON 을 받아온다 — 실패를 성공처럼 넘기지 않는다.
 *
 * `await (await fetch(url)).json()` 이 코드 곳곳에 있었다. 짧아서 편한데, 서버가
 * 500 을 주면 본문 `{error: "..."}` 를 그대로 돌려준다. 받는 쪽은 그게 배열인 줄 알고
 * .map 을 부르고, TypeError 가 난다. 그런데 그 예외를 잡는 곳이 없으면 화면은
 * '아무것도 없음' 으로 보인다 — 서버가 죽은 건지 정말 0개인지 알 방법이 없다.
 *
 * 실제로 그렇게 새 나간 자리들이 있었다: ⌘K 팔레트는 요청이 하나도 안 뜨고, 환경
 * 목록은 통째로 비고, 폴더 하나가 500 이면 트리 전체가 죽었다.
 *
 * 여기서는 두 가지를 강제한다.
 *  - res.ok 를 반드시 본다. 서버가 적어 보낸 이유를 살려서 메시지에 담는다 —
 *    상태 코드만 남기면 'VPN 인가, 주소가 틀렸나' 를 못 가른다.
 *  - 목록을 기대하는 곳은 배열인지 확인한다. 아니면 거기서 멈춘다.
 *    엉뚱한 값이 상태로 들어가면 터지는 자리가 훨씬 뒤라 원인을 못 찾는다.
 */

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'HttpError'
  }
}

/** 서버가 보낸 오류 이유를 꺼낸다. JSON 이 아니면 본문 앞부분이라도 — 빈 메시지보다 낫다. */
async function reason(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  if (!text) return `${res.status} ${res.statusText}`.trim()
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown }
    const msg = body?.error ?? body?.message
    if (typeof msg === 'string' && msg) return msg
  } catch { /* JSON 이 아니면 아래로 */ }
  return `${res.status} — ${text.slice(0, 200)}`
}

export async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init)
  if (!res.ok) throw new HttpError(res.status, await reason(res))
  return res.json() as Promise<T>
}

/**
 * 목록을 받는다. 배열이 아니면 던진다.
 *
 * 200 인데 배열이 아닌 경우가 실제로 있다 — 프록시가 끼어들어 HTML 로그인 페이지를
 * 주거나, 라우트가 실수로 객체를 돌려주거나. 그대로 상태에 넣으면 렌더 도중에 터지고,
 * 그때는 이미 어느 요청이 원인인지 알 수 없다.
 */
export async function fetchArray<T>(input: string, init?: RequestInit): Promise<T[]> {
  const body = await fetchJson<unknown>(input, init)
  if (!Array.isArray(body)) {
    throw new Error(`목록을 기대했는데 ${body === null ? 'null' : typeof body} 을 받았습니다 — ${input}`)
  }
  return body as T[]
}

/** 사람이 읽을 한 줄. catch 에서 그대로 화면에 띄울 수 있게. */
export function errorText(e: unknown): string {
  if (e instanceof HttpError) return e.message
  if (e instanceof Error) return e.message
  return String(e)
}
