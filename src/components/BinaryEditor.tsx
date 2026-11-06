'use client'
import { t as i18nText } from '@/i18n'
import { useRef, useState } from 'react'
import { parseBinaryBody } from '@/lib/binary'

export function BinaryEditor({ body, onChange }: { body: string; onChange: (body: string) => void }) {
  const spec = parseBinaryBody(body)
  const [error, setError] = useState('')
  const sequence = useRef(0)
  const fileInput = useRef<HTMLInputElement>(null)
  return <div className="space-y-3 rounded border border-border p-4 text-ui-md">
    <div className="flex flex-wrap items-center gap-3"><span className="ah-label">{i18nText('uiBodyFile')}</span><button className="ah-btn" type="button" onClick={() => fileInput.current?.click()}>{i18nText('uiSelectFile')}</button><span className="text-muted-foreground">{spec.filename || i18nText('jsxNoFilesSelected')}</span>
      <input ref={fileInput} className="hidden" type="file" aria-label={i18nText('uiBinaryBodyFile')} onChange={async e => {
        const file = e.target.files?.[0]; e.target.value = ''
        if (!file) return
        const current = ++sequence.current
        setError('')
        // 서버 JSON 요청 제한(64 MiB) 안에서 base64로 저장한다.
        if (file.size > 16 * 1024 * 1024) { setError(i18nText('jsxPleaseSelectFilesUnder16MiB')); return }
        const reader = new FileReader()
        reader.onload = () => { if (current === sequence.current) onChange(JSON.stringify({ filename: file.name, contentType: file.type || 'application/octet-stream', dataBase64: String(reader.result) })) }
        reader.onerror = () => { if (current === sequence.current) setError(i18nText('jsxFailedToReadFile')) }
        reader.readAsDataURL(file)
      }} />
    </div>
    {spec.filename && <p className="break-all">{spec.filename} · {spec.contentType}
      <button className="ml-3 text-muted-foreground" onClick={() => { sequence.current++; onChange('') }}>{i18nText('uiDeleteAttachment')}</button>
    </p>}
    {spec.dataBase64 === null && <p className="text-muted-foreground">{i18nText('uiWhenYouSelectAFileTheOriginalBytesAre')}</p>}
    <p className="text-faint-foreground">{i18nText('uiWhenYouSaveTheContentsOfTheFileWill')}</p>
    {error && <p role="alert">{error}</p>}
  </div>
}
