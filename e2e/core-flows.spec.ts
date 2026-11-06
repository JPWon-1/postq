import { expect, test, type Page } from '@playwright/test'

// E2E 가 만든 데이터(e2e-* 워크스페이스·시나리오)는 DB 에 남는다. 지우지 않으면 매 실행마다 쌓여서
// 프로젝트 드롭다운이 찌꺼기로 덮인다(실제로 11개까지 쌓였다).
//
// 단, **이번 실행이 만든 것만** 지운다. 예전엔 이름이 'e2e-' 로 시작하면 전부 지웠다 — 주석은 '사람이
// 만든 데이터는 절대 건드리지 않는다' 고 했지만 코드엔 그런 보장이 없었다. 다른 실행이 남긴 것,
// 누가 우연히 e2e- 로 지은 프로젝트까지 지웠다. 이름은 소유권의 증거가 아니다.
// 그래서 시작할 때 있던 ID 를 적어 두고, 그 목록에 없던 것만 지운다.
const preexisting = { flows: new Set<string>(), workspaces: new Set<string>() }
test.beforeAll(async ({ request }) => {
  const flows = await (await request.get('/api/flows?workspaceId=default')).json() as { id: string }[]
  const ws = await (await request.get('/api/workspaces')).json() as { id: string }[]
  for (const f of flows) preexisting.flows.add(f.id)
  for (const w of ws) preexisting.workspaces.add(w.id)
})
test.afterAll(async ({ request }) => {
  const flows = await (await request.get('/api/flows?workspaceId=default')).json()
  for (const f of flows as { id: string; name: string }[]) {
    if (f.name.startsWith('e2e-') && !preexisting.flows.has(f.id)) await request.delete(`/api/flows/${f.id}`)
  }
  const ws = await (await request.get('/api/workspaces')).json()
  for (const w of ws as { id: string; name?: string }[]) {
    if ((w.name ?? '').startsWith('e2e-') && !preexisting.workspaces.has(w.id)) await request.delete(`/api/workspaces/${w.id}`)
  }
})

/**
 * 테스트용 헬퍼 서버(echo :9999 / 목 스펙 :9998)를 **앱이** 부를 때 쓰는 호스트 이름.
 *
 * 앱이 도커 안에 있으면 호스트의 서버는 host.docker.internal 로 보인다. 그런데 앱을
 * `next dev` 로 호스트에서 띄우면 그 이름은 아예 안 풀린다(ENOTFOUND) — 그러면 21개
 * 테스트가 한꺼번에 깨지는데, 화면상으로는 코드가 망가진 것처럼 보인다. 실제로 그렇게
 * 한 번 헤맸다. 어느 쪽에서 돌리는지는 테스트가 알 수 없으니 밖에서 받는다.
 *
 *   도커(기본) : npx playwright test
 *   호스트 dev : E2E_HOST_ALIAS=localhost npx playwright test
 *
 * 실행 테스트가 고르는 환경(ENV)은 scripts/e2e-safe.mjs 가 사본 DB 에 심는다 — baseUrl 이
 * echo 서버를 가리킨다. 예전엔 실데이터의 '도커' 환경을 빌려 썼는데, 그게 지워지자 10개가
 * 코드와 상관없이 깨졌다.
 */
const HOST = process.env.E2E_HOST_ALIAS ?? 'host.docker.internal'
const ENV = 'e2e-echo'

// 접힘 상태 초기화 — 각 테스트가 같은 시작점을 갖게 한다.
async function boot(page: Page) {
  await page.addInitScript(() => {
    localStorage.removeItem('ah:collapsed')
    localStorage.removeItem('ah:expandedGroups')
    localStorage.setItem('ah:workspace', 'default')
    // 테마는 미설정일 때만 다크로 고정 — 테스트 중 토글한 값을 리로드가 덮지 않게
    if (!localStorage.getItem('theme')) localStorage.setItem('theme', 'dark')
  })
  await page.goto('/')
  await expect(page.getByText('수동 테스트')).toBeVisible()
}


/**
 * 요청 실행 — 미해석 {{변수}} 가 있으면 앱이 [그대로 실행] 확인을 요구하므로
 * 사용자가 확인한 상황을 그대로 재현한다(가드를 끄는 게 아니라 통과시킨다).
 */
async function addScenarioRequest(page: Page, name: string) {
  await page.getByRole('button', { name: '추가할 요청', exact: true }).click()
  const picker = page.getByRole('dialog', { name: '시나리오 요청 선택' })
  await picker.getByRole('textbox', { name: '요청 검색' }).fill(name)
  await picker.getByRole('button').filter({ hasText: name }).first().click()
  await expect(picker).toHaveCount(0)
}

async function runRequest(page: Page) {
  await page.getByTestId('run-request').click()
  const confirmBtn = page.getByRole('button', { name: '그대로 실행' })
  if (await confirmBtn.isVisible().catch(() => false)) await confirmBtn.click()
}

/**
 * 레일 이동.
 *
 * 예전엔 보조 항목(스케줄·실시간 등)이 [더보기] 뒤에 접혀 있어
 * 여기서 한 번 펼쳤다. 지금은 레일이 항목을 전부 드러낸다 — 펼칠 것이 없다.
 * 그런데 펼치기 버튼을 계속 찾고 있어서, 항목이 안 보이면 없는 버튼을 기다리다
 * 30초 타임아웃으로 죽었다. 무엇이 없는지 말하고 죽는 게 낫다.
 */
async function goRail(page: Page, mode: string) {
  const item = page.getByTestId(`rail-${mode}`)
  await expect(item, `레일에 rail-${mode} 항목이 보여야 한다`).toBeVisible()
  await item.click()
}

/** 설정 메뉴 안의 항목(쿠키·AI 연결) 열기 */
/**
 * 설정을 열고 원하는 칸으로 간다. 예전엔 헤더 톱니 → 메뉴였고, 환경/변수는 헤더 버튼이었다 —
 * 전부 여기로 모였다.
 */
async function openSetting(page: Page, tab?: 'env' | 'cookies' | 'ai' | 'display' | 'diagnostics') {
  await page.getByTestId('rail-settings').click()
  await expect(page.getByRole('dialog', { name: '설정' })).toBeVisible()
  if (tab) await page.getByTestId(`settings-${tab}`).click()
}

test('홈 로드 — 3패널 + 폴더 트리 + 콘솔 에러 없음', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(String(e)))
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  await boot(page)
  await expect(page.getByText('Sample API')).toBeVisible()
  // 헤더는 이제 '어디서 일하는지' 만 말한다 — 설정하는 것들은 레일의 [설정] 으로 갔다
  await expect(page.getByTestId('rail-settings')).toBeVisible()
  expect(errors).toEqual([])
})

test('요청 열기 → 탭 + 변수 스트립 + 이력 패널', async ({ page }) => {
  await boot(page)
  await page.getByRole('button', { name: /펫 등록/ }).first().click()
  await expect(page.getByRole('tab', { name: /펫 등록/ })).toBeVisible()
  // 변수 스트립이 뜬다 (어떤 변수가 뜨는지는 전역변수 등록 상태에 따라 달라지므로 단정하지 않는다)
  await expect(page.getByText('환경/변수 관리 →')).toBeVisible()
  // 환경 선택 → 값 미리보기 칩으로 전환
  await page.getByLabel('실행 환경').selectOption({ label: ENV })
  // 값 미리보기는 28자에서 잘리므로 부분 매치로 확인
  await expect(page.getByText(new RegExp(HOST.replace(/\./g, '\\.'))).first()).toBeVisible()
})

test('실행 → 200 응답 + 이력 갱신 + 복원', async ({ page }) => {
  await boot(page)
  await page.getByRole('button', { name: /펫 등록/ }).first().click()
  await page.getByLabel('실행 환경').selectOption({ label: ENV })
  const executionPayload = page.waitForRequest(r => r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/execute'))
  await runRequest(page)
  expect((await executionPayload).postDataJSON()).not.toHaveProperty('executedBy')
  await expect(page.getByTitle('OK — 성공')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('pre').last()).toContainText('"success"')
  // 이력은 기본 접힘(요청 편집 폭 확보). 헤더의 패널 아이콘 하나로 켠다 —
  // 열려 있든 닫혀 있든 자리가 같아서 되살릴 것을 따로 만들 필요가 없다.
  const historyBtn = page.getByTestId('toggle-history')
  if (await historyBtn.getAttribute('aria-pressed') !== 'true') await historyBtn.click()
  await expect(historyBtn).toHaveAttribute('aria-pressed', 'true')
  // 이력 최신 항목 펼치고 복원
  await page.getByLabel(/^실행 이력,/).first().click()
  // 폴더 공통 헤더(X-Team)가 실제 송신 헤더로 이력에 남는다
  await expect(page.getByText('X-Team').first()).toBeVisible()
  // [이 값으로 복원] 버튼은 없어졌고(workspace-ux 가 부재를 단언한다), 그때 값으로 되돌리는
  // 길은 실행 permalink(?exec=<id>) 하나만 남았다. 남은 그 길을 확인한다.
  const list = await page.request.get('/api/executions?workspaceId=default&limit=1').then(r => r.json())
  const execId = list[0]?.execution?.id
  expect(execId, '방금 실행한 이력이 있어야 한다').toBeTruthy()
  await page.goto(`/?exec=${execId}`)
  await expect(page.getByLabel('요청 URL')).toHaveValue(new RegExp(`${HOST.replace(/\./g, '\\.')}:${process.env.E2E_ECHO_PORT ?? '9999'}`))
})

test('⌘K 팔레트 — 검색·Enter 로 열기', async ({ page }) => {
  await boot(page)
  await page.keyboard.press('ControlOrMeta+KeyK')
  const box = page.getByLabel('요청 검색').last()
  await expect(box).toBeVisible()
  await box.fill('일괄 등록')
  // 팔레트 안의 결과를 기다린다 — 트리에도 같은 이름이 보이므로 페이지 전체에서 찾으면 팔레트가 목록을
  // 받기 전에 통과해 버리고, 그때 누른 Enter 는 빈 목록이라 아무것도 열지 않는다.
  await expect(page.getByRole('dialog', { name: '커맨드 팔레트' }).getByText('펫 일괄 등록')).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('tab', { name: /펫 일괄 등록/ })).toBeVisible()
})

/**
 * 폴더를 펼쳐 요청 행이 실제로 그려지게 한다.
 *
 * 그냥 폴더 이름을 누르면 안 된다 — 이미 펼쳐져 있으면 접어 버려 행이 사라진다.
 * 그리고 이름에 ' / ' 가 있는 요청은 접힌 서브그룹 안이라 폴더만 펼쳐선 안 보인다.
 * 그래서 '보이면 그만둔다' 로 확인하고, 호출자는 그룹 없는 요청을 골라야 한다.
 */
async function revealRow(page: Page, folderName: string, requestName: string) {
  // 같은 이름이 둘일 수 있다 — first() 로 하나를 고정한다(트리에서 집는 것도 첫 행이다)
  const row = page.locator(`main [role="button"][draggable="true"][title="${requestName}"]`).first()
  if (await row.count() === 0) {
    const box = (await page.locator(`span[title="${folderName}"]`).first().boundingBox())!
    await page.mouse.click(Math.round(box.x + 20), Math.round(box.y + box.height / 2))
  }
  await expect(row).toBeVisible({ timeout: 10_000 })
  return row
}

/** 서브그룹(' / ')에 안 들어가는 요청 — 폴더만 펼치면 바로 보인다. */
const ungrouped = <T extends { name: string }>(rs: T[]) => rs.filter(r => !r.name.includes(' / '))

/**
 * 패널 토글은 자리가 안 움직여야 한다.
 *
 * 헤더 왼쪽 끝은 레일(NAVIGATION) 바로 위라, 무엇을 놓든 '메뉴 접기' 로 읽힌다.
 * 목록 토글을 거기 뒀다가 두 번 되돌렸다 — 그 자리는 레일의 것이다.
 *
 * 목록을 숨기는 버튼은 목록 헤더에 두고, 되살리기는 버튼을 하나 더 만드는 대신
 * 레일의 같은 항목을 다시 누르는 것으로 한다(VSCode 활동 바와 같다).
 */
test('패널 토글 — 목록 접기는 목록 위, 왼쪽 상단은 레일 것', async ({ page }) => {
  await boot(page)
  await page.getByRole('button', { name: /펫 등록/ }).first().click()

  const tree = page.getByLabel('요청 검색').first()
  await expect(tree).toBeVisible()

  // 헤더 왼쪽 끝에는 목록 토글이 없다. 거기 있는 건 레일 접기뿐이다.
  const rail = page.getByTestId('toggle-rail')
  const hide = page.getByTestId('hide-list')
  await expect(rail).toBeVisible()
  await expect(hide).toBeVisible()
  const railX = (await rail.boundingBox())!.x
  const hideX = (await hide.boundingBox())!.x
  expect(hideX, '목록 접기는 레일보다 오른쪽 — 목록 컬럼 안에 있다').toBeGreaterThan(railX + 28)

  // 숨기면 잔재 없이 사라진다.
  // 언마운트가 아니라 숨김으로 바뀌었다(접었다 펼 때 스크롤·검색어가 살아남는다) —
  // 확인할 건 DOM 에서 지워졌느냐가 아니라 화면에 안 보이느냐다.
  await hide.click()
  await expect(tree).toBeHidden()
  await expect(page.getByTestId('hide-list')).toBeHidden()

  // 되살리기: 레일의 같은 항목을 다시 누른다 (새 버튼을 만들지 않는다)
  await page.getByTestId('rail-collection').click()
  await expect(tree).toBeVisible()

  // 레일 접기는 살아 있고 레일 맨 위에 있다
  await rail.click()
  await expect(rail).toHaveAttribute('aria-pressed', 'false')
  await rail.click()
  await expect(rail).toHaveAttribute('aria-pressed', 'true')

  // 이력 토글은 오른쪽 끝 — 그쪽은 이력 패널 바로 위라 자리가 곧 대상이다
  const history = page.getByTestId('toggle-history')
  const historyAt = (await history.boundingBox())!.x
  if (await history.getAttribute('aria-pressed') !== 'true') await history.click()
  await history.click()
  await expect(history).toHaveAttribute('aria-pressed', 'false')
  expect(Math.round((await history.boundingBox())!.x), '이력 토글은 안 움직인다').toBe(Math.round(historyAt))

  // 단축키도 그대로
  await page.keyboard.press('ControlOrMeta+KeyB')
  await expect(history).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('ControlOrMeta+KeyE')
  await expect(tree).toBeHidden()
  await page.keyboard.press('ControlOrMeta+KeyE')
  await expect(tree).toBeVisible()
})

/**
 * 실행 비교는 응답 바디만 봤다.
 *
 * "저번엔 됐는데 왜 지금은 안 되지" 의 답이 헤더 하나·환경 하나·URL 의 쿼리 한 글자인
 * 경우가 많은데, 그건 화면에 아예 안 나왔다. 요청·응답·메타·검증을 전부 비교한다.
 */
/**
 * 시나리오는 돌려 봐야만 연결이 맞는지 알 수 있었다.
 *
 * 3단계가 {{token}} 을 기다리는데 1단계가 그 값을 'accc' 라는 이름으로 뽑고 있으면,
 * 실행해서 3단계가 터진 뒤 로그를 뒤져야 안다. 값 없이도 판정할 수 있는 것이다.
 */
/**
 * 스텝이 하나 이상인 시나리오를 사이드바 목록에서 고른다.
 *
 * 예전엔 드롭다운이라 option 텍스트('N스텝')로 골랐다. 지금은 늘 보이는 목록이고
 * 항목 오른쪽에 'N단계' 가 붙는다(FlowScenario.tsx:467). 목록이 도착하기 전에 세면
 * 0개라 '시나리오가 없다' 로 읽히므로 채워질 때까지 기다린다.
 */
async function pickScenarioWithSteps(page: Page) {
  const list = page.getByRole('region', { name: '시나리오 목록' })
  await expect(list).toBeVisible({ timeout: 10_000 })
  const items = list.getByRole('button', { name: / 열기$/ })
  await expect
    .poll(async () => (await items.allTextContents()).filter(t => /[1-9]\d*단계/.test(t)).length,
      { message: '스텝이 있는 시나리오가 하나는 있어야 한다', timeout: 10_000 })
    .toBeGreaterThan(0)
  const texts = await items.allTextContents()
  const idx = texts.findIndex(t => /[1-9]\d*단계/.test(t))
  await items.nth(idx).click()
}

test('시나리오 — 실행 전에 값 흐름과 끊긴 연결을 보여준다', async ({ page }) => {
  await boot(page)
  await page.getByTestId('rail-scenario').click()

  await pickScenarioWithSteps(page)

  // 평소엔 한 줄만 차지한다 — 인라인으로 펼치면 플로우차트와 편집기를 밀어낸다
  const bar = page.getByTestId('flow-preview-toggle')
  await expect(bar).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('받는 값', { exact: false })).toHaveCount(0)

  await bar.click()
  const dialog = page.getByRole('dialog', { name: '값 흐름 미리보기' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('받는 값', { exact: false }).first()).toBeVisible()
  await expect(dialog.getByText('넘기는 값', { exact: false }).first()).toBeVisible()
  // 출처가 붙는다 — 환경에서 온 것인지, 앞 단계가 뽑은 것인지
  await expect(dialog.getByText('환경·공통값').first()).toBeVisible()

  await dialog.getByRole('button', { name: '닫기' }).click()
  await expect(dialog).toBeHidden()
})

test('실행 비교 — 응답만이 아니라 요청·헤더·환경까지 비교한다', async ({ page }) => {
  await boot(page)
  await page.getByRole('button', { name: /펫 등록/ }).first().click()

  // 비교하려면 실행이 둘 이상이어야 한다 — 이 테스트가 직접 만든다
  // (앞 테스트가 남긴 이력에 기대면 실행 순서에 따라 통과가 흔들린다)
  await page.getByLabel('실행 환경').selectOption({ label: ENV })
  await runRequest(page)
  await expect(page.getByTitle('OK — 성공')).toBeVisible({ timeout: 10_000 })
  await runRequest(page)
  await expect(page.getByTitle('OK — 성공')).toBeVisible({ timeout: 10_000 })

  const historyBtn = page.getByTestId('toggle-history')
  if (await historyBtn.getAttribute('aria-pressed') !== 'true') await historyBtn.click()
  await expect(historyBtn).toHaveAttribute('aria-pressed', 'true')
  // 이력 항목은 aria-label 이 '실행 이력, ...' 이다 (다른 테스트와 같은 방식)
  const items = page.getByLabel(/^실행 이력,/)
  // count() 로 한 번만 세면 깜빡인다 — 두 번째 실행의 '성공' 배지는 첫 결과가 아직
  // 떠 있는 동안에도 보이므로, 이력이 갱신되기 전에 세는 경우가 있다. 될 때까지 기다린다.
  await expect.poll(() => items.count(), {
    timeout: 15_000,
    message: '비교하려면 실행이 둘 이상 필요하다',
  }).toBeGreaterThan(1)

  // 첫 항목을 기준(A)으로, 다른 항목과 비교(B)
  await items.nth(0).click()
  await page.getByRole('button', { name: '비교', exact: true }).first().click()
  await items.nth(1).click()
  await page.getByRole('button', { name: '이것과 비교' }).first().click()

  const dialog = page.getByRole('dialog', { name: '실행 비교' })
  await expect(dialog).toBeVisible()

  // 응답만이 아니라 여러 갈래를 비교한다 — [전부 보기] 로 같은 것까지 편다.
  await dialog.getByTestId('diff-show-same').click()
  for (const title of ['실행', '요청', '응답']) {
    await expect(dialog.getByRole('button', { name: new RegExp(`^${title}`) })).toBeVisible()
  }
  // 검증 섹션은 규칙이 있을 때만 나온다(빈 제목만 늘어놓지 않는다).
  // 이 요청에 규칙이 저장돼 있는지는 DB 마다 다르므로 '없다' 로 못 박지 않는다 —
  // 확인할 건 '뜬다면 내용이 있다' 는 쪽이다.
  const assertSection = dialog.getByRole('button', { name: /^검증/ })
  if (await assertSection.count() > 0) {
    await expect(assertSection.first()).toBeVisible()
    await expect(dialog.getByText('검증 규칙이 없습니다'), '빈 검증 섹션을 제목만 그리면 안 된다').toHaveCount(0)
  }
  // 예전엔 없던 것들 — 환경과 요청 URL 이 비교 대상에 들어온다
  await expect(dialog.getByText('환경', { exact: true })).toBeVisible()
  await expect(dialog.getByText('URL', { exact: true })).toBeVisible()

  // 기본은 다른 것만 — 같은 값 수십 줄에서 눈으로 찾게 두지 않는다
  await dialog.getByTestId('diff-show-same').click()
  await expect(dialog.getByTestId('diff-show-same')).toHaveAttribute('aria-pressed', 'false')

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('폴더 — 모두 접기 / 모두 펼치기', async ({ page }) => {
  await boot(page)
  const btn = page.getByTestId('collapse-all')
  const rows = page.locator('main [role="button"][draggable="true"]')

  // 펼쳐진 상태로 맞춘다
  if (await btn.getAttribute('aria-expanded') === 'false') await btn.click()
  await expect(rows.first()).toBeVisible({ timeout: 10_000 })

  await btn.click()
  // 전부 접히면 요청 행이 하나도 안 남는다(즐겨찾기 구역은 폴더 밖이라 별개)
  await expect(btn).toHaveAttribute('aria-expanded', 'false')
  await expect(rows).toHaveCount(0)
  await expect(btn).toHaveAccessibleName('폴더 모두 펼치기')

  await btn.click()
  await expect(btn).toHaveAttribute('aria-expanded', 'true')
  await expect(rows.first()).toBeVisible()
})

test('응답 창 — 접으면 상태만 남고, 실행하면 스스로 펴진다', async ({ page }) => {
  await boot(page)
  await page.getByRole('button', { name: /펫 등록/ }).first().click()
  const toggle = page.getByTestId('response-toggle')
  await expect(toggle).toBeVisible()

  // 실행해서 결과를 만든 뒤 접는다
  await page.getByLabel('실행 환경').selectOption({ label: ENV })
  await runRequest(page)
  await expect(page.getByTitle('OK — 성공')).toBeVisible({ timeout: 10_000 })

  // 응답 패널 = 접기 버튼이 달린 구분선의 다음 형제. 높이를 직접 잰다
  // (getByText(...).locator('..') 은 '..' 이 CSS 로 해석돼 안 된다)
  const paneHeight = () => page.evaluate(() => {
    const divider = document.querySelector('[data-testid="response-toggle"]')!.closest('[role="separator"]')!
    return Math.round(divider.nextElementSibling!.getBoundingClientRect().height)
  })
  const openH = await paneHeight()
  expect(openH, '펼친 응답 패널은 넉넉히 보인다').toBeGreaterThan(100)

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  // 접어도 '어떻게 끝났는지' 는 남아야 한다 — 상태까지 감추면 아무도 안 접는다
  await expect(page.getByTitle('OK — 성공')).toBeVisible()
  await expect(page.getByTestId('response-panel').getByRole('button', { name: '응답 펼치기', exact: true })).toBeVisible()
  expect(await paneHeight(), '접히면 한 줄').toBeLessThan(40)

  // 접힌 채 실행하면 결과가 안 보여 [실행]이 먹지 않는 것처럼 보인다 — 스스로 펴진다
  await runRequest(page)
  await expect(toggle).toHaveAttribute('aria-expanded', 'true', { timeout: 10_000 })

  await toggle.click()
  await page.reload()
  // 새로고침하면 URL 의 ?req= 로 보던 요청이 다시 열린다 — 누를 필요가 없다.
  // 예전엔 여기서 /펫 등록/ 을 다시 눌렀는데, 그 이름은 복원된 탭의 '펫 등록 탭 닫기' 에도 걸린다.
  // 트리보다 탭이 먼저 그려지면 닫기 버튼을 눌러 요청을 닫았고, 응답 패널이 없어 가끔만 깨졌다.
  await expect(page).toHaveURL(/[?&]req=/)
  // 접어 두는 사람은 계속 접어 두고 쓴다
  await expect(page.getByTestId('response-toggle')).toHaveAttribute('aria-expanded', 'false')

  // 다음 테스트를 위해 펴 둔다 — 접힌 상태가 브라우저에 남아 다른 테스트의 응답을 가린다
  await page.getByTestId('response-toggle').click()
  await expect(page.getByTestId('response-toggle')).toHaveAttribute('aria-expanded', 'true')
})

test('트리 드래그 — 요청을 다른 폴더로 옮긴다', async ({ page }) => {
  await boot(page)

  const folders = async () => (await (await page.request.get('/api/folders?workspaceId=default')).json()) as { id: string; name: string }[]
  const reqsIn = async (id: string) => (await (await page.request.get(`/api/requests?folderId=${id}`)).json()) as { id: string; name: string }[]

  // 특정 이름을 찍지 않는다. 예전엔 '펫 등록' 을 찾았는데 그 이름이 한 폴더에 둘이라
  // 트리에서 어느 행을 집었는지 알 수 없었고, 되돌리기가 엉뚱한 요청에 걸렸다.
  // 워크스페이스 전체에서 이름이 하나뿐이고 서브그룹에 안 들어간 요청을 고른다.
  const fs = await folders()
  const all = (await Promise.all(fs.map(async f => (await reqsIn(f.id)).map(r => ({ ...r, folder: f })))))
    .flat().filter(r => !r.name.includes(' / '))
  const counts = new Map<string, number>()
  for (const r of all) counts.set(r.name, (counts.get(r.name) ?? 0) + 1)
  const picked = all.find(r => counts.get(r.name) === 1)
  expect(picked, '이름이 워크스페이스에서 유일한 요청이 있어야 한다').toBeTruthy()
  const from = picked!.folder
  const moving: { id: string; name: string } = picked!
  const to = fs.find(f => f.id !== from.id)!
  const before = (await reqsIn(to.id)).length

  await revealRow(page, from.name, moving.name)

  // dragTo 는 요소 중앙에 떨어뜨리는데 그 자리를 액션 아이콘이 덮는다.
  // 좌표 싸움 대신 DnD 이벤트를 직접 쏘아 핸들러를 검사한다(브라우저가 하는 일과 같다).
  // title 을 정확히 맞춘다. includes 로 찾던 시절엔 '트리거 펫 등록'(이미 목적지 폴더에
  // 있던 다른 요청)을 집어, 옮겨도 개수가 안 늘어 통과·실패가 데이터에 따라 흔들렸다.
  await page.evaluate(([toName, movingName]) => {
    const row = [...document.querySelectorAll('main [role="button"][draggable="true"]')]
      .find(e => e.getAttribute('title') === movingName)!
    const target = [...document.querySelectorAll('main span')]
      .find(x => x.getAttribute('title') === toName)!.closest('.group')!
    const dt = new DataTransfer()
    row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }))
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }))
  }, [to.name, moving.name])

  await expect.poll(() => reqsIn(to.id).then(r => r.length), { timeout: 10_000 }).toBe(before + 1)

  // 원래 폴더로 되돌린다 — 테스트가 데이터를 바꿔놓고 끝나면 안 된다
  await page.request.put(`/api/requests/${moving.id}`, { data: { folderId: from.id } })
  await expect.poll(() => reqsIn(from.id).then(rs => rs.some(r => r.id === moving.id))).toBe(true)
})

