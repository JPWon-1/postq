import { describe, expect, it } from 'vitest'
import { combineGqlBody, splitGqlBody } from './graphqlBody'

describe('combine/split GraphQL body', () => {
  it('빈 variables → raw 쿼리', () => {
    expect(combineGqlBody('{ me { id } }', '')).toBe('{ me { id } }')
    expect(splitGqlBody('{ me { id } }')).toEqual({ query: '{ me { id } }', variables: '' })
  })
  it('유효 JSON variables → {query,variables} 봉투, 되분리', () => {
    const body = combineGqlBody('query($id:ID!){u(id:$id){n}}', '{"id":"42"}')
    expect(JSON.parse(body)).toEqual({ query: 'query($id:ID!){u(id:$id){n}}', variables: { id: '42' } })
    const s = splitGqlBody(body)
    expect(s.query).toBe('query($id:ID!){u(id:$id){n}}')
    expect(JSON.parse(s.variables)).toEqual({ id: '42' })
  })
  it('{{변수}} 포함 variables 를 유실하지 않고 임베드·되분리(핵심 회귀)', () => {
    const vars = '{ "count": {{count}}, "flag": {{on}} }'
    const body = combineGqlBody('q', vars)
    // 봉투에 raw 로 임베드돼 {{}} 가 살아있다(서버 resolveRequest 가 치환)
    expect(body).toContain('{{count}}')
    expect(body).toContain('{{on}}')
    // 되분리 시 query/variables 가 다시 분리된다(전부 query 박스로 안 쏟아짐)
    const s = splitGqlBody(body)
    expect(s.query).toBe('q')
    expect(s.variables).toContain('{{count}}')
  })
})
