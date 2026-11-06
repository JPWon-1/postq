'use client'
import { t as i18nText } from '@/i18n'
import { ToolButton } from './ToolButton'
import { useState } from 'react'
import type { KV } from '@/lib/variables'
import type { AuthConfig } from '@/lib/requestAuth'
import type { SimpleSchema } from '@/lib/graphqlIntrospect'
import { combineGqlBody as combineBody, splitGqlBody as splitBody } from '@/lib/graphqlBody'
import { useToast } from './Toast'
import { errorText } from '@/lib/fetchJson'

/**
 * GraphQL 편집기 — 쿼리 + Variables(JSON) 분리 편집(전송 시 {query, variables} 로 합침),
 * introspection 으로 스키마 탐색. bodyType='graphql' 일 때 RequestPanel 이 사용.
 * request.id 를 key 로 받아 요청 전환 시 재마운트되므로 body 에서 1회 시드한다.
 */
export function GraphqlEditor({ body, onBodyChange, ctx, disabled }: {
  body: string
  onBodyChange: (body: string) => void
  ctx: {
    url: string; headers: KV[]; auth: AuthConfig; environmentId: string | null; workspaceId: string
    vars?: { key: string; value: string }[]
    /** 개인 오버라이드 — 실행과 같은 값으로 해석해야 결과가 어긋나지 않는다 */
    personalVars?: Record<string, string>
  }
  disabled?: boolean
}) {
  const toast = useToast()
  const init = splitBody(body)
  const [query, setQuery] = useState(init.query)
  const [variables, setVariables] = useState(init.variables)
  const [showVars, setShowVars] = useState(!!init.variables)
  const [schema, setSchema] = useState<SimpleSchema | null>(null)
  const [schemaFilter, setSchemaFilter] = useState('')
  const [introspecting, setIntrospecting] = useState(false)

  const push = (q: string, v: string) => { setQuery(q); setVariables(v); onBodyChange(combineBody(q, v)) }
  // {{변수}} 를 담은 경우는 실행 시점에 치환돼 유효 JSON 이 되므로 경고하지 않는다(soft).
  const hasPlaceholder = /\{\{\s*[\w.$-]+\s*\}\}/.test(variables)
  const varsValid = !variables.trim() || hasPlaceholder || (() => { try { JSON.parse(variables); return true } catch { return false } })()

  const introspect = async () => {
    setIntrospecting(true)
    try {
      const res = await fetch('/api/graphql/introspect', {
        method: 'POST',
        body: JSON.stringify({
          url: ctx.url, headers: ctx.headers, auth: ctx.auth, environmentId: ctx.environmentId,
          workspaceId: ctx.workspaceId, vars: ctx.vars, personalVars: ctx.personalVars,
        }),
      })
      const data = await res.json()
      if (!res.ok) { toast('error', i18nText('dynamicIntrospectionFailed', { v0: String(data.error ?? res.status) })); return }
      setSchema(data.schema); toast('success', i18nText('dynamicSchemaLoadedType', { v0: String(data.schema.types.length) }))
    } catch (e) {
      toast('error', i18nText('dynamicIntrospectionFailed', { v0: String(errorText(e)) }))
    } finally { setIntrospecting(false) }
  }

  const filteredTypes = schema
    ? schema.types.filter(t => !schemaFilter || t.name.toLowerCase().includes(schemaFilter.toLowerCase()) || t.fields.some(f => f.name.toLowerCase().includes(schemaFilter.toLowerCase())))
    : []

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="ah-label">{i18nText('uiGraphQLQueries')}</span>
        <div className="flex items-center gap-1.5">
          <ToolButton icon="refresh" aria-label={i18nText('uiGetSchema')} type="button" className="text-ui-sm font-medium text-accent hover:text-accent-hover disabled:opacity-50" onClick={introspect} disabled={introspecting} />
          <ToolButton icon="variables" aria-label={i18nText('uiDisplayingGraphQLVariables')} type="button" className="text-ui-sm font-medium text-muted-foreground hover:text-foreground" onClick={() => setShowVars(s => !s)} />
        </div>
      </div>
      <textarea
        aria-label={i18nText('uiGraphQLQueries')}
        rows={8}
        disabled={disabled}
        className="w-full resize-y rounded-[var(--radius-sm)] border border-border bg-surface px-2.5 py-2 font-mono text-ui-md text-foreground outline-none placeholder:text-faint-foreground focus-visible:border-accent"
        placeholder={'query { me { id name } }'}
        value={query}
        onChange={e => push(e.target.value, variables)}
      />
      {showVars && (
        <div className="flex flex-col gap-1">
          <span className="ah-label">Variables (JSON){!varsValid && <span className="ml-1 text-method-delete">{i18nText('uiNotJSON')}</span>}</span>
          <textarea
            aria-label={i18nText('uiGraphQLVariables')}
            rows={3}
            disabled={disabled}
            className={`w-full resize-y rounded-[var(--radius-sm)] border bg-surface px-2.5 py-2 font-mono text-ui-md text-foreground outline-none focus-visible:border-accent ${varsValid ? 'border-border' : 'border-method-delete/50'}`}
            placeholder={'{ "id": 1 }'}
            value={variables}
            onChange={e => push(query, e.target.value)}
          />
        </div>
      )}
      {schema && (
        <div className="mt-1 rounded-[var(--radius-sm)] border border-border bg-surface-2">
          <div className="flex items-center gap-2 border-b border-border/70 px-2 py-1.5">
            <span className="ah-label">{i18nText('uiSchema')}</span>
            <input
              aria-label={i18nText('uiSchemaSearch')}
              className="min-w-0 flex-1 rounded-[var(--radius-sm)] border border-border bg-surface px-1.5 py-0.5 text-ui-sm text-foreground outline-none focus-visible:border-accent"
              placeholder={i18nText('uiTypeFieldSearch')}
              value={schemaFilter}
              onChange={e => setSchemaFilter(e.target.value)}
            />
            <ToolButton icon="close" aria-label={i18nText('uiClose')} type="button" className="ah-action shrink-0 text-ui-sm text-muted-foreground hover:text-foreground" onClick={() => setSchema(null)} />
          </div>
          <div className="max-h-56 overflow-y-auto p-2 font-mono text-ui-sm">
            {filteredTypes.map(t => (
              <div key={t.name} className="mb-2">
                <span className="font-bold text-accent">{t.name}</span>
                {t.name === schema.queryType && <span className="ml-1 text-ui-meta text-faint-foreground">(Query)</span>}
                {t.name === schema.mutationType && <span className="ml-1 text-ui-meta text-faint-foreground">(Mutation)</span>}
                <div className="pl-3">
                  {t.fields.map(f => (
                    <div key={f.name} className="text-muted-foreground">
                      <span className="text-foreground">{f.name}</span>{f.args.length ? `(${f.args.join(', ')})` : ''}: <span className="text-json-string">{f.type}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
