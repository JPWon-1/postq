import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'

// 프로젝트(팀) 단위 최상위 스코프 — 폴더/환경/시나리오가 여기에 귀속된다.
// 'default' 워크스페이스는 마이그레이션이 만들어 기존 데이터를 백필한다.
export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
})

export const folders = sqliteTable('folders', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().default('default'),
  name: text('name').notNull(),
  specSourceType: text('spec_source_type', { enum: ['none', 'url'] }).notNull().default('none'),
  specSourceUrl: text('spec_source_url'),
  // 폴더 공통 헤더(KV[] JSON) — 실행 시 요청 헤더에 병합(요청 쪽 같은 키가 활성으로 있으면 요청이 우선)
  /** 트리에서의 폴더 순서 — 요청과 같은 규칙(1024 간격) */
  sortOrder: integer('sort_order').notNull().default(0),
  sharedHeaders: text('shared_headers').notNull().default('[]'),
  // 폴더 공통 인증(AuthConfig JSON) — 요청 인증이 'inherit' 이면 이 값을 사용(요청이 직접 지정하면 요청 우선)
  sharedAuth: text('shared_auth').notNull().default('{"type":"none"}'),
  description: text('description').notNull().default(''),
}, t => [
  /**
   * 트리는 프로젝트의 폴더를 sort_order 순으로 읽는다 — 화면을 열 때마다 도는 쿼리다.
   * 인덱스가 없어 전체 스캔 + 임시 B-트리 정렬이었다(EXPLAIN 으로 확인).
   * 정렬 컬럼까지 넣어야 임시 B-트리가 사라진다 — where 만 받는 인덱스로는 정렬이 남는다.
   */
  index('folders_ws_order_idx').on(t.workspaceId, t.sortOrder, t.id),
])

export const requests = sqliteTable('requests', {
  aiExecutionAllowed: integer('ai_execution_allowed', { mode: 'boolean' }).notNull().default(false),
  id: text('id').primaryKey(),
  folderId: text('folder_id').notNull(),
  name: text('name').notNull(),
  method: text('method').notNull().default('GET'),
  url: text('url').notNull().default(''),
  params: text('params').notNull().default('[]'),
  headers: text('headers').notNull().default('[]'),
  bodyType: text('body_type', { enum: ['none', 'json', 'form', 'raw', 'graphql', 'multipart', 'binary'] }).notNull().default('none'),
  body: text('body').notNull().default(''),
  description: text('description').notNull().default(''),
  /**
   * 트리에서의 순서. 드래그로 바꾼 순서를 담는다.
   *
   * 예전엔 컬럼이 없어 삽입순(rowid)이 곧 순서였다 — 그래서 순서를 바꿀 방법이 아예 없었고,
   * 스펙 동기화로 수십 개가 한꺼번에 들어오면 자주 쓰는 것이 목록 한가운데 묻혔다.
   * 값 사이를 띄워 두면(1024 간격) 중간 삽입 때 이웃만 건드리면 되고 전체를 다시 쓸 일이 없다.
   */
  sortOrder: integer('sort_order').notNull().default(0),
  origin: text('origin', { enum: ['manual', 'spec', 'postman-import'] }).notNull().default('manual'),
  specState: text('spec_state', { enum: ['synced', 'new', 'changed', 'deprecated'] }),
  specOperationKey: text('spec_operation_key'),
  specFingerprint: text('spec_fingerprint'),
  specContract: text('spec_contract'),
  owner: text('owner').notNull().default(''),
  updatedAt: integer('updated_at').notNull(),
  // 마지막으로 템플릿을 수정한 사람(외부 API 메타데이터) — 낙관적 잠금 충돌 안내에 사용
  updatedBy: text('updated_by'),
  // 응답 assertion 규칙(Assertion[] JSON) — 실행 후 pass/fail 평가
  assertions: text('assertions').notNull().default('[]'),
  // pre/post 비주얼 스텝(스크립트 없음) — PreStep[]/PostStep[] JSON.
  // pre: 요청 전 변수 계산(timestamp/uuid/hmac 등), post: 응답에서 값 추출.
  preSteps: text('pre_steps').notNull().default('[]'),
  postSteps: text('post_steps').notNull().default('[]'),
  // 인증 설정(AuthConfig JSON) — none/bearer/basic/oauth2 client-credentials.
  // 실행 시 Authorization 헤더를 서버가 계산(oauth2 는 토큰 fetch+캐시).
  auth: text('auth').notNull().default('{"type":"none"}'),
  // 폴더와 직교하는 태그(string[] JSON) — smoke/deprecated/결제 등. 트리·팔레트 필터용.
  tags: text('tags').notNull().default('[]'),
  // 요청별 실행 설정(JSON) — { tlsVerify?, followRedirects?, timeoutMs? }. 미설정 필드는 기본값.
  settings: text('settings').notNull().default('{}'),
  // 요청별(=이 API 전용) 변수([{key,value}] JSON, 비-secret). 해석 우선순위: 전역<환경<요청<개인.
  // detailId·orderId 처럼 이 요청에만 쓰는 값을 환경 오염 없이 여기 둔다. 민감값은 환경 secret 변수로.
  vars: text('vars').notNull().default('[]'),
}, t => [
  /**
   * 이 앱에서 가장 자주 도는 쿼리. 트리를 한 번 그릴 때 폴더 수만큼 반복된다
   * (9개 폴더면 9번). 610행에서는 스캔도 빠르지만 컬렉션은 커지기만 하고,
   * 스펙 하나가 200개를 끌고 오는 도구라 금세 수천 행이 된다.
   * folder_id 로 좁히고 sort_order·id 로 정렬까지 인덱스가 받게 한다.
   */
  index('requests_folder_order_idx').on(t.folderId, t.sortOrder, t.id),
])

