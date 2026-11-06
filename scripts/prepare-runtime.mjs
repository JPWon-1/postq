// 데스크톱 앱에 넣을 런타임(src-tauri/runtime)을 만든다.
//
// 백엔드는 Rust(server/)이고 앱 실행 파일 안에 들어 있다 — 런타임에는 서버가 내줄 화면(정적 내보내기)과 DB 마이그레이션만 있으면 된다.
//   runtime/ui/       ← npm run build:static 의 out/
//   runtime/drizzle/  ← drizzle/ (서버가 기동 때 적용한다)
// 개발자 자격증명·DB·빌드 캐시는 절대 넣지 않는다.
import { cp, mkdir, rm, access, readdir } from 'node:fs/promises'
import { resolve, basename } from 'node:path'

const buildRoot = resolve(process.argv[2] ?? '.')
const ui = resolve(buildRoot, 'out')
const target = resolve('src-tauri/runtime')
await access(resolve(ui, 'index.html')).catch(() => {
  throw new Error(`정적 화면이 없습니다: ${ui}/index.html — 먼저 npm run build:static`)
})
await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
const safe = path => {
  const name = basename(path)
  return !name.startsWith('.env') && !/\.(db|sqlite)(-|$)/.test(name) && !['cache', '.git', 'data'].includes(name)
}
await cp(ui, resolve(target, 'ui'), { recursive: true, dereference: true, filter: safe })
await cp(resolve('drizzle'), resolve(target, 'drizzle'), { recursive: true, filter: safe })

// 서버가 기동 때 읽는 마이그레이션 일지 — 없으면 DB 를 못 연다. 빠뜨린 채 묶으면 설치본이 아예 안 뜬다.
await access(resolve(target, 'drizzle/meta/_journal.json'))
const files = await readdir(resolve(target, 'ui'), { recursive: true })
console.log(`Production runtime prepared: src-tauri/runtime (화면 ${files.length}개 파일 + drizzle)`)