/**
 * 렌더 중 예외가 나면 그 패널이 통째로 사라진다 — 그런데 화면에는 '결과 없음' 처럼 보인다.
 *
 * 실제로 그렇게 놓쳤다. 폴더 목록 계산을 선언 순서상 위로 옮겼더니 TDZ 로 매 렌더 예외가
 * 났는데, 타입 검사는 참조가 화살표 함수 안이라 즉시 실행됨을 증명하지 못해 통과시켰고
 * 화면은 그냥 트리 일부가 안 뜨는 것으로만 보였다. 콘솔을 직접 본다.
 */
test('트리 조작 중 렌더 예외가 없다', async ({ page }) => {
  const errors: string[] = []
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', e => errors.push(String(e)))

  await boot(page)
  const search = page.getByLabel('요청 검색').first()
  await search.fill('mock')
  await page.waitForTimeout(600)
  await search.fill('')
  await page.locator('main div[draggable="true"]').first().hover()
  await page.waitForTimeout(300)

  const render = errors.filter(e => /uncaught render error|before initialization|Minified React error/.test(e))
  expect(render, `렌더 예외:\n${render.join('\n')}`).toEqual([])
})

test('트리 드래그 — 폴더 안에서 요청 순서를 바꾼다', async ({ page }) => {
  await boot(page)
  const reqsIn = async (id: string) => (await (await page.request.get(`/api/requests?folderId=${id}`)).json()) as { id: string; name: string; sortOrder: number }[]
  const folders = (await (await page.request.get('/api/folders?workspaceId=default')).json()) as { id: string; name: string }[]

  // 이름이 겹치지 않는 폴더를 고른다 — 트리에서 요청을 title 로 찾기 때문에
  // 같은 이름이 둘이면 둘 다 같은 행을 가리켜 드래그가 자기 자신에게 떨어진다.
  let folder = null as { id: string; name: string } | null
  let rows: { id: string; name: string; sortOrder: number }[] = []
  for (const f of folders) {
    const rs = ungrouped(await reqsIn(f.id))
    if (rs.length >= 2 && new Set(rs.map(r => r.name)).size === rs.length) { folder = f; rows = rs; break }
  }
  expect(folder, '그룹 없이 이름이 겹치지 않는 요청 2개 이상인 폴더가 있어야 한다').toBeTruthy()
  const [first, second] = rows

  await revealRow(page, folder!.name, first.name)

  // 2번째를 1번째 '위쪽 절반' 에 떨어뜨린다 → 1번째 앞으로.
  // clientY 를 주는 게 핵심이다 — 이 좌표 하나로 앞/뒤가 갈린다.
  await page.evaluate(([aName, bName]) => {
    const find = (n: string) => [...document.querySelectorAll('main [role="button"][draggable="true"]')]
      .find(e => e.getAttribute('title') === n)!
    const target = find(aName), src = find(bName)
    const r = target.getBoundingClientRect()
    const dt = new DataTransfer()
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientY: r.top + 2 }))
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientY: r.top + 2 }))
  }, [first.name, second.name])

  // DOM 이 아니라 서버가 돌려주는 순서로 확인한다 — 화면만 바뀌고 저장이 안 된 적이 있다.
  // 순서 비교를 poll **안에서**, 한 번 받은 목록으로 한다. 예전엔 poll 이 '이미 있던 id 가 목록에
  // 있다' 만 확인해서 곧장 통과했고, 그 다음 재시도 없는 비교가 저장(비동기 POST)보다 먼저 옛 순서를
  // 읽으면 깨졌다. 또 indexOf 를 두 번 부르며 목록을 두 번 받아 서로 다른 시점을 비교할 수 있었다.
  const order = async () => ungrouped(await reqsIn(folder!.id)).map(r => r.id)
  await expect.poll(async () => { const o = await order(); return o.indexOf(second.id) < o.indexOf(first.id) },
    { timeout: 10_000, message: '2번째였던 것이 1번째 앞으로 와야 한다' }).toBe(true)

  // 되돌린다
  await page.request.post('/api/requests/reorder', { data: { id: first.id, folderId: folder!.id, beforeId: second.id } })
  await expect.poll(async () => (await order()).indexOf(first.id) < (await order()).indexOf(second.id)).toBe(true)
})

test('트리 드래그 — 폴더 순서를 바꾼다', async ({ page }) => {
  await boot(page)
  const list = async () => (await (await page.request.get('/api/folders?workspaceId=default')).json()) as { id: string; name: string }[]
  const before = await list()
  expect(before.length, '폴더가 2개 이상이어야 한다').toBeGreaterThan(1)
  const [a, b] = before

  await expect(page.locator(`span[title="${a.name}"]`).first()).toBeVisible({ timeout: 10_000 })
  await page.evaluate(([aName, bName]) => {
    const find = (n: string) => [...document.querySelectorAll('main div[draggable="true"]')]
      .filter(e => e.getAttribute('role') !== 'button')
      .find(e => e.querySelector(`span[title="${n}"]`))!
    const target = find(aName), src = find(bName)
    const r = target.getBoundingClientRect()
    const dt = new DataTransfer()
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientY: r.top + 2 }))
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientY: r.top + 2 }))
  }, [a.name, b.name])

  await expect.poll(() => list().then(fs => fs[0].id), { timeout: 10_000 }).toBe(b.id)
  await page.request.post('/api/folders/reorder', { data: { id: b.id, beforeId: before[2]?.id ?? null } })
  await expect.poll(() => list().then(fs => fs[0].id)).toBe(a.id)
})

test('폴더 ⋯ 메뉴 — 아이콘 6개를 글자 5줄로 옮겼다', async ({ page }) => {
  await boot(page)
  const menuBtn = page.locator('main [aria-haspopup="menu"]').first()
  // hover 로만 드러나므로 폴더 행에 마우스를 올린다.
  // 목록 위 요약 바가 뒤늦게 뜨면 줄이 한 칸 밀린다 — 자리가 잡힌 뒤에 누른다.
  const row = page.locator('main div[draggable="true"]').first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(300)
  await row.hover()
  await menuBtn.click()
  const menu = page.getByRole('menu')
  for (const label of ['이름 변경', '공통 헤더', '공통 인증', '일괄 실행', '폴더 삭제']) {
    await expect(menu.getByRole('menuitem', { name: new RegExp(label) })).toBeVisible()
  }
  // 삭제는 한 번에 실행되지 않는다 — 확인을 받는다
  await menu.getByRole('menuitem', { name: /폴더 삭제/ }).click()
  await expect(menu.getByText('정말 삭제할까요? (되돌릴 수 없음)')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
})

test('폴더 ⋯ 메뉴 — 행에서 마우스가 벗어나도 메뉴가 남는다', async ({ page }) => {
  await boot(page)
  const row = page.locator('main div[draggable="true"]').first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(300)
  await row.hover()
  await page.locator('main [aria-haspopup="menu"]').first().click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()

  // 메뉴는 hover 로 드러나는 액션바(opacity-0 → group-hover:opacity-100) 안에 그려진다.
  // ⋯ 버튼 아래 mt-1(3.5px) 띠에서는 폴더 행도 메뉴도 아닌 아래쪽 요청 행이 잡혀서,
  // 그 틈을 지나는 순간 액션바째 투명해져 메뉴가 사라진 것처럼 보였다. Chrome 은
  // focus-within 이 대신 버텨 줬지만 버튼 클릭에 포커스를 주지 않는 웹뷰에선 그대로 사라졌다.
  // 그래서 hover 와 focus 를 둘 다 없앤 상태로 본다 — 열린 메뉴는 둘과 무관하게 보여야 한다.
  // toBeVisible 로는 못 잡는다. opacity:0 도 Playwright 는 '보인다'로 친다.
  await page.mouse.move(5, 5)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const m = document.querySelector('[role="menu"]')
          const bar = m?.closest('span')
          if (!bar) return null
          const row = bar.closest('.group')
          return {
            opacity: getComputedStyle(bar).opacity,
            hover: !!row?.matches(':hover'),
            focusWithin: !!row?.matches(':focus-within'),
          }
        }),
      { timeout: 3_000 }
    )
    .toEqual({ opacity: '1', hover: false, focusWithin: false })
})

test('편집 모드 → 템플릿 저장 (⌘S) → dirty 점 소멸', async ({ page, request }) => {
  // 저장은 진짜 PUT 이라 남의 요청으로 하면 안 된다. 예전엔 기존 '펫 등록' 의 URL 을 바꾸고
  // 되돌리지 않았다(주석은 '설명 칸' 을 쓴다고 했지만 실제론 URL 이었다) — 돌릴 때마다 팀 공용
  // 템플릿에 흔적이 남는다. 이 테스트가 만든 임시 프로젝트의 요청으로 하고, 끝나면 통째로 지운다.
  const ws = await (await request.post('/api/workspaces', { data: { name: '__템플릿저장' } })).json() as { id: string }
  try {
    const f = await (await request.post('/api/folders', { data: { workspaceId: ws.id, name: '저장폴더' } })).json() as { id: string }
    await request.post('/api/requests', { data: { folderId: f.id, name: '저장할요청', method: 'GET', url: 'https://example.test/a' } })
    await page.addInitScript(id => { localStorage.setItem('ah:workspace', id) }, ws.id)
    await page.goto('/')
    await page.getByRole('button', { name: '저장할요청' }).first().click()

    // 바꾼 게 없으면 저장할 것도 없다 — 확인 모달이 '변경 0개' 로 막는다(ReviewTemplateSave.tsx).
    const url = page.getByRole('textbox', { name: '요청 URL', exact: true })
    await url.fill('https://example.test/b')

    const savedPayload = page.waitForRequest(r => r.method() === 'PUT' && /\/api\/requests\/[^/]+$/.test(new URL(r.url()).pathname))
    await page.keyboard.press('ControlOrMeta+KeyS')
    expect((await savedPayload).postDataJSON()).not.toHaveProperty('updatedBy')
    // ⌘S 는 즉시 저장하며 비교 대화상자는 열지 않는다.
    await expect(page.getByRole('dialog', { name: '저장된 요청 변경 확인' })).toHaveCount(0)
    await expect(page.getByText('요청이 저장되었습니다')).toBeVisible()
    await expect(page.getByText('요청이 저장되었습니다')).toBeVisible()
    await expect(page.getByText('저장하지 않은 변경')).toBeHidden()
  } finally {
    await request.delete(`/api/workspaces/${ws.id}`)
  }
})

test('실행 실패 — 에러 원인을 사람 말로 설명한다', async ({ page }) => {
  await boot(page)
  await page.getByRole('button', { name: /펫 등록/ }).first().click()
  await page.getByLabel('요청 URL').fill('http://127.0.0.1:59987/nope')
  await runRequest(page)
  await expect(page.getByText('대상 서버가 연결을 거부했습니다')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('포트 번호가 맞는지 확인하세요')).toBeVisible()
})

