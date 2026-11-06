#!/usr/bin/env node
// 배포 묶음을 만든다 — GitHub Release 에 올릴 압축 파일과 npm 패키지 디렉터리.
//
//   node scripts/package-release.mjs [--target <rust 대상>] [--binary <경로>] [--ui out] [--out dist] [--main]
//   node scripts/package-release.mjs --main-only [--out dist]
//
// 만드는 것(대상 하나당):
//   dist/postq-<버전>-<플랫폼>.tar.gz   (윈도우는 .zip) 와 .sha256
//       안에 postq-<버전>-<플랫폼>/{postq[.exe], ui/, drizzle/, LICENSE, README.md}
//   dist/npm/postq-<플랫폼>/            npm 플랫폼 패키지(os/cpu 필드, 실행 파일·ui·drizzle 이 한 폴더)
//   --main 이면 dist/npm/postq/          npm 메인 패키지(런처 + optionalDependencies)
//
// 실행 파일은 미리 빌드해 둔다: (cd server && cargo build --release --locked --bin postq --target <대상>).
// 화면은 미리 빌드해 둔다: npm run build (out/).
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** rust 대상 → npm 플랫폼. 플랫폼 이름은 node 의 process.platform-process.arch 와 같다(런처가 그걸로 찾는다). */
const TARGETS = {
  'aarch64-apple-darwin': { platform: 'darwin-arm64', os: 'darwin', cpu: 'arm64', archive: 'tar.gz' },
  'x86_64-apple-darwin': { platform: 'darwin-x64', os: 'darwin', cpu: 'x64', archive: 'tar.gz' },
  'x86_64-unknown-linux-gnu': { platform: 'linux-x64', os: 'linux', cpu: 'x64', archive: 'tar.gz', libc: 'glibc' },
  'aarch64-unknown-linux-gnu': { platform: 'linux-arm64', os: 'linux', cpu: 'arm64', archive: 'tar.gz', libc: 'glibc' },
  'x86_64-pc-windows-msvc': { platform: 'win32-x64', os: 'win32', cpu: 'x64', archive: 'zip', exe: '.exe' },
}

const REPO = 'https://github.com/JPWon-1/postq'

function hostTarget() {
  const key = `${process.platform}-${process.arch}`
  const found = Object.entries(TARGETS).find(([, t]) => t.platform === key)
  if (!found) throw new Error(`이 컴퓨터(${key})에 맞는 배포 대상이 없습니다 — --target 을 주세요`)
  return found[0]
}

function parseArgs(argv) {
  const opts = { ui: 'out', out: 'dist', main: false, mainOnly: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (!v) throw new Error(`${a} 에 값이 필요합니다`)
      return v
    }
    if (a === '--target') opts.target = next()
    else if (a === '--binary') opts.binary = next()
    else if (a === '--ui') opts.ui = next()
    else if (a === '--out') opts.out = next()
    else if (a === '--main') opts.main = true
    else if (a === '--main-only') opts.mainOnly = true
    else throw new Error(`모르는 옵션: ${a}`)
  }
  return opts
}

