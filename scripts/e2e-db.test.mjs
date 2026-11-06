import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contentHash, copyDatabase } from './e2e-db.mjs'

test('WAL 포함 사본은 원본과 같고 사본 변경은 원본에 영향을 주지 않는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pq-db-test-'))
  const source = join(dir, 'source.db'), copy = join(dir, 'copy.db')
  const db = new DatabaseSync(source)
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE sample (value, bytes, large)')
    db.prepare('INSERT INTO sample VALUES (?, ?, ?)').run('WAL data', Buffer.from([0, 255, 128]), 9223372036854775807n)
    assert.ok(existsSync(source + '-wal'))
    const before = contentHash(source)
    copyDatabase(source, copy)
    assert.equal(contentHash(copy), before)
    const duplicate = new DatabaseSync(copy)
    try { duplicate.exec("UPDATE sample SET value='changed'") } finally { duplicate.close() }
    assert.notEqual(contentHash(copy), before)
    assert.equal(contentHash(source), before)
    assert.throws(() => copyDatabase(source, copy))
    assert.equal(contentHash(source), before)
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('없는 원본은 읽기 전용으로 실패하고 DB를 만들지 않는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pq-db-missing-'))
  try {
    const missing = join(dir, 'missing.db')
    assert.throws(() => contentHash(missing))
    assert.throws(() => copyDatabase(missing, join(dir, 'copy.db')))
    assert.equal(existsSync(missing), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