// 테마는 한 번 정하면 끝이라 헤더에서 설정 메뉴 안으로 옮겼다 — 열어야 보인다.
test('테마 3-way — 라이트/시스템/다크 선택 + 리로드 유지', async ({ page }) => {
  await boot(page)
  // 테마는 설정 목록 맨 아래 구석에 있다가 '사라졌다' 는 말을 들었다 — 표시 칸으로 옮겼다
  await openSetting(page, 'display')
  await page.getByRole('radio', { name: '라이트 테마' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await openSetting(page, 'display')
  await page.getByRole('radio', { name: '다크 테마' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  // 시스템 선택 시 aria-checked 반영
  await page.getByRole('radio', { name: '시스템 테마' }).click()
  await expect(page.getByRole('radio', { name: '시스템 테마' })).toHaveAttribute('aria-checked', 'true')
})

test('Import/Export 버튼 + 환경 관리 모달', async ({ page }) => {
  await boot(page)
  // 자주 쓰는 동작이 아니라 [⋯] 로 접었다 — 목록 머리에 이름표가 셋이면 사이드바 기본 폭에서
  // 단어가 잘려 줄바꿈된다. 접혀 있어도 한 번에 닿을 수 있어야 한다.
  await page.getByTestId('list-overflow').click()
  await expect(page.getByRole('button', { name: /^파일 가져오기/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /전체 프로젝트 JSON 내보내기/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await openSetting(page, 'env')
  await expect(page.getByLabel('환경 선택')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: '설정' })).toBeHidden()
})

test('환경·변수 — 전역(모든 프로젝트)과 프로젝트 공통을 따로 고르고 저장한다', async ({ page, request }) => {
  await boot(page)
  await openSetting(page, 'env')
  const pick = page.getByLabel('환경 선택')
  await pick.selectOption({ label: '🌐 전역 (모든 프로젝트)' })
  await expect(page.getByText(/모든 프로젝트.*의 모든 환경이 상속/)).toBeVisible()
  const key = `e2eAll${Date.now()}`
  await page.getByRole('button', { name: '+ 변수' }).click()
  await page.getByLabel('변수 키').last().fill(key)
  await page.getByLabel('변수 값').last().fill('everywhere')
  await page.getByRole('dialog', { name: '설정' }).getByRole('button', { name: '저장', exact: true }).click()
  await expect(page.getByText('전역 변수 저장됨 — 모든 프로젝트의 모든 환경에 상속')).toBeVisible()
  const all = await (await request.get('/api/global-vars?workspaceId=*')).json() as { key: string; value: string }[]
  expect(all.find(v => v.key === key)?.value).toBe('everywhere')
  // 프로젝트 공통으로 바꾸면 그 값은 없다 — 다른 단계다
  await pick.selectOption({ label: '📁 프로젝트 공통 (이 프로젝트의 모든 환경)' })
  await expect(page.getByText(/이 프로젝트의 모든 환경이 상속/)).toBeVisible()
  await page.waitForLoadState('networkidle')
  expect(await page.getByLabel('변수 키').evaluateAll(els => els.map(e => (e as HTMLInputElement).value))).not.toContain(key)
})

test('시나리오 모드 — 생성 → 2스텝 체인 실행 → 전부 성공', async ({ page }) => {
  await boot(page)
  await page.getByTestId('rail-scenario').click()
  const name = `e2e-체인-${Date.now()}`
  await page.getByRole('button', { name: '새 시나리오 만들기' }).click()
  await page.getByLabel('새 시나리오 이름').fill(name)
  await page.getByRole('button', { name: '만들기', exact: true }).click()
  await addScenarioRequest(page, '펫 등록')
  await addScenarioRequest(page, '펫 등록')
  await page.getByRole('combobox', { name: '실행 환경', exact: true }).selectOption({ label: ENV })
  await page.getByRole('button', { name: '▶ 시나리오 실행' }).click()
  await expect(page.getByText(/시나리오 완료 — 2스텝 전부 성공/)).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/✓\s*200/).first()).toBeVisible()
})

test('단축키 도움말은 버튼으로 열고 Alt로는 열지 않는다', async ({ page }) => {
  await boot(page)
  const hint = page.getByText('요청 퀵오픈 (전체 검색)')
  await page.keyboard.down('Alt')
  await page.waitForTimeout(250)
  await expect(hint).toBeHidden()
  await page.keyboard.up('Alt')
  await page.getByRole('button', { name: '단축키 보기', exact: true }).click()
  await expect(hint).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(hint).toBeHidden()
})

test('워크스페이스 — 새 프로젝트는 빈 상태, 기본 복귀 시 데이터 유지', async ({ page }) => {
  await boot(page)
  // 새 프로젝트는 [▦ 목록] 안에서만 만든다. 잘못 눌렀으면 [취소]·Esc 로 빠져나온다(목록 창은 그대로).
  await page.getByRole('button', { name: '프로젝트 목록', exact: true }).click()
  const manager = page.getByRole('dialog', { name: '프로젝트 목록' })
  await manager.getByRole('button', { name: '새 프로젝트' }).click()
  await manager.getByRole('button', { name: '취소' }).click()
  await expect(page.getByLabel('새 프로젝트 이름')).toHaveCount(0)
  await manager.getByRole('button', { name: '새 프로젝트' }).click()
  await page.getByLabel('새 프로젝트 이름').press('Escape')
  await expect(page.getByLabel('새 프로젝트 이름')).toHaveCount(0)
  await expect(manager).toBeVisible()
  await manager.getByRole('button', { name: '새 프로젝트' }).click()
  const name = `e2e-팀-${Date.now()}`
  await page.getByLabel('새 프로젝트 이름').fill(name)
  await manager.getByRole('button', { name: '만들기', exact: true }).click()
  // 새 프로젝트: 빈 컬렉션 (온보딩 CTA)
  await expect(page.getByText('아직 비어 있습니다')).toBeVisible()
  await expect(page.getByRole('button', { name: '+ 새 요청', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '파일 가져오기', exact: true }).first()).toBeVisible()
  // 기본으로 복귀: 기존 데이터 그대로.
  // 라벨('기본')이 아니라 값('default')으로 고른다 — 기본 프로젝트의 이름은 배포마다 다르다
  // (어떤 DB 에선 '기본' 이 아니다). 이름에 매달리면 DB 가 바뀔 때마다 테스트가 깨진다.
  await page.getByLabel('프로젝트', { exact: true }).selectOption('default')
  await expect(page.getByText('수동 테스트')).toBeVisible()
})

test('시나리오 단계 실행 — 1단계 확인 후 [다음], 완료까지', async ({ page }) => {
  await boot(page)
  await page.getByTestId('rail-scenario').click()
  const name = `e2e-단계-${Date.now()}`
  await page.getByRole('button', { name: '새 시나리오 만들기' }).click()
  await page.getByLabel('새 시나리오 이름').fill(name)
  await page.getByRole('button', { name: '만들기', exact: true }).click()
  await addScenarioRequest(page, '펫 등록')
  await addScenarioRequest(page, '펫 등록')
  await page.getByRole('combobox', { name: '실행 환경', exact: true }).selectOption({ label: ENV })
  await page.getByLabel('실행 모드').selectOption({ label: '단계 실행 (확인 후 진행)' })
  // 1단계 실행 → 응답 자동 펼침 + 다음 버튼 대기
  await page.getByRole('button', { name: '▶ 1단계 실행' }).click()
  await expect(page.getByText(/1단계 완료 — 응답 확인 후/)).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('button', { name: /✓\s*200/ }).first()).toBeVisible({ timeout: 10_000 })
  // 사용자가 확인했다 치고 [다음] → 완료
  await page.getByRole('button', { name: /다음 \(2\/2\)/ }).click()
  await expect(page.getByText(/시나리오 완료 — 모든 스텝 성공/)).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('button', { name: '처음부터' })).toBeVisible()
})

test('API 이력 모드 — 필터 폼 + 목록', async ({ page }) => {
  await boot(page)
  await page.getByTestId('rail-history').click()
  await expect(page.getByLabel('상태', { exact: true })).toBeVisible()
  await expect(page.getByLabel('실행자')).toHaveCount(0)
  await expect(page.getByLabel('상태', { exact: true })).toBeVisible()
})

test('설정 — 여덟 칸이 전부 열리고 내용이 나온다', async ({ page }) => {
  await boot(page)
  await page.getByTestId('rail-settings').click()
  const dialog = page.getByRole('dialog', { name: '설정' })
  await expect(dialog).toBeVisible()

  // 처음 열면 환경/변수
  await expect(dialog.getByLabel('환경 선택')).toBeVisible()

  // 스케줄·공용 스펙 칸은 없다 — 스케줄은 레일 화면이 됐고 공용 스펙은 지웠다
  await expect(page.getByTestId('settings-schedule')).toHaveCount(0)
  await expect(page.getByTestId('settings-specs')).toHaveCount(0)

  await page.getByTestId('settings-cookies').click()
  await expect(dialog.getByLabel('쿠키 환경 스코프')).toBeVisible()

  await page.getByTestId('settings-ai').click()
  await expect(dialog.getByText(/MCP/).first()).toBeVisible()

  await page.getByTestId('settings-display').click()
  await expect(dialog.getByRole('button', { name: '레이아웃 초기화' })).toBeVisible()

  await page.getByTestId('settings-shortcuts').click()
  await expect(dialog.getByText('현재 요청 실행', { exact: true })).toBeVisible()
  await page.getByTestId('settings-data').click()
  await expect(dialog.getByRole('button', { name: /^파일 가져오기/ })).toBeVisible()
  await page.getByTestId('settings-about').click()
  await expect(dialog.getByText('MIT', { exact: true })).toBeVisible()

  // 안쪽 화면들이 각자 닫기·Esc 를 들고 있어 두 겹이 닫히던 것을 막았다 — 한 번에 하나만.
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('스펙 검증 버튼 — 실행 후 노출', async ({ page }) => {
  await boot(page)
  await page.getByRole('button', { name: /펫 등록/ }).first().click()
  await page.getByLabel('실행 환경').selectOption({ label: ENV })
  await runRequest(page)
  await expect(page.getByTitle('OK — 성공')).toBeVisible({ timeout: 10_000 })
  // 응답 도구는 [•••] 메뉴 없이 늘 보인다 — 헤더 하나 보려고 메뉴를 여는 게 불편했다.
  await expect(page.getByRole('button', { name: '코드 스니펫 복사 (fetch/axios/python)' })).toBeVisible()
  // [응답 구조 검사]는 응답이 오면 늘 보이고, '실제 HTTP 상태·Content-Type 에 맞는 스키마가 있을
  // 때만' 켜진다(응답 화면 정리 때 결정). 못 누르면 이유를 말해야 한다.
  // 이유는 버튼의 title 에 있다(예전엔 메뉴 안 작은 글씨였다).
  const validate = page.getByRole('button', { name: '응답 구조 검사' })
  await expect(validate).toBeVisible()
  await expect(validate, '버튼 안내가 비었다').toHaveAttribute('aria-description', /.+/)
  await expect(validate).not.toHaveAttribute('aria-description', '응답 정의 확인 중…', { timeout: 10_000 })
  if (await validate.isDisabled()) {
    // 스키마가 없어 못 누른다면, 안내는 '무엇을 검사하는지' 가 아니라 '왜 못 누르는지' 여야 한다
    await expect(validate, '못 누르는데 이유 대신 기능 설명이 나온다').not.toHaveAttribute('aria-description', /대조/)
  } else {
    await expect(validate).toHaveAttribute('aria-description', /대조/)
  }
})

test('WebSocket 모드 — 패널 렌더', async ({ page }) => {
  await boot(page)
  await goRail(page, 'ws')
  await expect(page.getByLabel('WebSocket 주소')).toBeVisible()
  await expect(page.getByRole('button', { name: '연결', exact: true })).toBeVisible()
})

// 여기까지는 '패널이 뜬다' 만 봤다 — 실제로 붙어서 주고받는지는 확인된 적이 없었다.
// ws-echo 서버(npm run e2e:ws-echo)가 붙으면 hello, 받으면 'echo: <값>' 을 돌려준다.
test('WebSocket — 실제 연결 → 수신 → 전송 → 에코 수신', async ({ page }) => {
  await boot(page)
  await goRail(page, 'ws')
  await page.getByLabel('WebSocket 주소').fill(`ws://127.0.0.1:${process.env.E2E_WS_PORT ?? '9997'}`)
  await page.getByRole('button', { name: '연결', exact: true }).click()

  await expect(page.getByText('연결됨', { exact: true }).first()).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('hello', { exact: true })).toBeVisible({ timeout: 10_000 })

  await page.getByLabel('보낼 메시지').fill('e2e-메시지')
  await page.getByRole('button', { name: '전송', exact: true }).click()
  await expect(page.getByText('echo: e2e-메시지')).toBeVisible({ timeout: 10_000 })
})

// SSE 도 '패널이 뜬다' 만 봤었다. echo 서버의 /sse 가 tick 3건을 흘려보내면
// 프록시(/api/sse)를 거쳐 화면에 그대로 찍혀야 한다.
test('SSE — 실제 스트림을 프록시로 받아 화면에 찍는다', async ({ page }) => {
  await boot(page)
  await goRail(page, 'ws')
  await page.getByRole('button', { name: 'SSE / 스트리밍' }).click()
  await page.getByLabel('스트림 URL').fill(`http://${HOST}:${process.env.E2E_ECHO_PORT ?? '9999'}/sse`)
  await page.getByRole('button', { name: '연결', exact: true }).click()
  await expect(page.getByText('data: tick-1')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('data: tick-3')).toBeVisible({ timeout: 10_000 })
})

test('SSE — 줄이 쏟아져도 최근 것만 남고, 버렸다고 말한다', async ({ page }) => {
  await boot(page)
  await goRail(page, 'ws')
  await page.getByRole('button', { name: 'SSE / 스트리밍' }).click()
  // 상한(2000)보다 많이 보낸다. 예전엔 전부 쌓아서 오래 켜 두면 화면이 굳었다.
  await page.getByLabel('스트림 URL').fill(`http://${HOST}:${process.env.E2E_ECHO_PORT ?? '9999'}/sse-flood?n=2100`)
  await page.getByRole('button', { name: '연결', exact: true }).click()

  // 마지막 줄은 남아 있어야 한다 — 버리는 쪽은 오래된 쪽이다.
  await expect(page.getByText('data: flood-2100')).toBeVisible({ timeout: 20_000 })
  // 맨 앞줄은 밀려났다.
  await expect(page.getByText('data: flood-1', { exact: true })).toHaveCount(0)
  // 조용히 사라지면 '처음부터 다 보고 있다'고 잘못 읽는다.
  await expect(page.getByText(/앞의 100줄은 버렸습니다/)).toBeVisible()
})

test('실시간 — 탭을 오가도 받아 둔 스트림이 남아 있다', async ({ page }) => {
  await boot(page)
  await goRail(page, 'ws')
  await page.getByRole('button', { name: 'SSE / 스트리밍' }).click()
  await page.getByLabel('스트림 URL').fill(`http://${HOST}:${process.env.E2E_ECHO_PORT ?? '9999'}/sse`)
  await page.getByRole('button', { name: '연결', exact: true }).click()
  await expect(page.getByText('data: tick-3')).toBeVisible({ timeout: 10_000 })

  // 예전엔 탭에 따라 하나만 그려서, WS 를 잠깐 보고 오면 받아 둔 게 전부 사라졌다.
  await page.getByRole('button', { name: 'WebSocket' }).click()
  await expect(page.getByLabel('WebSocket 주소')).toBeVisible()
  await page.getByRole('button', { name: 'SSE / 스트리밍' }).click()
  await expect(page.getByText('data: tick-3')).toBeVisible()

  // 열린 탭을 읽어 주는 도구도 알 수 있어야 한다
  await expect(page.getByRole('button', { name: 'SSE / 스트리밍' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: 'WebSocket' })).toHaveAttribute('aria-pressed', 'false')
})

test('WebSocket — 잘못된 스킴은 붙기 전에 막는다', async ({ page }) => {
  await boot(page)
  await goRail(page, 'ws')
  await page.getByLabel('WebSocket 주소').fill(`http://127.0.0.1:${process.env.E2E_WS_PORT ?? '9997'}`)
  await page.getByRole('button', { name: '연결', exact: true }).click()
  // 생성자가 http 를 ws 로 조용히 바꾸므로, 앞단에서 걸러 고칠 주소를 제안해야 한다.
  await expect(page.getByText(`ws://127.0.0.1:${process.env.E2E_WS_PORT ?? '9997'} 를 의도했나요`, { exact: false })).toBeVisible()
  await expect(page.getByText(`연결 시도: http://127.0.0.1:${process.env.E2E_WS_PORT ?? '9997'}`)).toHaveCount(0)
})

test('일괄 삭제 — 일부가 실패하면 그 수를 말한다', async ({ page }) => {
  await boot(page)
  // 예전엔 결과를 세지 않고 '${n}개 삭제됨' 을 띄웠다 — 3개가 실패해도 다 된 것처럼 보였다.
  //
  // DELETE 는 하나도 서버로 보내지 않는다. 성공하는 쪽도 목으로 200 을 준다.
  // 처음엔 첫 건만 route.fallback() 으로 통과시켰는데, 그게 실제 DB 의 요청을
  // 정말 지웠다(실행 이력까지 함께). 테스트가 검증하려는 건 '실패 수를 세어 말하는가'
  // 이지 '서버가 지우는가' 가 아니다. 지우는 쪽을 태울 이유가 없었다.
  let seen = 0
  await page.route('**/api/requests/*', async route => {
    if (route.request().method() !== 'DELETE') return route.fallback()
    seen++
    await route.fulfill({
      status: seen === 1 ? 200 : 500,
      contentType: 'application/json',
      body: seen === 1 ? '{"ok":true}' : '{"error":"삭제 실패"}',
    })
  })
  page.on('dialog', d => d.accept())

  // 선택 모드 토글은 [필터] 안으로 들어갔다 — 가끔 쓰는 것이라 접어 뒀다
  await page.getByTestId('filter-toggle').click()
  await page.getByRole('button', { name: '여러 요청 선택', exact: true }).click()
  const boxes = page.locator('input[type="checkbox"][aria-label$="선택"]')
  await expect(boxes.first()).toBeVisible({ timeout: 10_000 })
  // 실행/실패가 섞이도록 2개만 고른다
  await boxes.nth(0).click()
  await boxes.nth(1).click()
  await expect(page.getByText('2개 선택')).toBeVisible()

  await page.getByRole('button', { name: '삭제', exact: true }).click()
  // 1개 성공 · 1개 실패 — 둘 다 말해야 한다
  await expect(page.getByText(/1개 삭제됨 · 1개 실패/)).toBeVisible({ timeout: 10_000 })
})

test('쿠키 — 못 불러오면 그렇게 말한다(빈 목록으로 위장하지 않는다)', async ({ page }) => {
  await boot(page)
  // 예전엔 res.ok 도 catch 도 없어서, 500 이면 오류 객체가 rows 에 들어가 렌더에서 터졌다.
  await page.route('**/api/cookies?*', r => r.fulfill({
    status: 500, contentType: 'application/json', body: JSON.stringify({ error: '쿠키 저장소 오류' }),
  }))
  await openSetting(page, 'cookies')

  // 화면이 살아 있어야 하고(터지지 않는다),
  await expect(page.getByLabel('쿠키 도메인', { exact: true })).toBeVisible()
  // 이유를 말해야 하며,
  // Next 의 라우트 안내용 role=alert 가 항상 하나 있어서 범위를 좁힌다.
  await expect(page.getByRole('alert').filter({ hasText: '쿠키를 불러오지 못했습니다' }))
    .toContainText('쿠키 저장소 오류')
  // '쿠키가 없다' 로 위장하면 안 된다 — 남은 세션 쿠키를 없는 줄 알고 헤매게 된다.
  await expect(page.getByText('저장된 쿠키가 없습니다', { exact: false })).toHaveCount(0)
})

test('쿠키 관리 모달 + 붙여넣기 폼 + GraphQL 바디 타입', async ({ page }) => {
  await boot(page)
  await openSetting(page, 'cookies')
  await expect(page.getByLabel('쿠키 도메인', { exact: true })).toBeVisible()
  await expect(page.getByLabel('쿠키 문자열')).toBeVisible()
  await page.keyboard.press('Escape')
  // GraphQL 바디 타입
  await page.getByRole('button', { name: /펫 등록/ }).first().click()
  await page.getByRole('button', { name: /^Body/ }).click()
  await page.getByLabel('바디 타입').selectOption('graphql')
  await expect(page.getByLabel('GraphQL 쿼리')).toBeVisible()
  // Variables 패널은 접혀 있는 게 기본 — 펼쳐야 편집기가 나온다
  await page.getByRole('button', { name: 'GraphQL 변수 표시' }).click()
  await expect(page.getByLabel('GraphQL 변수', { exact: true })).toBeVisible()
})

test('개인 환경 오버라이드 — 환경 모달에 개인 값 컬럼', async ({ page }) => {
  await boot(page)
  await openSetting(page, 'env')
  // 스테이지 환경 선택 후 개인 값 컬럼 확인
  await page.getByLabel('환경 선택').selectOption({ label: '스테이지' }).catch(() => {})
  await expect(page.getByText('내 값 (개인)')).toBeVisible()
})

test('응답 검증(Tests) 탭 — 규칙 추가 + 실행 후 통과 배지', async ({ page }) => {
  await boot(page)
  await page.getByRole('button', { name: /펫 등록/ }).first().click()
  await page.getByLabel('요청 도구').click()
  await page.getByRole('button', { name: /^응답 확인 조건/ }).click()
  await page.getByRole('button', { name: '+ 검증 규칙' }).click()
  await expect(page.getByLabel('검증 대상').first()).toBeVisible()
  // 실행 → 테스트 배지 (status=200 규칙 기본값, e2e-echo 환경)
  await page.getByLabel('실행 환경').selectOption({ label: ENV })
  await runRequest(page)
  await expect(page.getByText(/테스트 \d+\/\d+/)).toBeVisible({ timeout: 10_000 })
})

test('Multipart 바디 타입 — 필드/파일 편집기', async ({ page }) => {
  await boot(page)
  await page.getByRole('button', { name: /펫 등록/ }).first().click()
  await page.getByRole('button', { name: /^Body/ }).click()
  await page.getByLabel('바디 타입').selectOption('multipart')
  await expect(page.getByRole('button', { name: '+ 텍스트 필드' })).toBeVisible()
  await expect(page.getByRole('button', { name: '+ 파일 첨부' })).toBeVisible()
})

test('AI 연결 허브 — MCP 온보딩 모달', async ({ page }) => {
  await boot(page)
  await openSetting(page, 'ai')
  const dialog = page.getByRole('dialog', { name: '설정' })
  // 연결 명령에 MCP 엔드포인트 경로가 노출되는지
  await expect(dialog.getByText(/^claude mcp add .*\/api\/mcp\/mcp/)).toBeVisible()
  // 레포가 없는 Claude Desktop 사용자도 따라 할 수 있는 설정이 같이 있어야 한다
  await expect(dialog.getByText(/"mcp-remote", ".*\/api\/mcp\/mcp"/)).toBeVisible()
  await expect(dialog.getByText('execute_request')).toBeVisible()
  // ESC 로 닫힘
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('AI 연결 허브 — MCP_TOKEN 을 정한 서버면 토큰 자리만 넣고 값은 받지 않는다', async ({ page }) => {
  // 안내 경로(/api/mcp-info)는 토큰 검사 밖이라 토큰 값을 내려주면 누구나 읽어 간다 — 자리표시자만 보여야 한다.
  await page.route('**/api/mcp-info', r => r.fulfill({ json: { tokenRequired: true } }))
  await boot(page)
  await openSetting(page, 'ai')
  const dialog = page.getByRole('dialog', { name: '설정' })
  await expect(dialog.getByText(/^claude mcp add .*\/api\/mcp\/mcp --header "Authorization: Bearer <MCP_TOKEN 값>"$/)).toBeVisible()
  await expect(dialog.getByText(/"--header", "Authorization: Bearer <MCP_TOKEN 값>"/)).toBeVisible()
})

test('프로젝트 목록 — 못 불러와도 앱이 죽지 않는다', async ({ page }) => {
  // 오류 처리가 아예 없어서, 500 이면 오류 객체가 목록에 들어가 list.some 에서 터졌다.
  // 헤더 맨 위, 항상 떠 있는 컴포넌트라 앱 전체가 같이 죽는 자리였다.
  const errors: string[] = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.route('**/api/workspaces', r => r.fulfill({
    status: 500, contentType: 'application/json', body: '{"error":"DB 오류"}',
  }))
  // boot 이 컬렉션 트리가 뜨는 것까지 확인한다 — 프로젝트 목록 하나 때문에 화면을 잃지 않는다
  await boot(page)
  expect(errors, `렌더 중 예외: ${errors.join(' / ')}`).toEqual([])
})

test('사이드바 크기 조절 — 끌면 바뀌고, 새로고침해도 남는다', async ({ page }) => {
  await boot(page)
  const handle = page.getByRole('separator', { name: '사이드바 크기 조절' })
  await expect(handle).toBeVisible()

  const box = await handle.boundingBox()
  const before = Number(await page.evaluate(() => localStorage.getItem('ah:sidebarWidth') ?? '256'))

  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await page.mouse.down()
  await page.mouse.move(box!.x + 80, box!.y + box!.height / 2, { steps: 8 })
  await page.mouse.up()

  const after = Number(await page.evaluate(() => localStorage.getItem('ah:sidebarWidth')))
  expect(after, '끌었는데 폭이 그대로다').toBeGreaterThan(before)

  // 새로고침해도 유지 — 매번 다시 맞추게 하면 조절할 이유가 없다
  await page.reload()
  await expect(page.getByText('수동 테스트')).toBeVisible({ timeout: 10_000 })
  expect(Number(await page.evaluate(() => localStorage.getItem('ah:sidebarWidth')))).toBe(after)
})

test('창 밖에서 손을 떼 mouseup 을 놓쳐도 드래그가 풀린다', async ({ page }) => {
  await boot(page)
  const handle = page.getByRole('separator', { name: '사이드바 크기 조절' })
  const box = (await handle.boundingBox())!

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 40, box.y, { steps: 4 })

  // 브라우저 탭바처럼 페이지 밖에서 손을 떼면 mouseup 이 창에 오지 않는다.
  // mouse.up() 은 실제로 전달되므로 그 상황이 아니다 — 버튼이 이미 떼어진(buttons: 0)
  // mousemove 만 오는 것을 직접 만들어 재현한다. 예전엔 여기서 안 풀려서, 손을 뗐는데도
  // 패널이 커서를 계속 따라다니고 아무 데나 클릭해야 멈췄다.
  const move = (x: number, buttons: number) => page.evaluate(([cx, b]) => {
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: cx, clientY: 300, buttons: b, bubbles: true }))
  }, [x, buttons] as const)

  // 실제로 그려진 폭으로 본다. localStorage 는 드래그 중에 안 쓰이므로(놓을 때만 쓴다)
  // 그걸로 비교하면 고치기 전에도 통과하는 헛 테스트가 된다.
  const paneWidth = () => page.getByTestId('sidebar-pane').evaluate(el => (el as HTMLElement).offsetWidth)

  await move(box.x + 60, 0)                    // 여기서 끝나야 한다
  const parked = await paneWidth()

  await move(box.x + 400, 0)                   // 버튼 없이 더 움직여도
  await move(box.x + 600, 0)
  expect(await paneWidth(), '손을 뗀 뒤에도 드래그가 계속되고 있다').toBe(parked)

  await page.mouse.up()                        // 뒷정리
})

test('모달 안에서 Tab 은 밖으로 새지 않는다', async ({ page }) => {
  await boot(page)
  await openSetting(page, 'cookies')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()

  // 20번을 눌러도 포커스가 모달 안에 머물러야 한다. 새면 뒤의 요청 패널을 건드리게 된다.
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Tab')
    const inside = await dialog.evaluate(d => d.contains(document.activeElement))
    expect(inside, `Tab ${i + 1}번째에 포커스가 모달 밖으로 나갔다`).toBe(true)
  }
  // Shift+Tab 도 마찬가지
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Shift+Tab')
    expect(await dialog.evaluate(d => d.contains(document.activeElement))).toBe(true)
  }
})

test('토글 상태 — 색만이 아니라 aria-pressed 로도 드러난다', async ({ page }) => {
  await boot(page)
  await page.getByRole('button', { name: /펫 등록/ }).first().click()

  // 요청 패널 탭 — 이 앱에서 제일 많이 누르는 자리인데 밑줄 색으로만 알리고 있었다.
  const params = page.getByRole('button', { name: /^Params/ })
  const headers = page.getByRole('button', { name: /^Headers/ })
  await expect(params).toHaveAttribute('aria-pressed', 'true')
  await expect(headers).toHaveAttribute('aria-pressed', 'false')
  await headers.click()
  await expect(headers).toHaveAttribute('aria-pressed', 'true')
  await expect(params).toHaveAttribute('aria-pressed', 'false')

  // Bulk 전환도 켜짐/꺼짐이 테두리 색이 전부였다
  // 라벨이 모드에 따라 바뀌므로(텍스트로 편집 ↔ 표로 편집) 이름 대신 훅으로 집는다
  const bulk = page.getByTestId('bulk-toggle')
  await expect(bulk).toHaveAttribute('aria-pressed', 'false')
  await bulk.click()
  await expect(bulk).toHaveAttribute('aria-pressed', 'true')
})

test('GraphQL 스키마 조회 — 개인 변수도 실행과 똑같이 해석한다', async ({ page }) => {
  // 개인 값은 팀에 안 올리는 내 토큰을 두라고 만든 자리다. 그런데 introspect 만 그걸 안 써서,
  // 같은 요청이 실행은 되고 [스키마 불러오기] 만 '미해석 변수' 로 실패했다.
  const body = { url: `http://${HOST}:${process.env.E2E_ECHO_PORT ?? '9999'}/{{myTok}}`, workspaceId: 'default' }

  const without = await page.request.post('/api/graphql/introspect', { data: body })
  expect(without.status(), '개인 변수를 안 주면 미해석이어야 대조가 된다').toBe(400)
  expect((await without.json()).error).toContain('미해석 변수: myTok')

  const withPersonal = await page.request.post('/api/graphql/introspect', {
    data: { ...body, personalVars: { myTok: 'gql' } },
  })
  // 변수가 풀려 실제로 나갔다는 뜻 — echo 서버는 GraphQL 이 아니므로 스키마가 없다(422).
  expect(withPersonal.status(), '개인 변수를 줬는데 여전히 안 풀린다').not.toBe(400)
  expect((await withPersonal.json()).error ?? '').not.toContain('미해석 변수')
})

/**
 * 여덟 개 모드를 전부 들러 콘솔이 조용한지 본다.
 *
 * 개별 화면 테스트는 '무엇이 보이는가' 를 보는데, 렌더 중에 난 예외는 그 화면이
 * 조금 덜 그려진 것처럼만 보인다(TDZ 로 한 구역이 통째로 안 뜬 적이 있다).
 * 화면마다 따로 보지 말고 한 번에 훑는다.
 */
test('여덟 모드 전부 — 콘솔이 조용하다', async ({ page }) => {
  const noise = [
    /favicon/i,                       // 아이콘 404 는 기능과 무관
    /Download the React DevTools/i,
  ]
  const errors: string[] = []
  page.on('pageerror', e => errors.push(`[pageerror] ${e}`))
  page.on('console', m => {
    if (m.type() !== 'error') return
    const t = m.text()
    if (noise.some(r => r.test(t))) return
    errors.push(t)
  })

  await boot(page)
  for (const mode of ['collection', 'scenario', 'history', 'schedule', 'ws'] as const) {
    await goRail(page, mode)
    if (mode === 'scenario') await pickScenarioWithSteps(page)
    if (mode === 'schedule') await page.getByRole('button', { name: '새 스케줄', exact: true }).click()
    await expect(page.locator('main')).toBeVisible()
    expect(errors, `${mode} 모드에서 콘솔 오류:\n${errors.join('\n')}`).toEqual([])
  }

  // 요청을 하나 열고 탭을 전부 눌러 본다 — 탭 내용은 눌러야 그려진다
  await goRail(page, 'collection')
  await page.getByRole('button', { name: /펫 등록/ }).first().click()
  // 탭 이름 뒤에 개수 배지가 붙는 것들이 있어(Headers 1) 접두 일치로 찾는다.
  // '설정' 은 레일에도 같은 글자가 있어서 탭 줄 안으로 범위를 좁힌다.
  // 탭 줄은 Headers·Params·Body·Auth·Cookies. [검사·자동화] 는 탭 줄에서 빠져 [⋯] 메뉴로 갔다.
  const tabs = page.getByRole('button', { name: 'Params' }).locator('xpath=..')
  for (const tab of ['Params', 'Headers', 'Auth', 'Body', 'Cookies']) {
    await tabs.getByRole('button', { name: new RegExp(`^${tab}`) }).click()
    expect(errors, `${tab} 탭에서 콘솔 오류:\n${errors.join('\n')}`).toEqual([])
  }
  await expect(tabs.getByRole('button', { name: /^검사·자동화/ })).toHaveCount(0)
  await page.getByLabel('요청 도구').click()
  await page.getByRole('button', { name: /^응답 확인 조건/ }).click()
  for (const sub of ['응답 확인 조건', '값 자동 입력']) {
    await page.getByRole('button', { name: sub }).click()
    expect(errors, `${sub} 에서 콘솔 오류:\n${errors.join('\n')}`).toEqual([])
  }
})

test('Cookies 탭 — 이 요청의 호스트로 좁혀 보여주고, 붙여넣은 쿠키가 바로 보인다', async ({ page }) => {
  await boot(page)
  await page.getByRole('button', { name: /펫 등록/ }).first().click()
  await page.getByLabel('실행 환경').selectOption({ label: ENV })
  await page.getByRole('button', { name: /^Cookies/ }).click()
  await expect(page.getByText('세션 동기화 — 브라우저 확장으로 가져오기')).toBeVisible()
  const name = `e2eck${Date.now()}`
  await page.getByLabel('쿠키 문자열').fill(`${name}=v1`)
  await page.getByRole('button', { name: / 에 넣기$/ }).click()
  await expect(page.getByRole('cell', { name, exact: true })).toBeVisible()
  await page.getByRole('button', { name: `${name} 쿠키 삭제` }).click()
  await expect(page.getByRole('cell', { name, exact: true })).toHaveCount(0)
})

test('지워진 요청·시나리오에 저장하면 성공이라 하지 않는다', async ({ request }) => {
  // 없는 행에 UPDATE 를 걸면 0행을 고치고 조용히 성공했다. 삭제된 요청의 탭이 열린 채로
  // ⌘S 를 누르면 '저장됨' 이 뜨고 작업은 사라진다 — 잃었다는 사실조차 모른다.
  const ws = await (await request.post('/api/workspaces', { data: { name: '__삭제후저장' } })).json() as { id: string }
  try {
    const f = await (await request.post('/api/folders', { data: { workspaceId: ws.id, name: 'F' } })).json() as { id: string }
    const r = await (await request.post('/api/requests', { data: { folderId: f.id, name: '곧 지울 요청' } })).json() as { id: string }

    // 살아 있을 때는 저장된다(대조군 — 404 가 그냥 라우트 고장이 아님을 보인다)
    expect((await request.put(`/api/requests/${r.id}`, { data: { name: '수정됨' } })).status()).toBe(200)

    await request.delete(`/api/requests/${r.id}`)
    const after = await request.put(`/api/requests/${r.id}`, { data: { name: '지워진 뒤 저장' } })
    expect(after.status(), '없는 요청에 저장이 성공했다').toBe(404)
    expect((await after.json()).error).toContain('다른 사람이 지웠을')

    // 시나리오도 같은 구멍이 있었다
    const fl = await (await request.post('/api/flows', { data: { workspaceId: ws.id, name: '곧 지울 시나리오' } })).json() as { id: string }
    expect((await request.put(`/api/flows/${fl.id}`, { data: { name: '수정됨' } })).status()).toBe(200)
    await request.delete(`/api/flows/${fl.id}`)
    const flAfter = await request.put(`/api/flows/${fl.id}`, { data: { name: '지워진 뒤 저장' } })
    expect(flAfter.status(), '없는 시나리오에 저장이 성공했다').toBe(404)
  } finally {
    await request.delete(`/api/workspaces/${ws.id}`)
  }
})

