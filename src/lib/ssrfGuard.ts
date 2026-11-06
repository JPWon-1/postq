// SSRF 가드.
// 기본(셀프호스트) 모드: 클라우드 메타데이터(IMDS)만 차단. localhost/사설망은 정당한 대상이라 허용.
// 하드닝(공개 egress) 모드: BLOCK_PRIVATE_NETWORKS=1 / EGRESS_MODE=public 이면 RFC1918·loopback·
//   링크로컬·CGNAT·IPv6 ULA 까지 전면 차단 — 더 넓게 노출될 때(공개/멀티테넌트) 오픈프록시 방지.
// 한계: 호스트명이 사설IP 로 '해석'되는 DNS 리바인딩은 이 문자열 계층에서 못 막음 — 완전한 방어는
//   소켓레벨 해석 IP 핀닝 + 네트워크 세그먼트 분리가 필요(SaaS 로드맵 Phase 0).

const META_HOSTS = new Set(['metadata.google.internal', 'metadata.goog'])

/** dotted-quad 가 사설/예약 대역이면 종류, 아니면 null. */
function ipv4Reserved(ip: string): string | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/)
  if (!m) return null
  const a = Number(m[1]), b = Number(m[2])
  if (a === 127) return 'loopback'
  if (a === 10) return 'private'
  if (a === 172 && b >= 16 && b <= 31) return 'private'
  if (a === 192 && b === 168) return 'private'
  if (a === 169 && b === 254) return 'linklocal'
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat'
  if (a === 0) return 'reserved'
  return null
}

/** 숫자형 호스트(십진/16진/dotted)를 dotted-quad 로 정규화. 아니면 null. */
function toIPv4(host: string): string | null {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host
  let n: number | null = null
  if (/^\d+$/.test(host)) n = Number(host)
  else if (/^0x[0-9a-f]+$/i.test(host)) n = Number.parseInt(host, 16)
  if (n == null || !Number.isFinite(n) || n < 0 || n > 0xffffffff) return null
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
}

/** IPv4-mapped IPv6(::ffff:a.b.c.d 또는 URL 파서가 만드는 ::ffff:aabb:ccdd 16진)를 dotted IPv4 로 환원. */
function unmapV4(h: string): string {
  const m = h.match(/^::ffff:([0-9a-f.:]+)$/i)
  if (!m) return h
  const tail = m[1]
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) return tail
  const hx = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i)
  if (hx) {
    const hi = Number.parseInt(hx[1], 16), lo = Number.parseInt(hx[2], 16)
    return [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join('.')
  }
  return h
}

/**
 * 차단 대상이면 true. blockPrivate=false(기본): 메타데이터/IMDS 만(셀프호스트용).
 * blockPrivate=true(공개 egress): 사설망·loopback·링크로컬·CGNAT·IPv6 ULA 까지 전면 차단.
 */
export function isBlockedHost(hostname: string, blockPrivate = false): boolean {
  const raw = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')  // 소문자·대괄호·후행점 정규화
  const h = unmapV4(raw)
  if (META_HOSTS.has(h)) return true
  if (h === 'fd00:ec2::254') return true
  const ip = toIPv4(h) ?? h
  if (/^169\.254\./.test(ip)) return true      // 링크로컬(AWS/GCP/Azure IMDS)
  if (ip === '100.100.100.200') return true    // Alibaba 메타데이터
  if (h.startsWith('fe80:')) return true        // IPv6 링크로컬(메타데이터 포함)

  if (blockPrivate) {
    if (raw === 'localhost' || raw.endsWith('.localhost')) return true
    if (ipv4Reserved(ip)) return true
    // IPv6 loopback(::1)·미지정(::)·ULA(fc00::/7 → fc/fd 접두)
    if (h === '::1' || h === '::' || /^f[cd][0-9a-f]{0,2}:/.test(h) || h === 'fc00' || h.startsWith('fd')) return true
  }
  return false
}

/** 환경변수로 공개 egress 하드닝 모드 여부 판단. */
export function blockPrivateNetworks(): boolean {
  return process.env.BLOCK_PRIVATE_NETWORKS === '1' || process.env.EGRESS_MODE === 'public'
}

/**
 * http/https 만 허용한다.
 *
 * 지금까지 file:// 이나 ftp:// 는 fetch 가 그 스킴을 구현하지 않아서 "우연히" 막혔다.
 * 우연에 기대는 방어는 런타임이 한 줄 바뀌면 사라지고, 그때 아무도 모른다.
 *
 * 사용자에게도 이게 낫다. 예전엔 file:///etc/passwd 를 넣으면
 * "TypeError: fetch failed (not implemented... yet...)" 가 떴는데, 그걸 보고
 * 무엇을 고쳐야 할지 알 수 있는 사람은 없다.
 *
 * 반환값은 거절 사유(통과면 null) — 호출부가 그대로 사용자에게 보여준다.
 */
export function schemeProblem(protocol: string): string | null {
  const p = protocol.toLowerCase()
  if (p === 'http:' || p === 'https:') return null
  return `${p}// 는 보낼 수 없습니다 — http:// 또는 https:// 만 지원합니다`
}
