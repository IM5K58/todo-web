import { Screen } from '@/components/screen'

/**
 * 즉시 표시되는 스켈레톤.
 *
 * 이 파일이 없으면 App Router 는 서버 컴포넌트가 DB 조회를 끝낼 때까지
 * 화면 전환 자체를 붙잡는다. 탭을 눌러도 몇백 ms 동안 이전 화면이 그대로
 * 있어서 '버퍼링' 처럼 느껴진다. loading.tsx 가 있으면 전환은 즉시 일어나고
 * 이 골격이 먼저 그려진 뒤 내용이 스트리밍된다.
 *
 * 레이아웃은 실제 화면과 같은 폭/간격을 쓴다. 다르면 내용이 도착하는 순간
 * 화면이 튄다.
 */
export default function GroupsLoading() {
  return (
    <Screen>
      <div aria-busy="true" aria-live="polite" className="flex flex-col gap-5">
        <span className="sr-only">불러오는 중…</span>
        <div className="motion-safe:animate-pulse flex flex-col gap-3">
          <div className="bg-surface-2 h-7 w-40 rounded-lg" />
          <div className="bg-surface-2 h-4 w-24 rounded-md" />
        </div>
        <div className="motion-safe:animate-pulse flex flex-col gap-3">
        <div className="bg-surface-2 h-16 rounded-2xl" />
        <div className="bg-surface-2 h-16 rounded-2xl" />
        <div className="bg-surface-2 h-16 rounded-2xl" />
        </div>
      </div>
    </Screen>
  )
}
