import { Screen } from '@/components/screen'

/**
 * 즉시 표시되는 스켈레톤.
 *
 * 이 파일이 없으면 App Router 는 서버 컴포넌트가 DB 조회를 끝낼 때까지 화면
 * 전환 자체를 붙잡는다. 링크를 눌러도 몇백 ms 동안 이전 화면이 그대로 있어서
 * '버퍼링' 처럼 느껴진다. loading.tsx 가 있으면 전환은 즉시 일어나고 이 골격이
 * 먼저 그려진 뒤 내용이 스트리밍된다.
 *
 * 이 화면은 체크를 누를 때마다 서버 액션 뒤 다시 이 경로로 돌아오므로, 그
 * 왕복에서도 이 골격이 뜬다. 그래서 실제 화면과 같은 폭·간격·행 높이를 쓴다 —
 * 다르면 내용이 도착하는 순간 목록이 통째로 밀린다.
 */

/** 실제 RoutineRow 와 같은 3단(체크박스 / 막대+숫자 / 날짜 줄) 구조. */
function RoutineRowSkeleton() {
  return (
    <div className="border-line flex flex-col gap-2 border-b py-2 last:border-b-0">
      <div className="flex min-h-11 items-center gap-3 px-1 py-2">
        <div className="bg-surface-2 size-6 shrink-0 rounded-md" />
        <div className="bg-surface-2 h-4 w-32 rounded-md" />
      </div>
      <div className="flex items-center gap-2 pl-10">
        <div className="bg-surface-2 h-2 min-w-0 flex-1 rounded-full" />
        <div className="bg-surface-2 h-3 w-14 rounded-sm" />
      </div>
      <div className="bg-surface-2 ml-10 h-3 w-3/4 rounded-sm" />
    </div>
  )
}

export default function RoutinesLoading() {
  return (
    <Screen>
      <div aria-busy="true" aria-live="polite" className="flex flex-col gap-5">
        <span className="sr-only">불러오는 중…</span>

        {/* PageHeader (뒤로 + 제목 + 설명) */}
        <div className="motion-safe:animate-pulse flex flex-col gap-3">
          <div className="bg-surface-2 h-4 w-16 rounded-md" />
          <div className="bg-surface-2 h-7 w-28 rounded-lg" />
          <div className="bg-surface-2 h-4 w-full rounded-md" />
        </div>

        {/* 루틴 카드 */}
        <div className="motion-safe:animate-pulse border-line bg-surface flex flex-col gap-3 rounded-2xl border p-5">
          <div className="bg-surface-2 h-4 w-24 rounded-md" />
          <RoutineRowSkeleton />
          <RoutineRowSkeleton />
          <RoutineRowSkeleton />
        </div>
      </div>
    </Screen>
  )
}
