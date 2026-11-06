#!/usr/bin/env node
// postq 런처 — 이 컴퓨터에 맞는 플랫폼 패키지(postq-<os>-<cpu>)의 실행 파일을 찾아 그대로 실행한다.
// 플랫폼 패키지는 optionalDependencies 로 깔리고, npm 이 os/cpu 필드를 보고 맞는 것 하나만 받는다(postinstall 다운로드 없음).
// 인자·표준 입출력은 그대로 넘기고, 자식의 종료 코드·신호를 그대로 돌려준다.
'use strict'

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const PLATFORMS = {
  'darwin-arm64': 'postq-darwin-arm64',
  'darwin-x64': 'postq-darwin-x64',
  'linux-arm64': 'postq-linux-arm64',
  'linux-x64': 'postq-linux-x64',
  'win32-x64': 'postq-win32-x64',
}

function fail(lines) {
  process.stderr.write(lines.join('\n') + '\n')
  process.exit(1)
}

function findBinary() {
  // 개발·시험용 — 실행 파일을 직접 가리킨다.
  if (process.env.POSTQ_BINARY) return process.env.POSTQ_BINARY

  const key = `${process.platform}-${process.arch}`
  const pkg = PLATFORMS[key]
  if (!pkg) {
    fail([
      `postq: this platform (${key}) has no prebuilt binary.`,
      `Supported: ${Object.keys(PLATFORMS).join(', ')}.`,
      'You can build from source: https://github.com/JPWon-1/postq',
    ])
  }
  const exe = process.platform === 'win32' ? 'postq.exe' : 'postq'
  let dir
  try {
    dir = path.dirname(require.resolve(`${pkg}/package.json`))
  } catch {
    fail([
      `postq: the platform package "${pkg}" is not installed.`,
      'It is an optional dependency, so it is skipped when installing with --omit=optional / --no-optional,',
      'or when node_modules was copied from another OS or CPU.',
      'Reinstall:  npm install -g @postq/postq',
    ])
  }
  const bin = path.join(dir, exe)
  if (!fs.existsSync(bin)) {
    fail([`postq: ${bin} is missing — the package "${pkg}" looks broken. Reinstall: npm install -g @postq/postq`])
  }
  return bin
}

const bin = findBinary()
const child = spawn(bin, process.argv.slice(2), { stdio: 'inherit', windowsHide: false })

child.on('error', err => {
  fail([`postq: could not start ${bin}: ${err.message}`])
})

// 터미널의 Ctrl+C 는 같은 프로세스 그룹인 자식도 직접 받는다. 런처는 죽지 말고 자식이 끝나기를 기다린다.
// kill <런처 pid> 처럼 런처만 받은 신호는 자식에게 넘긴다. 윈도우에는 신호가 없어(kill 은 곧 강제 종료) 넘기지 않는다.
// 윈도우의 Ctrl+Break(SIGBREAK)도 같은 콘솔의 자식이 직접 받는다 — 들어 두지 않으면 node 가 바로 죽어 종료 코드가 0 이 아니다.
const forwarded = ['SIGINT', 'SIGTERM', 'SIGHUP', ...(process.platform === 'win32' ? ['SIGBREAK'] : [])]
const handlers = {}
for (const sig of forwarded) {
  handlers[sig] = () => {
    if (process.platform !== 'win32' && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill(sig)
      } catch {}
    }
  }
  try {
    process.on(sig, handlers[sig])
  } catch {}
}

child.on('exit', (code, signal) => {
  for (const sig of forwarded) process.removeListener(sig, handlers[sig])
  if (signal) {
    // 자식이 신호로 끝났으면 런처도 같은 신호로 끝나 부모 셸이 같은 결과를 본다.
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
