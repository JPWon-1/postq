#!/usr/bin/env node
/**
 * 로컬 목 OpenAPI 서버 (기본 :9998) — 폴더의 OpenAPI URL 동기화 테스트가 쓰는 스펙 소스.
 *
 * 없으면 그 폴더 동기화가 가드에 막힌다("엔드포인트를 하나도 읽지 못했습니다").
 * 이 목 덕분에 E2E 가 외부 서버와 무관하게 결정적이다.
 *
 *   node e2e/mock-spec-server.mjs      # 포그라운드
 */
import { createServer } from 'node:http'

const port = Number(process.env.PORT ?? 9998)

const op = (summary, tag) => ({
  summary, tags: [tag], responses: { '200': { description: 'OK' } },
})

const spec = {
  openapi: '3.0.1',
  info: { title: 'petstore-mock', version: '1.0.0' },
  paths: {
    '/mock/pets/register': { post: op('펫 등록', 'pet') },
    '/mock/pets/{petId}': { get: op('펫 상세 조회', 'pet') },
    '/mock/owners/{ownerId}/pets': { get: op('보호자 펫 목록', 'pet') },
  },
  components: { schemas: {} },
}

createServer((req, res) => {
  /**
   * 상류가 살아 있는데 스펙만 빈 경우 — 실제로 겪은 사고 모양이다.
   * 이때 동기화가 그대로 진행되면 기존 요청 전부가 폐기된다(실제로 140개).
   * 그 가드를 테스트하려면 '0개를 정상 응답으로 주는' 소스가 필요하다.
   */
  if (req.url?.startsWith('/empty/api-docs')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ openapi: '3.0.1', info: { title: 'empty', version: '1' }, paths: {} }))
    return
  }
  /**
   * 같은 엔드포인트가 '바뀐' 버전 — 동기화가 남기는 스펙 변경(이전 → 이후)을 확인하는 데 쓴다.
   * 지문이 같으면 planSync 가 변경으로 치지 않으므로, 실제로 다른 스펙이 필요하다.
   * (요약이 바뀌고 쿼리 파라미터가 하나 늘었다)
   */
  if (req.url?.startsWith('/v2/api-docs')) {
    const changed = structuredClone(spec)
    changed.paths['/mock/pets/register'].post = {
      summary: '펫 등록 (v2)',
      tags: ['pet'],
      parameters: [{ name: 'dryRun', in: 'query', schema: { type: 'boolean' } }],
      responses: { '200': { description: 'OK' } },
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(changed))
    return
  }
  if (req.url?.startsWith('/v3/api-docs')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(spec))
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
}).listen(port, '0.0.0.0', () => {
  // 0.0.0.0 — 도커 안의 postq 가 host.docker.internal 로 들어온다.
  console.log(`[mock-spec] http://0.0.0.0:${port}/v3/api-docs — 폴더 동기화용 목 스펙`)
})
