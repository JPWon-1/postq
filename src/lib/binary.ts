/** multipart와 같은 base64 저장 형식. null은 가져온 파일의 재첨부가 필요함을 뜻한다. */
export type BinarySpec = { filename: string; contentType: string; dataBase64: string | null }
export function parseBinaryBody(body: string): BinarySpec {
  try {
    const value = JSON.parse(body)
    return { filename: typeof value?.filename === 'string' ? value.filename : '', contentType: typeof value?.contentType === 'string' && value.contentType ? value.contentType : 'application/octet-stream', dataBase64: typeof value?.dataBase64 === 'string' ? value.dataBase64 : null }
  } catch { return { filename: '', contentType: 'application/octet-stream', dataBase64: null } }
}
