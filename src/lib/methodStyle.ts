// HTTP 메서드 표기 스타일 — 화면마다 제각각이던 것을 한 곳으로 모은다.
// (stitch 시안 'Proton Syntax': 배지는 15% 배경 + 같은 색 1px 테두리, 텍스트는 단색)

/** 배지형 — 요청 헤더·스텝 카드처럼 '이 요청이 무엇인지' 강조할 때. */
export const METHOD_PILL: Record<string, string> = {
  GET: 'border-method-get/40 bg-method-get/10 text-method-get',
  POST: 'border-method-post/40 bg-method-post/10 text-method-post',
  PUT: 'border-method-put/40 bg-method-put/10 text-method-put',
  PATCH: 'border-method-patch/40 bg-method-patch/10 text-method-patch',
  DELETE: 'border-method-delete/40 bg-method-delete/10 text-method-delete',
}

/** 텍스트형 — 목록에서 수십 줄이 늘어설 때(배지는 시각 소음이 된다). */
export const METHOD_TEXT: Record<string, string> = {
  GET: 'text-method-get',
  POST: 'text-method-post',
  PUT: 'text-method-put',
  PATCH: 'text-method-patch',
  DELETE: 'text-method-delete',
}

export const methodPill = (m: string) => METHOD_PILL[m?.toUpperCase()] ?? 'border-border text-faint-foreground'
export const methodText = (m: string) => METHOD_TEXT[m?.toUpperCase()] ?? 'text-faint-foreground'
