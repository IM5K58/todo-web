import { Screen } from '@/components/screen'
import { Card, ErrorText, PageHeader } from '@/components/ui'

/**
 * A read failed. Deliberately NOT an empty state: "아무도 안 적었어요" for a
 * query that errored is a lie, and it is precisely the lie that would send
 * someone off to nudge a friend who had in fact already finished.
 *
 * 이 화면은 <Screen> 을 통째로 대신 그립니다 — page.tsx 는 board.error 가 있으면
 * 여기서 return 하므로, StatusRealtime 도 로스터도 마운트되지 않습니다. 보드를
 * 못 읽은 상태에서 구독만 살아 있어 봐야 새로 받을 것이 없기 때문입니다.
 */
export function LoadFailure({ message }: { message: string }) {
  return (
    <Screen>
      <PageHeader title="오늘 현황" backHref="/" backLabel="오늘로 돌아가기" />
      <Card>
        <ErrorText>{message}</ErrorText>
        {/*
          A plain <a>, not <Link>: a client-side navigation to the route we are
          already on can be served from the Router Cache without re-running the
          query, which would make the retry a no-op exactly when it matters.
        */}
        <a
          href="/status"
          className="border-line bg-surface text-fg inline-flex h-12 w-full shrink-0 items-center justify-center rounded-xl border px-4 text-base font-medium transition active:scale-[0.99]"
        >
          다시 불러오기
        </a>
      </Card>
    </Screen>
  )
}