// API 체인 시나리오 — steps: [{requestId, extracts:[{path,variable}], bodySource?, bodyOverride?}] JSON.
// 실행 시 순서대로 호출하며 추출 변수를 다음 스텝의 {{변수}} 오버레이로 전달한다.
// sharedVars: 이 시나리오의 공유 입력([{key,value,secret}]) — 전 스텝이 {{key}} 로 참조(환경보다 우선).
export const flows = sqliteTable('flows', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().default('default'),
  name: text('name').notNull(),
  steps: text('steps').notNull().default('[]'),
  sharedVars: text('shared_vars').notNull().default('[]'),
  updatedAt: integer('updated_at').notNull(),
})

// 시나리오 실행 기록 — 한 번의 '시나리오 실행'을 한 행으로 남긴다.
// executions 는 요청 단위라, 새벽에 스케줄이 깨졌을 때 "어느 스텝에서 멈췄나"를
// 시각으로 짜맞춰야 했다. 이 표가 그 묶음을 보존한다.
export const flowRuns = sqliteTable('flow_runs', {
  id: text('id').primaryKey(),
  flowId: text('flow_id').notNull(),
  workspaceId: text('workspace_id').notNull().default('default'),
  environmentId: text('environment_id'),
  executedBy: text('executed_by').notNull(),
  startedAt: integer('started_at').notNull(),
  durationMs: integer('duration_ms').notNull().default(0),
  // 멈춘 스텝 인덱스. null 이면 전 스텝 성공.
  stoppedAt: integer('stopped_at'),
  // 스텝별 요약 JSON — [{ name, method, url, status, ms, error, executionId }]
  steps: text('steps').notNull().default('[]'),
}, t => [
  index('flow_runs_flow_idx').on(t.flowId, t.startedAt),
])

// 시나리오 스케줄 — 주기적으로 flow 를 실행하고 실패 시 슬랙 알림.
export const schedules = sqliteTable('schedules', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().default('default'),
  flowId: text('flow_id').notNull(),
  environmentId: text('environment_id'),
  intervalMinutes: integer('interval_minutes').notNull().default(60),
  slackWebhookUrl: text('slack_webhook_url'),
  notifyOn: text('notify_on', { enum: ['always', 'failure'] }).notNull().default('failure'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  lastRunAt: integer('last_run_at'),
  lastStatus: text('last_status'),
})

