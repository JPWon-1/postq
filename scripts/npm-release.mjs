#!/usr/bin/env node
// npm 배포 도우미 — .github/workflows/release.yml 의 npm·homebrew 작업이 쓴다. 로컬에서도 같은 순서로 돌려 볼 수 있다.
//
//   node scripts/npm-release.mjs pack    --npm-dir dist/npm --out tgz   # 실행 비트 복원 → npm pack → 실행 비트 검사 → tgz/packs.json
//   node scripts/npm-release.mjs check   <tgz…>                          # 플랫폼 패키지 안 실행 파일에 실행 비트가 있는지
//   node scripts/npm-release.mjs verify  --packs tgz/packs.json         # 레지스트리에 같은 이름·버전이 있으면 내용이 같은지(다르면 실패)
//   node scripts/npm-release.mjs publish --packs tgz/packs.json [--dry-run]
//   node scripts/npm-release.mjs compare <a> <b>                         # a<b 면 -1, 같으면 0, a>b 면 1 을 찍는다
//
// 왜 이렇게 하나:
// - actions/upload-artifact 는 파일 권한을 담지 않는다. 0644 로 돌아온 실행 파일을 그대로 pack 하면 설치 뒤 spawn EACCES.
//   워크플로는 tar 로 묶어 넘기지만, 여기서도 한 번 더 chmod +x 하고 tgz 안의 모드를 확인한다.
// - 같은 이름·버전이 이미 있으면 '우리가 올린 것' 인지 tgz 의 shasum·integrity 로 확인한다. npm pack 은 같은 내용이면
//   같은 바이트를 낸다(mtime 을 1985-10-26 으로 고정, 확인함). 남이 선점했거나 다른 빌드가 올라가 있으면 멈춘다.
// - 현재 latest 보다 낮은 버전(뒤늦게 돈 옛 태그)은 latest 를 덮지 않고 'previous' 로, 프리릴리스(1.2.0-beta.1)는 'next' 로 올린다.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAIN = 'postq'

/** semver(x.y.z[-pre]) 비교. 빌드 메타(+…)는 무시. 형식이 틀리면 던진다. */
export function compareVersions(a, b) {
  const parse = v => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v).trim())
    if (!m) throw new Error(`버전 형식이 아닙니다: ${v}`)
    return { nums: [m[1], m[2], m[3]].map(Number), pre: m[4] ? m[4].split('.') : [] }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1
  // 프리릴리스가 없는 쪽이 크다.
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    if (p === q) continue
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1
    if (pn !== qn) return pn ? -1 : 1
    return p < q ? -1 : 1
  }
  return 0
}

/** 올릴 dist-tag. 현재 latest 가 없으면 latest. 프리릴리스는 next 이되, 이미 더 높은 next 가 있으면
 *  뒤늦게 돈 옛 프리릴리스가 next 를 되돌리지 않게 previous 로 올린다. */
export function chooseTag(version, currentLatest, currentNext) {
  if (version.includes('-')) {
    if (currentNext && compareVersions(version, currentNext) < 0) return 'previous'
    return 'next'
  }
  if (currentLatest && compareVersions(version, currentLatest) < 0) return 'previous'
  return 'latest'
}

/** tgz 안의 파일 모드를 읽는다(ustar). { 'package/postq': 0o755, … } */
export function tarModes(tgzFile) {
  const buf = gunzipSync(readFileSync(tgzFile))
  const out = {}
  let off = 0
  let longName = null
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512)
    if (h.every(b => b === 0)) break
    const str = (s, l) => h.subarray(s, s + l).toString('utf8').replace(/\0.*$/s, '')
    const size = parseInt(str(124, 12).trim() || '0', 8)
    const type = str(156, 1)
    const prefix = str(345, 155)
    let name = prefix ? `${prefix}/${str(0, 100)}` : str(0, 100)
    const body = buf.subarray(off + 512, off + 512 + size)
    if (type === 'L') longName = body.toString('utf8').replace(/\0.*$/s, '')
    else if (type === 'x' || type === 'g') {
      const m = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))
      if (m && type === 'x') longName = m[1]
    } else {
      if (longName) name = longName
      longName = null
      out[name] = parseInt(str(100, 8).trim() || '0', 8) & 0o7777
    }
    off += 512 + Math.ceil(size / 512) * 512
  }
  return out
}

