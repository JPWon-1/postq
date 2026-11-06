#!/usr/bin/env node
import ts from 'typescript'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = new URL('../src/', import.meta.url).pathname
const korean = /[가-힣]/
let count = 0

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = join(dir, entry.name)
    return entry.isDirectory() ? files(file) : entry.name.endsWith('.tsx') && !entry.name.includes('.test.') ? [file] : []
  })
}

for (const file of files(root)) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  function visit(node) {
    const visible = ts.isJsxText(node) ||
      (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) ||
      (ts.isJsxExpression(node) && node.expression && (ts.isStringLiteral(node.expression) || ts.isNoSubstitutionTemplateLiteral(node.expression)))
    if (visible && korean.test(node.getText(source))) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
      console.log(`${relative(root, file)}:${line}: ${node.getText(source).trim().slice(0, 100)}`)
      count++
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

console.log(`Remaining Korean JSX strings/attributes: ${count}`)
if (count) process.exitCode = 1
