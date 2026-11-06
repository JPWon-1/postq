// GraphQL introspection — 표준 introspection 쿼리로 스키마를 끌어와 타입/필드 탐색에 쓴다.
// 외부 의존 없이(자기완결) 서버가 대상 엔드포인트에 쿼리를 보내고 결과를 단순화한다.

export const INTROSPECTION_QUERY = `query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    types {
      kind name
      fields { name type { ...TypeRef } args { name } }
    }
  }
}
fragment TypeRef on __Type {
  kind name
  ofType { kind name ofType { kind name ofType { kind name } } }
}`

type IntroType = {
  kind: string; name: string | null
  fields?: { name: string; type: IntroTypeRef; args?: { name: string }[] }[] | null
}
type IntroTypeRef = { kind: string; name: string | null; ofType?: IntroTypeRef | null }

export type SimpleField = { name: string; type: string; args: string[] }
export type SimpleType = { name: string; kind: string; fields: SimpleField[] }
export type SimpleSchema = { queryType: string | null; mutationType: string | null; types: SimpleType[] }

/** 중첩 ofType(NON_NULL/LIST 래핑)을 GraphQL SDL 표기(String!, [User!]!)로 평탄화. */
export function typeRefToString(t: IntroTypeRef | null | undefined): string {
  if (!t) return ''
  if (t.kind === 'NON_NULL') return `${typeRefToString(t.ofType)}!`
  if (t.kind === 'LIST') return `[${typeRefToString(t.ofType)}]`
  return t.name ?? ''
}

/** introspection 응답(data.__schema)을 타입→필드 탐색용으로 단순화. 내부 __ 타입 제외. */
export function simplifySchema(introspection: unknown): SimpleSchema | null {
  const schema = (introspection as { data?: { __schema?: unknown } })?.data?.__schema
    ?? (introspection as { __schema?: unknown })?.__schema
  if (!schema || typeof schema !== 'object') return null
  const s = schema as { queryType?: { name?: string }; mutationType?: { name?: string } | null; types?: IntroType[] }
  const types: SimpleType[] = (s.types ?? [])
    .filter(t => t.name && !t.name.startsWith('__') && (t.kind === 'OBJECT' || t.kind === 'INTERFACE') && t.fields)
    .map(t => ({
      name: t.name!,
      kind: t.kind,
      fields: (t.fields ?? []).map(f => ({ name: f.name, type: typeRefToString(f.type), args: (f.args ?? []).map(a => a.name) })),
    }))
  return { queryType: s.queryType?.name ?? null, mutationType: s.mutationType?.name ?? null, types }
}
