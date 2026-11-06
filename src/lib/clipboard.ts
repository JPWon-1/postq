/**
 * 클립보드에 글자를 넣는다. 성공 여부를 돌려준다.
 *
 * `navigator.clipboard` 는 보안 컨텍스트(HTTPS 또는 localhost)에서만 존재한다.
 * 다른 기기에서 `http://<서버>:3000` 으로 열면 보안 컨텍스트가 아니라
 * `navigator.clipboard` 가 아예 undefined 다. 그러면 복사 버튼을 눌러도
 * 예외만 나고 아무 일도 일어나지 않는다.
 *
 * 그래서 두 단계로 시도한다.
 *  1) Clipboard API — 있으면 이게 맞다.
 *  2) 없거나 거부되면 `document.execCommand('copy')`. 오래됐지만 http 에서도 동작하고,
 *     이 앱이 지원하는 브라우저에는 전부 남아 있다.
 *
 * 둘 다 실패하면 false 를 돌려준다. 부르는 쪽은 그걸 보고 실패를 말해야 한다 —
 * 조용히 넘기면 눌러도 아무 일이 없는 것처럼 보이고, 사람은 자기 손을 의심한다.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch { /* 권한 거부·포커스 없음 — 아래 방법으로 한 번 더 */ }
  }
  return legacyCopy(text)
}

/** http 로 열린 화면을 위한 옛 방식. 화면 밖 textarea 를 만들어 선택하고 복사한다. */
function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined') return false
  const ta = document.createElement('textarea')
  ta.value = text
  // 화면에 보이지 않으면서 선택은 되어야 한다. display:none 은 선택이 안 된다.
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.top = '-1000px'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  try {
    ta.select()
    ta.setSelectionRange(0, text.length)
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    document.body.removeChild(ta)
  }
}
