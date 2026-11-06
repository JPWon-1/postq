import { toCurl } from './curl'
import { toFetch, toAxios, toPythonRequests } from './codegen'
import type { RequestInput } from './variables'

export type SnippetLanguage = 'curl' | 'fetch' | 'axios' | 'python'
export const formatSnippet = (language: SnippetLanguage, input: RequestInput) => language === 'curl'
  ? toCurl(input, {}, { prepared: true }).command
  : ({ fetch: toFetch, axios: toAxios, python: toPythonRequests })[language](input, {}, { prepared: true })
