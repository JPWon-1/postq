/**
 * 목록 로딩 자리표시.
 *
 * '불러오는 중…' 한 줄만 띄우면 데이터가 도착하는 순간 높이가 확 늘어 화면이 튄다.
 * 올 내용과 비슷한 높이를 미리 차지해 두면 그 튐이 사라진다.
 */
export function SkeletonRows({ rows = 6, className = '' }: { rows?: number; className?: string }) {
  return (
    <div className={`flex flex-col gap-1.5 p-3 ${className}`} aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="ah-skeleton h-3 w-10 shrink-0" />
          {/* 폭을 조금씩 다르게 — 전부 같은 길이면 표가 아니라 격자처럼 보인다 */}
          <span className="ah-skeleton h-3 flex-1" style={{ maxWidth: `${68 + ((i * 13) % 28)}%` }} />
        </div>
      ))}
    </div>
  )
}
