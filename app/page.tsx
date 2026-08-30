import { redirect } from 'next/navigation'

import { Card, EmptyState, ErrorText, Hint, LinkButton } from '@/components/ui'
import { STREAK_WINDOW_DAYS, getTodayPageData } from '@/lib/tasks'
import { createClient } from '@/lib/supabase/server'

import TodayTasks, { type TodayTaskView } from './today-tasks'

/**
 * "오늘" 홈 화면 — Phase 2.
 *
 * `/` is the manifest start_url + scope, the post-login redirect target, and
 * the URL every push payload opens, so this file has to exist and has to be
 * cheap. Phase 1 left a placeholder here; the task list is now real.
 *
 * Server Component. Every read goes through lib/tasks.ts, which is the module
 * /status shares — so the two screens can never disagree about what "today"
 * is or how a streak is counted. Only <TodayTasks> ships JS, because it is the
 * only part that needs local state (optimistic checks, and a text field that
 * has to keep focus between entries).
 *
 * The honest states, in this order:
 *   1. 로그인 안 됨          -> redirect('/login')
 *   2. 읽기 실패             -> 실패했다고 말하기 (빈 화면으로 삼키지 않기)
 *   3. 프로필이 아직 기본값   -> /onboarding 으로 유도하는 카드를 맨 위에
 *   4. 그룹 없음             -> /groups/new · /groups/join 빈 상태
 *   5. 그룹 있음             -> 날짜 · 이름 · 스트릭 + 진행 요약 + 할 일 목록
 *
 * State 3 is a BANNER, not a wall. A hard branch would lock anyone who
 * genuinely wants to stay '친구' 🙂 out of their own home screen forever, since
 * there is nowhere to record "I already declined".
 *
 * ---------------------------------------------------------------------------
 * WHAT "TODAY" MEANS HERE, AND WHY IT IS NOT COMPUTED IN JAVASCRIPT
 * ---------------------------------------------------------------------------
 * `tasks.task_date` DEFAULTs to `public.current_user_local_date()` — today in
 * the user's *profile* timezone. `getTodayPageData()` filters on the value that
 * same function returns, over rpc(). If this screen decided "today" on its own
 * and the two ever disagreed, a task written at 00:30 KST would be filed under
 * a date the list never queries and it would look like the app lost it.
 *
 * So the header formats `data.today` — the exact string the query filtered on —
 * rather than formatting `new Date()` a second time. The profile timezone is
 * only shown as a footnote. `new Date().toISOString().slice(0, 10)` appears
 * nowhere: it is UTC, and returns yesterday for the whole Korean night.
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
 * §3): an unknown zone falls back to Asia/Seoul rather than throwing.
 */
const FALLBACK_TIMEZONE = 'Asia/Seoul'

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * "2026년 8월 30일 토요일" from a 'YYYY-MM-DD' calendar date.
 *
 * Formatted at `timeZone: 'UTC'` against a UTC-midnight Date, which is not a
 * timezone assumption but the opposite of one: the input is already a plain
 * calendar date with no instant attached, and pinning both ends to UTC is the
 * only way to render it without a zone shifting it a day either way.
 */
function formatKoreanDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number)
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(new Date(Date.UTC(year, month - 1, day)))
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
 * 56px bar. A sibling <div> has no such ambiguity. `h-28` is the same 7rem the
 * bar's own note asks for (56px bar + home-indicator inset + breathing room).
 */
