import { expect, test } from 'vitest'
import { decideExecution, executionPolicies, type ExecutionSource } from './executionPolicy'

for (const policy of executionPolicies) for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE', 'CUSTOM', 'get']) {
  for (const source of ['ui', 'mcp', 'schedule', 'flow'] as ExecutionSource[]) for (const aiExecutionAllowed of [false, true]) for (const confirmed of [false, true]) {
    test(`${policy} ${method} ${source} AI=${aiExecutionAllowed} confirmed=${confirmed}`, () => {
      const read = ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())
      const expected = read || (policy !== 'read-only' && (policy !== 'confirm-writes' || (source === 'ui' && confirmed)) && (source !== 'mcp' || aiExecutionAllowed))
      expect(decideExecution({ policy, method, source, aiExecutionAllowed, confirmed }).allowed).toBe(expected)
    })
  }
}
test('omitted policy preserves human open behavior but MCP writes remain opt-in', () => {
  expect(decideExecution({ method: 'POST', source: 'ui' }).allowed).toBe(true)
  expect(decideExecution({ method: 'POST', source: 'mcp' }).allowed).toBe(false)
})

import { parameterTypeError } from './executionPolicy'
test.each([
  ['integer', '12', false], ['integer', '1.2', true], ['number', '1.2', false], ['number', 'NaN', true],
  ['boolean', 'true', false], ['boolean', '1', true], ['string', 'anything', false],
])('scalar query validation: %s %s', (type, value, rejected) => {
  const error = parameterTypeError({ fields: { '요청 query.limit': { type, required: false } }, incomplete: [] }, {
    method: 'GET', url: 'https://example.com', headers: [], params: [{ key: 'limit', value, enabled: true }], bodyType: 'none', body: '',
  })
  expect(!!error).toBe(rejected)
})
