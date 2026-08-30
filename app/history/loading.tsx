/**
 * 즉시 표시되는 스켈레톤.
 *
 * 이 파일이 없으면 App Router 는 서버 컴포넌트가 DB 조회를 끝낼 때까지
 * 화면 전환 자체를 붙잡는다. 탭을 눌러도 몇백 ms 동안 이전 화면이 그대로
 * 있어서 '버퍼링' 처럼 느껴진다. loading.tsx 가 있으면 전환은 즉시 일어나고
 * 이 골격이 먼저 그려진 뒤 내용이 스트리밍된다.
 *
 * 이 화면은 특히 이 파일이 중요하다. 기록은 180일치를 한 번에 집계하는
 * 화면이라 홈/현황보다 첫 응답이 느리고, 달력 칸을 눌러 하루를 펼칠 때마다
 * 다시 서버로 간다. 그때마다 이 골격이 뜬다.
 *
 * 레이아웃은 실제 화면과 같은 폭/간격을 쓴다. 다르면 내용이 도착하는 순간
 * 화면이 튄다. 그래서 달력 자리(7열 격자)까지 미리 잡아 둔다 — 요약 카드만
 * 그려 두면 달력이 도착할 때 페이지가 통째로 밀린다.
 */

/** 실제 달력과 같은 7열 격자. 요일 헤더 한 줄 + 6주. */
function CalendarSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      <div className="bg-surface-2 h-4 w-20 rounded-md" />
      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: 7 }, (_, index) => (
          <div key={`head-${index}`} className="bg-surface-2 mx-auto h-3 w-4 rounded-sm" />
        ))}
        {Array.from({ length: 42 }, (_, index) => (
          <div key={`cell-${index}`} className="bg-surface-2 aspect-square rounded-md" />
        ))}
      </div>
    </div>
  )
}

export default function HistoryLoading() {
  return (
    <main className="screen-safe px-safe mx-auto flex w-full max-w-md flex-col gap-5 py-6">
      <div aria-busy="true" aria-live="polite" className="flex flex-col gap-5">
        <span className="sr-only">불러오는 중…</span>

        {/* PageHeader (뒤로 + 제목) */}
        <div className="motion-safe:animate-pulse flex flex-col gap-3">
          <div className="bg-surface-2 h-4 w-28 rounded-md" />
          <div className="bg-surface-2 h-7 w-32 rounded-lg" />
        </div>

        {/* 요약 카드: 2 x 2 타일 */}
        <div className="motion-safe:animate-pulse border-line bg-surface rounded-2xl border p-5">
          <div className="grid grid-cols-2 gap-3">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={`stat-${index}`} className="bg-surface-2 h-20 rounded-xl" />
            ))}
          </div>
        </div>

        {/* 달력 카드 */}
        <div className="motion-safe:animate-pulse border-line bg-surface flex flex-col gap-5 rounded-2xl border p-5">
          <div className="bg-surface-2 h-4 w-12 rounded-md" />
          <CalendarSkeleton />
          <div className="bg-surface-2 h-3 w-3/4 rounded-sm" />
        </div>
      </div>

      <div aria-hidden="true" className="h-28 shrink-0" />
    </main>
  )
}
