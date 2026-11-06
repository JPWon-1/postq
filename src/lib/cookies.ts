// 쿠키 jar 로직 — 서버 프록시 실행이라 쿠키를 서버가 보관한다(로그인 세션 유지용).
// 실행 시 대상 도메인 매칭 쿠키를 Cookie 헤더로 주입하고, 응답 Set-Cookie 를 파싱해 저장.

export type ParsedCookie = {
  name: string; value: string; domain: string; path: string
  expires: number | null // epoch ms, null=세션
}

/** Set-Cookie 한 줄을 파싱. 요청 도메인을 기본 도메인으로(Domain 속성 없으면 host-only). */
export function parseSetCookie(line: string, requestHost: string): ParsedCookie | null {
  const parts = line.split(';')
  const [nv, ...attrs] = parts
  const eq = nv.indexOf('=')
  if (eq === -1) return null
  const name = nv.slice(0, eq).trim()
  const value = nv.slice(eq + 1).trim()
  if (!name) return null

  let domain = requestHost
  let path = '/'
  let expires: number | null = null
  for (const a of attrs) {
    const [k, ...vp] = a.split('=')
    const key = k.trim().toLowerCase()
    const v = vp.join('=').trim()
    // Domain 속성은 요청 호스트가 그 도메인에 속할 때만 채택(RFC6265 domain-match).
    // 무검증 채택 시 응답이 임의 Domain 을 지정해 같은 스코프의 다른 호스트 요청에 쿠키를
    // 주입할 수 있어(크로스호스트 주입) 차단 — 매칭 안 되면 host-only(요청 호스트) 유지.
    if (key === 'domain' && v) {
      const d = v.replace(/^\./, '').toLowerCase()
      if (cookieMatchesHost(d, requestHost)) domain = d
    }
    else if (key === 'path' && v) path = v
    // v 가 비어 있으면(`Max-Age=`) Number('') 는 0 이라 '지금 만료' 로 읽혔다 —
    // 값이 없는 건 지시가 없는 것이지 삭제 지시가 아니다.
    else if (key === 'max-age' && v) { const s = Number(v); if (Number.isFinite(s)) expires = Date.now() + s * 1000 }
    else if (key === 'expires' && v && expires === null) { const t = Date.parse(v); if (!Number.isNaN(t)) expires = t }
  }
  // 삭제 지시(만료 과거/Max-Age<=0)도 그대로 반환 — jar 에서 삭제 처리
  return { name, value, domain, path, expires }
}

/**
 * 쿠키 Domain 으로 하위 전체를 잡을 수 없는 이름들 — 공용 접미사.
 *
 * 전체 Public Suffix List 가 아니다. 여기서 막으려는 건 딱 하나, 응답이
 * `Domain=com` 같은 걸 지정해 그 뒤의 모든 .com 요청에 쿠키를 실어 보내는 것이다.
 * 라벨이 하나뿐인 이름(com, kr, net…)은 전부 막고, 실제로 쓰는 2라벨 접미사만 적는다.
 * 필요해지면 여기 줄만 추가하면 된다.
 */
const PUBLIC_SUFFIXES = new Set([
  'co.kr', 'or.kr', 'ne.kr', 'go.kr', 'ac.kr', 're.kr', 'pe.kr',
  'co.jp', 'co.uk', 'org.uk', 'com.au', 'com.br', 'com.cn', 'com.sg', 'co.in',
])

function isPublicSuffix(d: string): boolean {
  // 라벨이 하나면(점이 없으면) 그 자체가 최상위다. localhost 도 여기 걸리지만,
  // host-only 매칭(h === d)은 아래에서 먼저 통과하므로 로컬 개발은 영향이 없다.
  if (!d.includes('.')) return true
  return PUBLIC_SUFFIXES.has(d)
}

/**
 * 요청 호스트에 이 쿠키의 domain 이 적용되는지 (host-only 또는 도메인 서픽스 매칭).
 *
 * 예전엔 서픽스 매칭만 봤다. 그래서 응답이 `Set-Cookie: sid=…; Domain=com` 을 주면
 * 그대로 채택되고, 그 뒤로 **모든 .com 요청에 그 쿠키가 실려 나갔다**. 사내 시스템의
 * 세션이 무관한 외부 호스트로 새는 경로다(측정으로 확인했다 — 'com' 이 채택되고
 * totally-unrelated.com 요청에 sid 가 붙었다).
 *
 * 이제 공용 접미사로는 하위를 잡지 못한다. 저장 단계(Domain 채택)와 전송 단계
 * (Cookie 헤더 조립) 둘 다 이 함수를 지나므로, 이미 jar 에 그런 쿠키가 있어도 안 나간다.
 */
export function cookieMatchesHost(cookieDomain: string, requestHost: string): boolean {
  const h = requestHost.toLowerCase()
  const d = cookieDomain.toLowerCase()
  if (h === d) return true            // host-only — 정확히 그 호스트에만
  if (isPublicSuffix(d)) return false
  return h.endsWith(`.${d}`)
}

/** jar 쿠키들 → Cookie 요청 헤더 값. 만료된 것 제외. */
export function buildCookieHeader(
  cookies: { name: string; value: string; domain: string; expires: number | null }[],
  requestHost: string,
): string {
  const now = Date.now()
  const active = cookies.filter(c =>
    cookieMatchesHost(c.domain, requestHost) && (c.expires === null || c.expires > now))
  // 같은 이름이 여러 도메인에 있으면 더 구체적인 쪽(라벨이 긴 도메인)이 이긴다.
  // 주석에는 그렇게 적혀 있었지만 실제로는 '배열의 마지막' 이었다 — DB 가 돌려주는
  // 순서에 따라 광역 도메인 쿠키가 호스트 전용 쿠키를 덮을 수 있었다.
  const byName = new Map<string, string>()
  for (const c of [...active].sort((a, b) => a.domain.length - b.domain.length)) {
    byName.set(c.name, c.value)
  }
  // 값에 개행이나 세미콜론이 섞이면 헤더 한 줄이 쪼개진다. 파싱 경로상 들어오기
  // 어렵지만, 헤더를 만드는 자리에서 한 번 더 막는 편이 싸다.
  const clean = (x: string) => x.replace(/[\r\n;]/g, '')
  return [...byName.entries()].map(([n, v]) => `${clean(n)}=${clean(v)}`).join('; ')
}

/** 만료 지시 여부(삭제해야 하는 쿠키). */
export function isExpired(c: ParsedCookie): boolean {
  return c.expires !== null && c.expires <= Date.now()
}

/**
 * 브라우저에서 복사한 Cookie 문자열("a=1; b=2; c=3")을 개별 쿠키로 파싱한다.
 * DevTools 의 Request Headers > Cookie 나 document.cookie 를 그대로 붙여넣는 용도.
 * 세미콜론/개행 구분 모두 허용, name= 뒤 = 포함 값 보존.
 */
export function parseCookieString(input: string): { name: string; value: string }[] {
  return input
    .split(/[;\n]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(pair => {
      const eq = pair.indexOf('=')
      if (eq === -1) return null
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      return name ? { name, value } : null
    })
    .filter((c): c is { name: string; value: string } => c !== null)
}
