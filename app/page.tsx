import { redirect } from 'next/navigation'

import { Card, EmptyState, Hint, LinkButton } from '@/components/ui'
import { createClient } from '@/lib/supabase/server'

/**
 * "오늘" 홈 화면 — Phase 1.
 *
 * `/` is the manifest start_url + scope, the post-login redirect target, and
 * the URL every push payload opens, so this file has to exist and has to be
 * cheap. Task CRUD is deliberately NOT here (Phase 2) and is NOT faked.
 *
 * Server Component: it reads cookies through createClient(), which makes the
 * route dynamic automatically — no `export const dynamic` needed.
 *
 * The honest states, in this order:
 *   1. 로그인 안 됨          -> redirect('/login')
 *   2. 읽기 실패             -> 실패했다고 말하기 (빈 화면으로 삼키지 않기)
 *   3. 프로필이 아직 기본값   -> /onboarding 으로 유도하는 카드를 맨 위에
 *   4. 그룹 없음             -> /groups/new · /groups/join 빈 상태
 *   5. 그룹 있음             -> 그룹 이름 · 내 이름 · 오늘 날짜 + Phase 2 안내
 *
 * State 3 is a BANNER, not a wall. A hard branch would lock anyone who
 * genuinely wants to stay '친구' 🙂 out of their own home screen forever, since
 * there is nowhere to record "I already declined".
 */

// ---------------------------------------------------------------------------
// Profile defaults
// ---------------------------------------------------------------------------

/**
 * The literal column DEFAULTs in supabase/migrations/0001_init.sql:
 *
 *   display_name text not null default '친구'
 *   avatar_emoji text not null default '🙂'
 *
 * `handle_new_user()` copies Google's name into display_name whenever the OAuth
 * payload carries one, so plenty of accounts never sit at the default at all.
 */
const DEFAULT_DISPLAY_NAME = '친구'
const DEFAULT_AVATAR_EMOJI = '🙂'

/**
 * Mirrors `public.current_user_local_date()`'s fallback exactly (0001_init.sql
 * §3): an unknown zone falls back to Asia/Seoul rather than throwing. That
 * function is the DEFAULT for `tasks.task_date`, so if this header and the
 * database disagreed about "today", a task filed at 00:30 KST would land under
 * a date the screen never showed.
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
    // The `profiles_validate_timezone` trigger checks the value against
    // pg_timezone_names on write, but Node's ICU tables and Postgres's are not
    // the same vintage, so a zone that is valid in the database can still throw
    // here. Falling back beats a 500 on the app's start_url.
    return new Intl.DateTimeFormat('ko-KR', {
      ...options,
      timeZone: FALLBACK_TIMEZONE,
    }).format(new Date())
  }
}

// ---------------------------------------------------------------------------
// Shared shell
// ---------------------------------------------------------------------------

/**
 * The page wrapper app/settings/page.tsx established, plus clearance for the
 * fixed <BottomNav> that app/layout.tsx mounts.
 *
 * The clearance is a spacer element rather than `pb-28` on the <main>, because
 * `screen-safe` already sets `padding-bottom: env(safe-area-inset-bottom)` and
 * which of the two utilities wins the cascade is not something to leave to
 * chance -- if `screen-safe` won, the last row of content would sit under a
 * 56px bar. A sibling <div> has no such ambiguity.
 */
function Screen({ children }: { children: React.ReactNode }) {
  return (
    <main className="screen-safe px-safe mx-auto flex w-full max-w-md flex-col gap-5 py-6">
      {children}
      <div aria-hidden="true" className="h-20 shrink-0" />
    </main>
  )
}

/**
 * A read failed. Never swallow it into an empty list — "아직 그룹이 없어요" and
 * "그룹을 못 불러왔어요" are completely different things to a user, and only one
 * of them is fixed by trying again.
 *
 * The retry is a plain <a>, not <Link>/LinkButton, on purpose: a client-side
 * navigation to the route we are already on can be served from the router cache
 * without ever re-running the query, which would make the button a no-op
 * exactly when it matters. This forces a real document request.
 */
function LoadError({ message }: { message: string }) {
  return (
    <Screen>
      <div className="flex flex-1 flex-col items-center justify-center gap-5 text-center">
        <div className="flex flex-col gap-2">
          <h1 className="text-fg text-xl font-semibold">불러오지 못했어요</h1>
          <Hint>{message}</Hint>
        </div>
        <a
          href="/"
          className="bg-accent text-accent-fg inline-flex h-12 w-full max-w-xs shrink-0 items-center justify-center rounded-xl px-4 text-base font-medium transition active:scale-[0.99]"
        >
          다시 시도하기
        </a>
      </div>
    </Screen>
  )
}

const READ_FAILED_KO = '잠시 문제가 생겼어요. 인터넷 연결을 확인하고 다시 시도해 주세요.'

/** State 3. Sits above whatever else the home screen is showing. */
function OnboardingNudge() {
  return (
    <Card title="프로필부터 정해볼까요?">
      <Hint>
        아직 기본값인 <strong className="text-fg">친구</strong> 🙂 그대로예요. 친구들이
        누가 누군지 알아볼 수 있게 이름과 이모지를 정해주세요.
      </Hint>
      <LinkButton href="/onboarding">이름·이모지 정하기</LinkButton>
    </Card>
  )
}

