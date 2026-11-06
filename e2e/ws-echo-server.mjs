#!/usr/bin/env node
/**
 * E2E 용 WebSocket echo 서버 (기본 :9997).
 *
 * 실시간(WS/SSE) 화면은 URL 검증만 테스트돼 있었고 '실제로 붙어서 주고받는지' 는
 * 한 번도 확인된 적이 없다. 그걸 보려면 붙을 대상이 필요하다.
 *
 * 의존성을 안 쓴다 — 이 저장소는 HTTP echo 서버도 직접 짰다. WebSocket 은 핸드셰이크와
 * 프레임 규격(RFC 6455)만 지키면 되고, echo 에 필요한 만큼만 구현한다:
 *   - 핸드셰이크: Sec-WebSocket-Accept = base64(sha1(key + MAGIC))
 *   - 수신: 텍스트(0x1)·close(0x8)·ping(0x9), 마스킹 해제, 길이 7/16/64비트
 *   - 송신: 마스킹 없음(서버→클라이언트 규칙), 길이 7/16비트
 *
 * 계약(테스트가 의존하는 것):
 *   붙으면 즉시  "hello"      를 보낸다 — 수신 경로 확인용
 *   무엇을 받든  "echo: <받은것>" 을 돌려준다 — 송신 경로 확인용
 *   "close" 를 받으면 정상 종료(1000)
 *
 *   node e2e/ws-echo-server.mjs
 *   PORT=9997 node e2e/ws-echo-server.mjs
 */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

const port = Number(process.env.PORT ?? 9997)
// RFC 6455 고정 GUID. 한 글자만 틀려도 핸드셰이크가 'Incorrect hash' 로 거절된다.
const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** 서버→클라이언트 프레임. 마스킹하지 않는다(규격상 서버는 마스킹 금지). */
function encode(text, opcode = 0x1) {
  const payload = Buffer.from(text, 'utf8')
  const head = payload.length < 126
    ? Buffer.from([0x80 | opcode, payload.length])
    : Buffer.concat([Buffer.from([0x80 | opcode, 126]), (() => {
        const b = Buffer.alloc(2); b.writeUInt16BE(payload.length); return b
      })()])
  return Buffer.concat([head, payload])
}

/**
 * 버퍼에서 프레임 하나를 떼어낸다. 부족하면 null(다음 데이터와 합쳐 다시 시도).
 * 클라이언트 프레임은 항상 마스킹돼 있어 4바이트 키로 XOR 해야 한다.
 */
function decode(buf) {
  if (buf.length < 2) return null
  const opcode = buf[0] & 0x0f
  const masked = (buf[1] & 0x80) !== 0
  let len = buf[1] & 0x7f
  let off = 2
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4 }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10 }
  let mask = null
  if (masked) { if (buf.length < off + 4) return null; mask = buf.subarray(off, off + 4); off += 4 }
  if (buf.length < off + len) return null
  const payload = Buffer.from(buf.subarray(off, off + len))
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
  return { opcode, text: payload.toString('utf8'), rest: buf.subarray(off + len) }
}

const server = createServer((_req, res) => { res.writeHead(426); res.end('WebSocket only') })

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key']
  if (!key) { socket.destroy(); return }
  const accept = createHash('sha1').update(key + MAGIC).digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`)

  socket.write(encode('hello'))

  let buf = Buffer.alloc(0)
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk])
    for (;;) {
      const f = decode(buf)
      if (!f) break
      buf = f.rest
      if (f.opcode === 0x8) { socket.end(encode('', 0x8)); return }
      if (f.opcode === 0x9) { socket.write(encode(f.text, 0xA)); continue }  // ping → pong
      if (f.opcode !== 0x1) continue
      if (f.text === 'close') { socket.end(encode('', 0x8)); return }
      socket.write(encode(`echo: ${f.text}`))
    }
  })
  socket.on('error', () => socket.destroy())
})

server.listen(port, '0.0.0.0', () => {
  console.log(`[ws-echo] ws://0.0.0.0:${port} — 붙으면 hello, 받으면 "echo: <값>"`)
})
