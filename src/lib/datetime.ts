/**
 * 화면에 찍는 시각 — 전부 한국 시간(KST) 기준.
 *
 * 이 계산이 11곳에 흩어져 있었다. 전부 `new Date(ts + 9시간).toISOString()` 뒤에
 * slice 로 필요한 자리를 잘라 쓰는 방식인데, 자르는 위치가 곳마다 달라서
 * (11,19) (0,10) (0,16) (0,19) (5,16) … 같은 숫자만 보고는 무엇이 나오는지 알 수 없었다.
 * 이름을 붙여 한곳에 모은다.
 *
 * 브라우저 로캘을 안 쓰고 UTC+9 를 직접 더한다 — 한국어 UI 라 보는 사람도, 서버 로그도,
 * 이야기할 때 쓰는 시각도 전부 KST 라고 본다. 기계 설정에 따라 표시가 달라지면 오히려 헷갈린다.
 * (그래서 서머타임이 없는 KST 에서만 맞는 방식이다. 다른 지역을 지원하게 되면 여기만 고친다)
 *
 * 값이 이상하면 던지지 않고 '—' 를 돌려준다. Date 범위를 벗어난 밀리초에
 * toISOString() 은 RangeError 를 던지는데, 렌더 중에 터지면 화면 전체가 날아간다.
 * 쿠키 만료(Max-Age 가 터무니없이 큰 서버 응답)처럼 남이 준 숫자가 그대로 들어오는
 * 자리가 있어서 실제로 닿을 수 있는 경로다. 시각 하나 때문에 화면을 잃을 이유는 없다.
 */
const KST_OFFSET_MS = 9 * 3600_000

/** 잘못된 값 자리에 찍는 글자 — 빈칸으로 두면 '아직 안 왔나' 로 읽힌다. */
export const NO_TIME = '—'

/** KST 로 옮긴 ISO 문자열('YYYY-MM-DDTHH:MM:SS.sssZ' 모양). 범위를 벗어나면 null. */
function isoKst(ts: number): string | null {
  if (!Number.isFinite(ts)) return null
  try { return new Date(ts + KST_OFFSET_MS).toISOString() }
  catch { return null }  // RangeError — Date 가 표현할 수 있는 범위 밖
}

function cut(ts: number, from: number, to: number, sep = false): string {
  const iso = isoKst(ts)
  if (iso === null) return NO_TIME
  const s = iso.slice(from, to)
  return sep ? s.replace('T', ' ') : s
}

/** 'HH:MM:SS' */
export const kstTime = (ts: number) => cut(ts, 11, 19)

/** 'HH:MM' — 초까지 필요 없는 자리(스케줄 최근 실행 등) */
export const kstHm = (ts: number) => cut(ts, 11, 16)

/** 'YYYY-MM-DD' */
export const kstDay = (ts: number) => cut(ts, 0, 10)

/** 'YYYY-MM-DD HH:MM:SS' */
export const kstFull = (ts: number) => cut(ts, 0, 19, true)

/** 'YYYY-MM-DD HH:MM' */
export const kstMinute = (ts: number) => cut(ts, 0, 16, true)

/** 'MM-DD HH:MM' — 목록에서 연도가 자리만 먹을 때 */
export const kstMonthDay = (ts: number) => cut(ts, 5, 16, true)

/** 오늘(KST) 'YYYY-MM-DD' — 날짜 입력칸 기본값 */
export const kstToday = () => kstDay(Date.now())
