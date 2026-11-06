// 테스트 사본만 쓴다. Node 22.13+ 내장 SQLite — npm 네이티브 빌드가 필요 없다.
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'

/** WAL을 포함한 논리 내용 지문. 원본은 읽기 전용, 한 스냅샷으로 읽는다. */
export function contentHash(file) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    db.exec('BEGIN')
    const h = createHash('sha256')
    const tables = db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name").all()
    for (const { name } of tables) {
      h.update(`\n#${name}\n`)
      const stmt = db.prepare(`select * from "${name.replace(/"/g, '""')}" order by rowid`)
      stmt.setReadBigInts(true)
      for (const row of stmt.iterate()) {
        h.update(JSON.stringify(row, (_k, v) => v instanceof Uint8Array ? Buffer.from(v).toString('base64') : typeof v === 'bigint' ? String(v) : v))
      }
    }
    return h.digest('hex')
  } finally { db.close() }
}

/** 파일 복사 대신 VACUUM INTO로 WAL까지 일관된 사본을 만든다. */
export function copyDatabase(source, destination) {
  const db = new DatabaseSync(source, { readOnly: true })
  try { db.prepare('VACUUM INTO ?').run(destination) } finally { db.close() }
}
