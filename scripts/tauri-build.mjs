// tauri build — 로컬 서명 인증서(scripts/setup-local-signing.sh)가 있으면 그걸로 서명한다.
// 서명 신원이 고정돼야 macOS 의 '데스크탑 폴더 접근' 허락이 재빌드·재설치 뒤에도 유지된다.
import { spawnSync } from 'node:child_process'

const NAME = 'postq local signing'
const env = { ...process.env }
if (process.platform === 'darwin' && !env.APPLE_SIGNING_IDENTITY) {
  const ids = spawnSync('security', ['find-identity', '-p', 'codesigning'], { encoding: 'utf8' }).stdout ?? ''
  if (ids.includes(NAME)) {
    env.APPLE_SIGNING_IDENTITY = NAME
    console.log(`서명: ${NAME}`)
  } else {
    console.log('서명: ad-hoc — 재빌드할 때마다 macOS 가 폴더 접근을 다시 묻는다. 고정하려면 sh scripts/setup-local-signing.sh')
  }
}
const r = spawnSync('npx', ['tauri', 'build', ...process.argv.slice(2)], { stdio: 'inherit', env })
process.exit(r.status ?? 1)