/** State 4. */
function NoGroupState({ needsOnboarding }: { needsOnboarding: boolean }) {
  return (
    <Screen>
      {needsOnboarding && <OnboardingNudge />}

      <div className="flex flex-1 flex-col justify-center">
        <EmptyState
          title="아직 그룹이 없어요"
          description="그룹을 만들어 친구를 초대하거나, 받은 초대코드로 들어가 보세요. 할 일은 그룹 안에서 서로 보이게 됩니다."
          action={
            <div className="flex flex-col gap-3">
              <LinkButton href="/groups/new">그룹 만들기</LinkButton>
              <LinkButton href="/groups/join" variant="secondary">
                초대코드로 참여하기
              </LinkButton>
            </div>
          }
        />
      </div>
    </Screen>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

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
    // NEVER .select('*') here. Migration 0003 narrowed the profiles SELECT
    // grant to (id, display_name, avatar_emoji, timezone, created_at), so '*'
    // reaches for the auto_nudge_* columns and comes back 42501.
    supabase
      .from('profiles')
      .select('display_name, avatar_emoji, timezone')
      .eq('id', userId)
      .maybeSingle(),
    supabase
      .from('group_members')
      .select('group_id, joined_at')
      .eq('user_id', userId)
      // Deterministic "primary group" for anyone who is in more than one.
      .order('joined_at', { ascending: true }),
  ])

  if (profileResult.error || membershipResult.error) {
    return <LoadError message={READ_FAILED_KO} />
  }

  const profile = profileResult.data
  const displayName = profile?.display_name.trim() || DEFAULT_DISPLAY_NAME
  const avatarEmoji = profile?.avatar_emoji.trim() || DEFAULT_AVATAR_EMOJI
  const timeZone = profile?.timezone.trim() || FALLBACK_TIMEZONE

  // A missing profile row means the `handle_new_user` trigger never ran for
  // this account, and /onboarding is the only screen that can repair it.
  // Otherwise: BOTH fields still at their column defaults = never personalised.
  // Only one of the two at its default is a deliberate choice — leave it be.
  const needsOnboarding =
    !profile ||
    (displayName === DEFAULT_DISPLAY_NAME && avatarEmoji === DEFAULT_AVATAR_EMOJI)

  const groupIds = (membershipResult.data ?? []).map((row) => row.group_id)
  if (groupIds.length === 0) {
    return <NoGroupState needsOnboarding={needsOnboarding} />
  }

  // Name the columns. `.select('*')` on public.groups trips the column-level
  // grant that hides `invite_code` and fails with "permission denied for column
  // invite_code" — the code is readable ONLY through rpc('get_invite_code'),
  // and only by the owner.
  const { data: groups, error: groupsError } = await supabase
    .from('groups')
    .select('id, name, created_by, created_at')
    .in('id', groupIds)

  if (groupsError) {
    return <LoadError message={READ_FAILED_KO} />
  }

  // `.in()` does not preserve the order of `groupIds`, so re-sort by join order
  // instead of trusting whatever PostgREST happened to return first.
  const byId = new Map((groups ?? []).map((group) => [group.id, group]))
  const primaryGroup = groupIds.map((id) => byId.get(id)).find((group) => group != null)

  // `groups_select_members` lets any member read their own groups row, so an
  // empty result when a membership exists is a failed read, not "no groups".
  if (!primaryGroup) {
    return <LoadError message={READ_FAILED_KO} />
  }

  const otherGroupCount = groupIds.length - 1

  return (
    <Screen>
      <header className="flex flex-col gap-1">
        <p className="text-muted truncate text-sm">
          {primaryGroup.name}
          {otherGroupCount > 0 ? ` 외 ${otherGroupCount}개` : ''}
        </p>
        <h1 className="text-fg text-2xl font-semibold tracking-tight">
          <span aria-hidden="true">{avatarEmoji}</span> {displayName}님의 오늘
        </h1>
        <p className="text-muted text-sm tabular-nums">{formatToday(timeZone)}</p>
      </header>

      {needsOnboarding && <OnboardingNudge />}

      <Card>
        <p className="text-muted text-xs font-medium tracking-wide">준비 중</p>
        <h2 className="text-fg text-base font-semibold">할 일 기능은 다음 단계예요</h2>
        <Hint>
          할 일 적기·완료 체크·친구 콕 찌르기는 아직 붙지 않았어요. 지금은 로그인,
          그룹, 알림 설정까지 동작합니다. 보여줄 진짜 할 일이 생기기 전까지는 비워둘게요.
        </Hint>
      </Card>

      <div className="flex flex-col gap-3">
        <LinkButton href="/groups" variant="secondary">
          내 그룹 보기
        </LinkButton>
        <LinkButton href="/settings" variant="secondary">
          알림 설정
        </LinkButton>
      </div>

      <p className="text-muted mt-auto text-xs">시간대 기준: {timeZone}</p>
    </Screen>
  )
}