test('메서드로 좁히면 빈 폴더는 접히고, 0건이면 이유를 말한다', async ({ page }) => {
  await boot(page)
  const rows = page.locator('main [role="button"][draggable="true"]')
  const folderRows = page.locator('main div[draggable="true"]')
  await expect(rows.first()).toBeVisible({ timeout: 10_000 })
  const foldersBefore = await folderRows.count()

  // 필터는 접혀 있다 — 자주 쓰는 건 검색이고 나머지는 가끔이다
  await page.getByTestId('filter-toggle').click()
  // DELETE 만 남긴다 — 이 프로젝트에는 DELETE 요청이 거의 없다
  await page.getByLabel('메서드 필터').selectOption('DELETE')

  // 예전엔 검색어일 때만 폴더를 접어서, 결과가 없는 폴더의 머리만 줄줄이 남았다
  await expect.poll(() => folderRows.count(), { timeout: 10_000 }).toBeLessThan(foldersBefore)

  // 아무것도 안 맞는 조건이면 텅 빈 트리가 아니라 이유가 떠야 한다
  await page.getByLabel('요청 검색').fill('존재하지않는요청이름zzz')
  const empty = page.getByText(/에 맞는 요청이 없습니다/)
  await expect(empty).toBeVisible({ timeout: 10_000 })
  await expect(empty).toContainText('DELETE')          // 무엇 때문인지 적혀 있다
  await expect(empty).toContainText('존재하지않는요청이름zzz')

  // 조건을 한 번에 지울 수 있어야 한다 — 어디를 되돌려야 하는지 찾게 만들지 않는다
  await page.getByRole('button', { name: '조건 지우기' }).click()
  await expect(rows.first()).toBeVisible()
  expect(await folderRows.count()).toBe(foldersBefore)
  // 조건이 걸려 있는 동안엔 접혀 있어도 펼쳐 보인다 — 접힌 채 좁혀져 있으면 '왜 안 보이지' 가 된다
  await expect(page.getByTestId('filter-toggle')).toHaveAttribute('aria-pressed', 'true')
})

test('복사 — clipboard API 가 없어도 동작하고, 안 되면 안 됐다고 말한다', async ({ page }) => {
  // http://<서버>:3000 으로 열면 보안 컨텍스트가 아니라 navigator.clipboard 가 아예 없다 —
  // 예전엔 그 화면에서 복사 버튼이 조용히 죽었다.
  await page.addInitScript(() => {
    delete (navigator as unknown as { clipboard?: unknown }).clipboard
  })
  await boot(page)
  // 진단 칸의 [복사] — 늘 값이 있는 복사 버튼이다
  await openSetting(page, 'diagnostics')
  const copyBtn = page.getByRole('dialog', { name: '설정' }).getByTestId('copy-button').first()
  await expect(copyBtn).toBeAttached({ timeout: 10_000 })

  // 옛 방식(execCommand)이 성공하는 상황 — 버튼이 '복사됨' 으로 바뀐다
  await page.evaluate(() => { document.execCommand = () => true })
  await copyBtn.click({ force: true })
  await expect(copyBtn).toHaveText('복사됨')

  // 그마저 안 되면 조용히 넘어가지 않는다 — 눌러도 아무 일이 없으면 자기 손을 의심하게 된다
  await expect(copyBtn).toHaveText('복사', { timeout: 5_000 })
  await page.evaluate(() => { document.execCommand = () => false })
  await copyBtn.click({ force: true })
  await expect(copyBtn).toHaveText('복사 실패')
})

test('Docs 탭 — 편집 모드에 들어가지 않고 바로 설명을 쓴다', async ({ page, request }) => {
  // 설명은 [편집] 을 먼저 눌러야 나오는 이름 칸 아래에만 있었다. 그래서 아무도 안 썼다.
  const ws = await (await request.post('/api/workspaces', { data: { name: '__docs탭' } })).json() as { id: string }
  try {
    const f = await (await request.post('/api/folders', { data: { workspaceId: ws.id, name: '문서폴더' } })).json() as { id: string }
    await request.post('/api/requests', { data: { folderId: f.id, name: '설명쓸요청' } })

    await page.addInitScript(id => { localStorage.setItem('ah:workspace', id) }, ws.id)
    await page.goto('/')
    // 앱이 그려지기 전에 눌러 생기는 흔들림을 막는다 — 전체 스위트로 돌릴 때만 한 번 깨졌다.
    await expect(page.getByTestId('rail-collection')).toBeVisible({ timeout: 15_000 })
    await page.getByRole('button', { name: '설명쓸요청' }).first().click()

    // 문서는 탭 줄에서 [⋯](요청 도구) 뒤로 옮겼다 — 자주 안 쓰는 것을 늘어놓지 않는다
    // (RequestPanel.tsx:845, 852).
    // ⋯ 는 <summary> 라 role=button 으로 안 잡힌다. 항목의 설명은 title 속성에만 있어
    // 글자로도 못 잡는다 — 보이는 라벨('문서')로 고른다.
    await page.getByLabel('요청 도구').click()
    // '문서' 는 실행/문서 토글에도 있다 — 메뉴 안의 것만 집는다
    await page.getByTestId('request-toolbar').getByRole('button', { name: '설명 편집', exact: true }).click()

    const box = page.getByLabel('요청 설명')
    await expect(box).toBeVisible()
    await box.fill('dryRun=true 로 먼저 확인하세요.')

    // 치자마자 편집 모드로 들어가 저장 버튼이 살아난다 — [편집] 을 따로 누르게 하지 않는다
    const save = page.getByRole('button', { name: /^변경 저장/ })
    await expect(save).toBeVisible()
    await save.click()
    await expect(page.getByRole('dialog', { name: '저장된 요청 변경 확인' })).toHaveCount(0)
    await expect(page.getByText('요청이 저장되었습니다')).toBeVisible()

    // 저장되면 실행 화면에도 그대로 뜬다.
    // 실행 화면에서는 'API 설명 · <첫 줄>' 한 줄로 접혀 보이고, 펼치면 전문이 나온다
    // (RequestPanel.tsx:929-932). 접힌 상태의 <p> 는 안 보이므로 요약 줄로 확인한다.
    await expect(page.getByText(/API 설명 · dryRun=true 로 먼저 확인하세요/))
      .toBeVisible({ timeout: 10_000 })
    // 탭에도 '있음' 표시가 붙는다
    // '있음' 표시는 이제 [⋯] 메뉴 안의 문서 항목에 붙는다
    // (문서 '있음' 표시는 메뉴 라벨이 아니라 화면 본문으로 이미 확인했다)
  } finally {
    await request.delete(`/api/workspaces/${ws.id}`)
  }
})

test('실행 상세 — 요청·응답을 그대로 복사할 수 있다', async ({ page }) => {
  // 팀에 물어보거나 티켓에 붙일 때 이 화면을 그대로 옮겨야 한다.
  // 예전엔 눈으로 읽고 손으로 다시 치는 수밖에 없었다.
  await boot(page)
  await goRail(page, 'history')
  // 행은 '상태 · 이름 · 폴더·메서드·주소' 를 담은 버튼이다
  const firstRow = page.getByTestId('global-history').getByRole('button').filter({ hasText: /·/ }).first()
  await expect(firstRow).toBeVisible({ timeout: 15_000 })
  await firstRow.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible({ timeout: 10_000 })

  // CopyButton 의 접근성 이름은 title 이라, 보이는 글자로 찾는다
  for (const label of ['요청 복사', '전체 복사']) {
    await expect(dialog.getByTestId('copy-button').filter({ hasText: label })).toBeVisible()
  }

  // 실제로 무엇이 담기는지 본다. clipboard 는 프로토타입 게터라 delete 로는 안 지워진다 —
  // writeText 를 직접 갈아 끼워 받은 글자를 붙든다.
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (t: string) => { (window as unknown as { __copied?: string }).__copied = t } },
    })
  })
  await dialog.getByTestId('copy-button').filter({ hasText: '전체 복사' }).click()
  const copied = await page.evaluate(() => (window as unknown as { __copied?: string }).__copied ?? '')
  expect(copied, '복사한 내용이 비었다').toContain('## 보낸 요청')
  expect(copied).toContain('## 응답')
})

test('스펙 변경 — 무엇이 어떻게 바뀌었는지 이전 → 이후로 적는다', async ({ page, request }) => {
  // 예전엔 'CHANGED' 와 이름·경로만 남겼다. 바뀐 건 알겠는데 무엇이 바뀌었는지는
  // 스펙을 직접 열어 대조해야 했다. 변경 기록의 기본은 이전 → 이후다.
  const ws = await (await request.post('/api/workspaces', { data: { name: '__스펙변경' } })).json() as { id: string }
  try {
    const f = await (await request.post('/api/folders', {
      data: {
        workspaceId: ws.id, name: 'mock', specSourceType: 'url',
        specSourceUrl: `http://${HOST}:${process.env.E2E_SPEC_PORT ?? '9998'}/v3/api-docs`,
      },
    })).json() as { id: string }
    expect((await (await request.post(`/api/folders/${f.id}/sync`)).json()).added).toBe(3)

    // 같은 엔드포인트의 '바뀐' 스펙으로 갈아 끼운다(요약이 바뀌고 파라미터가 하나 늘었다)
    await request.put(`/api/folders/${f.id}`, { data: { specSourceUrl: `http://${HOST}:${process.env.E2E_SPEC_PORT ?? '9998'}/v2/api-docs` } })
    expect((await (await request.post(`/api/folders/${f.id}/sync`)).json()).changed).toBe(1)

    await page.addInitScript(id => { localStorage.setItem('ah:workspace', id) }, ws.id)
    await page.goto('/')
    // 앱이 그려지기 전에 레일을 누르면 goRail 이 '보조 메뉴 펼치기' 를 찾다 타임아웃한다.
    // 전체 스위트로 돌릴 때만 느려져서 깨졌다 — 단독 실행에서는 안 보이던 종류다.
    await expect(page.getByTestId('rail-collection')).toBeVisible({ timeout: 15_000 })
    // 타임라인은 지웠다 — [이어서 하기] 에서 바뀐 요청을 바로 열면 머리말의 '스펙 변경' 표시가 이전 → 이후를 말한다
    // (동기화는 사람이 붙인 요청 이름을 바꾸지 않는다 — 바뀐 요약 '펫 등록 (v2)' 는 변경 기록에 남는다)
    await page.getByRole('button', { name: '스펙 변경 요청 열기: 펫 등록', exact: true }).click()
    const badge = page.locator('main span[title]', { hasText: /^스펙 변경 · / }).first()
    await expect(badge).toBeVisible({ timeout: 15_000 })
    await expect(badge).toHaveAttribute('title', /→/)
    await expect(badge).toHaveAttribute('title', /펫 등록 \(v2\)/)
    await expect(badge).toHaveAttribute('title', /파라미터 추가/)
    await expect(badge).toHaveAttribute('title', /dryRun/)
  } finally {
    await request.delete(`/api/workspaces/${ws.id}`)
  }
})

test('미등록 변수 — 발견한 자리에서 바로 만든다', async ({ page, request }) => {
  // 예전엔 '가서 등록하세요' 라고만 말했다. 그러려면 설정을 열고 환경을 고르고 행을 더하고
  // 저장하고 다시 돌아와야 했다 — 그 사이에 무엇을 만들려 했는지 잊는다.
  const ws = await (await request.post('/api/workspaces', { data: { name: '__미등록변수' } })).json() as { id: string }
  try {
    const f = await (await request.post('/api/folders', { data: { workspaceId: ws.id, name: 'F' } })).json() as { id: string }
    const r = await (await request.post('/api/requests', { data: { folderId: f.id, name: '변수요청' } })).json() as { id: string }
    await request.put(`/api/requests/${r.id}`, { data: { url: 'https://x.example/{{미등록키}}' } })

    await page.addInitScript(id => { localStorage.setItem('ah:workspace', id) }, ws.id)
    await page.goto('/')
    await page.getByRole('button', { name: '변수요청' }).first().click()

    // 미등록 칩이 눌리는 버튼이어야 한다
    const chip = page.getByRole('button', { name: '미등록키 변수 값', exact: true })
    await expect(chip).toBeVisible({ timeout: 10_000 })
    await chip.click()

    await page.getByLabel('변수 저장 범위').selectOption('project')
    await page.getByLabel('변수 편집 값').fill('https://made-here.example')
    await page.getByRole('dialog', { name: '미등록키 변수 편집' }).getByRole('button', { name: '저장', exact: true }).click()

    // 만들자마자 미등록이 사라지고 값이 붙은 칩으로 바뀐다 — 다시 실행하러 가지 않아도 된다
    await expect(chip).toContainText('프로젝트', { timeout: 10_000 })
    await expect(page.locator('main')).toContainText('made-here.example')

    // 서버에도 정말 저장됐다
    const vars = await (await request.get(`/api/global-vars?workspaceId=${ws.id}`)).json() as { key: string; value: string }[]
    expect(vars.find(v => v.key === '미등록키')?.value).toBe('https://made-here.example')
  } finally {
    await request.delete(`/api/workspaces/${ws.id}`)
  }
})

test('요청 상태 — 머리말에 실행 수·성공률 중복 요약을 다시 띄우지 않는다', async ({ page, request }) => {
  // 한때 이 요약을 요청 머리말에 띄웠다가, 트리의 실패 점·이력 화면과 겹치는 중복이라 일부러 뺐다
  // (응답 화면 정리 때 결정). 그런데 이 테스트가 옛 기대('보인다')로
  // 남아 있어서, 깨질 때마다 '회귀' 로 읽혀 두 번이나 되살아났다(83fda15 에서 철회, 그 뒤 또 한 번).
  // 이제 이 테스트는 그 결정을 지킨다. 실패는 트리의 점으로 보인다 — 그건 따로 확인한다.
  const ws = await (await request.post('/api/workspaces', { data: { name: '__요청상태' } })).json() as { id: string }
  try {
    const f = await (await request.post('/api/folders', { data: { workspaceId: ws.id, name: 'F' } })).json() as { id: string }
    const r = await (await request.post('/api/requests', { data: { folderId: f.id, name: '상태요청' } })).json() as { id: string }
    const run = (url: string) => request.post(`/api/requests/${r.id}/execute`, {
      data: { executedBy: 'e2e', input: { method: 'GET', url, bodyType: 'none', params: [], headers: [], body: '' } },
    })

    // 성공 2 · 실패 1 → 성공률 67%
    await run(`http://${HOST}:${process.env.E2E_ECHO_PORT ?? '9999'}/ok`)
    await run(`http://${HOST}:${process.env.E2E_ECHO_PORT ?? '9999'}/ok`)
    await run('http://127.0.0.1:1/닿지않음')

    await page.addInitScript(id => { localStorage.setItem('ah:workspace', id) }, ws.id)
    await page.goto('/')
    await page.getByRole('button', { name: '상태요청' }).first().click()

    // 요청이 열린 뒤에 확인한다 — 안 열린 화면에 없다고 통과하면 아무것도 안 본 것이다
    await expect(page.getByRole('button', { name: /^Params/ })).toBeVisible({ timeout: 10_000 })
    const main = page.locator('main')
    await expect(main).not.toContainText('최근 24시간')
    await expect(main).not.toContainText('성공 67%')
    // 실패가 있었다는 사실 자체는 트리의 점으로 남는다
    await expect(page.getByLabel('최근 실패', { exact: true })).toHaveCount(1)
  } finally {
    await request.delete(`/api/workspaces/${ws.id}`)
  }
})

test('스펙 변경 — 트리에 표시되고, 확인하면 내려간다', async ({ page, request }) => {
  // 배지가 다음 동기화 전까지 안 내려가면 며칠 뒤엔 벽지가 된다 — 그때부터는 정말 바뀐 것도
  // 눈에 안 들어온다. 알림은 지울 수 있어야 알림이다.
  const ws = await (await request.post('/api/workspaces', { data: { name: '__확인처리' } })).json() as { id: string }
  try {
    const f = await (await request.post('/api/folders', {
      data: {
        workspaceId: ws.id, name: 'mock', specSourceType: 'url',
        specSourceUrl: `http://${HOST}:${process.env.E2E_SPEC_PORT ?? '9998'}/v3/api-docs`,
      },
    })).json() as { id: string }
    await request.post(`/api/folders/${f.id}/sync`)
    await request.put(`/api/folders/${f.id}`, { data: { specSourceUrl: `http://${HOST}:${process.env.E2E_SPEC_PORT ?? '9998'}/v2/api-docs` } })
    expect((await (await request.post(`/api/folders/${f.id}/sync`)).json()).changed).toBe(1)

    // 표시 API 가 바뀐 요청을 집어낸다
    const flags = await (await request.get(`/api/workspaces/${ws.id}/flags`)).json() as { spec: Record<string, string> }
    expect(Object.values(flags.spec)).toContain('changed')

    await page.addInitScript(id => { localStorage.setItem('ah:workspace', id) }, ws.id)
    await page.goto('/')
    await expect(page.getByTestId('rail-collection')).toBeVisible({ timeout: 15_000 })

    // 트리에 CHANGED 가 보인다
    await expect(page.locator('main')).toContainText('CHANGED', { timeout: 10_000 })

    await page.getByRole('button', { name: /펫 등록/ }).first().click()
    await expect(page.locator('main')).toContainText('스펙 변경', { timeout: 10_000 })

    // 확인하면 서버에서도 내려간다
    await page.getByRole('button', { name: '확인', exact: true }).click()
    await expect.poll(async () => {
      const after = await (await request.get(`/api/workspaces/${ws.id}/flags`)).json() as { spec: Record<string, string> }
      return Object.values(after.spec).filter(v => v === 'changed').length
    }, { timeout: 10_000 }).toBe(0)
  } finally {
    await request.delete(`/api/workspaces/${ws.id}`)
  }
})

test('실패 표시 — 트리에서 깨진 요청이 눈에 띄고, 열린다', async ({ page, request }) => {
  const ws = await (await request.post('/api/workspaces', { data: { name: '__실패표시' } })).json() as { id: string }
  try {
    const f = await (await request.post('/api/folders', { data: { workspaceId: ws.id, name: 'F' } })).json() as { id: string }
    const ok = await (await request.post('/api/requests', { data: { folderId: f.id, name: '멀쩡한요청' } })).json() as { id: string }
    const bad = await (await request.post('/api/requests', { data: { folderId: f.id, name: '깨진요청' } })).json() as { id: string }
    const run = (id: string, url: string) => request.post(`/api/requests/${id}/execute`, {
      data: { executedBy: 'e2e', input: { method: 'GET', url, bodyType: 'none', params: [], headers: [], body: '' } },
    })
    await run(ok.id, `http://${HOST}:${process.env.E2E_ECHO_PORT ?? '9999'}/ok`)
    await run(bad.id, 'http://127.0.0.1:1/닿지않음')

    // 표시 API 는 '표시할 게 있는 것' 만 준다 — 멀쩡한 요청은 안 실린다
    const flags = await (await request.get(`/api/workspaces/${ws.id}/flags`)).json() as { failed: string[] }
    expect(flags.failed).toEqual([bad.id])

    await page.addInitScript(id => { localStorage.setItem('ah:workspace', id) }, ws.id)
    await page.goto('/')
    await expect(page.getByTestId('rail-collection')).toBeVisible({ timeout: 15_000 })

    // 깨진 요청에만 점이 붙는다
    await expect(page.getByLabel('최근 실패', { exact: true })).toHaveCount(1, { timeout: 10_000 })

    // 깨진 요청을 누르면 그 요청이 열린다.
    await page.getByRole('button', { name: '깨진요청' }).first().click()
    await expect(page.getByRole('button', { name: /^Params/ })).toBeVisible({ timeout: 10_000 })
  } finally {
    await request.delete(`/api/workspaces/${ws.id}`)
  }
})

test('목록 요약 — 손볼 것을 모아 말하고, 문제만 보기·모두 확인이 된다', async ({ page, request }) => {
  // 점만 찍어 두면 수백 줄 중에서 눈으로 찾아야 하고, 결국 안 찾는다.
  const ws = await (await request.post('/api/workspaces', { data: { name: '__요약바' } })).json() as { id: string }
  try {
    // 깨진 요청 하나
    const plain = await (await request.post('/api/folders', { data: { workspaceId: ws.id, name: '손수폴더' } })).json() as { id: string }
    const bad = await (await request.post('/api/requests', { data: { folderId: plain.id, name: '깨진요청' } })).json() as { id: string }
    await request.post('/api/requests', { data: { folderId: plain.id, name: '멀쩡한요청' } })
    await request.post(`/api/requests/${bad.id}/execute`, {
      data: { executedBy: 'e2e', input: { method: 'GET', url: 'http://127.0.0.1:1/x', bodyType: 'none', params: [], headers: [], body: '' } },
    })

    // 스펙이 바뀐 요청 하나
    const spec = await (await request.post('/api/folders', {
      data: {
        workspaceId: ws.id, name: 'mock', specSourceType: 'url',
        specSourceUrl: `http://${HOST}:${process.env.E2E_SPEC_PORT ?? '9998'}/v3/api-docs`,
      },
    })).json() as { id: string }
    await request.post(`/api/folders/${spec.id}/sync`)
    await request.put(`/api/folders/${spec.id}`, { data: { specSourceUrl: `http://${HOST}:${process.env.E2E_SPEC_PORT ?? '9998'}/v2/api-docs` } })
    await request.post(`/api/folders/${spec.id}/sync`)

    await page.addInitScript(id => { localStorage.setItem('ah:workspace', id) }, ws.id)
    await page.goto('/')
    await expect(page.getByTestId('rail-collection')).toBeVisible({ timeout: 15_000 })

    const main = page.locator('main')
    await expect(main).toContainText('최근 실패 1', { timeout: 10_000 })
    await expect(main).toContainText('스펙 변경 1')

    // 문제만 보기 — 멀쩡한 요청은 빠진다
    // 행 버튼 이름은 'GET 깨진요청' 에 상태 라벨까지 붙는다('… 최근 실패').
    // 이름으로 잡으면 표시가 바뀔 때마다 깨지므로, 끌 수 있는 행(draggable)에서 글자로 찾는다.
    const row = (name: string) => main.locator('[role="button"][draggable="true"]').filter({ hasText: name })
    await page.getByRole('button', { name: '문제만 보기' }).click()
    await expect(row('멀쩡한요청')).toHaveCount(0)
    await expect(row('깨진요청')).toHaveCount(1)
    await page.getByRole('button', { name: '전체 보기' }).click()
    await expect(row('멀쩡한요청')).toHaveCount(1)

    // 모두 확인 — 스펙 변경만 내려가고 실패 표시는 남는다
    await page.getByRole('button', { name: '모두 확인' }).click()
    await expect(main).not.toContainText('스펙 변경 1', { timeout: 10_000 })
    await expect(main).toContainText('최근 실패 1')
  } finally {
    await request.delete(`/api/workspaces/${ws.id}`)
  }
})

test('값 흐름 — 전역 변수를 못 읽으면 없는 문제를 만들어내지 않는다', async ({ page }) => {
  // 못 읽은 채로 판정하면 전역에만 있는 값이 전부 '어디에도 없음' 으로 잡힌다.
  // 거짓 경고를 한 번 무시하고 나면 진짜 경고도 안 본다 — 그래서 판정을 보류한다고 말한다.
  await boot(page)
  await page.route('**/api/global-vars*', r => r.fulfill({
    status: 500, contentType: 'application/json', body: '{"error":"조회 실패"}',
  }))
  await goRail(page, 'scenario')

  await pickScenarioWithSteps(page)

  await expect(page.getByText(/전역 변수을 못 읽어 판정 보류/)).toBeVisible({ timeout: 10_000 })
  // 못 읽었는데 '실행 전 확인 N건' 을 띄우면 그게 거짓 경고다
  await expect(page.getByText(/실행 전 확인 \d+건/)).toHaveCount(0)
})

test('토스트 — 같은 오류가 쏟아져도 화면을 덮지 않는다', async ({ page }) => {
  // error 토스트는 자동으로 안 사라진다. 일괄 작업이 20건 실패하면 같은 문구가 20장 쌓였고,
  // 스무 번을 손으로 닫아야 했다 — 그 사이 화면은 아무것도 못 쓴다.
  await boot(page)
  await page.route('**/api/requests/*', async route => {
    if (route.request().method() !== 'DELETE') return route.fallback()
    await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"삭제 실패"}' })
  })
  page.on('dialog', d => d.accept())

  await page.getByTestId('filter-toggle').click()
  await page.getByRole('button', { name: '여러 요청 선택', exact: true }).click()
  const boxes = page.locator('input[type="checkbox"][aria-label$="선택"]')
  await expect(boxes.first()).toBeVisible({ timeout: 10_000 })
  for (let i = 0; i < 6; i++) await boxes.nth(i).click()
  await page.getByRole('button', { name: '삭제', exact: true }).click()

  // 닫기 버튼 하나가 토스트 한 장이다
  const toasts = page.getByRole('button', { name: '알림 닫기' })
  await expect(toasts.first()).toBeVisible({ timeout: 10_000 })
  const count = await toasts.count()
  // 하나는 떠 있어야 하고(안 뜨면 이 검사가 아무것도 안 본 것),
  expect(count, '토스트가 하나도 없다 — 이 검사가 헛돌고 있다').toBeGreaterThan(0)
  // 같은 말은 겹쳐 쌓지 않으므로 상한을 넘지 않는다
  expect(count, `토스트가 ${count}장 쌓였다`).toBeLessThanOrEqual(5)
})