/** 플랫폼 패키지 tgz 의 실행 파일에 실행 비트가 있는지. 윈도우 패키지(.exe)는 볼 것이 없다. 문제 목록을 돌려준다. */
export function checkExecBits(tgzFile) {
  const name = basename(tgzFile)
  if (!/^postq-(darwin|linux)-/.test(name)) return []
  const modes = tarModes(tgzFile)
  const mode = modes['package/postq']
  if (mode === undefined) return [`${name}: package/postq 가 없습니다`]
  if ((mode & 0o111) !== 0o111) return [`${name}: package/postq 의 모드가 ${mode.toString(8)} — 실행 비트가 없어 설치 뒤 spawn EACCES 가 납니다`]
  return []
}

function npm(args, { allowFail = false } = {}) {
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { encoding: 'utf8', shell: process.platform === 'win32' })
  if (r.error) throw new Error(`npm 실행 실패: ${r.error.message}`)
  if (r.status !== 0 && !allowFail) throw new Error(`npm ${args.join(' ')} 가 ${r.status} 로 끝났습니다\n${r.stderr}`)
  return r
}

/** 레지스트리 조회. 없으면(E404) null, 그 밖의 실패는 던진다 — 네트워크 오류를 '없다' 로 읽으면 안 된다. */
function npmView(spec, field) {
  const r = npm(['view', spec, field, '--json'], { allowFail: true })
  const text = (r.stdout || '').trim()
  if (r.status !== 0) {
    let code = ''
    try {
      code = JSON.parse(text)?.error?.code ?? ''
    } catch {}
    if (code === 'E404' || /E404|404 Not Found/.test(r.stderr)) return null
    throw new Error(`npm view ${spec} ${field} 실패(${r.status}): ${r.stderr || text}`)
  }
  // 버전은 있는데 그 필드가 없으면 npm 은 빈 출력을 낸다.
  return text ? JSON.parse(text) : undefined
}

function parseOpts(argv) {
  const opts = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') opts.dryRun = true
    else if (a.startsWith('--')) {
      const v = argv[++i]
      if (!v) throw new Error(`${a} 에 값이 필요합니다`)
      opts[a.slice(2)] = v
    } else opts._.push(a)
  }
  return opts
}

/** 플랫폼 패키지를 먼저, 메인을 마지막에 — 메인이 먼저 나가면 그 사이 설치한 사람은 실행 파일 없이 깔린다. */
function ordered(packs) {
  return [...packs.filter(p => p.name !== MAIN), ...packs.filter(p => p.name === MAIN)]
}

function cmdPack(opts) {
  const npmDir = resolve(opts['npm-dir'] ?? 'dist/npm')
  const out = resolve(opts.out ?? 'tgz')
  mkdirSync(out, { recursive: true })
  const dirs = readdirSync(npmDir)
    .filter(d => existsSync(join(npmDir, d, 'package.json')))
    .sort()
  if (!dirs.includes(MAIN)) throw new Error(`${npmDir}/${MAIN} 가 없습니다 — 먼저 package-release.mjs --main-only`)
  const packs = []
  const problems = []
  for (const d of dirs) {
    const dir = join(npmDir, d)
    const exe = join(dir, 'postq')
    // 아티팩트를 거치며 실행 비트가 빠졌어도 되살린다(윈도우 패키지는 postq.exe 라 해당 없음).
    if (existsSync(exe) && statSync(exe).isFile()) chmodSync(exe, 0o755)
    const r = npm(['pack', dir, '--pack-destination', out, '--json'])
    const [info] = JSON.parse(r.stdout)
    const file = join(out, info.filename)
    problems.push(...checkExecBits(file))
    packs.push({ name: info.name, version: info.version, file, shasum: info.shasum, integrity: info.integrity })
  }
  if (problems.length) throw new Error(problems.join('\n'))
  const versions = new Set(packs.map(p => p.version))
  if (versions.size !== 1) throw new Error(`패키지 버전이 서로 다릅니다: ${[...versions].join(', ')}`)
  writeFileSync(join(out, 'packs.json'), JSON.stringify(packs, null, 2) + '\n')
  for (const p of packs) console.log(`${p.name}@${p.version}  ${basename(p.file)}  sha1 ${p.shasum}`)
}

