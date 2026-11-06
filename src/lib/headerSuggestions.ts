import type { KVSuggest } from '@/components/KVEditor'

// 헤더 KV 편집기용 제안 목록 — datalist 기반이라 선택과 수기 입력이 모두 가능하다.
// 키는 자주 쓰는 표준/사내 헤더, 값은 키별 상용 값. 여기 없는 키/값은 그냥 타이핑하면 된다.
export const HEADER_SUGGEST: KVSuggest = {
  keys: [
    'Content-Type',
    'Accept',
    'Authorization',
    'X-API-KEY',
    'X-API-TOKEN',
    'Cookie',
    'User-Agent',
    'Accept-Language',
    'Cache-Control',
    'If-None-Match',
    'X-Requested-With',
    'Origin',
    'Referer',
  ],
  values: {
    'content-type': [
      'application/json',
      'application/x-www-form-urlencoded',
      'multipart/form-data',
      'text/plain',
      'application/xml',
    ],
    accept: [
      'application/json',
      '*/*',
      'text/html',
      'application/xml',
      'text/event-stream',
    ],
    authorization: ['Bearer {{token}}', 'Basic '],
    'x-api-key': ['{{token}}'],
    'x-api-token': ['{{token}}'],
    'cache-control': ['no-cache', 'no-store', 'max-age=0'],
    'accept-language': ['ko-KR,ko;q=0.9', 'en-US,en;q=0.9'],
    'x-requested-with': ['XMLHttpRequest'],
  },
}
