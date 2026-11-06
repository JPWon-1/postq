import { redirect } from 'next/navigation'

// 구 /docs 전용 페이지는 컬렉션의 '문서 모드'로 흡수됐다(같은 데이터를 두 곳에서 렌더하던 중복 제거).
// 기존 공유 링크가 죽지 않도록 앱으로 보낸다 — ?docs=1 이면 컬렉션이 문서 모드로 열린다.
export default function DocsRedirect() {
  redirect('/?docs=1')
}
