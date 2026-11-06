#!/usr/bin/env node
// Homebrew formula(packaging/homebrew/postq.rb)를 버전·sha256 으로 다시 쓴다.
//
//   node scripts/update-formula.mjs --dist dist                 # dist/ 의 묶음 4개에서 sha256 을 계산
//   node scripts/update-formula.mjs --sha darwin-arm64=<hex> …  # sha256 을 직접 준다
//   옵션: --version <x.y.z>(기본 package.json) --url-base <주소>(기본 GitHub Release) --out <파일> --allow-missing
//
// 릴리스 워크플로(.github/workflows/release.yml)가 묶음을 올린 뒤 이것으로 탭 저장소의 Formula/postq.rb 를 만든다.
// --allow-missing 은 묶음이 일부만 있을 때(로컬 시험) 빠진 칸을 0 으로 채운다 — 그 formula 는 해당 플랫폼에서 설치되지 않는다.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']
const PLACEHOLDER = '0'.repeat(64)

function parseArgs(argv) {
  const opts = { sha: {}, out: join(root, 'packaging/homebrew/postq.rb'), allowMissing: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (!v) throw new Error(`${a} 에 값이 필요합니다`)
      return v
    }
    if (a === '--version') opts.version = next()
    else if (a === '--dist') opts.dist = next()
    else if (a === '--url-base') opts.urlBase = next()
    else if (a === '--out') opts.out = resolve(next())
    else if (a === '--allow-missing') opts.allowMissing = true
    else if (a === '--sha') {
      const [plat, hex] = next().split('=')
      if (!PLATFORMS.includes(plat) || !/^[0-9a-f]{64}$/i.test(hex ?? '')) throw new Error(`--sha 는 <${PLATFORMS.join('|')}>=<sha256 64자> 입니다`)
      opts.sha[plat] = hex.toLowerCase()
    } else throw new Error(`모르는 옵션: ${a}`)
  }
  return opts
}

function formula({ version, urlBase, sha }) {
  const url = plat => `${urlBase}/postq-${version}-${plat}.tar.gz`
  const block = plat => `      url "${url(plat)}"\n      sha256 "${sha[plat]}"`
  return `# 이 파일은 scripts/update-formula.mjs 가 만든다 — 직접 고치지 말 것.
# 탭 저장소 JPWon-1/homebrew-tap 의 Formula/postq.rb 로 올라간다(.github/workflows/release.yml).
class Postq < Formula
  desc "Local API client (Postman-like) that runs in your browser"
  homepage "https://github.com/JPWon-1/postq"
  version "${version}"
  license "MIT"

  on_macos do
    on_arm do
${block('darwin-arm64')}
    end
    on_intel do
${block('darwin-x64')}
    end
  end

  on_linux do
    on_arm do
${block('linux-arm64')}
    end
    on_intel do
${block('linux-x64')}
    end
  end

  def install
    bin.install "postq"
    # 실행 파일은 <prefix>/bin/../share/postq 에서 화면(ui)과 마이그레이션(drizzle)을 찾는다.
    pkgshare.install "ui", "drizzle"
  end

  def caveats
    <<~EOS
      Run \`postq\` to start it and open the browser (\`postq --help\` for options).
      Data (database and secret.key) lives in your user data folder, not in Homebrew's prefix;
      back up secret.key together with the database.
    EOS
  end

  test do
    assert_match "postq #{version}", shell_output("#{bin}/postq --version")
  end
end
`
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const version = opts.version ?? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  const urlBase = (opts.urlBase ?? `https://github.com/JPWon-1/postq/releases/download/v${version}`).replace(/\/$/, '')
  const sha = { ...opts.sha }
  if (opts.dist) {
    for (const plat of PLATFORMS) {
      const file = resolve(opts.dist, `postq-${version}-${plat}.tar.gz`)
      if (!sha[plat] && existsSync(file)) sha[plat] = createHash('sha256').update(readFileSync(file)).digest('hex')
    }
  }
  const missing = PLATFORMS.filter(p => !sha[p])
  if (missing.length && !opts.allowMissing) throw new Error(`sha256 이 없습니다: ${missing.join(', ')} (--dist 나 --sha 로 주거나 --allow-missing)`)
  for (const p of missing) sha[p] = PLACEHOLDER
  writeFileSync(opts.out, formula({ version, urlBase, sha }))
  console.log(`formula: ${opts.out} (v${version})`)
  for (const p of PLATFORMS) console.log(`  ${p.padEnd(13)} ${sha[p]}${sha[p] === PLACEHOLDER ? '  (없음)' : ''}`)
}

try {
  main()
} catch (e) {
  console.error(`update-formula: ${e.message}`)
  process.exit(1)
}
