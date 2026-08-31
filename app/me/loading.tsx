/**
 * 즉시 표시되는 스켈레톤.
 *
 * 이 파일이 없으면 App Router 는 서버 컴포넌트가 DB 조회를 끝낼 때까지
 * 화면 전환 자체를 붙잡는다. 탭을 눌러도 몇백 ms 동안 이전 화면이 그대로
 * 있어서 '버퍼링' 처럼 느껴진다. loading.tsx 가 있으면 전환은 즉시 일어나고
 * 이 골격이 먼저 그려진 뒤 내용이 스트리밍된다.
 *
 * 레이아웃은 실제 화면(app/me/page.tsx)과 같은 폭/간격/순서를 쓴다. 다르면
 * 내용이 도착하는 순간 화면이 튄다. 그래서 카드 개수와 대략의 높이까지
 * 맞춰 둔다:
 *
 *   PageHeader → 프로필 → 사진 → 이름 → 알림 설정 → 계정(로그아웃·탈퇴)
 *
 * 마지막 스페이서는 하단 고정 탭바(56px + safe-area) 가림 방지용이다.
 * `pb-28` 을 쓰면 안 된다 — screen-safe 가 min-height:100dvh 라서 내용이
 * 짧아도 무의미한 스크롤이 생긴다.
 */

/** 실제 화면의 <Card> 와 같은 테두리·모서리·패딩. 안쪽만 회색 블록. */
function CardSkeleton({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-line bg-surface rounded-2xl border p-5">
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  )
}

export default function MeLoading() {
  return (
    <main className="screen-safe px-safe mx-auto flex w-full max-w-md flex-col gap-5 py-6">
      <div aria-busy="true" aria-live="polite" className="motion-safe:animate-pulse flex flex-col gap-5">
        <span className="sr-only">불러오는 중…</span>

        {/* PageHeader: 제목 + 설명 한 줄 */}
        <div className="flex flex-col gap-3">
          <div className="bg-surface-2 h-7 w-32 rounded-lg" />
          <div className="bg-surface-2 h-4 w-52 rounded-md" />
        </div>

        {/* 프로필 카드: 64px 아바타 + 이름 + 가입일 */}
        <CardSkeleton>
          <div className="flex items-center gap-4">
            <div className="bg-surface-2 size-16 shrink-0 rounded-full" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="bg-surface-2 h-5 w-28 rounded-md" />
              <div className="bg-surface-2 h-3.5 w-40 rounded-sm" />
            </div>
          </div>
        </CardSkeleton>

        {/* 사진 변경 카드: 제목 + 파일 선택(48px) + 보조 버튼 두 개 */}
        <CardSkeleton>
          <div className="bg-surface-2 h-4 w-20 rounded-md" />
          <div className="bg-surface-2 h-12 w-full rounded-xl" />
          <div className="bg-surface-2 h-12 w-full rounded-xl" />
          <div className="flex gap-2">
            <div className="bg-surface-2 h-11 flex-1 rounded-xl" />
            <div className="bg-surface-2 h-11 flex-1 rounded-xl" />
          </div>
        </CardSkeleton>

        {/* 이름 변경 카드: 제목 + 라벨 + 입력(48px) + 힌트 + 저장 버튼 */}
        <CardSkeleton>
          <div className="bg-surface-2 h-4 w-20 rounded-md" />
          <div className="bg-surface-2 h-3.5 w-10 rounded-sm" />
          <div className="bg-surface-2 h-12 w-full rounded-xl" />
          <div className="bg-surface-2 h-3.5 w-3/4 rounded-sm" />
          <div className="bg-surface-2 h-12 w-full rounded-xl" />
        </CardSkeleton>

        {/* 알림 설정 카드 */}
        <CardSkeleton>
          <div className="bg-surface-2 h-4 w-20 rounded-md" />
          <div className="bg-surface-2 h-3.5 w-2/3 rounded-sm" />
          <div className="bg-surface-2 h-12 w-full rounded-xl" />
        </CardSkeleton>

        {/* 계정 카드: 로그아웃 + 탈퇴 */}
        <CardSkeleton>
          <div className="bg-surface-2 h-4 w-12 rounded-md" />
          <div className="bg-surface-2 h-12 w-full rounded-xl" />
          <div className="bg-surface-2 h-3.5 w-5/6 rounded-sm" />
          <div className="bg-surface-2 h-12 w-full rounded-xl" />
        </CardSkeleton>
      </div>

      {/* 하단 고정 탭바 가림 방지. pb-28 이 아니라 스페이서. */}
      <div aria-hidden="true" className="h-28 shrink-0" />
    </main>
  )
}
