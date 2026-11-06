import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const json = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'))
const writeJson = (path, value) => writeFileSync(resolve(root, path), `${JSON.stringify(value, null, 2)}\n`)
const read = path => readFileSync(resolve(root, path), 'utf8')
const write = (path, value) => writeFileSync(resolve(root, path), value)
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const platforms = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']

function tomlVersion(path) {
  const match = read(path).match(/^\[package\]\n(?:[^\[]*\n)*?version = "([^"]+)"/m)
  if (!match) throw new Error(`Missing package version: ${path}`)
  return match[1]
}

function lockVersion(path, name) {
  const match = read(path).match(new RegExp(`\\[\\[package\\]\\]\\nname = "${name}"\\nversion = "([^"]+)"`))
  if (!match) throw new Error(`Missing ${name} in ${path}`)
  return match[1]
}

export function versions() {
  const main = json('package.json')
  const npm = json('npm/postq/package.json')
  const lock = json('package-lock.json')
  const values = {
    'package.json': main.version,
    'package-lock.json': lock.version,
    'package-lock.json packages[""]': lock.packages[''].version,
    'npm/postq/package.json': npm.version,
    'npm/postq package name': npm.name,
    'server/Cargo.toml': tomlVersion('server/Cargo.toml'),
    'src-tauri/Cargo.toml': tomlVersion('src-tauri/Cargo.toml'),
    'src-tauri/tauri.conf.json': json('src-tauri/tauri.conf.json').version,
    'server/Cargo.lock postq-server': lockVersion('server/Cargo.lock', 'postq-server'),
    'src-tauri/Cargo.lock postq-server': lockVersion('src-tauri/Cargo.lock', 'postq-server'),
    'src-tauri/Cargo.lock postq-desktop': lockVersion('src-tauri/Cargo.lock', 'postq-desktop'),
    'server/src/mcp.rs': read('server/src/mcp.rs').match(/const SERVER_VERSION: &str = "([^"]+)"/)?.[1],
    'packaging/homebrew/postq.rb': read('packaging/homebrew/postq.rb').match(/^  version "([^"]+)"/m)?.[1],
  }
  for (const platform of platforms) values[`npm/postq optionalDependencies ${platform}`] = npm.optionalDependencies[`postq-${platform}`]
  for (const platform of platforms.slice(0, 4)) {
    const formula = read('packaging/homebrew/postq.rb')
    const match = formula.match(new RegExp(`postq-([^/]+)-${platform}\\.tar\\.gz`))
    values[`packaging/homebrew URL ${platform}`] = match?.[1]
  }
  return values
}

export function checkVersions() {
  const values = versions()
  const expected = values['package.json']
  if (!semver.test(expected)) throw new Error(`Invalid SemVer: ${expected}`)
  const wrong = Object.entries(values).filter(([path, value]) => value !== (path === 'npm/postq package name' ? '@postq/postq' : expected))
  if (wrong.length) throw new Error(`Version mismatch (expected ${expected}):\n${wrong.map(([path, value]) => `  ${path}: ${value ?? '(missing)'}`).join('\n')}`)
  return expected
}

function replaceOne(path, pattern, replacement) {
  const source = read(path)
  if (!pattern.test(source)) throw new Error(`Version not found in ${path}`)
  write(path, source.replace(pattern, replacement))
}

function replaceLock(path, name, version) {
  const pattern = new RegExp(`(\\[\\[package\\]\\]\\nname = "${name}"\\nversion = ")[^"]+(")`)
  replaceOne(path, pattern, (_, before, after) => `${before}${version}${after}`)
}

export function bumpVersion(version) {
  if (!semver.test(version)) throw new Error(`Expected SemVer, got: ${version}`)
  const previous = checkVersions()
  if (version === previous) throw new Error(`Already at ${version}`)
  const main = json('package.json'); main.version = version; writeJson('package.json', main)
  const lock = json('package-lock.json'); lock.version = version; lock.packages[''].version = version; writeJson('package-lock.json', lock)
  const npm = json('npm/postq/package.json'); npm.version = version
  for (const platform of platforms) npm.optionalDependencies[`postq-${platform}`] = version
  writeJson('npm/postq/package.json', npm)
  for (const path of ['server/Cargo.toml', 'src-tauri/Cargo.toml']) replaceOne(path, /^version = "[^"]+"/m, `version = "${version}"`)
  const tauri = json('src-tauri/tauri.conf.json'); tauri.version = version; writeJson('src-tauri/tauri.conf.json', tauri)
  for (const [path, names] of [['server/Cargo.lock', ['postq-server']], ['src-tauri/Cargo.lock', ['postq-server', 'postq-desktop']]]) {
    for (const name of names) replaceLock(path, name, version)
  }
  replaceOne('server/src/mcp.rs', /const SERVER_VERSION: &str = "[^"]+";/, `const SERVER_VERSION: &str = "${version}";`)
  replaceOne('server/src/mcp.rs', /("serverInfo":\{"name":"postq","version":")[^"]+("\})/, (_, before, after) => `${before}${version}${after}`)
  write('packaging/homebrew/postq.rb', read('packaging/homebrew/postq.rb').replaceAll(previous, version))
  checkVersions()
}
