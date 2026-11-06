/** Structural contract, independent of examples and the user's execution values. */
export type ContractField = { type: string; required: boolean; enum?: unknown[]; constraints?: Record<string, unknown> }
export type ApiContract = { fields: Record<string, ContractField>; incomplete: string[] }
export type ContractChange = { label: string; from: string; to: string; severity: 'breaking' | 'review' | 'info' }
const object = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v : {}
export function operationContract(spec: any, op: any, params: any[]): ApiContract {
  const fields: ApiContract['fields'] = {}, incomplete: string[] = []
  const resolve = (raw: unknown, seen: Set<string>): any => {
    const s = object(raw)
    if (!s.$ref) return s
    if (typeof s.$ref !== 'string' || !s.$ref.startsWith('#/') || seen.has(s.$ref)) return null
    const found = s.$ref.slice(2).split('/').reduce((v: any, k: string) => v?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], spec)
    if (!found) return null
    return resolve(found, new Set([...seen, s.$ref]))
  }
  function walk(raw: unknown, path: string, required: boolean, depth = 0, refs = new Set<string>()) {
    const ref = object(raw).$ref
    if (depth > 12 || (ref && refs.has(ref))) { incomplete.push(path); return }
    const s = resolve(raw, new Set())
    if (!s || !Object.keys(s).length) { incomplete.push(path); return }
    const nextRefs = ref ? new Set([...refs, ref]) : refs
    const constraints: Record<string, unknown> = {}
    for (const k of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'additionalProperties', 'format', 'nullable']) if (s[k] !== undefined) constraints[k] = s[k]
    fields[path] = { type: Array.isArray(s.type) ? [...s.type].sort().join('|') : s.type ?? (s.properties ? 'object' : s.items ? 'array' : 'unknown'), required, ...(Array.isArray(s.enum) ? { enum: [...s.enum].sort() } : {}), ...(Object.keys(constraints).length ? { constraints } : {}) }
    if (s.oneOf || s.anyOf || s.allOf || s.not) incomplete.push(path + ' (조합 스키마)')
    for (const [name, child] of Object.entries(object(s.properties))) walk(child, `${path}.${name}`, Array.isArray(s.required) && s.required.includes(name), depth + 1, nextRefs)
    if (s.items) walk(s.items, path + '[]', false, depth + 1, nextRefs)
  }
  for (const raw of params) {
    const p = resolve(raw, new Set())
    if (!p?.name || !p.in) { incomplete.push('파라미터 참조'); continue }
    walk(p.schema, `요청 ${p.in}.${p.name}`, p.in === 'path' || p.required === true)
  }
  const body = resolve(op.requestBody, new Set())
  for (const [media, raw] of Object.entries(object(body?.content))) walk(object(raw).schema, `요청 body[${media}]`, body?.required === true)
  if (!Object.keys(object(op.responses)).length) incomplete.push('응답 정의 없음')
  for (const [code, raw] of Object.entries(object(op.responses))) {
    const response = resolve(raw, new Set())
    if (!response) { incomplete.push(`응답 ${code}`); continue }
    fields[`응답 ${code}`] = { type: 'response', required: false }
    const content = object(response.content)
    if (!Object.keys(content).length && code !== '204' && code !== '304') incomplete.push(`응답 ${code} 스키마 없음`)
    for (const [media, value] of Object.entries(content)) walk(object(value).schema, `응답 ${code}[${media}]`, false)
    for (const [name, value] of Object.entries(object(response.headers))) {
      const header = resolve(value, new Set()); walk(header?.schema, `응답 ${code} header.${name.toLowerCase()}`, header?.required === true)
    }
  }
  return { fields: Object.fromEntries(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b))), incomplete: [...new Set(incomplete)].sort() }
}
const description = (f?: ContractField) => !f ? '(없음)' : `${f.type} · ${f.required ? '필수' : '선택'}${f.enum ? ` · 허용값 ${JSON.stringify(f.enum)}` : ''}${f.constraints ? ` · ${JSON.stringify(f.constraints)}` : ''}`
export function diffContract(before: ApiContract | null | undefined, after: ApiContract | null | undefined): ContractChange[] {
  if (!before || !after) return [] // First capture establishes a baseline, not a fabricated change.
  const changes: ContractChange[] = []
  for (const key of new Set([...Object.keys(before.fields), ...Object.keys(after.fields)])) {
    const a = before.fields[key], b = after.fields[key]
    if (JSON.stringify(a) === JSON.stringify(b)) continue
    const input = key.startsWith('요청 ')
    let severity: ContractChange['severity'] = 'review'
    if (!a) severity = input && b.required ? 'breaking' : 'info'
    else if (!b) severity = 'breaking'
    else if (a.type !== b.type || (input ? !a.required && b.required : a.required && !b.required)) severity = 'breaking'
    else if (a.enum && b.enum && (input ? a.enum.some(v => !b.enum!.includes(v)) : b.enum.some(v => !a.enum!.includes(v)))) severity = 'breaking'
    changes.push({ label: `${severity === 'breaking' ? '호환성 주의' : severity === 'review' ? '검토 필요' : '스키마 변경'} · ${key}`, from: description(a), to: description(b), severity })
  }
  if (after.incomplete.length && JSON.stringify(before.incomplete) !== JSON.stringify(after.incomplete)) changes.push({ label: '분석 범위 확인', from: before.incomplete.join(', ') || '없음', to: after.incomplete.join(', '), severity: 'review' })
  return changes
}

export function parseContract(value: unknown): ApiContract | null {
  if (typeof value === 'string') { try { value = JSON.parse(value) } catch { return null } }
  const v = object(value)
  if (!v.fields || typeof v.fields !== 'object' || Array.isArray(v.fields) || !Array.isArray(v.incomplete)) return null
  if (Object.values(v.fields).some((f: any) => !f || typeof f.type !== 'string' || typeof f.required !== 'boolean')) return null
  return { fields: v.fields, incomplete: v.incomplete.filter((x: unknown) => typeof x === 'string') }
}