test('시나리오 편집 — 타자마다 저장하지 않고, 실행 전에는 반드시 저장한다', async ({ page, request }) => {
  // 예전엔 편집마다 바로 PUT 했다. URL 칸은 onChange 에 물려 있어 40자를 치면 40번 나갔고,
  // 응답이 순서대로 오지 않으면 나중에 도착한 예전 요청이 이겨 치다 만 값이 남았다.
  const ws = await (await request.post('/api/workspaces', { data: { name: '__저장모으기' } })).json() as { id: string }
  try {
    const f = await (await request.post('/api/folders', { data: { workspaceId: ws.id, name: 'F' } })).json() as { id: string }
    const r = await (await request.post('/api/requests', { data: { folderId: f.id, name: '스텝요청' } })).json() as { id: string }
    await request.put(`/api/requests/${r.id}`, { data: { url: `http://${HOST}:${process.env.E2E_ECHO_PORT ?? '9999'}/step` } })
    const flow = await (await request.post('/api/flows', { data: { workspaceId: ws.id, name: '저장테스트' } })).json() as { id: string }

    let puts = 0
    await page.route(`**/api/flows/${flow.id}`, route => { if (route.request().method() === 'PUT') puts++; return route.fallback() })

    await page.addInitScript(id => { localStorage.setItem('ah:workspace', id) }, ws.id)
    await page.goto('/')
    await expect(page.getByTestId('rail-collection')).toBeVisible({ timeout: 15_000 })
    await goRail(page, 'scenario')
    // 드롭다운 → 사이드바 목록(FlowScenario.tsx:467). 항목 이름은 '{시나리오 이름} 열기'.
    await page.getByRole('button', { name: '저장테스트 열기' }).click()

    // 스텝 하나를 넣고 그 저장이 나갈 때까지 기다린다(여기까지는 준비)
    await addScenarioRequest(page, '스텝요청')
    await expect(page.getByText('1스텝', { exact: true })).toBeVisible({ timeout: 10_000 })
    await expect.poll(() => puts, { timeout: 5_000 }).toBeGreaterThan(0)
    await page.waitForTimeout(600)

    // ① 모으기 — 빠르게 친 20글자는 PUT 20번이 아니라 한두 번이어야 한다.
    // 예전 테스트는 '스텝 추가' 를 세 번 했는데, 매번 선택 창을 열고 검색하느라 편집 사이가 400ms
    // 디바운스를 넘길 수 있었다. 그러면 정상 동작에서도 PUT 3번으로 깨진다. 타자는 간격이 짧아
    // 디바운스 안에 확실히 들어간다.
    puts = 0
    await page.locator('button.ah-node').first().click()
    const url = page.getByLabel('이 단계 URL').first()
    await url.click()
    await page.keyboard.press('End')
    await page.keyboard.type('?a=12345678901234567', { delay: 10 })   // 20글자, 약 200ms
    await page.waitForTimeout(900)
    expect(puts, `20글자에 PUT 이 ${puts}번 나갔다 — 타자마다 보내고 있다`).toBeLessThanOrEqual(2)
    expect(puts, '한 번도 안 보냈다 — 미룬 저장이 영영 안 나간 것이다').toBeGreaterThan(0)

    // ② 실행 전 저장 — 방금 친 것이 저장되기 전에 실행을 누르면, 저장이 먼저 나가야 한다.
    // 서버는 저장된 것을 실행한다. 순서가 뒤집히면 화면에 보이는 값과 다른 것이 실행된다.
    const order: string[] = []
    await page.unroute(`**/api/flows/${flow.id}`)
    await page.route(`**/api/flows/${flow.id}`, route => { if (route.request().method() === 'PUT') order.push('save'); return route.fallback() })
    await page.route(`**/api/flows/${flow.id}/run`, route => { order.push('run'); return route.fallback() })
    await page.keyboard.type('X')                      // 디바운스 대기 중인 편집을 하나 남긴다
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '▶ 시나리오 실행' }).click()
    await expect.poll(() => order.includes('run'), { timeout: 10_000 }).toBe(true)
    expect(order.indexOf('save'), `실행 전에 저장이 안 나갔다: ${order.join(' → ')}`).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('save'), `저장보다 실행이 먼저 나갔다: ${order.join(' → ')}`).toBeLessThan(order.indexOf('run'))

    // 서버에 실제로 마지막 글자까지 저장돼 있어야 한다. 단건 GET 은 없다 — 목록에서 읽는다
    const list = await (await request.get(`/api/flows?workspaceId=${ws.id}`)).json() as { id: string; steps: { url?: string; urlOverride?: string }[] }[]
    const saved = JSON.stringify(list.find(x => x.id === flow.id)?.steps ?? [])
    expect(saved, '마지막으로 친 글자가 저장되지 않았다').toContain('12345678901234567X')
  } finally {
    await request.delete(`/api/workspaces/${ws.id}`)
  }
})

test('시나리오 동시 편집 — 뒤늦은 저장이 앞사람 것을 지우지 않는다', async ({ request }) => {
  // 시나리오는 팀이 같이 만지는 물건이고, 저장은 steps 전체를 통째로 덮어쓴다.
  // 둘이 같은 시나리오를 열어 두면 나중에 저장한 쪽이 앞사람의 스텝을 조용히 지웠다 —
  // 지운 쪽도 지워진 쪽도 모른다. 요청(requests)에는 이미 있던 보호가 여기엔 없었다.
  const ws = await (await request.post('/api/workspaces', { data: { name: '__동시편집' } })).json() as { id: string }
  try {
    const fl = await (await request.post('/api/flows', { data: { workspaceId: ws.id, name: '원본' } })).json() as { id: string }
    const list = await (await request.get(`/api/flows?workspaceId=${ws.id}`)).json() as { id: string; updatedAt: number }[]
    const known = list.find(x => x.id === fl.id)!.updatedAt

    // A 가 먼저 저장한다
    const a = await request.put(`/api/flows/${fl.id}`, { data: { name: 'A가 고침', ifUpdatedAt: known } })
    expect(a.status()).toBe(200)

    // B 는 아직 옛 시각을 들고 있다 — 덮어쓰지 못한다
    const b = await request.put(`/api/flows/${fl.id}`, { data: { name: 'B가 고침', ifUpdatedAt: known } })
    expect(b.status(), '뒤늦은 저장이 그냥 덮어썼다').toBe(409)
    expect((await b.json()).error).toContain('먼저 저장')

    const after = await (await request.get(`/api/flows?workspaceId=${ws.id}`)).json() as { id: string; name: string }[]
    expect(after.find(x => x.id === fl.id)?.name, 'A 의 저장이 지워졌다').toBe('A가 고침')

    // 시각을 안 보내면(구형 클라이언트·내부 호출) 예전처럼 그냥 저장된다
    expect((await request.put(`/api/flows/${fl.id}`, { data: { name: 'C가 고침' } })).status()).toBe(200)
  } finally {
    await request.delete(`/api/workspaces/${ws.id}`)
  }
})

test('환경 동시 편집 — 뒤늦은 저장이 앞사람 변수를 지우지 않는다', async ({ request }) => {
  // 환경 저장은 변수 표 전체를 지우고 다시 넣는다. 둘이 같은 환경을 열어 두면 나중에
  // 저장한 쪽이 앞사람이 넣은 변수를 지운다 — 거기 토큰이 있으면 무엇을 잃었는지도 모른 채
  // 실행이 깨진다. 이 앱에서 제일 비싼 조용한 덮어쓰기다.
  const ws = await (await request.post('/api/workspaces', { data: { name: '__환경동시' } })).json() as { id: string }
  try {
    const env = await (await request.post('/api/environments', { data: { workspaceId: ws.id, name: 'E' } })).json() as { id: string }
    await request.put(`/api/environments/${env.id}`, {
      data: { name: 'E', variables: [{ key: 'token', value: 'T1', secret: false }] },
    })
    const list = await (await request.get(`/api/environments?workspaceId=${ws.id}`)).json() as { id: string; updatedAt: number }[]
    const known = list.find(e => e.id === env.id)!.updatedAt

    // A 가 변수를 하나 더 넣고 저장한다
    const a = await request.put(`/api/environments/${env.id}`, {
      data: {
        name: 'E', ifUpdatedAt: known,
        variables: [{ key: 'token', value: 'T1', secret: false }, { key: 'A가추가', value: 'x', secret: false }],
      },
    })
    expect(a.status()).toBe(200)

    // B 는 아직 옛 시각을 들고 있다 — 덮어쓰지 못한다
    const b = await request.put(`/api/environments/${env.id}`, {
      data: { name: 'E', ifUpdatedAt: known, variables: [{ key: 'token', value: 'T1', secret: false }] },
    })
    expect(b.status(), '뒤늦은 저장이 그냥 덮어썼다').toBe(409)

    const after = await (await request.get(`/api/environments?workspaceId=${ws.id}`)).json() as
      { id: string; variables: { key: string }[] }[]
    expect(after.find(e => e.id === env.id)?.variables.map(v => v.key).sort(), 'A 가 넣은 변수가 지워졌다')
      .toEqual(['A가추가', 'token'])
  } finally {
    await request.delete(`/api/workspaces/${ws.id}`)
  }
})

test('쿠키·웹훅 — 값은 화면으로 안 내려온다(서버는 그대로 들고 쓴다)', async ({ request }) => {
  // 쿠키 값은 로그인 세션 그 자체고, 슬랙 웹훅은 아는 사람 누구나 그 채널에 글을 올릴 수 있다.
  // 인증 없이 열려 있는 도구라, 주소만 알면 둘 다 읽을 수 있었다.
  const ws = await (await request.post('/api/workspaces', { data: { name: '__읽기시크릿' } })).json() as { id: string }
  try {
    await request.post('/api/cookies', {
      data: { workspaceId: ws.id, domain: 'x.com', cookieString: 'sid=SESSION-SECRET-777' },
    })
    const cookies = await (await request.get(`/api/cookies?workspaceId=${ws.id}&environmentId=`)).json() as
      { name: string; value: string }[]
    expect(cookies[0].name, '어느 쿠키인지는 알아볼 수 있어야 한다').toBe('sid')
    expect(cookies[0].value, '쿠키 값이 조회로 새어 나왔다').toBe('')

    const fl = await (await request.post('/api/flows', { data: { workspaceId: ws.id, name: 'F' } })).json() as { id: string }
    await request.post('/api/schedules', {
      data: { workspaceId: ws.id, flowId: fl.id, slackWebhookUrl: 'https://hooks.slack.com/services/T/B/SECRET' },
    })
    const scheds = await (await request.get(`/api/schedules?workspaceId=${ws.id}`)).json() as
      { slackWebhookUrl: string | null; hasWebhook: boolean }[]
    expect(scheds[0].slackWebhookUrl, '웹훅 URL 이 조회로 새어 나왔다').toBeNull()
    // 그래도 '알림 보낼 곳이 있다' 는 사실은 화면이 알아야 한다 — 없으면 실패가 어디에도 안 간다
    expect(scheds[0].hasWebhook).toBe(true)
  } finally {
    await request.delete(`/api/workspaces/${ws.id}`)
  }
})

test('저장된 인증 — 조회로는 안 나오고, 비워 저장해도 유지되고, 실행에는 실린다', async ({ request }) => {
  // 환경 변수 secret 은 조회할 때 값을 지우고 내려준다. 내보내기에서도 인증 비밀값은 지운다.
  // 그런데 요청·폴더 인증만 조회하면 토큰이 평문 그대로 돌아왔다 — 이 도구는 로그인이 없어
  // 서버에 닿기만 하면, 주소만 알면 저장된 토큰을 전부 읽을 수 있다는 뜻이다.
  const ws = await (await request.post('/api/workspaces', { data: { name: '__인증마스킹' } })).json() as { id: string }
  try {
    const f = await (await request.post('/api/folders', { data: { workspaceId: ws.id, name: 'F' } })).json() as { id: string }
    const r = await (await request.post('/api/requests', { data: { folderId: f.id, name: 'R' } })).json() as { id: string }
    await request.put(`/api/requests/${r.id}`, {
      data: { auth: { type: 'bearer', token: 'SECRET-TOKEN-12345' }, url: `http://${HOST}:${process.env.E2E_ECHO_PORT ?? '9999'}/x` },
    })

    // 1) 조회로는 안 나온다
    const shown = await (await request.get(`/api/requests/${r.id}`)).json() as { auth: { token: string } }
    expect(shown.auth.token, '저장된 토큰이 조회로 새어 나왔다').toBe('')
    const list = await (await request.get(`/api/requests?folderId=${f.id}`)).json() as { auth: { token: string } }[]
    expect(list[0].auth.token, '목록 조회로 새어 나왔다').toBe('')

    // 2) 화면이 돌려준 빈 값으로 저장해도 지워지지 않는다
    //    (이 짝이 없으면 마스킹을 넣는 순간 저장할 때마다 토큰이 사라진다)
    await request.put(`/api/requests/${r.id}`, { data: { auth: { type: 'bearer', token: '' }, name: '이름만 바꿈' } })

    // 3) 실행에는 그대로 실린다
    const exec = await request.post(`/api/requests/${r.id}/execute`, {
      data: {
        executedBy: 'e2e',
        input: { method: 'GET', url: `http://${HOST}:${process.env.E2E_ECHO_PORT ?? '9999'}/x`, params: [], headers: [], bodyType: 'none', body: '' },
      },
    })
    const body = JSON.parse((await exec.json()).responseBody ?? '{}') as { auth?: string }
    expect(body.auth, '빈 값 저장이 토큰을 지웠다').toBe('Bearer SECRET-TOKEN-12345')

    // 4) {{변수}} 참조는 지우지 않는다 — 비밀이 아니라 어디서 가져오는지다
    await request.put(`/api/requests/${r.id}`, { data: { auth: { type: 'bearer', token: '{{token}}' } } })
    const ref = await (await request.get(`/api/requests/${r.id}`)).json() as { auth: { token: string } }
    expect(ref.auth.token).toBe('{{token}}')
  } finally {
    await request.delete(`/api/workspaces/${ws.id}`)
  }
})

test('환경 저장 — 없는 환경에 성공이라 하지 않는다', async ({ request }) => {
  // 요청·시나리오·폴더에서 고친 같은 구멍이 환경에 남아 있었다. 다른 사람이 지운 환경에
  // 변수를 저장하고 '저장됨' 을 보면, 그 변수는 어디에도 없다.
  const gone = await request.put('/api/environments/does-not-exist-9999', { data: { name: 'x' } })
  expect(gone.status(), '없는 환경에 저장이 성공했다').toBe(404)
  expect((await gone.json()).error).toContain('다른 사람이 지웠을')

  // 있는 환경은 그대로 저장된다(대조군)
  const ws = await (await request.post('/api/workspaces', { data: { name: '__환경404' } })).json() as { id: string }
  try {
    const env = await (await request.post('/api/environments', { data: { workspaceId: ws.id, name: 'E' } })).json() as { id: string }
    expect((await request.put(`/api/environments/${env.id}`, { data: { name: 'E2' } })).status()).toBe(200)
  } finally {
    await request.delete(`/api/workspaces/${ws.id}`)
  }
})

test('쿠키 — 못 읽으면 그렇게 말하고, 남의 스코프 것을 지우지 않는다', async ({ request }) => {
  const ws = await (await request.post('/api/workspaces', { data: { name: '__쿠키검증' } })).json() as { id: string }
  try {
    // 한 쌍도 못 읽었으면 그렇게 말한다. '0개 추가됨' 으로 넘기면 왜 안 먹었는지 알 수 없다.
    expect((await request.post('/api/cookies', {
      data: { workspaceId: ws.id, domain: 'x.com', cookieString: '쓰레기' },
    })).status()).toBe(400)

    const ok = await request.post('/api/cookies', {
      data: { workspaceId: ws.id, domain: 'x.com', cookieString: 'sid=A; who=B' },
    })
    expect(ok.status()).toBe(201)
    expect((await ok.json()).added).toBe(2)

    const rows = await (await request.get(`/api/cookies?workspaceId=${ws.id}&environmentId=`)).json() as { id: string }[]
    expect(rows).toHaveLength(2)

    // 다른 프로젝트를 보고 있던 낡은 화면이 이 프로젝트의 쿠키를 지우면 안 된다
    const cross = await request.delete(`/api/cookies?id=${rows[0].id}&workspaceId=default`)
    expect((await cross.json()).deleted, '남의 스코프에서 지워졌다').toBe(0)
    expect((await (await request.get(`/api/cookies?workspaceId=${ws.id}&environmentId=`)).json() as unknown[])).toHaveLength(2)

    // 제 스코프에서는 지워진다(대조군)
    const mine = await request.delete(`/api/cookies?id=${rows[0].id}&workspaceId=${ws.id}`)
    expect((await mine.json()).deleted).toBe(1)
  } finally {
    await request.delete(`/api/workspaces/${ws.id}`)
  }
})

test('스케줄 — 없는 환경·엉뚱한 주기를 안 받는다', async ({ request }) => {
  // 스케줄은 사람이 안 볼 때 돈다. 잘못 만들어져도 등록 시점엔 아무 일이 없다가 새벽에
  // 조용히 실패한다 — 그때까지 아무도 모른다. (flowId=999 짜리가 201 로 만들어진 적이 있다)
  const ws = await (await request.post('/api/workspaces', { data: { name: '__스케줄검증' } })).json() as { id: string }
  try {
    const fl = await (await request.post('/api/flows', { data: { workspaceId: ws.id, name: 'F' } })).json() as { id: string }
    const env = await (await request.post('/api/environments', { data: { workspaceId: ws.id, name: 'E' } })).json() as { id: string }

    // 없는 환경 — 그대로 두면 새벽 실행이 변수를 못 채워 {{baseUrl}} 이 문자 그대로 나간다
    expect((await request.post('/api/schedules', {
      data: { workspaceId: ws.id, flowId: fl.id, environmentId: '없는환경' },
    })).status()).toBe(404)

    // 오타를 조용히 60분으로 바꾸지 않는다
    expect((await request.post('/api/schedules', {
      data: { workspaceId: ws.id, flowId: fl.id, intervalMinutes: '아무거나' },
    })).status()).toBe(400)

    // 정상 값은 통과한다(대조군)
    const sc = await (await request.post('/api/schedules', {
      data: { workspaceId: ws.id, flowId: fl.id, environmentId: env.id, intervalMinutes: 5 },
    })).json() as { id: string; intervalMinutes: number }
    expect(sc.intervalMinutes).toBe(5)

    // 고칠 때도 같은 규칙 — 만들 때만 막으면 PUT 으로 우회된다
    expect((await request.put(`/api/schedules/${sc.id}`, { data: { intervalMinutes: '엉뚱' } })).status()).toBe(400)
    expect((await request.put(`/api/schedules/${sc.id}`, { data: { environmentId: '없는환경' } })).status()).toBe(404)
    expect((await request.put(`/api/schedules/${sc.id}`, { data: { enabled: false } })).status()).toBe(200)

    // 없는 스케줄을 껐다고 믿게 하지 않는다
    expect((await request.put('/api/schedules/does-not-exist', { data: { enabled: false } })).status()).toBe(404)
  } finally {
    await request.delete(`/api/workspaces/${ws.id}`)
  }
})

test('요청 저장 — 엉뚱한 bodyType·method 를 안 받는다', async ({ request }) => {
  // SQLite 는 enum 을 강제하지 않는다. 안 막으면 그대로 저장되고, 화면은 어느 바디 탭도
  // 안 고른 상태가 되며, method 는 실행할 때에야 fetch 가 던진다.
  const ws = await (await request.post('/api/workspaces', { data: { name: '__요청검증' } })).json() as { id: string }
  try {
    const f = await (await request.post('/api/folders', { data: { workspaceId: ws.id, name: 'F' } })).json() as { id: string }

    expect((await request.post('/api/requests', {
      data: { folderId: f.id, name: 'R', bodyType: '아무거나' },
    })).status(), '만들 때 안 막았다').toBe(400)

    const r = await (await request.post('/api/requests', {
      data: { folderId: f.id, name: 'R', bodyType: 'json' },
    })).json() as { id: string }

    expect((await request.put(`/api/requests/${r.id}`, {
      data: { method: '엉뚱한메서드' },
    })).status(), '고칠 때 안 막았다 — 만들 때만 막으면 우회된다').toBe(400)

    // 정상 값은 통과한다(대조군)
    expect((await request.put(`/api/requests/${r.id}`, {
      data: { method: 'PATCH', bodyType: 'graphql' },
    })).status()).toBe(200)
  } finally {
    await request.delete(`/api/workspaces/${ws.id}`)
  }
})

test('폴더 저장 — 없는 폴더에 성공이라 하지 않고, 엉뚱한 스펙 타입을 안 받는다', async ({ request }) => {
  // 없는 행에 UPDATE 를 걸면 0행을 고치고 조용히 성공한다 — 요청·시나리오에서 고친
  // 같은 구멍이 폴더에 남아 있었다. 다른 사람이 지운 폴더의 이름을 바꾸면 '바꿨다' 고 뜬다.
  const gone = await request.put('/api/folders/does-not-exist-9999', { data: { name: 'x' } })
  expect(gone.status(), '없는 폴더에 저장이 성공했다').toBe(404)

  const ws = await (await request.post('/api/workspaces', { data: { name: '__폴더검증' } })).json() as { id: string }
  try {
    const f = await (await request.post('/api/folders', { data: { workspaceId: ws.id, name: 'F' } })).json() as { id: string }

    // specSourceType 은 enum 인데 SQLite 는 강제하지 않는다 — 엉뚱한 값이 박히면
    // 중복 판정은 '스펙 소스가 있다' 로 보고 동기화는 영문 모를 오류만 남긴다.
    const bad = await request.put(`/api/folders/${f.id}`, { data: { specSourceType: '아무거나' } })
    expect(bad.status(), '엉뚱한 스펙 타입이 그대로 저장됐다').toBe(400)

    // 정상 값은 그대로 저장된다(대조군 — 400 이 그냥 라우트 고장이 아님을 보인다)
    expect((await request.put(`/api/folders/${f.id}`, {
      data: { specSourceType: 'url', specSourceUrl: 'http://x/api-docs' },
    })).status()).toBe(200)
    const after = await (await request.get(`/api/folders?workspaceId=${ws.id}`)).json() as { specSourceType: string }[]
    expect(after[0].specSourceType).toBe('url')
  } finally {
    await request.delete(`/api/workspaces/${ws.id}`)
  }
})

test('구 /docs 링크 — 죽지 않고 문서 모드로 열린다', async ({ page }) => {
  await boot(page)
  // /docs 전용 페이지는 컬렉션의 문서 모드로 흡수됐다. 이미 팀에 뿌려진 링크가 있어
  // 리다이렉트로 살려 두는데, 그 약속을 지키는지 본 적이 없었다.
  await page.goto('/docs')
  await expect(page.getByText('수동 테스트')).toBeVisible({ timeout: 10_000 })
  // URL 에는 '지금 보고 있는 화면' 을 남긴다(page.tsx:302-316) — 문서 모드도 그중 하나라
  // docs=1 이 남는 게 맞다. 링크를 그대로 건네도 같은 화면이 열린다.
  await expect(page).toHaveURL(/[?&]docs=1/)
  await expect(page, '/docs 전용 경로는 더 없다').not.toHaveURL(/\/docs(\?|$)/)

  // 실행/문서 토글은 요청을 열어야 나온다 — 열었을 때 '문서' 쪽이 눌려 있어야 한다.
  await page.getByRole('button', { name: /펫 등록/ }).first().click()
  await expect(page.getByRole('button', { name: '문서 보기', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: '요청 편집', exact: true })).toHaveAttribute('aria-pressed', 'false')
})