function cmdCheck(opts) {
  const problems = opts._.flatMap(f => checkExecBits(resolve(f)))
  if (problems.length) throw new Error(problems.join('\n'))
  console.log(`실행 비트 확인: ${opts._.length}개 OK`)
}

/** 이미 있는 것은 같은지 확인하고, 없는 것은 어떤 태그로 올릴지 정한다. */
function plan(packs) {
  const steps = []
  for (const p of ordered(packs)) {
    const dist = npmView(`${p.name}@${p.version}`, 'dist')
    if (dist === null) {
      const tags = npmView(p.name, 'dist-tags')
      steps.push({ ...p, action: 'publish', tag: chooseTag(p.version, tags?.latest, tags?.next), latest: tags?.latest ?? null })
      continue
    }
    if (!dist || dist.shasum !== p.shasum || dist.integrity !== p.integrity) {
      throw new Error(
        [
          `${p.name}@${p.version} 가 이미 레지스트리에 있는데 내용이 다릅니다.`,
          `  레지스트리: shasum ${dist?.shasum} integrity ${dist?.integrity}`,
          `  이번 빌드:  shasum ${p.shasum} integrity ${p.integrity}`,
          '  남이 이름·버전을 먼저 가져갔거나, 다른 빌드가 이미 올라갔습니다. npm 은 같은 버전을 다시 올릴 수 없으니',
          '  maintainers(npm view <이름> maintainers)를 확인하고, 우리 것이면 버전을 올려 새로 태그합니다.',
        ].join('\n'),
      )
    }
    steps.push({ ...p, action: 'skip' })
  }
  return steps
}

function cmdVerify(opts) {
  const packs = JSON.parse(readFileSync(resolve(opts.packs ?? 'tgz/packs.json'), 'utf8'))
  for (const s of plan(packs)) {
    console.log(s.action === 'skip' ? `${s.name}@${s.version}: 이미 있음(내용 같음)` : `${s.name}@${s.version}: 올릴 것 → --tag ${s.tag} (현재 latest ${s.latest ?? '없음'})`)
  }
}

function cmdPublish(opts) {
  const packs = JSON.parse(readFileSync(resolve(opts.packs ?? 'tgz/packs.json'), 'utf8'))
  // 하나라도 어긋나면 아무것도 올리지 않는다 — 먼저 전부 확인한다.
  const steps = plan(packs)
  for (const s of steps) {
    if (s.action === 'skip') {
      console.log(`${s.name}@${s.version} 이미 있음(내용 같음) — 건너뜀`)
      continue
    }
    // tgz 그대로 올린다 — 위에서 비교한 shasum 이 레지스트리에 그대로 남는다. 토큰이 없으면 npm 이 OIDC(Trusted Publishing)를 쓴다.
    const args = ['publish', s.file, '--access', 'public', '--provenance', '--tag', s.tag]
    if (opts.dryRun) args.push('--dry-run')
    console.log(`npm ${args.join(' ')}`)
    const r = npm(args, { allowFail: true })
    process.stdout.write(r.stdout)
    process.stderr.write(r.stderr)
    if (r.status !== 0) throw new Error(`${s.name}@${s.version} publish 실패(${r.status})`)
  }
}

function cmdCompare(opts) {
  const [a, b] = opts._
  if (!a || !b) throw new Error('compare <a> <b>')
  console.log(String(compareVersions(a, b)))
}

const COMMANDS = { pack: cmdPack, check: cmdCheck, verify: cmdVerify, publish: cmdPublish, compare: cmdCompare }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2)
  try {
    if (!COMMANDS[cmd]) throw new Error(`명령: ${Object.keys(COMMANDS).join(' | ')}`)
    COMMANDS[cmd](parseOpts(rest))
  } catch (e) {
    console.error(`npm-release: ${e.message}`)
    process.exit(1)
  }
}
