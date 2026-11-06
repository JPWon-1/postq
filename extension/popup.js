// 도메인 쿠키를 브라우저에서 읽어 postq 로 보낸다.
//
// chrome.cookies.getAll({domain}) 은 그 도메인과 하위 도메인의 쿠키를 준다 — 브라우저가
// 이 확장에 허용한 권한이다. OS 키체인을 뚫는 게 아니다.

const $ = id => document.getElementById(id)
const out = $('out')

function show(kind, msg) {
  out.className = kind
  out.textContent = msg
}

// 마지막에 쓴 값을 기억한다 — 매번 다시 치지 않게. 브라우저 로컬에만 남는다.
for (const id of ['domain', 'ws', 'env', 'server']) {
  const saved = localStorage.getItem('ahcb:' + id)
  if (saved != null) $(id).value = saved
  $(id).addEventListener('change', () => localStorage.setItem('ahcb:' + id, $(id).value))
}

$('go').addEventListener('click', async () => {
  const raw = $('domain').value.trim()
  if (!raw) { show('err', '도메인을 넣어 주세요.'); return }
  // 사용자가 https://…/ 를 통째로 붙여도 호스트만 남긴다.
  const domain = raw.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^\./, '')
  const server = ($('server').value.trim() || 'http://localhost:3000').replace(/\/$/, '')
  const ws = $('ws').value.trim() || 'default'
  const env = $('env').value.trim()

  $('go').disabled = true
  show('', '쿠키를 읽는 중…')
  try {
    const all = await chrome.cookies.getAll({ domain })
    if (!all.length) {
      show('err', `'${domain}' 에 저장된 쿠키가 없습니다. 그 사이트에 로그인돼 있나요?`)
      return
    }
    const cookies = all.map(c => ({
      name: c.name, value: c.value, path: c.path, expires: c.expirationDate,
    }))
    const res = await fetch(server + '/api/cookies/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain, cookies, workspaceId: ws, environmentId: env }),
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) {
      show('err', (data && data.error) || `postq 가 거부했습니다 (${res.status})`)
      return
    }
    show('ok', `✓ ${data.added}개 쿠키를 postq 에 저장했습니다 (${data.domain}).`)
  } catch (e) {
    // 연결 실패가 제일 흔하다 — postq 가 안 떠 있거나 포트가 다른 경우.
    show('err', `보내지 못했습니다: ${e.message}. postq 앱이 켜져 있고 주소가 맞는지 확인하세요.`)
  } finally {
    $('go').disabled = false
  }
})