test('요청 공유 링크 — ?req=<id> 로 열면 해당 요청 탭이 열림', async ({ page }) => {
  await boot(page)
  // id 는 API 로 얻는다. 트리에서 이름으로 클릭해 얻던 때에는, 같은 이름의 엔드포인트가
  // 다른 쪽에도 같은 이름이 있으면 .first() 가 그쪽을 집어 요청 패널이 안 열렸다.
  const reqId = await page.evaluate(async () => {
    const folders = await fetch('/api/folders?workspaceId=default').then(r => r.json())
    for (const f of folders) {
      const reqs = await fetch(`/api/requests?folderId=${f.id}`).then(r => r.json())
      if (reqs.length) return reqs[0].id as string
    }
    return null
  })
  expect(reqId, '요청이 하나는 있어야 이 검사가 의미를 갖는다').toBeTruthy()

  await page.goto(`/?req=${reqId}`)
  // 컬렉션 모드로 전환되고 해당 요청 탭이 활성화된다.
  await expect(page.getByRole('button', { name: /^Params/ })).toBeVisible({ timeout: 15_000 })
  // URL 에는 '지금 보고 있는 화면' 이 남는다 — req 도 그중 하나라 지우지 않는다(page.tsx:309).
  await expect(page).toHaveURL(new RegExp(`[?&]req=${reqId}`))
})

test('공유 링크 크로스-워크스페이스 — 다른 프로젝트 요청을 열면 그 프로젝트로 전환', async ({ page }) => {
  await boot(page)
  // 임시 워크스페이스 + 폴더 + 요청을 API 로 시딩 (현재 활성 워크스페이스는 default)
  const seed = await page.evaluate(async () => {
    const ws = await fetch('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: 'e2e-xws' }) }).then(r => r.json())
    const folder = await fetch('/api/folders', { method: 'POST', body: JSON.stringify({ name: 'e2e-xws-folder', workspaceId: ws.id }) }).then(r => r.json())
    const req = await fetch('/api/requests', { method: 'POST', body: JSON.stringify({ name: 'e2e-xws-req', method: 'GET', url: 'https://example.com', folderId: folder.id }) }).then(r => r.json())
    return { wsId: ws.id, folderId: folder.id, reqId: req.id }
  })
  try {
    // default 워크스페이스에 있는 상태에서 다른 워크스페이스의 요청 공유 링크를 연다
    await expect(page.getByLabel('프로젝트', { exact: true })).toHaveValue('default')
    await page.goto(`/?req=${seed.reqId}`)
    // 요청 탭이 열리고 + 워크스페이스 셀렉트가 그 요청의 소속 프로젝트로 전환돼야 한다
    await expect(page.getByRole('button', { name: /^Params/ })).toBeVisible()
    await expect(page.getByLabel('프로젝트', { exact: true })).toHaveValue(seed.wsId)
  } finally {
    // 시드 데이터 정리
    await page.evaluate(async (s) => {
      await fetch(`/api/requests/${s.reqId}`, { method: 'DELETE' })
      await fetch(`/api/folders/${s.folderId}`, { method: 'DELETE' })
      await fetch(`/api/workspaces/${s.wsId}`, { method: 'DELETE' })
    }, seed)
  }
})

test('Steps 탭 — Pre/Post 스텝 편집기 렌더 + op별 입력 전환', async ({ page }) => {
  await boot(page)
  await page.getByRole('button', { name: /펫 등록/ }).first().click()
  // [⋯] 메뉴의 [값 자동 입력] 으로 연다.
  await page.getByLabel('요청 도구').click()
  await page.getByRole('button', { name: /^값 자동 입력/ }).click()
  // 제목·버튼이 도메인 용어에서 사용자 말로 바뀌었다(RequestPanel.tsx:1443, 1500, 1494, 1548).
  await expect(page.getByRole('heading', { name: '1. 보낼 때마다 새 값 만들기' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '2. 응답 값을 다음 요청에 사용하기' })).toBeVisible()
  // Pre 스텝 추가 → 연산을 hmacSha256 으로 바꾸면 시크릿/메시지 입력이 나타난다
  await page.getByRole('button', { name: '+ 직접 값 생성 규칙 추가' }).click()
  await expect(page.getByLabel('연산').first()).toBeVisible()
  await page.getByLabel('연산').first().selectOption('hmacSha256')
  await expect(page.getByLabel('시크릿 키')).toBeVisible()
  await expect(page.getByLabel('메시지')).toBeVisible()
  // Post 스텝 추가 → 소스/경로/변수명
  await page.getByRole('button', { name: '+ 직접 추출 규칙 추가' }).click()
  await expect(page.getByLabel('추출 소스').first()).toBeVisible()
})

test('Auth 탭 — 방식 전환 시 OAuth2 필드 렌더', async ({ page }) => {
  await boot(page)
  await page.getByRole('button', { name: /펫 등록/ }).first().click()
  await page.getByRole('button', { name: /^Auth/ }).click()
  await page.getByLabel('인증 방식').selectOption('bearer')
  // 즐겨찾기 별의 aria-label 에 요청 이름이 들어가므로('…토큰 set diff… 즐겨찾기 추가')
  // 라벨만으로 찾으면 버튼과 겹친다 — 역할로 좁힌다.
  await expect(page.getByRole('textbox', { name: '토큰', exact: true })).toBeVisible()
  await page.getByLabel('인증 방식').selectOption('oauth2cc')
  await expect(page.getByLabel('토큰 URL')).toBeVisible()
  await expect(page.getByLabel('Client ID')).toBeVisible()
  await expect(page.getByLabel('Client Secret')).toBeVisible()
})

test('인증 주입 — bearer 가 Authorization 헤더로 전송 (echo 서버)', async ({ page }) => {
  await boot(page)
  const setup = await page.evaluate(async (envName) => {
    const envs = await fetch('/api/environments?workspaceId=default').then(r => r.json())
    const docker = envs.find((e: { name: string }) => e.name === envName)
    const folders = await fetch('/api/folders?workspaceId=default').then(r => r.json())
    let req: { id: string; url: string; params: unknown[]; headers: { key: string; value: string; enabled: boolean }[]; bodyType: string; body: string } | null = null
    for (const f of folders) {
      const rs = await fetch(`/api/requests?folderId=${f.id}`).then(r => r.json())
      const found = rs.find((x: { url: string }) => x.url.includes('pets/register'))
      if (found) { req = found; break }
    }
    return { envId: docker?.id ?? null, req }
  }, ENV)
  expect(setup.req).toBeTruthy()
  const data = await page.evaluate(async ({ envId, req }) => {
    // 기존 Authorization 헤더를 제거해야 Auth 설정이 주입된다(있으면 요청 헤더가 우선).
    const headers = req!.headers.filter(h => h.key.toLowerCase() !== 'authorization')
    const input = { method: 'POST', url: req!.url, params: req!.params, headers, bodyType: req!.bodyType, body: req!.body }
    const res = await fetch(`/api/requests/${req!.id}/execute`, {
      method: 'POST',
      body: JSON.stringify({
        executedBy: 'e2e', environmentId: envId, input,
        auth: { type: 'bearer', token: 'TESTTOKEN123' },
        postSteps: [{ name: 'echoedAuth', source: 'jsonPath', path: 'auth' }],
      }),
    })
    return res.json()
  }, setup)
  expect(data.responseStatus).toBe(200)
  const byName: Record<string, string> = Object.fromEntries((data.extracted ?? []).map((e: { name: string; value: string }) => [e.name, e.value]))
  expect(byName.echoedAuth).toBe('Bearer TESTTOKEN123')  // Auth 설정이 실제 Authorization 으로 나감
})

test('pre/post 실행 — 동적변수 전송 + 응답 값 추출 (echo 서버)', async ({ page }) => {
  await boot(page)
  const setup = await page.evaluate(async (envName) => {
    const envs = await fetch('/api/environments?workspaceId=default').then(r => r.json())
    const docker = envs.find((e: { name: string }) => e.name === envName)
    const folders = await fetch('/api/folders?workspaceId=default').then(r => r.json())
    let req: { id: string; url: string; params: unknown[]; headers: { key: string; value: string; enabled: boolean }[]; bodyType: string; body: string } | null = null
    for (const f of folders) {
      const rs = await fetch(`/api/requests?folderId=${f.id}`).then(r => r.json())
      const found = rs.find((x: { url: string }) => x.url.includes('pets/register'))
      if (found) { req = found; break }
    }
    return { envId: docker?.id ?? null, req }
  }, ENV)
  expect(setup.envId).toBeTruthy()
  expect(setup.req).toBeTruthy()

  const result = await page.evaluate(async ({ envId, req }) => {
    const input = {
      method: 'POST', url: req!.url, params: req!.params,
      headers: [...req!.headers, { key: 'Authorization', value: 'Bearer {{$uuid}}', enabled: true }],
      bodyType: req!.bodyType, body: req!.body,
    }
    const res = await fetch(`/api/requests/${req!.id}/execute`, {
      method: 'POST',
      body: JSON.stringify({
        executedBy: 'e2e', environmentId: envId, input,
        preSteps: [{ name: 'sig', op: 'hmacSha256', key: 'k', input: 'm', secret: true }],
        postSteps: [
          { name: 'ok', source: 'jsonPath', path: 'success' },
          { name: 'echoedAuth', source: 'jsonPath', path: 'auth' },
        ],
      }),
    })
    return res.json()
  }, setup)

  expect(result.responseStatus).toBe(200)
  const byName: Record<string, string> = Object.fromEntries((result.extracted ?? []).map((e: { name: string; value: string }) => [e.name, e.value]))
  expect(byName.ok).toBe('true')                                // echo success:true 추출됨
  expect(byName.echoedAuth).toMatch(/^Bearer [0-9a-f-]{36}$/)   // {{$uuid}} 동적변수가 실제 전송됨
})

/**
 * 좁은 칸에 들어간 긴 값은 잘린다. 입력칸이라 스크롤은 되지만 커서를 끝까지 끌고 가야
 * 보이는 것이고, 눈으로 한 번에 확인할 방법이 없었다 — baseUrl 처럼 뒤쪽이
 * 스테이지/운영을 가르는 값에서 특히 곤란하다.
 */
test('긴 값 — 편집 칸이 늘어나 전체가 보인다', async ({ page }) => {
  await boot(page)
  await page.getByTestId('rail-settings').click()
  const dialog = page.getByRole('dialog', { name: '설정' })
  await expect(dialog).toBeVisible()

  const value = dialog.getByLabel('변수 값').first()
  await expect(value).toBeVisible({ timeout: 10_000 })
  const full = 'https://example.test/' + 'long-variable-path/'.repeat(12)
  await value.fill(full)
  await value.blur()

  expect(await value.evaluate(el => el.scrollHeight <= el.clientHeight + 2 && el.scrollWidth <= el.clientWidth + 2)).toBe(true)
  await expect(value).toHaveValue(full)

})

/**
 * 서버가 500 을 주면 어떻게 보이는가.
 *
 * `await (await fetch(url)).json()` 이 곳곳에 있었다. 500 의 {error} 를 그대로
 * 돌려주니 받는 쪽이 배열인 줄 알고 .map 을 불러 TypeError 가 났고, 잡는 곳이 없으면
 * 화면은 '아무것도 없음' 으로 보였다 — 서버가 죽은 건지 정말 0개인지 알 수 없다.
 */
test('서버 500 — 빈 화면이 아니라 이유가 뜬다', async ({ page }) => {
  const crashes: string[] = []
  page.on('pageerror', e => crashes.push(String(e)))

  await boot(page)
  let failedFolderLoads = 0
  await page.route('**/api/folders?workspaceId=*', r => {
    failedFolderLoads++
    return r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '테스트용 서버 오류' }) })
  })

  // ⌘K 팔레트 — 예전엔 catch 조차 없어 조용히 빈 목록이었다
  await page.keyboard.press('ControlOrMeta+KeyK')
  const palette = page.getByRole('dialog', { name: '커맨드 팔레트' })
  await expect(palette).toBeVisible()
  // 전체 실행에서 가끔 여기서 깨졌다(단독으로는 매번 통과). 다음에 깨지면 원인을 가르도록,
  // 팔레트가 실제로 실패하는 조회를 겪었는지 먼저 확인한다 — 0 이면 테스트 쪽 문제다.
  await expect.poll(() => failedFolderLoads, { message: '팔레트가 목록을 다시 부르지 않았다(가로챈 조회 0회)' }).toBeGreaterThan(0)
  await expect(palette.getByText('요청 목록 조회 실패')).toBeVisible({ timeout: 10_000 })
  // 원인은 [오류 상세 보기] 접힘 안에 있다(LoadFailed) — 한 줄이 아닐 때가 많아서다.
  await palette.getByText('오류 상세 보기').click()
  await expect(palette.getByText('테스트용 서버 오류')).toBeVisible()
  await page.keyboard.press('Escape')

  // 컬렉션 트리도 같은 규칙
  await page.reload()
  await expect(page.getByText('폴더 목록 조회 실패').first()).toBeVisible({ timeout: 15_000 })

  // 렌더 도중 죽지 않았다 — 예전에는 .map/.filter 가 TypeError 를 던졌다
  expect(crashes.filter(c => /is not a function|undefined is not/.test(c))).toEqual([])
})

/**
 * 타입이 틀린 입력은 400 이어야 한다 — 500 도, 201 도 아니다.
 *
 * `if (!b.name)` / `b?.name?.trim()` 은 문자열 검증이 아니다. ?. 은 null/undefined 만
 * 막아서 숫자·배열·객체가 오면 'trim is not a function' 으로 500 이 났고(500 은
 * '우리가 잘못했다' 는 신호라 원인을 엉뚱한 데서 찾게 된다), truthy 검사만 하는 곳은
 * flowId=999 짜리 스케줄을 201 로 만들어 줬다.
 *
 * 스케줄이 특히 나쁘다. 사람이 안 볼 때 도는 것이라 등록 시점엔 아무 일도 없다가
 * 새벽에 조용히 실패한다 — 여기서 막지 않으면 그때까지 아무도 모른다.
 */
test('API — 타입이 틀린 입력을 400 으로 거절한다', async ({ request }) => {
  const cases: { path: string; body: unknown; want: number; label: string }[] = [
    { path: '/api/workspaces', body: { name: 123 }, want: 400, label: '숫자 이름' },
    { path: '/api/workspaces', body: { name: ['a'] }, want: 400, label: '배열 이름' },
    { path: '/api/workspaces', body: { name: { a: 1 } }, want: 400, label: '객체 이름' },
    { path: '/api/workspaces', body: { name: '   ' }, want: 400, label: '공백 이름' },
    { path: '/api/schedules', body: { flowId: 999 }, want: 400, label: '숫자 flowId' },
    { path: '/api/schedules', body: { flowId: { x: 1 } }, want: 400, label: '객체 flowId' },
    { path: '/api/cookies', body: { domain: 5, cookieString: 'a=b' }, want: 400, label: '숫자 domain' },
    { path: '/api/cookies', body: { domain: 'a.com', cookieString: 9 }, want: 400, label: '숫자 쿠키문자열' },
    { path: '/api/folders', body: { workspaceId: 'default', name: 123 }, want: 400, label: '폴더 이름=숫자' },
    { path: '/api/flows', body: { workspaceId: 'default', name: [1] }, want: 400, label: '시나리오 이름=배열' },
    { path: '/api/environments', body: { workspaceId: 'default', name: { a: 1 } }, want: 400, label: '환경 이름=객체' },
    { path: '/api/folders/reorder', body: { id: { a: 1 } }, want: 400, label: '폴더 reorder id=객체' },
  ]
  for (const c of cases) {
    const res = await request.post(c.path, { data: c.body })
    expect(res.status(), `${c.label} → ${c.path}`).toBe(c.want)
    // 400 이면 왜인지 말해야 한다 — 빈 400 은 무엇을 고쳐야 할지 안 알려준다
    expect((await res.json()).error, `${c.label}: 이유가 있어야 한다`).toBeTruthy()
  }

  // 실제 id 가 있어야 하는 것들 — 이름을 숫자로 바꾸면 SQLite 에 숫자로 저장돼
  // 목록에 '123.0' 이 뜬다. 조용히 저장되니 되돌리려면 원본을 찾아야 한다(실제로 겪었다).
  const folders = await (await request.get('/api/folders?workspaceId=default')).json() as { id: string }[]
  const reqs = await (await request.get(`/api/requests?folderId=${folders[0].id}`)).json() as { id: string; name: string }[]
  const envs = await (await request.get('/api/environments?workspaceId=default')).json() as { id: string }[]

  for (const c of [
    { path: `/api/requests`, body: { folderId: folders[0].id, name: 123 }, label: '요청 생성 이름=숫자' },
    { path: '/api/requests/reorder', body: { id: 1, folderId: folders[0].id }, label: 'reorder id=숫자' },
  ]) {
    const res = await request.post(c.path, { data: c.body })
    expect(res.status(), c.label).toBe(400)
  }
  for (const c of [
    { path: `/api/requests/${reqs[0].id}`, body: { name: 123 }, label: '요청 수정 이름=숫자' },
    { path: `/api/environments/${envs[0].id}`, body: { name: 123 }, label: '환경 수정 이름=숫자' },
  ]) {
    const res = await request.put(c.path, { data: c.body })
    expect(res.status(), c.label).toBe(400)
  }
  // 거절됐으니 이름이 그대로여야 한다 — 이 검사가 없으면 '400 을 주면서 저장도 했다' 를 놓친다
  const after = await (await request.get(`/api/requests?folderId=${folders[0].id}`)).json() as { name: string }[]
  expect(after[0].name, '거절된 요청이 데이터를 바꾸면 안 된다').toBe(reqs[0].name)

  // 없는 시나리오를 가리키는 스케줄은 만들지 않는다 (형식은 맞지만 존재하지 않는 id)
  const ghost = await request.post('/api/schedules', { data: { flowId: '00000000-0000-4000-8000-000000000000' } })
  expect(ghost.status(), '없는 시나리오면 404').toBe(404)
  expect((await ghost.json()).error).toContain('찾을 수 없습니다')
})

/**
 * secret 은 실행 이력에 남으면 안 된다 — 이력은 팀 전체가 본다.
 *
 * 코드에 마스킹이 있는 것과 실제로 안 새는 것은 다른 이야기라서, 끝에서 끝까지 확인한다.
 * 특히 응답 쪽이 놓치기 쉽다: 대상 서버가 받은 토큰을 그대로 돌려주면(에코·디버그
 * 엔드포인트가 흔히 그런다) 요청은 가렸는데 응답에 원문이 남는다.
 *
 * 실데이터를 건드리지 않으려고 임시 프로젝트를 만들고 끝나면 지운다.
 */
test('secret — 실행 이력 어디에도 원문이 남지 않는다', async ({ request }) => {
  const SENTINEL = `SENTINEL-${Date.now()}-DO-NOT-LEAK`
  const ws = await (await request.post('/api/workspaces', { data: { name: '__보안점검_임시' } })).json() as { id: string }
  try {
    const env = await (await request.post('/api/environments', { data: { workspaceId: ws.id, name: 'probe' } })).json() as { id: string }
    await request.put(`/api/environments/${env.id}`, { data: { name: 'probe', variables: [
      { key: 'baseUrl', value: `http://${HOST}:${process.env.E2E_ECHO_PORT ?? '9999'}`, secret: false },
      { key: 'tok', value: SENTINEL, secret: true },
    ] } })
    // secret 은 조회 응답에도 실리면 안 된다
    const envs = await (await request.get(`/api/environments?workspaceId=${ws.id}`)).text()
    expect(envs, '환경 조회 응답').not.toContain(SENTINEL)

    const folder = await (await request.post('/api/folders', { data: { workspaceId: ws.id, name: 'probe' } })).json() as { id: string }
    const req = await (await request.post('/api/requests', { data: { folderId: folder.id, name: 'probe' } })).json() as { id: string }

    const exec = await request.post(`/api/requests/${req.id}/execute`, { data: {
      executedBy: '보안점검', environmentId: env.id,
      input: {
        method: 'POST', url: '{{baseUrl}}/echo', bodyType: 'json', params: [],
        headers: [{ key: 'Authorization', value: 'Bearer {{tok}}', enabled: true }],
        body: '{"t":"{{tok}}"}',
      },
    } })
    expect(exec.status(), '실행이 성공해야 이 검사가 의미를 갖는다').toBe(200)
    expect((await exec.json()).responseStatus).toBe(200)

    const history = await (await request.get(`/api/requests/${req.id}/executions`)).text()
    expect(JSON.parse(history), '이력이 실제로 쌓여야 한다').toHaveLength(1)
    // 요청·응답·헤더·바디 어디에도 없어야 한다
    expect(history, '실행 이력 전체').not.toContain(SENTINEL)
    // 가린 흔적은 남아야 한다 — 통째로 지우면 무엇을 보냈는지 알 수 없다
    expect(history).toContain('{{tok}}')
  } finally {
    await request.delete(`/api/workspaces/${ws.id}`)
    const left = await (await request.get('/api/workspaces')).json() as { name: string }[]
    expect(left.map(w => w.name), '임시 프로젝트를 남기지 않는다').not.toContain('__보안점검_임시')
  }
})

/**
 * 이 앱은 저장·실패·복사를 전부 토스트로만 알린다 — 놓치면 아무 피드백이 없는 것과 같다.
 *
 * 토스트 자체에 role="status" 만 있었다. 알릴 내용과 알릴 자리가 동시에 생기는 모양이라
 * 스크린리더가 놓치는 경우가 있어, 늘 떠 있는 컨테이너로 옮겼다.
 */
test('토스트 — 알림이 스크린리더에 전달될 자리가 미리 있다', async ({ page }) => {
  await boot(page)
  // 토스트가 하나도 없을 때부터 살아있는 영역이 DOM 에 있어야 한다
  const live = page.locator('[aria-live="polite"]')
  await expect(live).toHaveCount(1)
  await expect(live).toBeAttached()

  // 실제 토스트가 그 안에 들어간다.
  // 예전엔 '개수 >= 0' 을 확인했다 — 0 도 통과하므로 아무것도 안 본 것과 같았다. 게다가 요청 실행은
  // 성공 토스트를 띄우지 않는다. 확실히 토스트를 띄우는 동작(링크 복사 — 권한이 없으면 실패
  // 토스트)을 하고, 그 문구가 live 영역 **안에** 나타나는지 본다. 사라지기 전에 잡으므로 poll 한다.
  await page.getByRole('button', { name: /펫 등록/ }).first().click()
  await expect(page.getByRole('button', { name: /^Params/ })).toBeVisible({ timeout: 10_000 })
  await page.getByTestId('request-toolbar').getByRole('button', { name: '링크 복사', exact: true }).click()
  await expect(live.getByText(/링크 복사됨|복사하지 못했습니다/)).toBeVisible()
})

/**
 * 시나리오에서 뽑은 값을 이력에서 가릴 수 있어야 한다.
 *
 * '로그인 → 토큰 추출 → 다음 단계' 가 시나리오의 가장 흔한 모양인데, 뽑은 값에는
 * secret 개념이 없었다. Authorization 헤더에 넣을 때만 헤더 이름 덕에 우연히
 * 가려졌고, URL 쿼리(?access_token=)나 바디에 넣으면 팀이 보는 이력에 평문으로 남았다.
 */
test('시나리오 추출 — 가리기를 켜면 URL·바디에서도 값이 안 남는다', async ({ request }) => {
  const ws = await (await request.post('/api/workspaces', { data: { name: '__추출점검_임시' } })).json() as { id: string }
  try {
    const env = await (await request.post('/api/environments', { data: { workspaceId: ws.id, name: 'p' } })).json() as { id: string }
    await request.put(`/api/environments/${env.id}`, { data: { name: 'p', variables: [
      { key: 'baseUrl', value: `http://${HOST}:${process.env.E2E_ECHO_PORT ?? '9999'}`, secret: false },
    ] } })
    const folder = await (await request.post('/api/folders', { data: { workspaceId: ws.id, name: 'p' } })).json() as { id: string }

    const mk = async (name: string, patch: object) => {
      const r = await (await request.post('/api/requests', { data: { folderId: folder.id, name } })).json() as { id: string }
      await request.put(`/api/requests/${r.id}`, { data: patch })
      return r.id
    }
    // 1단계가 되돌려주는 값을 뽑고, 2단계에서 헤더가 아닌 URL·바디에 넣는다
    const login = await mk('login', { method: 'POST', url: '{{baseUrl}}/echo', bodyType: 'json', body: '{}',
      headers: [{ key: 'X-Probe', value: 'RUNTIME-TOKEN-abc123', enabled: true }] })
    const use = await mk('use', { method: 'POST', url: '{{baseUrl}}/echo?t={{tok}}', bodyType: 'json',
      body: '{"passed":"{{tok}}"}', headers: [] })

    const flow = await (await request.post('/api/flows', { data: { workspaceId: ws.id, name: 'c' } })).json() as { id: string }
    const runWith = async (secret: boolean) => {
      await request.put(`/api/flows/${flow.id}`, { data: { name: 'c', steps: [
        { requestId: login, extracts: [{ path: 'headers.x-probe', variable: 'tok', secret }] },
        { requestId: use, extracts: [] },
      ] } })
      const out = await (await request.post(`/api/flows/${flow.id}/run`, { data: { executedBy: '점검', environmentId: env.id } })).json() as
        { steps: { extracted?: Record<string, string>; execution?: { resolved: { url: string; body: string } } }[] }
      expect(out.steps[0].extracted?.tok, '추출이 실제로 돼야 이 검사가 의미를 갖는다').toBe('RUNTIME-TOKEN-abc123')
      return out.steps[1].execution!.resolved
    }

    // 끄면 평문 — 이 상태가 예전 동작이다
    const plain = await runWith(false)
    expect(plain.url).toContain('RUNTIME-TOKEN-abc123')
    expect(plain.body).toContain('RUNTIME-TOKEN-abc123')

    // 켜면 헤더가 아닌 자리에서도 값이 안 남는다
    const masked = await runWith(true)
    expect(masked.url, 'URL').not.toContain('RUNTIME-TOKEN-abc123')
    expect(masked.body, '바디').not.toContain('RUNTIME-TOKEN-abc123')
    expect(masked.url).toContain('{{tok}}')
  } finally {
    await request.delete(`/api/workspaces/${ws.id}`)
  }
})

