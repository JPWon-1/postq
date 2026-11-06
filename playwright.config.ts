import { defineConfig } from '@playwright/test'

// 이 설정을 직접 쓰지 말고 `npm run e2e:safe` 를 쓴다.
//
//   npm run e2e:safe              # 전부
//   npm run e2e:safe -- -g "스케줄"    # 뒤 인자는 여기로 그대로 넘어온다
//
// 왜: 이 테스트들은 서버에 진짜 쓰기를 한다. 요청을 만들고 고치고, afterAll 은 DELETE 를
// 보낸다. baseURL 기본값이 :3000 이라 아무 생각 없이 `npm run e2e` 를 치면 그게 운영
// DB 를 때린다 — 실제로 그렇게 실데이터가 지워진 적이 있다. 그 뒤로는 무서워서 아무도
// 안 돌렸고, 166개 중 49개가 화면과 어긋난 채 몇 달을 방치돼 회귀를 못 잡았다.
//
// scripts/e2e-safe.mjs 는 실 DB 의 일관 사본을 떠서 거기에만 서버를 물리고(사본이
// 아니면 즉시 중단한다), 헬퍼 서버를 띄우고, 끝나고 원본 지문을 다시 재서 대조한다.
// 아래 헬퍼들도 e2e:safe 가 알아서 띄우므로 따로 실행할 필요 없다.
//
//   npm run e2e:echo      # :9999 HTTP echo + /sse 스트림
//   npm run e2e:mock-spec # :9998 목 OpenAPI (폴더 동기화)
//   npm run e2e:ws-echo   # :9997 WebSocket echo
//
// echo 가 없으면 실행이 필요한 6개가 status=null 로 깨진다. 예전엔 저장소 밖 임시
// 프로세스로 띄워 둬서 머신 재시작 후 원인 모를 실패로 보였다.
// ws-echo 가 없으면 실시간(WS) 연결 테스트가, echo 의 /sse 가 없으면 SSE 스트림
// 테스트가 깨진다 — 둘 다 '패널이 뜬다' 만 보던 것을 실제 송수신까지 보게 만든 것이다.
/**
 * 붙을 서버. 기본값을 두지 않는다 — 예전 기본값 :3000 이 바로 운영 DB 였다.
 * 주석으로만 '쓰지 말 것' 이라 적어 두면 급할 때 `npm run e2e` 한 줄이 그대로 운영을 때린다.
 * 주소를 명시해야만 돌고, 운영이 사는 포트(:3000 도커, :39100 데스크톱 앱)는 명시적 허락 없이는 거부한다.
 */
function baseURL(): string {
  const url = process.env.E2E_BASE_URL
  if (!url) {
    throw new Error('E2E_BASE_URL 이 없습니다. `npm run e2e:safe` 를 쓰세요 — 실데이터 사본에 대고 돌립니다.\n' +
      '(이 테스트들은 서버에 진짜 쓰기·삭제를 합니다. 기본값으로 붙던 :3000 은 운영 DB 였습니다.)')
  }
  const port = new URL(url).port
  if (['3000', '39100'].includes(port) && process.env.E2E_I_KNOW_THIS_IS_LIVE !== '1') {
    throw new Error(`E2E_BASE_URL(${url}) 은 운영 데이터를 쓰는 포트입니다. \`npm run e2e:safe\` 를 쓰세요.\n` +
      '정말 거기에 돌려야 하면 E2E_I_KNOW_THIS_IS_LIVE=1 을 함께 주세요.')
  }
  return url
}

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 0,
  workers: 1, // 같은 DB 를 공유하므로 직렬 실행
  use: {
    baseURL: baseURL(),
    locale: 'ko-KR',
    viewport: { width: 1440, height: 900 },
    storageState: {
      cookies: [],
      origins: [{ origin: new URL(baseURL()).origin, localStorage: [{ name: 'postq:language', value: 'ko' }] }],
    },
  },
  reporter: [['list']],
})
