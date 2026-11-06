'use client'
import { t as i18nText } from '@/i18n'
import { useRef } from 'react'
import { parseMultipartBody, type MultipartSpec } from '@/lib/multipart'

// multipart/form-data 편집기 — 텍스트 필드 + 파일 첨부(브라우저에서 base64 인코딩).
// draft.body 에 JSON({fields,files})으로 직렬화. 파일은 실행 시점 전송용(템플릿 저장 시 크기 주의).
export function MultipartEditor({ body, onChange }: { body: string; onChange: (body: string) => void }) {
  const spec = parseMultipartBody(body)
  const fileRef = useRef<HTMLInputElement>(null)
  const update = (next: MultipartSpec) => onChange(JSON.stringify(next))

  const addFile = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataBase64 = String(reader.result)
      update({ ...spec, files: [...spec.files, { name: 'file', filename: file.name, contentType: file.type, dataBase64 }] })
    }
    reader.readAsDataURL(file)
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-hidden rounded-[var(--radius-sm)] border border-border">
        <table className="w-full text-ui-md">
          <thead>
            <tr className="border-b border-border bg-surface-2 text-left text-ui-sm font-semibold uppercase tracking-wide text-faint-foreground">
              <th className="px-2 py-1.5">field</th><th className="px-2 py-1.5">value</th><th className="w-7" />
            </tr>
          </thead>
          <tbody>
            {spec.fields.map((f, i) => (
              <tr key={i} className="border-t border-border first:border-t-0">
                <td className="p-1"><input aria-label={i18nText('uiFieldName')} className="w-full rounded-[var(--radius-sm)] border border-transparent bg-transparent px-1.5 py-1 font-mono text-ui-md text-foreground outline-none hover:border-border focus-visible:border-accent" value={f.name} onChange={e => update({ ...spec, fields: spec.fields.map((x, j) => j === i ? { ...x, name: e.target.value } : x) })} /></td>
                <td className="p-1"><input aria-label={i18nText('uiFieldValue')} className="w-full rounded-[var(--radius-sm)] border border-transparent bg-transparent px-1.5 py-1 font-mono text-ui-md text-foreground outline-none hover:border-border focus-visible:border-accent" value={f.value} onChange={e => update({ ...spec, fields: spec.fields.map((x, j) => j === i ? { ...x, value: e.target.value } : x) })} /></td>
                <td className="p-1 text-center"><button type="button" aria-label={i18nText('uiDeleteField')} title={i18nText('uiDeleteField')} className="ah-action inline-flex h-6 w-auto px-1.5 items-center justify-center rounded-[var(--radius-sm)] text-muted-foreground transition-colors hover:bg-surface-2 hover:text-method-delete focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent" onClick={() => update({ ...spec, fields: spec.fields.filter((_, j) => j !== i) })}>{i18nText('uiDelete')}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" className="w-full border-t border-border/70 px-2 py-1.5 text-left text-ui-md font-medium text-accent hover:bg-accent/5" onClick={() => update({ ...spec, fields: [...spec.fields, { name: '', value: '' }] })}>{i18nText('uiTextField')}</button>
      </div>

      <div className="flex flex-col gap-1 rounded-[var(--radius-sm)] border border-border p-2">
        <p className="ah-label">{i18nText('uiFile')}</p>
        {spec.files.map((f, i) => (
          <div key={i} className="flex items-center gap-2 text-ui-md">
            <input aria-label={i18nText('uiFileFieldName')} className="w-28 rounded-[var(--radius-sm)] border border-border bg-surface px-1.5 py-1 font-mono text-ui-sm text-foreground outline-none focus-visible:border-accent" value={f.name} onChange={e => update({ ...spec, files: spec.files.map((x, j) => j === i ? { ...x, name: e.target.value } : x) })} />
            <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground" title={f.filename}>{f.filename}</span>
            <button type="button" aria-label={i18nText('uiDeleteFile')} title={i18nText('uiDeleteFile')} className="ah-action inline-flex h-6 w-auto px-1.5 items-center justify-center rounded-[var(--radius-sm)] text-muted-foreground transition-colors hover:bg-surface-2 hover:text-method-delete focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent" onClick={() => update({ ...spec, files: spec.files.filter((_, j) => j !== i) })}>{i18nText('uiDelete')}</button>
          </div>
        ))}
        <input ref={fileRef} type="file" className="hidden" aria-hidden onChange={e => { const f = e.target.files?.[0]; if (f) addFile(f); e.target.value = '' }} />
        <button type="button" className="self-start text-ui-md font-medium text-accent hover:text-accent-hover" onClick={() => fileRef.current?.click()}>{i18nText('uiAttachFiles')}</button>
      </div>
    </div>
  )
}
