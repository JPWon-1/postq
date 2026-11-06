// 에러/상태코드를 사람 말로 설명한다 — "fetch failed" 를 그대로 보여주지 않기 위한 레이어.

export type ErrorExplanation = { title: string; hints: string[] }

const TRANSPORT: [RegExp, ErrorExplanation][] = [
  [/ENOTFOUND|EAI_AGAIN/i, {
    title: '도메인을 찾을 수 없습니다 (DNS 실패)',
    hints: [
      'URL 의 호스트명에 오타가 없는지 확인하세요',
      '내부 도메인이라면 VPN/내부망에 연결되어 있는지 확인하세요',
      '{{baseUrl}} 값이 지금 선택된 환경에 맞는지 확인하세요',
    ],
  }],
  [/ECONNREFUSED/i, {
    title: '대상 서버가 연결을 거부했습니다',
    hints: [
      '대상 서버가 떠 있는지 확인하세요',
      '포트 번호가 맞는지 확인하세요',
      '도커에서 실행 중이라면 localhost 대신 host.docker.internal 을 써야 할 수 있습니다',
    ],
  }],
  [/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|TimeoutError|timeout/i, {
    title: '응답 시간 초과 (30초)',
    hints: [
      '대상 서버가 느리거나 응답하지 않습니다 — 서버 상태를 확인하세요',
      '방화벽/네트워크 정책이 이 주소를 막고 있을 수 있습니다',
    ],
  }],
  [/ECONNRESET|socket hang up/i, {
    title: '연결이 중간에 끊겼습니다',
    hints: ['대상 서버가 요청 처리 중 종료됐을 수 있습니다 — 서버 로그를 확인하세요', '재시도해 보세요'],
  }],
  [/certificate|CERT_|SSL|TLS/i, {
    title: '인증서(SSL) 검증에 실패했습니다',
    hints: ['https 주소의 인증서가 만료/자체서명일 수 있습니다', '자체 인증서라면 http 스테이징 주소를 쓰거나 신뢰 루트에 인증서를 추가하세요'],
  }],
  [/BlockedHost/i, {
    title: '차단된 주소입니다',
    hints: ['클라우드 메타데이터 주소(169.254.x.x)로는 요청할 수 없습니다'],
  }],
  [/bad port/i, {
    title: '브라우저/런타임이 차단하는 포트입니다',
    hints: ['1, 7, 9 같은 예약 포트는 fetch 표준이 차단합니다 — 대상 서비스의 실제 포트를 확인하세요'],
  }],
  [/Invalid URL/i, {
    title: 'URL 형식이 잘못됐습니다',
    hints: [
      'http:// 또는 https:// 로 시작하는지 확인하세요',
      '{{변수}}가 남아 있다면 환경을 선택했는지, 변수가 등록돼 있는지 확인하세요 (위 변수 칩 참고)',
    ],
  }],
]

/** 실행 실패 문자열(executor error)을 원인+확인사항으로 번역. 모르는 에러는 null. */
export function explainTransportError(error: string): ErrorExplanation | null {
  for (const [re, ex] of TRANSPORT) if (re.test(error)) return ex
  return null
}

const STATUS: Record<number, { label: string; hint?: string }> = {
  200: { label: 'OK — 성공' },
  201: { label: 'Created — 생성됨' },
  202: { label: 'Accepted — 접수됨(비동기 처리 중)' },
  204: { label: 'No Content — 성공(응답 본문 없음)' },
  301: { label: 'Moved Permanently — 영구 이동', hint: 'Location 응답 헤더의 새 주소를 확인하세요' },
  302: { label: 'Found — 임시 이동', hint: 'Location 응답 헤더의 새 주소를 확인하세요' },
  304: { label: 'Not Modified — 변경 없음(캐시)' },
  400: { label: 'Bad Request — 잘못된 요청', hint: '바디 형식과 필수 파라미터를 확인하세요 (응답 바디에 상세 사유가 있는 경우가 많습니다)' },
  401: { label: 'Unauthorized — 인증 실패', hint: 'Authorization 헤더와 토큰 값을 확인하세요 (만료됐다면 재발급)' },
  403: { label: 'Forbidden — 권한 없음', hint: '계정 권한 또는 IP 허용 목록을 확인하세요' },
  404: { label: 'Not Found — 없는 경로/리소스', hint: 'URL 경로와 경로 안의 ID 값을 확인하세요' },
  405: { label: 'Method Not Allowed — 허용되지 않는 메서드', hint: 'GET/POST 등 메서드가 스펙과 맞는지 확인하세요' },
  409: { label: 'Conflict — 충돌', hint: '중복 생성이거나 리소스 상태가 요청과 충돌합니다' },
  415: { label: 'Unsupported Media Type — 지원하지 않는 형식', hint: 'Content-Type 헤더(예: application/json)를 확인하세요' },
  422: { label: 'Unprocessable Entity — 검증 실패', hint: '필드 값 규칙(형식/범위)을 응답 바디에서 확인하세요' },
  429: { label: 'Too Many Requests — 요청 과다', hint: '잠시 후 재시도하세요 (Retry-After 헤더 참고)' },
  500: { label: 'Internal Server Error — 서버 내부 오류', hint: '응답 바디와 대상 서버 로그를 확인하세요' },
  502: { label: 'Bad Gateway — 게이트웨이 오류', hint: '업스트림 서버가 죽었거나 배포 중일 수 있습니다' },
  503: { label: 'Service Unavailable — 서비스 불가', hint: '대상 서비스가 점검/배포 중일 수 있습니다' },
  504: { label: 'Gateway Timeout — 게이트웨이 시간 초과', hint: '업스트림 서버가 제때 응답하지 못했습니다' },
}

/** 상태코드 설명. 정의 없는 코드는 클래스(2xx/4xx/5xx) 기본 설명으로. */
export function explainStatus(status: number): { label: string; hint?: string } {
  if (STATUS[status]) return STATUS[status]
  if (status >= 200 && status < 300) return { label: '성공' }
  if (status >= 300 && status < 400) return { label: '리다이렉트' }
  if (status >= 400 && status < 500) return { label: '클라이언트 오류', hint: '요청 값(경로/헤더/바디)을 확인하세요' }
  if (status >= 500) return { label: '서버 오류', hint: '대상 서버 측 문제입니다 — 응답 바디/서버 로그를 확인하세요' }
  return { label: `HTTP ${status}` }
}
