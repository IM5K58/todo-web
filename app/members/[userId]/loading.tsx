import { Screen } from '@/components/screen'

/**
 * 즉시 표시되는 스켈레톤.
 *
 * 이 파일이 없으면 App Router 는 서버 컴포넌트가 DB 조회를 끝낼 때까지 화면
 * 전환 자체를 붙잡습니다. 현황에서 이름을 눌러도 몇백 ms 동안 이전 화면이
 * 그대로 있어서 "안 눌렸나?" 로 읽힙니다. loading.tsx 가 있으면 전환은 즉시
 * 일어나고 이 골격이 먼저 그려진 뒤 내용이 스트리밍됩니다.
 *
 * 이 화면은 특히 필요합니다. 파 2개(오늘+멤버십 → 그룹·프로필·180일·오늘 목록)
 * 라서 첫 응답이 현황보다 느립니다.
 *
 * 레이아웃은 실제 화면과 같은 폭/간격/순서를 씁니다. 다르면 내용이 도착하는
 * 순간 화면이 튑니다. 그래서 달력 자리(7열 격자)까지 미리 잡아 둡니다.
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

export default function MemberDetailLoading() {
  return (
    <Screen>
      <div aria-busy="true" aria-live="polite" className="flex flex-col gap-5">
        <span className="sr-only">불러오는 중…</span>

        {/* PageHeader (뒤로 + 이름) */}
        <div className="motion-safe:animate-pulse flex flex-col gap-3">
          <div className="bg-surface-2 h-4 w-32 rounded-md" />
          <div className="bg-surface-2 h-7 w-40 rounded-lg" />
        </div>

        {/* 이름표 카드: 아바타 + 이름 두 줄 */}
        <div className="motion-safe:animate-pulse border-line bg-surface rounded-2xl border p-5">
          <div className="flex items-center gap-3">
            <div className="bg-surface-2 size-14 shrink-0 rounded-full" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="bg-surface-2 h-5 w-24 rounded-md" />
              <div className="bg-surface-2 h-3 w-32 rounded-sm" />
            </div>
          </div>
        </div>

        {/* 오늘 카드: 제목 + 목록 세 줄 */}
        <div className="motion-safe:animate-pulse border-line bg-surface flex flex-col gap-3 rounded-2xl border p-5">
          <div className="bg-surface-2 h-4 w-40 rounded-md" />
          {Array.from({ length: 3 }, (_, index) => (
            <div key={`task-${index}`} className="flex items-center gap-3">
              <div className="bg-surface-2 size-5 shrink-0 rounded-md" />
              <div className="bg-surface-2 h-4 flex-1 rounded-sm" />
            </div>
          ))}
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
    </Screen>
  )
}
