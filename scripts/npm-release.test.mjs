// node --test scripts/npm-release.test.mjs — 레지스트리·npm 을 부르지 않는 부분만 본다.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MAIN, checkExecBits, chooseTag, compareVersions, publishArgs, tarModes, validatePacks } from './npm-release.mjs'

test('scoped main package, unchanged platform names, and public publishing', () => {
  assert.equal(MAIN, '@postq/postq')
  const packs = [{ name: MAIN }, { name: 'postq-darwin-arm64' }]
  assert.doesNotThrow(() => validatePacks(packs))
  assert.throws(() => validatePacks([{ name: 'postq' }]), /예상하지 않은/)
  assert.throws(() => validatePacks([{ name: MAIN }, { name: MAIN }]), /중복/)
  assert.throws(() => validatePacks([{ name: 'postq-darwin-arm64' }]), /메인 패키지/)
  assert.deepEqual(publishArgs({ file: 'main.tgz' }, 'latest'), ['publish', 'main.tgz', '--access', 'public', '--provenance', '--tag', 'latest'])
})

test('버전 비교', () => {
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0)
  assert.equal(compareVersions('0.1.0', '0.2.0'), -1)
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1)
  assert.equal(compareVersions('v1.0.0', '1.0.0'), 0)
  assert.equal(compareVersions('1.0.0-beta.1', '1.0.0'), -1)
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.10'), -1)
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1)
  assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1)
  assert.throws(() => compareVersions('1.0', '1.0.0'))
})

test('dist-tag 고르기', () => {
  assert.equal(chooseTag('0.1.0', undefined), 'latest')
  assert.equal(chooseTag('0.2.0', '0.1.0'), 'latest')
  assert.equal(chooseTag('0.2.0', '0.2.0'), 'latest')
  // 뒤늦게 돈 옛 태그가 latest 를 되돌리지 않는다.
  assert.equal(chooseTag('0.1.5', '0.2.0'), 'previous')
  assert.equal(chooseTag('0.3.0-beta.1', '0.2.0'), 'next')
  assert.equal(chooseTag('0.3.0-beta.2', '0.2.0', '0.3.0-beta.1'), 'next')
  // 뒤늦게 돈 옛 프리릴리스가 next 를 되돌리지 않는다.
  assert.equal(chooseTag('0.3.0-beta.1', '0.2.0', '0.3.0-beta.2'), 'previous')
})

test('tgz 안 실행 비트 검사', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'pq-tar-'))
  const make = (plat, mode) => {
    const pkg = join(root, plat, 'package')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'postq'), 'bin')
    chmodSync(join(pkg, 'postq'), mode)
    const file = join(root, `postq-${plat}-0.1.0.tgz`)
    const r = spawnSync('tar', ['-czf', file, '-C', join(root, plat), 'package'])
    assert.equal(r.status, 0)
    return file
  }
  const good = make('linux-x64', 0o755)
  const bad = make('darwin-arm64', 0o644)
  assert.equal(tarModes(good)['package/postq'], 0o755)
  assert.deepEqual(checkExecBits(good), [])
  assert.equal(checkExecBits(bad).length, 1)
  assert.match(checkExecBits(bad)[0], /EACCES/)
})