/** 버전은 package.json 과 server/Cargo.toml 이 같아야 한다 — `postq --version` 이 Cargo 쪽을 찍는다. */
function readVersion() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  const cargo = readFileSync(join(root, 'server/Cargo.toml'), 'utf8').match(/^version\s*=\s*"([^"]+)"/m)?.[1]
  if (pkg !== cargo) throw new Error(`버전이 다릅니다: package.json ${pkg}, server/Cargo.toml ${cargo}`)
  return pkg
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function run(cmd, args, cwd) {
  // 맥 tar 가 ._ 파일(확장 속성)을 끼워 넣지 않게 한다.
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } })
  if (r.error) throw new Error(`${cmd} 실행 실패: ${r.error.message}`)
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 가 ${r.status} 로 끝났습니다`)
}

/** DB·.env 같은 개인 파일이 묶음에 섞이지 않게 거른다(prepare-runtime.mjs 와 같은 규칙). */
const safe = path => {
  const name = basename(path)
  return !name.startsWith('.env') && !/\.(db|sqlite)(-|$)/.test(name) && !['cache', '.git', 'data', '.DS_Store'].includes(name)
}

function copyPayload(dest, { binary, exeName, ui }) {
  mkdirSync(dest, { recursive: true })
  cpSync(binary, join(dest, exeName))
  chmodSync(join(dest, exeName), 0o755)
  cpSync(ui, join(dest, 'ui'), { recursive: true, dereference: true, filter: safe })
  cpSync(join(root, 'drizzle'), join(dest, 'drizzle'), { recursive: true, filter: safe })
  cpSync(join(root, 'LICENSE'), join(dest, 'LICENSE'))
}

function writeJson(file, obj) {
  writeFileSync(file, JSON.stringify(obj, null, 2) + '\n')
}

const common = version => ({
  version,
  license: 'MIT',
  repository: { type: 'git', url: `git+${REPO}.git` },
  homepage: REPO,
  bugs: { url: `${REPO}/issues` },
})

function platformPackage(dir, triple, version, payload) {
  const t = TARGETS[triple]
  const name = `postq-${t.platform}`
  rmSync(dir, { recursive: true, force: true })
  copyPayload(dir, payload)
  writeJson(join(dir, 'package.json'), {
    name,
    ...common(version),
    description: `The ${t.platform} binary for postq. Install "@rocknzero/postq" instead of this package.`,
    os: [t.os],
    cpu: [t.cpu],
    ...(t.libc ? { libc: [t.libc] } : {}),
    // 실행 비트는 npm pack 이 그대로 담는다(확인함). 런처가 직접 실행하므로 bin 으로 등록하지 않는다 — 전역 명령이 둘 생긴다.
    files: [payload.exeName, 'ui', 'drizzle', 'LICENSE', 'README.md'],
    preferUnplugged: true,
  })
  writeFileSync(
    join(dir, 'README.md'),
    `# ${name}\n\nThe prebuilt \`${t.platform}\` binary of [postq](${REPO}). Do not install this directly — run:\n\n\`\`\`sh\nnpm install -g @rocknzero/postq\n\`\`\`\n`,
  )
  return name
}

function mainPackage(dir, version) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'bin'), { recursive: true })
  const src = JSON.parse(readFileSync(join(root, 'npm/postq/package.json'), 'utf8'))
  if (src.name !== '@rocknzero/postq') throw new Error(`메인 npm 패키지 이름이 다릅니다: ${src.name}`)
  const optionalDependencies = Object.fromEntries(
    Object.values(TARGETS)
      .map(t => `postq-${t.platform}`)
      .sort()
      .map(n => [n, version]),
  )
  writeJson(join(dir, 'package.json'), { ...src, ...common(version), optionalDependencies })
  cpSync(join(root, 'npm/postq/bin/postq.js'), join(dir, 'bin/postq.js'))
  chmodSync(join(dir, 'bin/postq.js'), 0o755)
  // npm 페이지에서는 저장소 안의 상대 경로가 깨진다 — GitHub 주소로 바꿔 둔다(그림은 raw, 문서는 blob).
  const readme = readFileSync(join(root, 'README.md'), 'utf8').replace(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g, (_, p) =>
    /\.(png|jpe?g|gif|svg|webp)$/i.test(p) ? `](${REPO}/raw/main/${p})` : `](${REPO}/blob/main/${p})`,
  ).replace(/\b(src|href)="(?!https?:|#|mailto:)([^"\s]+)"/g, (_, attr, p) =>
    /\.(png|jpe?g|gif|svg|webp)$/i.test(p) ? `${attr}="${REPO}/raw/main/${p}"` : `${attr}="${REPO}/blob/main/${p}"`,
  )
  writeFileSync(join(dir, 'README.md'), readme)
  cpSync(join(root, 'LICENSE'), join(dir, 'LICENSE'))
}

