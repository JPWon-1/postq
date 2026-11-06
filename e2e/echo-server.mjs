#!/usr/bin/env node
/**
 * E2E 용 echo 서버 (기본 :9999).
 *
 * E2E 실행 환경 'e2e-echo'(scripts/e2e-safe.mjs 가 사본에 심음)의 baseUrl 이 가리키는 대상이다. 이게 없으면
 * 실행이 필요한 E2E 6개가 status=null 로 전부 깨진다 — 예전엔 저장소 밖 임시 프로세스로
 * 띄워 두고 있어서, 머신을 재시작하면 아무 설명 없이 실패했다. 그래서 여기 넣는다.
 *
 *   node e2e/echo-server.mjs          # 포그라운드
 *   PORT=9999 node e2e/echo-server.mjs
 *
 * 응답 계약(테스트가 의존하는 것):
 *   success : 항상 true          — 응답 추출(postSteps)이 값을 뽑을 대상
 *   auth    : Authorization 헤더 — 인증 주입·동적변수가 실제로 나갔는지 확인용
 *   나머지는 디버깅 편의를 위해 받은 그대로 되돌려준다.
 */
import { createServer } from 'node:http'

const port = Number(process.env.PORT ?? 9999)

createServer((req, res) => {
  // /sse-flood?n=2100 — 한 번에 많은 줄을 쏟아붓고 닫는다.
  // SSE 패널은 받은 줄을 무한히 쌓고 있었다(오래 켜 두면 스스로 굳는다). 상한을
  // 넣었으니, 상한을 실제로 넘겨 봐야 그게 도는지 알 수 있다.
  if (req.url?.startsWith('/sse-flood')) {
    const n = Number(new URL(req.url, 'http://x').searchParams.get('n') ?? 2100)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    // 한 번에 다 쓴다 — 청크 하나에 상한을 넘는 양이 들어오는 경우까지 같이 본다.
    let out = ''
    for (let i = 1; i <= n; i++) out += `data: flood-${i}\n\n`
    res.end(out)
    return
  }

  // /sse — 서버센트 이벤트 스트림. 실시간 화면의 SSE 탭이 프록시(/api/sse)를 통해
  // 이걸 흘려받는지 확인하는 대상이다. 렌더만 테스트돼 있고 실제 스트리밍은
  // 확인된 적이 없었다. 3건 보내고 닫는다(테스트가 끝나야 하므로 무한 스트림은 안 쓴다).
  if (req.url?.startsWith('/sse')) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    let n = 0
    const timer = setInterval(() => {
      n++
      res.write(`data: tick-${n}\n\n`)
      if (n >= 3) { clearInterval(timer); res.end() }
    }, 300)
    req.on('close', () => clearInterval(timer))
    return
  }


  let body = ''
  const chunks = []
  req.on('data', c => { body += c; chunks.push(c) })
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      success: true,
      auth: req.headers.authorization ?? null,
      method: req.method,
      path: req.url,
      headers: req.headers,
      body,
      bodyBase64: Buffer.concat(chunks).toString('base64'),
    }))
  })
}).listen(port, '0.0.0.0', () => {
  // 0.0.0.0 로 바인딩해야 컨테이너가 host.docker.internal 로 들어올 수 있다
  // (127.0.0.1 전용으로 열면 호스트에서만 보이고 컨테이너에서는 연결이 거부된다).
  console.log(`[echo] http://0.0.0.0:${port} — E2E 'e2e-echo' 환경 대상`)
})
