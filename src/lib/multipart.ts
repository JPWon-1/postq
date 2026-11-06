// multipart/form-data 바디 — 파일 업로드 지원.
// body 는 JSON 문자열: { fields: [{name, value}], files: [{name, filename, contentType, dataBase64}] }
// 파일은 브라우저에서 base64 로 인코딩해 실행 시점에만 전송(템플릿에 저장 안 함이 원칙 — 큰 파일 방어).

export type MultipartField = { name: string; value: string }
export type MultipartFile = { name: string; filename: string; contentType?: string; dataBase64: string }
export type MultipartSpec = { fields: MultipartField[]; files: MultipartFile[] }

export function parseMultipartBody(body: string): MultipartSpec {
  try {
    const p = JSON.parse(body)
    return { fields: Array.isArray(p.fields) ? p.fields : [], files: Array.isArray(p.files) ? p.files : [] }
  } catch {
    return { fields: [], files: [] }
  }
}

/** MultipartSpec → FormData (Node fetch 가 boundary/Content-Type 을 자동 설정). */
export function buildFormData(spec: MultipartSpec): FormData {
  const fd = new FormData()
  for (const f of spec.fields) if (f.name) fd.append(f.name, f.value)
  for (const file of spec.files) {
    if (!file.name || !file.filename) continue
    const buf = base64ToBuffer(file.dataBase64)
    fd.append(file.name, new Blob([buf], { type: file.contentType || 'application/octet-stream' }), file.filename)
  }
  return fd
}

function base64ToBuffer(b64: string): ArrayBuffer {
  const clean = b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64 // data: URI 접두 제거
  const bin = typeof atob === 'function' ? atob(clean) : Buffer.from(clean, 'base64').toString('binary')
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}
