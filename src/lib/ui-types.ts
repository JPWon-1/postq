import type { KV } from './variables'

export type FolderRow = {
  id: string; name: string; description?: string
  specSourceType: 'none' | 'url'
  specSourceUrl: string | null
  sharedHeaders: KV[]
  sharedAuth: import('./requestAuth').AuthConfig
  sortOrder?: number
}
export type RequestRow = {
  aiExecutionAllowed?: boolean
  owner?: string
  specContract?: import('./apiContract').ApiContract | null
  id: string; folderId: string; name: string; method: string; url: string
  params: KV[]; headers: KV[]
  bodyType: 'none' | 'json' | 'form' | 'raw' | 'graphql' | 'multipart' | 'binary'; body: string; description: string
  origin: 'manual' | 'spec' | 'postman-import'
  specState: 'synced' | 'new' | 'changed' | 'deprecated' | null
  updatedAt?: number
  updatedBy?: string | null
  assertions?: import('./assertions').Assertion[]
  preSteps?: import('./steps').PreStep[]
  postSteps?: import('./steps').PostStep[]
  auth?: import('./requestAuth').AuthConfig
  tags?: string[]
  settings?: import('./variables').RequestSettings
  vars?: { key: string; value: string }[]
  sortOrder?: number
}
export type ExecutionRow = {
  executionSource?: import('./executionPolicy').ExecutionSource
  denialReason?: string | null
  id: string; requestId: string; executedBy: string; executedAt: number
  environmentId: string | null
  resolved: { method: string; url: string; params: KV[]; headers: KV[]; bodyType: string; body: string }
  responseStatus: number | null; responseHeaders: Record<string, string> | null
  responseBody: string | null; durationMs: number | null; error: string | null
  missingVariables: string[]
  checkPassed?: boolean | null
  assertionResults?: import('./assertions').AssertResult[]
  pinned?: boolean
  truncated?: boolean
}
export type EnvironmentRow = {
  executionPolicy?: import('./executionPolicy').ExecutionPolicy
  id: string; name: string
  // keyState 는 secret 에만 붙는다 — 값이 안 보이는 자리라, 살아 있는지 여부는 따로
  // 말해주지 않으면 알 길이 없다('broken' 이어도 화면은 똑같은 빈칸이다).
  variables: {
    id: string; key: string; value: string; secret: boolean
    keyState?: 'plain' | 'current' | 'old' | 'broken'
  }[]
  /** 마지막 저장 시각 — 동시 편집에서 조용한 덮어쓰기를 막는 데 쓴다. */
  updatedAt?: number
}