export const environments = sqliteTable('environments', {
  executionPolicy: text('execution_policy', { enum: ['open', 'confirm-writes', 'read-only'] }).notNull().default('open'),
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().default('default'),
  name: text('name').notNull(),
  /** 마지막 저장 시각 — 동시 편집에서 조용한 덮어쓰기를 막는 데 쓴다(요청·시나리오와 같은 방식). */
  updatedAt: integer('updated_at').notNull().default(0),
})

export const variables = sqliteTable('variables', {
  id: text('id').primaryKey(),
  environmentId: text('environment_id').notNull(),
  key: text('key').notNull(),
  value: text('value').notNull().default(''),
  secret: integer('secret', { mode: 'boolean' }).notNull().default(false),
})

export const executions = sqliteTable('executions', {
  executionSource: text('execution_source', { enum: ['ui', 'mcp', 'schedule', 'flow'] }).notNull().default('ui'),
  denialReason: text('denial_reason'),
  id: text('id').primaryKey(),
  requestId: text('request_id').notNull(),
  executedBy: text('executed_by').notNull(),
  executedAt: integer('executed_at').notNull(),
  environmentId: text('environment_id'),
  resolved: text('resolved').notNull(),
  responseStatus: integer('response_status'),
  responseHeaders: text('response_headers'),
  responseBody: text('response_body'),
  durationMs: integer('duration_ms'),
  error: text('error'),
  checkPassed: integer('check_passed', { mode: 'boolean' }),
  assertionResults: text('assertion_results').notNull().default('[]'),
  missingVariables: text('missing_variables').notNull().default('[]'),
  // 성공한 실행을 "예시 응답"으로 핀 — 요청 상세에서 대표 응답으로 노출
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
}, t => [
  // 요청별 이력 조회가 주 접근 경로 — 이력이 쌓여도 목록이 느려지지 않게
  index('executions_request_id_idx').on(t.requestId),
  // 이력·이어서 하기는 executed_at 범위로 스캔 — 인덱스 없으면 풀스캔
  index('executions_executed_at_idx').on(t.executedAt),
])

// 스펙 동기화 기록 — 폴더 sync 마다 발생한 NEW/CHANGED/DEPRECATED. 요청 화면의 '스펙에서 무엇이 바뀌었나' 가 읽는다.
export const specChanges = sqliteTable('spec_changes', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().default('default'),
  folderId: text('folder_id').notNull(),
  requestId: text('request_id'),
  operationKey: text('operation_key').notNull(),
  changeType: text('change_type', { enum: ['new', 'changed', 'deprecated'] }).notNull(),
  requestName: text('request_name').notNull(),
  /**
   * 무엇이 어떻게 바뀌었는지 — [{label, from, to}] 의 JSON.
   * changed 에만 담긴다. 옛 행은 null(그때는 안 남겼으니 지어낼 수 없다).
   */
  detail: text('detail'),
  createdAt: integer('created_at').notNull(),
}, t => [
  index('spec_changes_workspace_id_idx').on(t.workspaceId),
])

// 쿠키 jar — 서버 프록시 실행이라 세션 쿠키를 서버가 보관한다(로그인 필요 API 지원).
// (환경, 도메인, 이름) 단위로 저장하고, 실행 시 대상 도메인 매칭 쿠키를 Cookie 헤더로 주입.
export const cookies = sqliteTable('cookies', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().default('default'),
  environmentId: text('environment_id'),
  domain: text('domain').notNull(),
  name: text('name').notNull(),
  value: text('value').notNull(),
  path: text('path').notNull().default('/'),
  expires: integer('expires'),
  updatedAt: integer('updated_at').notNull(),
}, t => [
  index('cookies_scope_idx').on(t.workspaceId, t.environmentId),
])

/** 앱 차원의 키-값 표식/설정(연결 설정·일회성 이관 표식 등). */
export const appMeta = sqliteTable('app_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

// Saved request definitions. Restoring appends history; execution records stay intact.
export const requestVersions = sqliteTable('request_versions', {
  id: text('id').primaryKey(),
  requestId: text('request_id').notNull(),
  snapshot: text('snapshot').notNull(),
  createdAt: integer('created_at').notNull(),
  author: text('author'),
}, t => [index('request_versions_request_time_idx').on(t.requestId, t.createdAt)])
