/** 무엇으로 받을지 — 파일 내용만 보고 정한다. 모르는 모양은 '환경' 으로 밀어 넣지 않는다. */
export type ImportKind = 'postq' | 'collection' | 'environment' | 'openapi' | 'unknown'
export function importKind(json: unknown): ImportKind {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return 'unknown'
  const j = json as Record<string, unknown>
  if (j.postq === 1) return 'postq'
  if ((j.info as { schema?: unknown } | undefined)?.schema) return 'collection'
  // 예전엔 위 둘이 아니면 전부 Postman 환경으로 보냈다. OpenAPI 문서를 넣으면 변수 0개짜리
  // 'Imported env' 가 생기고 '환경 import 완료' 라고 성공으로 떴다 — 요청은 하나도 안 생겼는데.
  if (j.openapi || j.swagger) return 'openapi'
  if (Array.isArray(j.values)) return 'environment'
  return 'unknown'
}
