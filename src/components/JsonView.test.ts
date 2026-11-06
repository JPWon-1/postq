import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { JsonView } from './JsonView'
import { findTextMatches } from '@/lib/textSearch'

it('keeps syntax colors inside a single match spanning multiple tokens', () => {
  const text = '{"key": "value"}'
  const { matches } = findTextMatches(text, '"key": "val')
  const html = renderToStaticMarkup(createElement(JsonView, { text, matches, current: 0 }))
  expect(html.match(/<mark /g)).toHaveLength(1)
  expect(html).toMatch(/<mark[^>]*data-current-match="true"/)
  expect(html).toMatch(/<mark[^>]*>.*var\(--json-key\).*var\(--json-string\).*<\/mark>/)
  expect(html.replace(/<[^>]+>/g, '').replaceAll('&quot;', '"')).toBe(text)
})

it('renders a dense body without spreading hundreds of thousands of tokens into function arguments', () => {
  const text = `[${'1,'.repeat(70_000)}0]`
  const html = renderToStaticMarkup(createElement(JsonView, { text }))
  expect(html.match(/<span /g)).toHaveLength(70_001)
  expect(html.replace(/<[^>]+>/g, '')).toBe(text)
})
