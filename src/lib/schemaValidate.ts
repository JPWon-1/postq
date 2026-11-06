// 응답 바디 ↔ OpenAPI 스키마 대조 — "스펙과 다른 응답"을 잡는 경량 검증기.
// 외부 의존 없이 OpenAPI 3 스키마의 핵심(type/required/properties/items/$ref/enum/nullable)만 다룬다.
// 목적은 완전한 JSON Schema 검증이 아니라 "백엔드가 스펙 어긴 것"을 빠르게 표면화하는 것.

export type SchemaIssue = { path: string; message: string }

type Schema = Record<string, unknown>
type Components = { schemas?: Record<string, Schema> }

const MAX_DEPTH = 8
const REF_PREFIX = '#/components/schemas/'

function resolveRef(schema: Schema, components: Components): Schema {
  const ref = schema.$ref
  if (typeof ref !== 'string' || !ref.startsWith(REF_PREFIX)) return schema
  const name = ref.slice(REF_PREFIX.length)
  const target = components.schemas?.[name]
  return target ?? schema
}

// oneOf/anyOf/allOf 는 "가장 관대하게" 처리 — allOf 만 병합, one/any 는 통과(오탐 방지).
function effectiveType(schema: Schema): string | undefined {
  if (typeof schema.type === 'string') return schema.type
  if (schema.properties || schema.additionalProperties) return 'object'
  if (schema.items) return 'array'
  return undefined
}

function typeMatches(expected: string, value: unknown): boolean {
  switch (expected) {
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'integer':
    case 'number': return typeof value === 'number'
    case 'boolean': return typeof value === 'boolean'
    default: return true
  }
}

function walk(value: unknown, schema: Schema, components: Components, path: string, depth: number, issues: SchemaIssue[]) {
  if (depth > MAX_DEPTH || issues.length > 100) return
  const s = resolveRef(schema, components)

  // allOf 병합(얕게) — 하위 스키마 required/properties 를 합쳐서 검사
  if (Array.isArray(s.allOf)) {
    for (const sub of s.allOf) walk(value, sub as Schema, components, path, depth + 1, issues)
  }
  // one/any Of 는 통과(관대) — 어떤 분기든 맞을 수 있어 오탐 방지
  if (Array.isArray(s.oneOf) || Array.isArray(s.anyOf)) return

  if (value === null) {
    if (s.nullable === true) return
    const t = effectiveType(s)
    if (t && t !== 'null') issues.push({ path, message: `null 인데 스펙은 ${t}` })
    return
  }

  const expected = effectiveType(s)
  if (expected && !typeMatches(expected, value)) {
    issues.push({ path, message: `타입 불일치 — 스펙 ${expected}, 실제 ${Array.isArray(value) ? 'array' : typeof value}` })
    return
  }

  if (Array.isArray(s.enum) && !s.enum.includes(value as never)) {
    issues.push({ path, message: `enum 벗어남 — 허용 ${JSON.stringify(s.enum)}, 실제 ${JSON.stringify(value)}` })
  }

  if (expected === 'object' && value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const props = (s.properties ?? {}) as Record<string, Schema>
    for (const req of (Array.isArray(s.required) ? s.required : []) as string[]) {
      if (!(req in obj)) issues.push({ path: path ? `${path}.${req}` : req, message: '필수 필드 누락' })
    }
    for (const [k, v] of Object.entries(obj)) {
      const ps = props[k]
      if (ps) walk(v, ps, components, path ? `${path}.${k}` : k, depth + 1, issues)
    }
  }

  if (expected === 'array' && Array.isArray(value) && s.items) {
    // 배열은 앞 20개만 검사(대형 응답 방어)
    value.slice(0, 20).forEach((item, i) => walk(item, s.items as Schema, components, `${path}[${i}]`, depth + 1, issues))
  }
}

/**
 * 응답 바디(JSON 문자열)를 스키마와 대조한다.
 * 반환: { ok, issues[] }. 스키마/바디가 없거나 JSON 이 아니면 ok=true(검증 스킵).
 */
export function validateAgainstSchema(
  responseBody: string | null,
  schema: Schema | undefined,
  components: Components = {},
): { ok: boolean; issues: SchemaIssue[]; skipped?: string } {
  if (!schema) return { ok: true, issues: [], skipped: '스펙에 응답 스키마가 없음' }
  if (responseBody == null || responseBody.trim() === '') return { ok: true, issues: [], skipped: '응답 바디 없음' }
  let value: unknown
  try { value = JSON.parse(responseBody) } catch { return { ok: true, issues: [], skipped: 'JSON 응답 아님' } }
  const issues: SchemaIssue[] = []
  walk(value, schema, components, '', 0, issues)
  return { ok: issues.length === 0, issues }
}
