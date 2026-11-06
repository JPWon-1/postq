import { VAR_NAME_CHARS, type RequestInput } from './variables'
import { resolveEffectiveAuth } from './requestAuth'
import type { SnippetContext } from './snippetRequest'
import type { PreStep, PostStep } from './steps'

/** 현재 편집 중인 요청과 실제 상속 대상에서 참조한 변수만 모은다. */
export function requestVariableReferences(input: RequestInput, context?: SnippetContext, preSteps: PreStep[] = [], postSteps: PostStep[] = []): string[] {
  const names = new Set<string>()
  const scan = (value: unknown) => {
    for (const match of String(value ?? '').matchAll(new RegExp(`\\{\\{\\s*(${VAR_NAME_CHARS}+)\\s*(?:\\|\\s*json)?\\s*\\}\\}`, 'gu'))) names.add(match[1])
  }
  scan(input.url)
  for (const pair of input.params) if (pair.enabled) { scan(pair.key); scan(pair.value) }
  const own = new Set(input.headers.filter(h => h.enabled).map(h => h.key.toLowerCase()))
  for (const pair of [...(context?.folderHeaders ?? []).filter(h => !own.has(h.key.toLowerCase())), ...input.headers]) {
    if (pair.enabled) { scan(pair.key); scan(pair.value) }
  }
  if (input.bodyType !== 'none') scan(input.body)
  scan(JSON.stringify(resolveEffectiveAuth(context?.auth, context?.folderAuth)))
  for (const step of preSteps) for (const field of ['value', 'input', 'key', 'min', 'max'] as const) scan(step[field])
  for (const step of postSteps) scan(step.path)
  return [...names]
}
