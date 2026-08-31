/**
 * 즉시 표시되는 스켈레톤.
 *
 * 이 파일이 없으면 App Router 는 서버 컴포넌트가 DB 조회를 끝낼 때까지 화면
 * 전환 자체를 붙잡는다. 홈에서 "반복 할 일"을 눌러도 몇백 ms 동안 홈이 그대로
 * 있어서 '버퍼링' 처럼 느껴진다. loading.tsx 가 있으면 전환은 즉시 일어나고
 * 이 골격이 먼저 그려진 뒤 내용이 스트리밍된다.
 *
 * 레이아웃은 실제 화면과 같은 폭/간격(max-w-md, gap-5, py-6)을 쓴다. 다르면
 * 내용이 도착하는 순간 화면이 튄다. 그래서 요일 칩 줄(7칸)까지 미리 자리를
 * 잡아 둔다 — 카드 높이의 절반이 칩 줄이라 그것만 빠져도 페이지가 밀린다.
 *
 * 하단 스페이서도 실제 화면과 똑같이 넣는다(app/(nav)/BottomNav.tsx 가 56px +
 * safe-area 로 고정돼 있다). 스켈레톤에만 없으면 로딩 중에는 스크롤 끝이
 * 탭바에 가려졌다가 내용이 오면서 펴진다.
 */

/** 템플릿 한 줄: 제목 + 요일 칩 7개. */
function TemplateRowSkeleton() {
  return (
    <div className="border-line flex flex-col gap-2 border-b py-3 last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <div className="bg-surface-2 h-4 w-32 rounded-md" />
        <div className="bg-surface-2 h-8 w-14 rounded-xl" />
      </div>
      <div className="flex gap-1.5">
        {Array.from({ length: 7 }, (_, index) => (
          <div key={`chip-${index}`} className="bg-surface-2 size-9 rounded-full" />
        ))}
      </div>
    </div>
  )
}

export default function TemplatesLoading() {
  return (
    <main className="screen-safe px-safe mx-auto flex w-full max-w-md flex-col gap-5 py-6">
      <div aria-busy="true" aria-live="polite" className="flex flex-col gap-5">
        <span className="sr-only">불러오는 중…</span>

        {/* PageHeader (뒤로 + 제목 + 설명) */}
        <div className="motion-safe:animate-pulse flex flex-col gap-3">
          <div className="bg-surface-2 h-4 w-32 rounded-md" />
          <div className="bg-surface-2 h-7 w-36 rounded-lg" />
          <div className="bg-surface-2 h-4 w-full rounded-md" />
        </div>

        {/* 목록 카드 */}
        <div className="motion-safe:animate-pulse border-line bg-surface flex flex-col gap-3 rounded-2xl border p-5">
          <div className="bg-surface-2 h-4 w-24 rounded-md" />
          <TemplateRowSkeleton />
          <TemplateRowSkeleton />
        </div>

        {/* 추가 카드 */}
        <div className="motion-safe:animate-pulse border-line bg-surface flex flex-col gap-3 rounded-2xl border p-5">
          <div className="bg-surface-2 h-4 w-20 rounded-md" />
          <div className="bg-surface-2 h-12 w-full rounded-xl" />
          <div className="flex gap-1.5">
            {Array.from({ length: 7 }, (_, index) => (
              <div key={`new-chip-${index}`} className="bg-surface-2 size-9 rounded-full" />
            ))}
          </div>
          <div className="bg-surface-2 h-12 w-full rounded-xl" />
        </div>
      </div>

      {/* 하단 고정 탭바(56px + safe-area) 가림 방지. screen-safe 가
          min-height:100dvh 라서 pb-28 을 쓰면 내용이 짧아도 무의미한 스크롤이
          생긴다. 그래서 패딩이 아니라 스페이서. */}
      <div aria-hidden="true" className="h-28 shrink-0" />
    </main>
  )
}
