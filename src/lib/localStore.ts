/**
 * 브라우저에 남기는 값 — 키를 한 곳에 모으고, 읽고 쓰는 방식도 하나로 맞춘다.
 *
 * 48곳에서 각자 localStorage 를 직접 만지고 있었다. 문제가 셋이었다:
 *
 *  1. 키가 생문자열이라 오타가 조용히 통과한다. 쓰는 쪽과 읽는 쪽이 한 글자만 달라도
 *     '저장은 되는데 다음에 열면 없는' 상태가 되고, 그건 화면에 흔적이 안 남는다.
 *  2. [표시 설정]의 '레이아웃 초기화' 가 지울 키 목록을 따로 들고 있었다 — 새 키를
 *     만들 때 거기 추가하는 걸 잊으면 초기화가 조용히 일부만 지운다.
 *  3. 프라이빗 모드에서 setItem 이 던진다. 그래서 try/catch 가 아홉 파일에 흩어졌고,
 *     빠뜨린 곳은 그 화면 전체가 죽는다.
 *
 * 접두사는 'ah:' 와 'postq:' 두 가지다. 이미 저장된 값의 이름이라 바꾸면 쓰던 사람의 설정이
 * 한 번 초기화된다. 여기 모아 두는 것으로 충분하다.
 */

export const KEYS = {
  workspace: 'ah:workspace',
  /** 접두사가 없다 — 부팅 스크립트(layout.tsx)가 인라인으로 같은 이름을 읽는다.
   *  바꾸려면 그 스크립트도 같이 고쳐야 하고, 안 그러면 첫 페인트가 반대 테마로 번쩍인다.
   *  ('ah:themepref' 는 키가 아니라 같은 탭에 알리는 이벤트 이름이다 — 헷갈리기 쉽다) */
  theme: 'theme',
  /** 개인 환경 오버라이드. 프로젝트별이 아니라 환경 id 로 갈린다({[envId]: {...}}) */
  personalVars: 'ah:personalVars',

  // 레이아웃 — '초기화' 가 지우는 대상
  sidebarOpen: 'ah:sidebarOpen',
  sidebarWidth: 'ah:sidebarWidth',
  historyOpen: 'ah:historyOpen',
  historyWidth: 'ah:historyWidth',
  consoleHeight: 'ah:consoleHeight',
  responseHeight: 'ah:responseHeight',
  responseCollapsed: 'ah:responseCollapsed',
  /** 오른쪽 패널(코드·변수) — 마지막으로 연 칸과 폭 */
  rightTab: 'postq:right-tab',
  rightWidth: 'postq:right-width',
  /** 사이드바 바닥의 접힌 섹션(환경·쿠키) 중 펼쳐 둔 것 */
  sidebarSections: 'postq:sidebar-sections',
  /** 문서 모드에서 마지막으로 고른 범위(이 요청/이 폴더/전체) */
  docsScope: 'ah:docsScope',
  /** 화면을 떠났다 와도 남아야 하는 선택들 — 조건부 마운트로 죽던 것들 */
  realtimeTab: 'ah:realtimeTab',
  historyFilterStatus: 'ah:historyFilterStatus',
  historyFilterSince: 'ah:historyFilterSince',
  scenarioEnv: 'ah:scenarioEnv',
  scenarioFlow: 'ah:scenarioFlow',
  collapsedFolders: 'ah:collapsed',
  expandedGroups: 'ah:expandedGroups',
  railCollapsed: 'postq:rail-collapsed',
  /** 지금은 안 쓴다([더보기] 제거). 초기화가 옛 브라우저의 잔값까지 치우도록 남긴다. */
  railMore: 'postq:rail-more',
  /** 코드 스니펫 패널에서 고른 언어·줄바꿈 — 배치가 아니라 고른 것이라 초기화하지 않는다 */
  snippetLang: 'postq:snippet-lang',
  snippetWrap: 'postq:snippet-wrap',
} as const

export type StoreKey = (typeof KEYS)[keyof typeof KEYS]

/** 프로젝트별로 갈리는 키 — 프로젝트를 바꾸면 즐겨찾기도 따라 바뀌어야 한다. */
export const scoped = {
  requestTabs: (workspaceId: string) => `ah:requestTabs:${workspaceId}`,
  favRequests: (workspaceId: string) => `ah:favRequests:${workspaceId}`,
} as const

/**
 * '초기화' 가 지우는 것 = 화면 배치. 즐겨찾기처럼 사용자가 고른 내용은
 * 여기 없다 — 배치를 되돌리려다 고른 것까지 날아가면 그게 더 나쁘다.
 */
export const LAYOUT_KEYS: readonly string[] = [
  KEYS.sidebarOpen, KEYS.sidebarWidth, KEYS.historyOpen, KEYS.historyWidth,
  KEYS.consoleHeight, KEYS.responseHeight, KEYS.responseCollapsed,
  KEYS.rightTab, KEYS.rightWidth, KEYS.sidebarSections,
  KEYS.collapsedFolders, KEYS.expandedGroups, KEYS.railCollapsed, KEYS.railMore,
]

/**
 * 읽기. 없거나 못 읽으면 null.
 * 서버 렌더에서도 불릴 수 있어 window 를 확인한다 — 안 하면 첫 렌더가 통째로 죽는다.
 */
export function read(key: string): string | null {
  if (typeof window === 'undefined') return null
  try { return window.localStorage.getItem(key) } catch { return null }
}

/** 쓰기. 프라이빗 모드에서 던지는 것을 여기서 삼킨다 — 저장 실패로 화면이 죽으면 안 된다. */
export function write(key: string, value: string): void {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(key, value) } catch { /* 프라이빗 모드·용량 초과 */ }
}

export function remove(key: string): void {
  if (typeof window === 'undefined') return
  try { window.localStorage.removeItem(key) } catch { /* 프라이빗 모드 */ }
}

/** 켜짐/꺼짐. 저장 안 된 상태의 기본값을 호출자가 정한다(기본이 켜짐인 것도 있다). */
export function readFlag(key: string, whenMissing: boolean): boolean {
  const v = read(key)
  return v === null ? whenMissing : v === '1'
}

export function writeFlag(key: string, on: boolean): void {
  write(key, on ? '1' : '0')
}

/**
 * JSON 배열/객체. 손상된 값이 남아 있어도 그 화면이 죽지 않고 기본값으로 떨어진다 —
 * 예전에 JSON.parse 를 그대로 부르던 곳들이 정확히 그 이유로 위험했다.
 */
export function readJson<T>(key: string, fallback: T): T {
  const raw = read(key)
  if (raw === null) return fallback
  try {
    const v = JSON.parse(raw)
    return v === null || v === undefined ? fallback : (v as T)
  } catch { return fallback }
}

export function writeJson(key: string, value: unknown): void {
  try { write(key, JSON.stringify(value)) } catch { /* 순환 참조 등 */ }
}

/** 문자열 배열 — 즐겨찾기·숨긴 목록이 전부 이 모양이다. 요소 타입까지 지킨다. */
export function readStringArray(key: string): string[] {
  const v = readJson<unknown>(key, [])
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}
