import { Screen } from '@/components/screen'

/**
 * /pledge 의 즉시 표시 스켈레톤.
 *
 * 이 파일이 없으면 App Router 는 서버 컴포넌트가 그룹 목록 · 공약 · am_i_admin
 * 조회를 끝낼 때까지 화면 전환 자체를 붙잡습니다. 홈에서 "공약 고치기" 를 눌러도
 * 몇백 ms 동안 홈이 그대로 있어서 탭이 씹힌 것처럼 느껴집니다. loading.tsx 가
 * 있으면 전환은 즉시 일어나고 이 골격이 먼저 그려집니다.
 *
 * 폭과 간격은 실제 화면과 같은 <Screen> 을 씁니다. 다르면 내용이 도착하는 순간
 * 화면이 튑니다. 블록은 실제 배치를 따릅니다: 뒤로가기 · 제목 · 설명 한 줄,
 * 그리고 입력칸이 들어갈 큰 카드 하나.
 */
export default function PledgeLoading() {
  return (
    <Screen>
      <div aria-busy="true" aria-live="polite" className="flex flex-col gap-5">
        <span className="sr-only">불러오는 중…</span>

        <div className="motion-safe:animate-pulse flex flex-col gap-3">
          <div className="bg-surface-2 h-4 w-16 rounded-md" />
          <div className="bg-surface-2 h-7 w-32 rounded-lg" />
          <div className="bg-surface-2 h-4 w-48 rounded-md" />
        </div>

        <div className="motion-safe:animate-pulse flex flex-col gap-3">
          <div className="bg-surface-2 h-56 rounded-2xl" />
          <div className="bg-surface-2 h-28 rounded-2xl" />
        </div>
      </div>
    </Screen>
  )
}