function archive(stageParent, folder, outFile, kind) {
  rmSync(outFile, { force: true })
  if (kind === 'zip') {
    if (process.platform === 'win32') {
      // 윈도우 10+ 에 들어 있는 bsdtar 는 확장자를 보고 zip 을 만든다(-a). 경로를 박아 둔다 — Git Bash 에서 돌리면
      // PATH 앞쪽의 GNU tar 가 잡히는데, 그건 zip 을 못 만들고 'D:\…' 를 원격 호스트로 읽는다.
      const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      run(existsSync(tar) ? tar : 'tar', ['-a', '-c', '-f', outFile, folder], stageParent)
    } else {
      run('zip', ['-q', '-r', '-X', outFile, folder], stageParent)
    }
  } else {
    run('tar', ['-c', '-z', '-f', outFile, folder], stageParent)
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const version = readVersion()
  const out = resolve(root, opts.out)
  mkdirSync(join(out, 'npm'), { recursive: true })

  if (opts.mainOnly) {
    mainPackage(join(out, 'npm/postq'), version)
    console.log(`npm 메인 패키지: ${join(out, 'npm/postq')} (${version})`)
    return
  }

  const triple = opts.target ?? hostTarget()
  const t = TARGETS[triple]
  if (!t) throw new Error(`모르는 대상: ${triple} — ${Object.keys(TARGETS).join(', ')}`)
  const exeName = `postq${t.exe ?? ''}`
  const candidates = [join('server/target', triple, 'release', exeName)]
  // 대상 없이 빌드한 것(cargo build --release)은 이 컴퓨터용일 때만 쓴다.
  if (`${process.platform}-${process.arch}` === t.platform) candidates.push(join('server/target/release', exeName))
  const binary = resolve(root, opts.binary ?? candidates.find(p => existsSync(resolve(root, p))) ?? candidates[0])
  if (!existsSync(binary)) throw new Error(`실행 파일이 없습니다: ${binary} — 먼저 cargo build --release --bin postq --target ${triple}`)
  const ui = resolve(root, opts.ui)
  if (!existsSync(join(ui, 'index.html'))) throw new Error(`화면이 없습니다: ${ui}/index.html — 먼저 npm run build`)
  if (!existsSync(join(root, 'drizzle/meta/_journal.json'))) throw new Error('drizzle/meta/_journal.json 이 없습니다')
  const payload = { binary, exeName, ui }

  // 1) 릴리스 압축 파일
  const folder = `postq-${version}-${t.platform}`
  const stage = join(out, 'stage')
  rmSync(join(stage, folder), { recursive: true, force: true })
  copyPayload(join(stage, folder), payload)
  cpSync(join(root, 'README.md'), join(stage, folder, 'README.md'))
  const archiveFile = join(out, `${folder}.${t.archive}`)
  archive(stage, folder, archiveFile, t.archive)
  const digest = sha256(archiveFile)
  writeFileSync(`${archiveFile}.sha256`, `${digest}  ${basename(archiveFile)}\n`)
  rmSync(join(stage, folder), { recursive: true, force: true })

  // 2) npm 플랫폼 패키지
  const pkgDir = join(out, 'npm', `postq-${t.platform}`)
  const name = platformPackage(pkgDir, triple, version, payload)

  // 3) npm 메인 패키지
  if (opts.main) mainPackage(join(out, 'npm/postq'), version)

  const size = statSync(archiveFile).size
  console.log(`묶음: ${archiveFile} (${(size / 1024 / 1024).toFixed(1)} MB, sha256 ${digest})`)
  console.log(`npm 플랫폼 패키지: ${pkgDir} (${name}@${version}, 파일 ${readdirSync(pkgDir).length}개 항목)`)
  if (opts.main) console.log(`npm 메인 패키지: ${join(out, 'npm/postq')}`)
}

try {
  main()
} catch (e) {
  console.error(`package-release: ${e.message}`)
  process.exit(1)
}