function Screen({ children }: { children: React.ReactNode }) {
  return (
    <main className="screen-safe px-safe mx-auto flex w-full max-w-md flex-col gap-5 py-6">
      {children}
      <div aria-hidden="true" className="h-28 shrink-0" />
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

  if (claimsError || typeof userId !== 'string' || !userId) {
    redirect('/login')
  }

  const [profileResult, data] = await Promise.all([
    // NEVER .select('*') here. Migration 0003 narrowed the profiles SELECT
    // grant to (id, display_name, avatar_emoji, timezone, created_at), so '*'
    // reaches for the auto_nudge_* columns and comes back 42501.
    supabase
      .from('profiles')
      .select('display_name, avatar_emoji, timezone')
      .eq('id', userId)
      .maybeSingle(),
    // Groups + today's tasks + streak, all against the database's own idea of
    // "today". Never throws; a failure arrives as `data.error` in Korean.
    getTodayPageData(),
  ])

  if (profileResult.error) {
    return <LoadError message={READ_FAILED_KO} />
  }

  // The loader re-verifies the session independently. Losing it between the two
  // calls is rare but real (a token that expired mid-request), and rendering a
  // logged-out shell would be worse than bouncing to /login.
  if (!data.userId) {
    redirect('/login')
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

  // `getMyGroups` returns an EMPTY list on failure, so "no groups" and "the
  // group read failed" arrive looking identical. The error field is what tells
  // them apart, and showing 그룹 만들기 to someone who already has a group would
  // send them off to create a duplicate.
  if (data.groups.length === 0) {
    if (data.error) {
      return <LoadError message={data.error} />
    }
    return <NoGroupState needsOnboarding={needsOnboarding} />
  }

  const activeGroup = data.activeGroup
  if (!activeGroup) {
    return <LoadError message={READ_FAILED_KO} />
  }

  const otherGroupCount = data.groups.length - 1

  // At this point the groups read succeeded, so any remaining error came from
  // the task or streak query. That is survivable: the header, the profile nudge
  // and the links are all still true and still useful. Rendering an empty list
  // instead would claim the user wrote nothing today — a different, wrong thing.
  const tasksFailed = Boolean(data.error)

  const todayTasks: TodayTaskView[] = data.tasks.map((task) => ({
    id: task.id,
    title: task.title,
    done: task.done_at !== null,
  }))

  const headerDate = ISO_DATE_RE.test(data.today)
    ? formatKoreanDate(data.today)
    // The loader falls back to an Intl-derived date and only returns '' before
    // a session exists, which we already handled above. Belt and braces.
    : formatKoreanDate(
        new Intl.DateTimeFormat('en-CA', {
          timeZone: FALLBACK_TIMEZONE,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date()),
      )

  return (
    <Screen>
      {/* ---- 헤더 ------------------------------------------------------ */}
      <header className="flex flex-col gap-1">
        <p className="text-muted truncate text-sm">
          {activeGroup.name}
          {otherGroupCount > 0 ? ` 외 ${otherGroupCount}개` : ''}
        </p>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-fg text-2xl font-semibold tracking-tight">
            <span aria-hidden="true">{avatarEmoji}</span> {displayName}님의 오늘
          </h1>
          {/* Hidden while the task read is broken: a streak of 0 next to a
              "불러오지 못했어요" card reads as "you lost your streak". */}
          {!tasksFailed && data.streak > 0 && (
            <span
              className="border-line bg-surface-2 text-fg inline-flex h-7 shrink-0 items-center rounded-full border px-3 text-xs font-medium"
              title="적은 할 일을 그날 안에 모두 끝낸 날이 며칠 연속인지예요. 오늘이 아직 안 끝났어도 줄어들지 않아요."
            >
              <span aria-hidden="true">🔥</span>
              <span className="ml-1 tabular-nums">
                {data.streak}일 연속
                {data.streak >= STREAK_WINDOW_DAYS ? '+' : ''}
              </span>
            </span>
          )}
        </div>

        <p className="text-muted text-sm tabular-nums">{headerDate}</p>
      </header>

      {needsOnboarding && <OnboardingNudge />}

      {/* ---- 오늘 할 일 ------------------------------------------------ */}
      {tasksFailed ? (
        <Card title="할 일을 불러오지 못했어요">
          <ErrorText>{data.error}</ErrorText>
          <Hint>아직 아무것도 지워지지 않았어요. 다시 불러오면 그대로 보일 거예요.</Hint>
          {/* Same reasoning as LoadError: a soft navigation to '/' could be
              served from the router cache without re-running the query. */}
          <a
            href="/"
            className="border-line bg-surface text-fg inline-flex h-12 w-full shrink-0 items-center justify-center rounded-xl border px-4 text-base font-medium transition active:scale-[0.99]"
          >
            다시 불러오기
          </a>
        </Card>
      ) : (
        <TodayTasks
          tasks={todayTasks}
          groupId={activeGroup.id}
          groupName={activeGroup.name}
          showGroupHint={otherGroupCount > 0}
        />
      )}

      {/* ---- 이동 ------------------------------------------------------ */}
      <div className="flex flex-col gap-3">
        <LinkButton href="/status">친구들 현황 보기</LinkButton>
        <LinkButton href="/groups" variant="secondary">
          내 그룹 관리
        </LinkButton>
      </div>

      <p className="text-muted mt-auto text-xs">시간대 기준: {timeZone}</p>
    </Screen>
  )
}