/**
 * MCP 도구의 출력은 사람의 화면이 아니라 LLM 의 컨텍스트로 들어간다.
 *
 * 실행 라우트는 '실행 본인' 에게 실 응답을 돌려준다 — 그 사람은 시크릿의 주인이니 맞다.
 * 그런데 MCP 가 그걸 그대로 넘기면 secret 이 모델 제공자에게까지 흘러간다.
 * 대상 서버가 받은 토큰을 되돌려주는 경우(에코·디버그 엔드포인트)에 실제로 그랬다.
 */
test('MCP — 도구 응답에 secret 원문이 실리지 않는다', async ({ request }) => {
  const SENTINEL = `MCP-SENTINEL-${Date.now()}`
  const mcp = async (name: string, args: object) => {
    const res = await request.post('/api/mcp/mcp', {
      headers: { accept: 'application/json, text/event-stream' },
      data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    })
    const raw = await res.text()
    const line = raw.split('\n').find(l => l.startsWith('data: '))
    return JSON.parse(line ? line.slice(6) : raw) as { result?: { isError?: boolean; content: { text: string }[] } }
  }

  const ws = await (await request.post('/api/workspaces', { data: { name: '__MCP점검_임시' } })).json() as { id: string }
  try {
    const env = await (await request.post('/api/environments', { data: { workspaceId: ws.id, name: '스테이지' } })).json() as { id: string }
    await request.put(`/api/environments/${env.id}`, { data: { name: '스테이지', variables: [
      { key: 'baseUrl', value: `http://${HOST}:${process.env.E2E_ECHO_PORT ?? '9999'}`, secret: false },
      { key: 'tok', value: SENTINEL, secret: true },
    ] } })
    const folder = await (await request.post('/api/folders', { data: { workspaceId: ws.id, name: 'p' } })).json() as { id: string }
    const req = await (await request.post('/api/requests', { data: { folderId: folder.id, name: 's' } })).json() as { id: string }
    await request.put(`/api/requests/${req.id}`, { data: {
      method: 'POST', url: '{{baseUrl}}/echo', bodyType: 'json', body: '{"t":"{{tok}}"}',
      headers: [{ key: 'Authorization', value: 'Bearer {{tok}}', enabled: true }],
    } })

    // 쓰기는 기본 거부된다. 거부를 확인한 뒤 허용해야 실제 응답 마스킹을 검증할 수 있다.
    const denied = await mcp('execute_request', { requestId: req.id, environmentName: '스테이지', workspaceId: ws.id })
    expect(denied.result?.isError).toBe(true)
    expect(denied.result!.content[0].text).toContain('AI 실행 허용')
    expect((await request.put(`/api/requests/${req.id}`, { data: { aiExecutionAllowed: true } })).ok()).toBe(true)

    const out = await mcp('execute_request', { requestId: req.id, environmentName: '스테이지', workspaceId: ws.id })
    expect(out.result?.isError).not.toBe(true)
    const text = out.result!.content[0].text
    const body = JSON.parse(text) as { status: number; responseBody: string | null }

    // 실행이 실제로 성공해야 이 검사가 의미를 갖는다 — 아무 일도 안 일어나면 당연히 안 샌다
    expect(body.status, '실행이 성공해야 한다').toBe(200)
    expect(body.responseBody, '응답 본문은 계속 와야 한다 — 통째로 지우면 도구가 쓸모없다').toBeTruthy()
    // 가린 흔적은 남되 원문은 없어야 한다
    expect(text, 'MCP 도구 응답 전체').not.toContain(SENTINEL)
    expect(body.responseBody).toContain('***')
  } finally {
    await request.delete(`/api/workspaces/${ws.id}`)
  }
})

/**
 * 스펙이 0개로 읽히면 기존 요청을 폐기하지 않고 멈춰야 한다.
 *
 * 실제로 겪은 사고다 — 상류가 빈 스펙을 200 으로 주는 바람에 한 서비스의
 * 요청 140개가 한 번에 deprecated 로 바뀌었다. 상류 장애는 언제든 다시 나고,
 * 동기화는 폴더 하나를 통째로 바꾸는 조작이라 되돌리기가 어렵다.
 */
test('스펙 동기화 — 0개로 읽히면 기존 요청을 폐기하지 않고 멈춘다', async ({ request }) => {
  const ws = await (await request.post('/api/workspaces', { data: { name: '__동기화점검_임시' } })).json() as { id: string }
  try {
    // 1) 정상 스펙으로 폴더를 만들고 동기화 — 요청이 생긴다
    const folder = await (await request.post('/api/folders', { data: {
      workspaceId: ws.id, name: 'sync-probe',
      specSourceType: 'url', specSourceUrl: `http://${HOST}:${process.env.E2E_SPEC_PORT ?? '9998'}/v3/api-docs`,
    } })).json() as { id: string }
    const first = await request.post(`/api/folders/${folder.id}/sync`)
    expect(first.status(), '정상 스펙 동기화 — 실패하면 목 스펙 서버(:9998)가 떠 있는지 확인 (npm run e2e:mock-spec)').toBe(200)
    const made = await (await request.get(`/api/requests?folderId=${folder.id}`)).json() as unknown[]
    expect(made.length, '스펙에서 요청이 만들어져야 한다').toBeGreaterThan(0)

    // 2) 소스가 빈 스펙을 주게 바꾼다 (상류 장애를 흉내낸다 — 200 인데 paths 가 없다)
    await request.put(`/api/folders/${folder.id}`, { data: {
      specSourceUrl: `http://${HOST}:${process.env.E2E_SPEC_PORT ?? '9998'}/empty/api-docs`,
    } })
    const empty = await request.post(`/api/folders/${folder.id}/sync`)
    expect(empty.status(), '0개가 오면 409 로 멈춘다').toBe(409)
    const body = await empty.json() as { error: string; aborted: boolean; existing: number }
    expect(body.aborted).toBe(true)
    expect(body.existing).toBe(made.length)
    // 왜 멈췄고 무엇을 하면 되는지 말해야 한다
    expect(body.error).toContain('폐기하지 않고')

    // 3) 요청이 그대로 살아 있고 폐기 표시도 안 붙었다
    const after = await (await request.get(`/api/requests?folderId=${folder.id}`)).json() as { specState: string | null }[]
    expect(after.length, '요청 수가 그대로여야 한다').toBe(made.length)
    expect(after.filter(r => r.specState === 'deprecated'), '폐기된 것이 없어야 한다').toHaveLength(0)

    // 4) 대조군 — force=1 이면 실제로 폐기된다.
    //    이게 없으면 '가드가 막은 것' 인지 '원래 폐기가 안 되는 것' 인지 구분이 안 돼,
    //    가드를 지워도 테스트가 통과해 버린다.
    const forced = await request.post(`/api/folders/${folder.id}/sync?force=1`)
    expect(forced.status(), 'force 면 통과한다').toBe(200)
    const afterForce = await (await request.get(`/api/requests?folderId=${folder.id}`)).json() as { specState: string | null }[]
    expect(afterForce.filter(r => r.specState === 'deprecated').length,
      'force 로는 실제로 폐기된다 — 위 3번이 가드 덕분임을 증명한다').toBe(made.length)
  } finally {
    await request.delete(`/api/workspaces/${ws.id}`)
  }
})

/**
 * 내보내기/가져오기는 팀 이사·백업의 통로다. 두 가지가 동시에 성립해야 한다.
 *  - 내용이 그대로 돌아온다 (하나라도 빠지면 이사한 쪽에서 조용히 없어진다)
 *  - 자격증명은 안 실린다 (파일은 서버 밖으로 나가는 물건이다)
 * 둘 중 하나만 보면 '아무것도 안 담아서 안 샜다' 같은 가짜 통과가 난다.
 */
test('내보내기/가져오기 — 내용은 그대로, 자격증명은 안 실린다', async ({ request }) => {
  const SECRET = `EXPORT-SECRET-${Date.now()}`
  const src = await (await request.post('/api/workspaces', { data: { name: '__왕복_원본' } })).json() as { id: string }
  let dst: { id: string } | null = null
  try {
    const env = await (await request.post('/api/environments', { data: { workspaceId: src.id, name: '스테이지' } })).json() as { id: string }
    await request.put(`/api/environments/${env.id}`, { data: { name: '스테이지', variables: [
      { key: 'baseUrl', value: 'https://x.example', secret: false },
      { key: 'tok', value: SECRET, secret: true },
    ] } })
    const folder = await (await request.post('/api/folders', { data: { workspaceId: src.id, name: '폴더A' } })).json() as { id: string }
    await request.put(`/api/folders/${folder.id}`, { data: { sharedHeaders: [{ key: 'X-Team', value: 'team-a', enabled: true }] } })

    const want: [string, string, string][] = []
    for (const [i, [name, method]] of ([['요청1', 'GET'], ['요청2', 'POST'], ['요청3', 'DELETE']] as const).entries()) {
      const r = await (await request.post('/api/requests', { data: { folderId: folder.id, name } })).json() as { id: string }
      await request.put(`/api/requests/${r.id}`, { data: {
        method, url: `{{baseUrl}}/p${i}`, bodyType: 'json', body: `{"a":${i}}`,
        headers: [{ key: 'X-N', value: String(i), enabled: true },
                  { key: 'Authorization', value: 'Bearer LITERAL-TOKEN', enabled: true }],
        params: [{ key: 'q', value: `v${i}`, enabled: true }], tags: [`t${i}`],
      } })
      want.push([name, method, `{{baseUrl}}/p${i}`])
    }

    // 순서를 손으로 바꿔 둔다 — 왕복 뒤에도 이 순서여야 한다.
    // (정렬 없이 뽑던 시절엔 파일에 생성순이 담겨 왕복 한 번에 되돌아갔다)
    const srcReqs = await (await request.get(`/api/requests?folderId=${folder.id}`)).json() as { id: string; name: string }[]
    const last = srcReqs[srcReqs.length - 1]
    await request.post('/api/requests/reorder', { data: { id: last.id, folderId: folder.id, beforeId: srcReqs[0].id } })
    const wantOrder = (await (await request.get(`/api/requests?folderId=${folder.id}`)).json() as { name: string }[]).map(r => r.name)
    expect(wantOrder[0], '순서 바꾸기가 안 먹었다 — 뒤 검증이 의미 없어진다').toBe(last.name)

    const doc = await (await request.get('/api/export')).json() as {
      exportedAt: string
      folders: { id: string; sharedHeaders: string }[]
      requests: { folderId: string }[]
      environments: { id: string }[]
    }
    const dump = JSON.stringify(doc)
    expect(dump, 'secret 변수 실값').not.toContain(SECRET)
    expect(dump, '헤더에 하드코딩된 자격증명').not.toContain('LITERAL-TOKEN')

    // export 는 전체 DB 다(의도) — 이 테스트가 만든 것만 골라 옮긴다
    const mine = {
      postq: 1, exportedAt: doc.exportedAt,
      folders: doc.folders.filter(f => f.id === folder.id),
      requests: doc.requests.filter(r => r.folderId === folder.id),
      environments: doc.environments.filter(e => e.id === env.id),
      globalVars: [],
    }
    dst = await (await request.post('/api/workspaces', { data: { name: '__왕복_대상' } })).json() as { id: string }
    const imported = await request.post('/api/import/postq', { data: { ...mine, workspaceId: dst.id } })
    expect(imported.status()).toBe(201)
    expect(await imported.json()).toMatchObject({ folderCount: 1, requestCount: 3, environmentCount: 1 })

    const fs = await (await request.get(`/api/folders?workspaceId=${dst.id}`)).json() as { id: string; name: string; sharedHeaders: unknown[] }[]
    expect(fs).toHaveLength(1)
    expect(fs[0].name).toBe('폴더A')
    expect(fs[0].sharedHeaders, '폴더 공통 헤더도 따라와야 한다').toHaveLength(1)

    const rs = await (await request.get(`/api/requests?folderId=${fs[0].id}`)).json() as
      { name: string; method: string; url: string; body: string; params: unknown[]; tags?: string[]; headers: { key: string; value: string }[] }[]
    expect(rs.map(r => [r.name, r.method, r.url]).sort()).toEqual(want.sort())
    // 손으로 맞춰 둔 순서가 그대로 와야 한다. 이게 어긋나면 이사할 때마다 다시 정렬해야 한다.
    expect(rs.map(r => r.name), '왕복하면서 순서가 흐트러졌다').toEqual(wantOrder)
    for (const r of rs) {
      expect(r.params, '파라미터').toHaveLength(1)
      expect(r.tags, '태그').toHaveLength(1)
      // 자격증명은 마스킹된 채로 넘어온다 — 값은 없지만 '있었다' 는 흔적은 남는다
      expect(r.headers.find(h => h.key === 'Authorization')?.value).toBe('***')
    }
  } finally {
    await request.delete(`/api/workspaces/${src.id}`)
    if (dst) await request.delete(`/api/workspaces/${dst.id}`)
  }
})

/**
 * 조회가 잠깐 실패했다고 환경 목록을 비우면 안 된다.
 *
 * 비우면 화면에 '환경 없음' 으로 보이고, 사용자는 환경이 사라진 줄 알고 다시 만든다 —
 * 통신이 한 번 튄 대가로 중복 환경이 남는다. 이 앱에서 '없어 보이는 것' 이 만들어낸
 * 중복은 이미 겪었다(폴더 21개).
 */
test('환경 목록 — 조회가 실패해도 있던 목록이 사라지지 않는다', async ({ page }) => {
  await boot(page)
  await page.getByRole('button', { name: /펫 등록/ }).first().click()
  const envSelect = page.getByLabel('실행 환경')
  await expect(envSelect).toBeVisible()
  // 선택 상자는 목록이 오기 전에도 보인다 — 채워질 때까지 기다렸다 센다(바로 세면 가끔 0 이 나왔다).
  // 센 값은 poll 안에서 바로 적는다. poll 이 끝난 뒤 다시 세면, 그 사이 패널이 다시 그려지며
  // 잠깐 빈 순간을 잡아 before=0 이 됐다(전체 실행에서만 두 번 연속 재현).
  // 구분선·[환경·변수 관리…] 는 늘 있는 항목이라 빼고 센다 — 넣고 세면 목록이 오기 전에도 1 을 넘는다.
  const envOptions = envSelect.locator('option:not([disabled]):not([value="__manage_envs__"])')
  let before = 0
  await expect.poll(async () => (before = await envOptions.count()), { message: '환경이 있어야 이 검사가 의미를 갖는다' }).toBeGreaterThan(1)

  // 이후 목록 조회를 전부 실패시킨 뒤, 앱이 실제로 다시 부르게 만든다.
  // 예전엔 설정 창을 열었다 닫기만 했다 — 재조회는 환경 '저장 성공' 뒤에만 일어나서, 실패하는 GET 이
  // 한 번도 나가지 않았다. 아무것도 안 겪고 '목록이 그대로다' 를 확인한 셈이었다.
  let failedGets = 0
  await page.route('**/api/environments?workspaceId=*', r => { failedGets++; return r.abort('failed') })
  // 저장은 목으로 성공시킨다 — 실데이터를 바꾸지 않고 '저장 뒤 재조회' 경로만 탄다
  await page.route('**/api/environments/*', r => r.request().method() === 'PUT'
    ? r.fulfill({ json: { updatedAt: Date.now(), variables: [] } })
    : r.fallback())
  await page.getByTestId('rail-settings').click()
  await page.getByTestId('settings-env').click()
  const dialog = page.getByRole('dialog', { name: '설정' })
  await dialog.getByRole('button', { name: /^저장/ }).click()
  await expect.poll(() => failedGets, { message: '재조회가 한 번도 안 나갔다 — 이 검사가 아무것도 안 본다' }).toBeGreaterThan(0)
  await page.keyboard.press('Escape')

  await expect(envSelect, '목록이 그대로 있어야 한다').toBeVisible()
  expect(await envOptions.count(), '항목 수가 줄면 안 된다').toBe(before)
})

test('secret 이 상해 있으면 빈칸으로 위장하지 않는다', async ({ page }) => {
  // 값이 안 보이는 자리라 살아 있는 secret 과 못 푸는 secret 이 똑같은 빈칸이다.
  // 실제로 이 저장소의 secret 5개가 옛 키에 묶여 죽어 있었는데 아무도 몰랐다 —
  // 요청은 빈 자격증명으로 나가고 401 만 받았다.
  await page.route('**/api/environments?workspaceId=*', async r => {
    await r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        id: 'env-broken', name: '스테이지', updatedAt: 1,
        variables: [
          { id: 'v1', key: 'baseUrl', value: 'https://example.test', secret: false },
          { id: 'v2', key: 'api-key', value: '', secret: true, keyState: 'broken' },
          { id: 'v3', key: 'token', value: '', secret: true, keyState: 'old' },
        ],
      }]),
    })
  })

  await boot(page)
  await page.getByTestId('rail-settings').click()
  await page.getByTestId('settings-env').click()

  // 못 읽는 값 — 개수와 결과(빈 값으로 나간다)를 말한다
  await expect(page.getByText(/비밀값 1개를 읽을 수 없습니다/)).toBeVisible()
  await expect(page.getByPlaceholder(/값을 읽을 수 없습니다/)).toBeVisible()

  // 옛 키에 묶인 값 — 고장이 아니라 '옮기면 된다' 로 말하고, 옮길 방법을 준다
  await expect(page.getByText(/옛 키에 묶여 있습니다/)).toBeVisible()
  await expect(page.getByRole('button', { name: '현재 키로 옮기기' })).toBeVisible()

  // 대조군: 멀쩡한 secret 만 있으면 아무 경고도 안 뜬다(항상 켜져 있는 배너가 아니다)
  await page.unroute('**/api/environments?workspaceId=*')
  await page.route('**/api/environments?workspaceId=*', async r => {
    await r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify([{
        id: 'env-ok', name: '스테이지', updatedAt: 1,
        variables: [{ id: 'v2', key: 'api-key', value: '', secret: true, keyState: 'current' }],
      }]),
    })
  })
  await page.reload()
  await page.getByTestId('rail-settings').click()
  await page.getByTestId('settings-env').click()
  await expect(page.getByRole('button', { name: '현재 키로 옮기기' })).toHaveCount(0)
  await expect(page.getByText(/읽을 수 없습니다/)).toHaveCount(0)
})

test('사이드바 — 창이 넓으면 460px 을 넘겨 넓힐 수 있다', async ({ page }) => {
  // 상한이 460px 로 박혀 있었다. 긴 요청 이름이 잘리는데 더 넓힐 방법이
  // 없었고, 끝까지 당겨 둔 상태에서는 아무리 끌어도 안 움직이니 '크기 조절이 없다' 로 보인다.
  await page.addInitScript(() => localStorage.removeItem('ah:sidebarWidth'))
  await page.setViewportSize({ width: 1800, height: 900 })
  await boot(page)

  const pane = page.getByTestId('sidebar-pane')
  const before = (await pane.boundingBox())!.width
  const handle = page.getByRole('separator', { name: '사이드바 크기 조절' })
  const hb = (await handle.boundingBox())!

  await page.mouse.move(hb.x + hb.width / 2, hb.y + 100)
  await page.mouse.down()
  await page.mouse.move(hb.x + 900, hb.y + 100, { steps: 10 })
  await page.mouse.up()

  const after = (await pane.boundingBox())!.width
  expect(before, '기본값은 460 이하여야 이 검사가 의미를 갖는다').toBeLessThanOrEqual(460)
  expect(after, '옛 상한(460px)을 넘어야 한다').toBeGreaterThan(460)
  // 그렇다고 가운데를 없애면 안 된다 — 최소 480px 은 남긴다
  expect(after).toBeLessThanOrEqual(1800 - 480)
})

test('환경 선택은 창 전체의 것 — 요청 툴바가 아니라 상단 바에 있다', async ({ page }) => {
  // 환경은 요청 하나의 설정이 아니라 창 전체의 상태다(탭을 바꿔도 따라간다).
  // 요청마다 있는 것처럼 보이면 '이 탭만 스테이지' 로 오해하고, 그 한 줄 때문에
  // 툴바가 2행이 됐다 — 1600×950 에서 파라미터 한 줄을 보기까지 304px 를 머리말이 먹었다.
  await boot(page)
  await page.getByRole('button', { name: /펫 등록/ }).first().click()

  // 자리는 그 뒤로 한 번 더 옮겨졌다(요청을 열면 요청 머리줄, 아니면 가운데 패널 위).
  // DOM 조상이 <header> 냐로 묶으면 배치를 손볼 때마다 깨진다 — 확인할 건 배치가 아니라
  // ① 화면에 하나만 있고 ② '창 전체' 라고 말하고 ③ 실행 줄을 밀어내지 않는다는 것이다.
  const env = page.getByLabel('실행 환경')
  await expect(env).toHaveCount(1)
  await expect(env).toBeVisible()
  await expect(env, '요청 하나의 설정으로 오해되면 안 된다').toHaveAttribute('title', /창 전체/)

  // 요청 툴바(실행 버튼이 있는 줄)와 같은 줄에 있으면 안 된다
  const runBox = (await page.getByTestId('run-request').boundingBox())!
  const envBox = (await env.boundingBox())!
  expect(envBox.y + envBox.height, '환경 선택이 실행 버튼보다 위에 있어야 한다').toBeLessThan(runBox.y)

  // 원래 문제는 '한 줄이냐' 가 아니라 '머리말이 화면을 얼마나 먹느냐' 였다
  // (1600×950 에서 파라미터 한 줄을 보기까지 304px 를 먹었다).
  // 줄 수는 배치를 손볼 때마다 달라진다 — 재야 할 건 높이다.
  const headHeight = await page.getByTestId('request-toolbar').evaluate(
    el => Math.round(el.parentElement!.getBoundingClientRect().height))
  expect(headHeight, `요청 머리말이 ${headHeight}px 를 먹는다`).toBeLessThanOrEqual(120)
})

test('위계 — 목록의 이름은 고르지 않아도 읽힌다', async ({ page }) => {
  // 규칙이 '활성인 것만 밝고 나머지는 전부 흐림' 이었다. 그런데 목록을 훑을 때 대부분의
  // 행은 '고르지 않은' 상태다 — 실측 1600×950 에서 화면의 글자 131개 중 본문 색은 10개뿐,
  // 폴더·요청 이름 53개가 전부 흐린 쪽에 있었다. 내용이 부속보다 어두웠다.
  await boot(page)
  const tone = (l: import('@playwright/test').Locator) =>
    l.evaluate(el => getComputedStyle(el).color)

  const pane = page.getByTestId('sidebar-pane')
  // 고르지 않은 요청 행의 이름
  const row = pane.getByRole('button', { name: /펫 등록/ }).first()
  await expect(row).toBeVisible()
  const nameColor = await tone(row)

  // 옆에 붙는 개수·부속은 더 흐려야 한다 — 그게 위계다
  const rail = page.getByTestId('rail-scenario')
  const railColor = await tone(rail)

  // 본문 색을 직접 읽어 비교한다(토큰 값이 바뀌어도 안 깨지게)
  const fg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--foreground').trim())
  const toRgb = (hex: string) => {
    const n = parseInt(hex.slice(1), 16)
    return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
  }
  expect(nameColor, '고르지 않은 요청 이름도 본문 색이어야 한다').toBe(toRgb(fg))
  expect(railColor, '레일 항목은 본문보다 흐려야 한다 — 부속이다').not.toBe(toRgb(fg))
})

