import Link from 'next/link'
import { redirect } from 'next/navigation'

import { createClient } from '@/lib/supabase/server'

/**
 * "오늘" 홈 화면 -- Phase 1 placeholder.
 *
 * `/` is the manifest start_url + scope, the post-login redirect target, and
 * the URL every push payload opens, so this file has to exist and has to be
 * cheap. Task CRUD is deliberately NOT here (Phase 2).
 *
 * Server Component: it reads cookies through createClient(), which makes the
 * route dynamic automatically -- no `export const dynamic` needed.
 */

const FALLBACK_TIMEZONE = 'Asia/Seoul'

/** "2026년 8월 30일 토요일" in the user's own timezone. */
function formatToday(timeZone: string): string {
  const options: Intl.DateTimeFormatOptions = {
    timeZone,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }

  try {
    return new Intl.DateTimeFormat('ko-KR', options).format(new Date())
  } catch {
    // profiles.timezone is a plain text column, so a bad value is possible.
    return new Intl.DateTimeFormat('ko-KR', {
      ...options,
      timeZone: FALLBACK_TIMEZONE,
    }).format(new Date())
  }
}

export default async function TodayPage() {
  const supabase = await createClient()

  // getClaims() verifies the JWT signature. getSession() would just echo the
  // cookie back, which is not an authorization check.
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims()
  const userId = claimsData?.claims.sub

  if (claimsError || !userId) {
    redirect('/login')
  }

  const [profileResult, membershipResult] = await Promise.all([
    supabase
      .from('profiles')
      .select('display_name, timezone')
      .eq('id', userId)
      .maybeSingle(),
    supabase.from('group_members').select('group_id').eq('user_id', userId),
  ])

  const displayName = profileResult.data?.display_name.trim() || '친구'
  const timeZone = profileResult.data?.timezone.trim() || FALLBACK_TIMEZONE
  const groupIds = (membershipResult.data ?? []).map((row) => row.group_id)

  if (groupIds.length === 0) {
    return <NoGroupState />
  }

  const { data: groups } = await supabase
    .from('groups')
    .select('id, name')
    .in('id', groupIds)

  const groupName = groups?.[0]?.name ?? '내 그룹'

  return (
    <main className="screen-safe px-safe mx-auto flex w-full max-w-md flex-col gap-6 py-6">
      <header className="flex flex-col gap-1">
        <p className="text-muted text-sm">{groupName}</p>
        <h1 className="text-fg text-2xl font-semibold tracking-tight">
          {displayName}님의 오늘
        </h1>
        <p className="text-muted text-sm tabular-nums">{formatToday(timeZone)}</p>
      </header>

      <section className="border-line bg-surface rounded-2xl border p-5">
        <h2 className="text-fg text-base font-medium">할 일 목록은 준비 중이에요</h2>
        <p className="text-muted mt-2 text-sm leading-relaxed">
          할 일 추가·완료 체크·친구 콕 찌르기는 다음 단계(Phase 2)에서 붙습니다.
          지금은 로그인과 그룹 연결까지만 동작해요.
        </p>
      </section>

      <p className="text-muted text-xs">
        시간대 기준: {timeZone}
      </p>
    </main>
  )
}

function NoGroupState() {
  return (
    <main className="screen-safe px-safe mx-auto flex w-full max-w-md flex-col items-center justify-center gap-6 text-center">
      <div className="flex flex-col gap-2">
        <h1 className="text-fg text-xl font-semibold">아직 그룹이 없어요</h1>
        <p className="text-muted text-sm leading-relaxed">
          그룹을 만들어 친구를 초대하거나, 받은 초대 코드로 들어가 보세요.
        </p>
      </div>

      <div className="flex w-full flex-col gap-3">
        <Link
          href="/groups/new"
          className="bg-accent text-accent-fg rounded-xl px-5 py-3 text-sm font-medium"
        >
          그룹 만들기
        </Link>
        <Link
          href="/groups/join"
          className="border-line text-fg rounded-xl border px-5 py-3 text-sm font-medium"
        >
          초대 코드로 참여하기
        </Link>
      </div>

      <p className="text-muted text-xs leading-relaxed">
        그룹 만들기·참여 화면은 아직 만드는 중이라 지금은 열리지 않을 수 있어요.
      </p>
    </main>
  )
}