test('문서 모드 — 고른 요청을 보여주고, 바꾼 범위를 기억한다', async ({ page }) => {
  // 요청 하나를 고르고 [문서] 를 눌렀는데 폴더 141개가 펼쳐졌다. 누른 것과 다른 걸 주는 셈이다.
  // 게다가 범위를 바꿔 놔도 실행↔문서 를 한 번 오가면 기본값으로 되돌아갔다 —
  // 이 컴포넌트가 문서 모드일 때만 마운트돼서 상태가 죽기 때문이다.
  await page.addInitScript(() => localStorage.removeItem('ah:docsScope'))
  await boot(page)
  await page.getByRole('button', { name: /펫 등록/ }).first().click()
  await page.getByRole('button', { name: '문서 보기', exact: true }).click()

  // 기본은 '이 요청' — 고른 그것만
  await expect(page.getByText(/요청 1개/)).toBeVisible({ timeout: 15_000 })

  // 범위를 바꾸면 그대로 남는다
  await page.getByRole('button', { name: '이 폴더', exact: true }).click()
  await expect(page.getByText(/요청 1개/)).toHaveCount(0)

  await page.getByRole('button', { name: '요청 편집', exact: true }).click()
  await page.getByRole('button', { name: '문서 보기', exact: true }).click()
  const folderBtn = page.getByRole('button', { name: '이 폴더', exact: true })
  await expect(folderBtn, '탭을 오가도 고른 범위가 유지돼야 한다').toHaveClass(/accent/)
})

/**
 * 화면을 떠났다 와도 고른 것이 남아야 한다.
 *
 * 좌측 레일의 화면들은 `mode === 'x' && <Panel/>` 로 조건부 마운트된다. 다른 화면에
 * 갔다 오면 컴포넌트가 죽었다 다시 태어나 useState 가 전부 기본값으로 돌아갔다.
 * 문서 범위에서 처음 발견하고, 같은 패턴을 훑어 네 곳을 더 찾았다.
 */
test('화면을 오가도 고른 것이 남는다', async ({ page }) => {
  await page.addInitScript(() => {
    for (const k of ['ah:realtimeTab', 'ah:historyFilterSince']) {
      localStorage.removeItem(k)
    }
  })
  await boot(page)
  const away = async (mode: string) => {
    await page.getByTestId('rail-collection').click()
    await page.getByTestId(`rail-${mode}`).click()
  }

  // 이력 필터 — 직접 친 값이 사라지는 게 제일 나쁘다
  await page.getByTestId('rail-history').click()
  const filter = page.getByLabel('이후', { exact: true })
  await filter.fill('2026-01-01T09:30')
  await away('history')
  await expect(page.getByLabel('이후', { exact: true }),
    '직접 친 필터가 지워졌다').toHaveValue('2026-01-01T09:30')
})

test('시나리오 — 고른 것이 화면을 오가도 남는다', async ({ page }) => {
  // 이 패널도 조건부 마운트라 선택이 풀렸다. 객체는 그대로 못 담으므로 id 만 남기고
  // 목록을 받은 뒤 다시 찾아 고른다.
  await page.addInitScript(() => localStorage.removeItem('ah:scenarioFlow'))
  await boot(page)
  await page.getByTestId('rail-scenario').click()

  // 고르는 자리가 드롭다운에서 사이드바 목록으로 바뀌었다(FlowScenario.tsx:431, 467).
  // 한 번 펼쳐 고르는 대신 늘 보이고 검색도 되는 쪽 — 선택 상태는 aria-pressed 로 드러난다.
  const list = page.getByRole('region', { name: '시나리오 목록' })
  await expect(list).toBeVisible({ timeout: 15_000 })
  // 목록이 도착하기 전에 세면 0 이다 — 그걸 '시나리오가 없다' 로 읽으면 안 된다.
  const items = list.getByRole('button', { name: / 열기$/ })
  await expect.poll(() => items.count(), { timeout: 15_000 }).toBeGreaterThan(0)

  const pick = (await items.first().getAttribute('aria-label'))!
  await items.first().click()
  await expect(list.getByRole('button', { name: pick })).toHaveAttribute('aria-pressed', 'true')

  await page.getByTestId('rail-collection').click()
  await page.getByRole('tab', { name: '시나리오', exact: true }).click()

  // 보고 있던 시나리오는 다녀와도 열려 있어야 한다. 목록은 사이드바에 늘 떠 있으므로
  // 복원해도 '무엇이 있는지' 는 그대로 보인다 — 둘 중 하나를 고를 일이 아니다.
  const again = page.getByRole('region', { name: '시나리오 목록' }).getByRole('button', { name: pick })
  await expect(again, '다녀오니 목록에서 사라졌다').toBeVisible()
  await expect(again, '다녀오니 선택이 풀렸다').toHaveAttribute('aria-pressed', 'true')
})

test('빈 프로젝트 — 가져오기 말고 하나씩 만드는 길도 보인다', async ({ page, request }) => {
  // 예전엔 [Postman 가져오기] 만 큰 버튼이고 '하나씩 만들기' 는 문장 속에 묻혀 있었다.
  // 새 프로젝트를 만든 사람은 대개 가져올 게 없다 — '이 방법밖에 없나' 로 읽힌다.
  const created = await request.post('/api/workspaces', { data: { name: 'e2e-빈프로젝트' } })
  const ws = await created.json() as { id: string }
  try {
    await page.addInitScript(id => localStorage.setItem('ah:workspace', id), ws.id)
    await page.goto('/')

    await expect(page.getByText('아직 비어 있습니다')).toBeVisible({ timeout: 15_000 })
    // 1순위는 [+ 새 요청], 가져오기는 같은 자리의 보조 버튼, 폴더는 묶고 싶을 때
    await expect(page.getByRole('button', { name: '+ 새 요청', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '파일 가져오기', exact: true }).first()).toBeVisible()
    // 가져오기가 실제로 받는 형식을 적는다 — Postman 만 말하면 postq 파일을 가진 사람이 못 쓴다
    await expect(page.getByText(/postq 내보내기 파일/).first()).toBeVisible()
    const make = page.getByRole('button', { name: '+ 폴더 만들기' })
    await expect(make).toBeVisible()
    // 짧은 안내와 실제 동작하는 시작 버튼을 함께 제공한다
    await expect(page.getByText('요청을 만들거나 파일을 가져와 시작하세요.', { exact: true })).toBeVisible()

    // 누르면 바로 이름을 칠 수 있다 — 한 번 더 찾아 헤매지 않는다
    await make.click()
    await expect(page.locator('input[placeholder*="폴더"], input[aria-label*="폴더"]').first()).toBeVisible()
  } finally {
    await request.delete(`/api/workspaces/${ws.id}`)
  }
})

test('빈 프로젝트 첫 실행 — 시작 안내에서 예시 요청을 열고, 실행 전엔 아무것도 나가지 않는다', async ({ page, request }) => {
  // 예전엔 오른쪽이 '이어서 하기 — 0' 네 줄뿐이라 처음 온 사람에게 할 일을 하나도 알려주지 않았다.
  const created = await request.post('/api/workspaces', { data: { name: 'e2e-첫실행' } })
  const ws = await created.json() as { id: string }
  try {
    await page.addInitScript(id => { localStorage.setItem('ah:workspace', id) }, ws.id)
    await page.goto('/')
    const guide = page.getByTestId('start-guide')
    await expect(guide).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('heading', { name: '이어서 하기', exact: true })).toHaveCount(0)
    await expect(guide.getByRole('button', { name: 'curl 붙여넣기', exact: true })).toBeVisible()
    await expect(guide.getByRole('button', { name: 'OpenAPI 주소로 추가', exact: true })).toBeVisible()

    await guide.getByRole('button', { name: '예시 요청 열어 보기', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '요청 URL', exact: true })).toHaveValue('https://httpbin.org/get', { timeout: 10_000 })
    // 만들기만 했다 — 사용자가 [실행] 을 누르기 전엔 바깥으로 나간 기록이 없어야 한다
    const execs = await (await request.get(`/api/executions?workspaceId=${ws.id}&limit=5`)).json() as unknown[]
    expect(execs).toHaveLength(0)
    // 요청이 생겼으니 탭을 닫으면 '이어서 하기' 로 돌아간다
    const folders = await (await request.get(`/api/folders?workspaceId=${ws.id}`)).json() as { name: string }[]
    expect(folders.map(f => f.name)).toEqual(['예시'])
  } finally {
    await request.delete(`/api/workspaces/${ws.id}`)
  }
})

test('빈 프로젝트 — [+ 새 요청] 은 폴더를 알아서 만들고, 빈 폴더엔 요청 추가 길이 늘 보인다', async ({ page, request }) => {
  const created = await request.post('/api/workspaces', { data: { name: 'e2e-새요청' } })
  const ws = await created.json() as { id: string }
  try {
    await page.addInitScript(id => { localStorage.setItem('ah:workspace', id) }, ws.id)
    await page.goto('/')
    await page.getByRole('button', { name: '+ 새 요청', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '요청 URL', exact: true })).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText('내 요청', { exact: true }).first()).toBeVisible()

    // 빈 폴더 — 마우스를 올리지 않아도 요청을 넣는 길이 보인다
    const f = await request.post('/api/folders', { data: { name: 'e2e-빈폴더', workspaceId: ws.id } })
    expect(f.ok()).toBeTruthy()
    await page.reload()
    await expect(page.getByText('이 폴더에 요청이 없습니다').first()).toBeVisible({ timeout: 15_000 })
    await page.getByRole('button', { name: '+ 요청 추가', exact: true }).first().click()
    await expect(page.getByPlaceholder(/요청 이름/)).toBeVisible()
  } finally {
    await request.delete(`/api/workspaces/${ws.id}`)
  }
})

test('시작 안내 [curl 붙여넣기] — 새 요청을 열고 주소창에 커서를 둔다', async ({ page, request }) => {
  const created = await request.post('/api/workspaces', { data: { name: 'e2e-curl시작' } })
  const ws = await created.json() as { id: string }
  try {
    await page.addInitScript(id => { localStorage.setItem('ah:workspace', id) }, ws.id)
    await page.goto('/')
    await page.getByTestId('start-guide').getByRole('button', { name: 'curl 붙여넣기', exact: true }).click()
    const url = page.getByRole('textbox', { name: '요청 URL', exact: true })
    await expect(url).toBeFocused({ timeout: 10_000 })
    await expect(url).toHaveAttribute('placeholder', /curl 명령 붙여넣기/)
  } finally {
    await request.delete(`/api/workspaces/${ws.id}`)
  }
})

test('가져오기 — OpenAPI 문서를 넣으면 환경을 만들지 않고 폴더의 OpenAPI 주소 가져오기로 안내한다', async ({ page, request }) => {
  const created = await request.post('/api/workspaces', { data: { name: 'e2e-오픈API가져오기' } })
  const ws = await created.json() as { id: string }
  try {
    await page.addInitScript(id => { localStorage.setItem('ah:workspace', id) }, ws.id)
    await page.goto('/')
    await expect(page.getByTestId('start-guide')).toBeVisible({ timeout: 15_000 })
    await page.locator('input[type=file][accept*="json"]').first().setInputFiles({
      name: 'openapi.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ openapi: '3.0.0', info: { title: 't', version: '1' }, paths: {} })),
    })
    await expect(page.getByText(/OpenAPI\(Swagger\) 문서는 여기서 가져오지 않습니다/)).toBeVisible()
    await expect(page.getByText(/OpenAPI 주소에서 요청 가져오기/)).toBeVisible()
    const envs = await (await request.get(`/api/environments?workspaceId=${ws.id}`)).json() as unknown[]
    expect(envs).toHaveLength(0)
  } finally {
    await request.delete(`/api/workspaces/${ws.id}`)
  }
})

test('프로젝트 이름 바꾸기 — 서버는 되는데 화면에 길이 없었다', async ({ page, request }) => {
  // PUT /api/workspaces/[id] 는 진작 있었는데 화면에 버튼이 없었다. 오타를 낸 채로
  // 만들면 지우고 다시 만드는 수밖에 없었고, 그러면 그 안의 것도 같이 날아간다.
  const created = await request.post('/api/workspaces', { data: { name: 'e2e-이름전' } })
  const ws = await created.json() as { id: string }
  try {
    await page.addInitScript(id => {
      localStorage.setItem('ah:workspace', id)
    }, ws.id)
    await page.goto('/')

    await page.getByRole('button', { name: '프로젝트 목록', exact: true }).click()
    await page.getByRole('dialog', { name: '프로젝트 목록' }).getByRole('button', { name: '이름 변경', exact: true }).click()

    // 지금 이름이 미리 들어 있어야 한다 — 빈 칸이면 처음부터 다시 쳐야 한다
    const input = page.getByLabel('프로젝트 이름 변경')
    await expect(input).toHaveValue('e2e-이름전')

    await input.fill('e2e-이름후')
    await page.getByRole('button', { name: '저장', exact: true }).click()

    // 화면 목록과 서버가 함께 바뀌어야 한다
    await expect(page.getByLabel('프로젝트', { exact: true })).toContainText('e2e-이름후')
    const after = await (await request.get('/api/workspaces')).json() as { id: string; name: string }[]
    expect(after.find(w => w.id === ws.id)?.name, '서버에도 반영돼야 한다').toBe('e2e-이름후')
  } finally {
    await request.delete(`/api/workspaces/${ws.id}`)
  }
})

test('헤더 — 물려받은 것과 내가 쓴 것이 한 표에 보인다', async ({ page }) => {
  // 예전엔 폴더 공통 헤더가 표 아래 점선 상자에 따로 있었다. '실제로 나갈 헤더' 를 알려면
  // 두 목록을 머리로 합쳐야 했고, 같은 키를 적었을 때 어느 쪽이 이기는지도 안 보였다.
  await boot(page)
  await page.getByRole('button', { name: /펫 등록/ }).first().click()
  await page.getByRole('button', { name: /^Headers/ }).click()

  // 상속된 줄이 표 안에 있다
  const inherited = page.locator('tbody tr', { hasText: '폴더 공통' })
  await expect(inherited).toHaveCount(1, { timeout: 15_000 })
  await expect(inherited).toContainText('X-Team')

  // 따로 떨어진 점선 상자는 없어졌다
  await expect(page.getByText('폴더 공통 헤더 상속')).toHaveCount(0)

  // 같은 키를 요청에 적으면 어느 쪽이 이기는지 표가 말한다
  const key = page.getByPlaceholder('새 key…').first()
  await key.fill('X-Team')
  await expect(page.locator('tbody tr', { hasText: '요청 값으로 대체됨' })).toHaveCount(1)
})

test('헤더/파라미터 — 무엇에 대한 버튼인지 라벨이 말한다', async ({ page }) => {
  // 'Bulk' 한 단어가 표에서 멀찍이 떠 있어 무엇에 대한 버튼인지 안 보였다.
  // 열 이름도 KEY/VALUE(영어 대문자)와 설명(한국어)이 섞여 있었다.
  await boot(page)
  await page.getByRole('button', { name: /펫 등록/ }).first().click()
  await page.getByRole('button', { name: /^Headers/ }).click()

  await expect(page.getByText('요청 헤더', { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('thead th').filter({ hasText: '키' }).first()).toBeVisible()
  await expect(page.getByText('KEY', { exact: true })).toHaveCount(0)

  // 버튼이 '무엇을 여는지' 를 말하고, 누르면 되돌아가는 말로 바뀐다
  const toText = page.getByRole('button', { name: '텍스트로 편집' })
  await expect(toText).toBeVisible()
  await toText.click()
  await expect(page.getByRole('button', { name: '표로 편집' })).toBeVisible()
})

test('요청 편집 — URL 을 고치고 다른 화면에 다녀와도 남는다', async ({ page }) => {
  // 컬렉션 화면 전체가 조건부 마운트라, ⌘6 등으로 옮기면 RequestPanel 이 통째로 죽고
  // 돌아왔을 때 draft 가 서버 값으로 되돌아갔다. 저장 버튼도 경고도 없이 조용히 사라져,
  // 고쳤다고 믿은 URL 이 없어졌다. 화면 전환은 '지우기' 가 아니라 '감추기' 여야 한다.
  await boot(page)

  const folders = async () => (await (await page.request.get('/api/folders?workspaceId=default')).json()) as { id: string; name: string }[]
  const reqsIn = async (id: string) => (await (await page.request.get(`/api/requests?folderId=${id}`)).json()) as { id: string; name: string }[]

  // 이름이 워크스페이스에서 유일한 요청만 고른다 — 같은 이름이 둘이면 어느 행을 열었는지 모른다
  const fs = await folders()
  const all = (await Promise.all(fs.map(async f => (await reqsIn(f.id)).map(r => ({ ...r, folder: f })))))
    .flat().filter(r => !r.name.includes(' / '))
  const counts = new Map<string, number>()
  for (const r of all) counts.set(r.name, (counts.get(r.name) ?? 0) + 1)
  const picked = all.find(r => counts.get(r.name) === 1)
  expect(picked, '이름이 유일한 요청이 있어야 한다').toBeTruthy()

  const row = await revealRow(page, picked!.folder.name, picked!.name)
  await row.click()

  const url = page.getByLabel('요청 URL')
  await expect(url).toBeVisible({ timeout: 15_000 })
  const original = await url.inputValue()
  const edited = `${original}/e2e-draft-probe`

  // 저장하지 않는다 — 서버는 건드리지 않고 화면 상태만 본다
  await url.fill(edited)
  await expect(url).toHaveValue(edited)

  // 고치면 편집 모드로 들어가 저장할 자리가 생겨야 한다(고친 줄도 모르고 지나치지 않게)
  await expect(page.getByRole('button', { name: /^변경 저장/ }),
    'URL 을 고쳤는데 저장할 자리가 안 생겼다').toBeVisible()

  await page.getByTestId('rail-schedule').click()
  await expect(page.getByTestId('rail-schedule')).toHaveAttribute('aria-expanded', 'true')
  await page.getByRole('button', { name: '새 스케줄', exact: true }).click()
  await expect(page.getByTestId('rail-schedule')).toHaveAttribute('aria-current', 'true')
  await page.getByTestId('rail-collection').click()

  await expect(page.getByLabel('요청 URL'),
    '다른 화면에 다녀오니 저장 안 한 편집이 사라졌다').toHaveValue(edited)
})

test('요청 복제 — 헤더·바디까지 베끼고 원본 바로 아래에 놓는다', async ({ request }) => {
  // 트리는 slim 목록이라 예전엔 헤더·바디가 빈 채로 복제됐고, 복제본은 폴더 맨 끝에 붙었다.
  const folders = await (await request.get('/api/folders?workspaceId=default')).json() as { id: string }[]
  const folderId = folders[0].id
  const mk = async (name: string) => (await (await request.post('/api/requests', { data: {
    folderId, name, method: 'POST', url: 'http://x.test/a', bodyType: 'json', body: '{"a":1}',
    headers: [{ key: 'X-Dup', value: 'keep', enabled: true }],
  } })).json()) as { id: string }
  const a = await mk('e2e-dup-a'), b = await mk('e2e-dup-b')
  const res = await request.post(`/api/requests/${a.id}/duplicate`)
  expect(res.status()).toBe(201)
  const copy = await res.json() as { id: string; name: string; body: string; headers: { key: string; value: string }[] }
  try {
    expect(copy.name).toBe('e2e-dup-a (copy)')
    expect(copy.body).toBe('{"a":1}')
    expect(copy.headers).toEqual([expect.objectContaining({ key: 'X-Dup', value: 'keep' })])
    const order = (await (await request.get(`/api/requests?folderId=${folderId}&slim=1`)).json() as { id: string }[]).map(r => r.id)
    expect(order.indexOf(copy.id)).toBe(order.indexOf(a.id) + 1)
    expect(order.indexOf(b.id)).toBe(order.indexOf(copy.id) + 1)
  } finally {
    for (const id of [a.id, b.id, copy.id]) await request.delete(`/api/requests/${id}`)
  }
})

test('⌘⇧[ / ⌘⇧] — 열린 요청 탭 이전/다음', async ({ page }) => {
  await boot(page)
  const tabs = page.getByRole('tablist', { name: '열린 요청' }).getByRole('tab')
  // 서로 다른 요청 둘을 연다 — 트리 하나, ⌘K 하나
  await page.getByRole('button', { name: /펫 등록/ }).first().click()
  await page.keyboard.press('ControlOrMeta+KeyK')
  await page.getByLabel('요청 검색').last().fill('일괄 등록')
  await expect(page.getByRole('dialog', { name: '커맨드 팔레트' }).getByText('펫 일괄 등록')).toBeVisible()
  await page.keyboard.press('Enter')
  await expect.poll(() => tabs.count()).toBeGreaterThan(1)
  const selected = () => page.getByRole('tablist', { name: '열린 요청' }).locator('[role="tab"][aria-selected="true"]').innerText()
  const before = await selected()
  await page.keyboard.press('ControlOrMeta+Shift+BracketLeft')
  await expect.poll(selected).not.toBe(before)
  await page.keyboard.press('ControlOrMeta+Shift+BracketRight')
  await expect.poll(selected).toBe(before)
})

test('미리보기 교체·더블클릭 고정·편집 메서드와 즉시 저장·폴더 서버 설명', async ({ page, request }) => {
  page.setDefaultTimeout(5000)
  const ws = await (await request.post('/api/workspaces', { data: { name: `e2e-preview-${Date.now()}` } })).json()
  try {
    const folder = await (await request.post('/api/folders', { data: { workspaceId: ws.id, name: '미리보기 폴더' } })).json()
    const rows = []
    for (const name of ['첫 요청', '둘째 요청', '셋째 요청']) rows.push(await (await request.post('/api/requests', { data: { folderId: folder.id, name, method: 'GET', url: 'https://example.test/items' } })).json())
    await page.addInitScript(id => { localStorage.setItem('ah:workspace', id) }, ws.id)
    await page.goto('/')
    // Tree rows have request names as their accessible labels.
    await page.locator(`[data-req-id="${rows[0].id}"]`).click()
    await expect(page.getByRole('tab', { name: /첫 요청/ })).toBeVisible()
    await page.locator(`[data-req-id="${rows[1].id}"]`).click()
    await expect(page.getByRole('tab', { name: /첫 요청/ })).toHaveCount(0)
    await page.getByRole('tab', { name: /둘째 요청/ }).dblclick()
    await page.locator(`[data-req-id="${rows[2].id}"]`).click()
    await expect(page.getByRole('tab', { name: /둘째 요청/ })).toBeVisible()
    await expect(page.getByRole('tab', { name: /셋째 요청/ })).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('combobox', { name: 'HTTP 메서드' }).selectOption('POST')
    await expect(page.getByRole('tab', { name: /셋째 요청/ })).toContainText('POST')
    await page.keyboard.press('ControlOrMeta+s')
    await expect(page.getByText('요청이 저장되었습니다')).toBeVisible()
    await expect(page.getByRole('dialog', { name: '저장된 요청 변경 확인' })).toHaveCount(0)
    expect((await (await request.get(`/api/requests/${rows[2].id}`)).json()).method).toBe('POST')
    await page.getByRole('button', { name: '뒤로 이동', exact: true }).click()
    await expect(page.getByRole('tab', { name: /둘째 요청/ })).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('button', { name: '앞으로 이동', exact: true }).click()
    await expect(page.getByRole('tab', { name: /셋째 요청/ })).toHaveAttribute('aria-selected', 'true')
    await page.getByTestId('sidebar-pane').getByRole('button').filter({ has: page.locator('span[title="미리보기 폴더"]') }).click()
    await expect(page.locator(`[data-req-id="${rows[0].id}"]`)).toBeVisible()
    await page.getByLabel('폴더 설명').fill('서버에 보존되는 설명')
    await page.getByRole('button', { name: '설명 저장', exact: true }).click()
    await expect.poll(async () => (await (await request.get(`/api/folders?workspaceId=${ws.id}`)).json())[0].description).toBe('서버에 보존되는 설명')
    await page.reload()
    await page.getByTestId('sidebar-pane').getByRole('button').filter({ has: page.locator('span[title="미리보기 폴더"]') }).click()
    await expect(page.getByLabel('폴더 설명')).toHaveValue('서버에 보존되는 설명')
  } finally { await request.delete(`/api/workspaces/${ws.id}`) }
})

test('첫 실행 — 이름 입력 없이 빈 작업 화면에서 바로 요청을 만든다', async ({ page, request }) => {
  const ws = await (await request.post('/api/workspaces', { data: { name: 'e2e-first-launch' } })).json() as { id: string }
  try {
    await page.addInitScript(id => localStorage.setItem('ah:workspace', id), ws.id)
    await page.goto('/')
    await expect(page.getByTestId('start-guide')).toBeVisible()
    await expect(page.getByTestId('rail-settings')).toBeVisible()
    await expect(page.locator('#nickname-input')).toHaveCount(0)
    await expect(page.getByText('실행 이력에 남길 이름을 적어 주세요', { exact: false })).toHaveCount(0)
    await expect(page.locator('[title^="이 브라우저의 이름:"]')).toHaveCount(0)
    expect(await page.evaluate(() => Object.keys(localStorage))).not.toContain('nickname')
    await expect(page.locator('img[src*="postq-mark"], img[src*="postq-icon"]')).toHaveCount(0)
    await expect(page.locator('header').getByText('postq', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '+ 빈 요청', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '요청 URL', exact: true })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('textbox', { name: '요청 URL', exact: true })).toBeVisible()
    await expect(page.locator('#nickname-input')).toHaveCount(0)
  } finally { await request.delete(`/api/workspaces/${ws.id}`) }
})
