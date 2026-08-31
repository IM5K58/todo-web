import { redirect } from 'next/navigation'

import { Button, Card, EmptyState, ErrorText, Hint, LinkButton, SuccessText } from '@/components/ui'
import { STREAK_WINDOW_DAYS, getTodayPageData } from '@/lib/tasks'
import { createClient } from '@/lib/supabase/server'
import type { Weekday } from '@/lib/supabase/types'

import GroupSwitcher from './group-switcher'
import {
  applyTemplatesAction,
  copyTasksFromAction,
  type FillErrCode,
  type FillKind,
} from './templates/actions'
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

// ---------------------------------------------------------------------------
// 오늘을 빠르게 채우기 (0004 — 반복 할 일 / 어제 것 가져오기)
// ---------------------------------------------------------------------------

/**
 * 'YYYY-MM-DD' 에서 하루 전.
 *
 * ★ 여기서 Date 를 쓰는 것은 안전합니다 ★ — "지금"을 읽지 않기 때문입니다.
 * 입력은 DB 가 이미 사용자 시간대로 계산해 준 `data.today` 이고, Date.UTC 로
 * 순수 UTC 자정을 만들어 86400000ms 를 빼기만 합니다. 서머타임도 로컬 시간대도
 * 개입하지 않습니다. 금지된 것은 `new Date()` 로 "오늘"을 만드는 쪽이지 날짜
 * 산술이 아닙니다 (lib/tasks.ts 의 shiftDate 가 같은 이유로 같은 방식입니다).
 * shiftDate 를 재사용하지 않은 것은 그게 lib/tasks.ts 의 내부 함수라서입니다.
 */
function previousDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day) - 86_400_000).toISOString().slice(0, 10)
}

/**
 * 'YYYY-MM-DD' -> 0(일요일) ~ 6(토요일).
 *
 * task_templates.weekdays 의 인코딩과 같습니다 — 0004_templates.sql 이 쓰는
 * PostgreSQL `date_part('dow', ...)` 규약이고, JS 의 getUTCDay() 도 0=일요일
 * 입니다. isodow(월=1..일=7)로 바꾸면 일요일 템플릿이 통째로 사라집니다.
 * 위 previousDate 와 같은 이유로 Date 사용이 안전합니다.
 */
function weekdayOf(isoDate: string): Weekday {
  const [year, month, day] = isoDate.split('-').map(Number)
  // getUTCDay() 는 정의상 0..6 이므로 이 단언은 값에 대한 거짓말이 아닙니다.
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay() as Weekday
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * ?g= — 헤더 드롭다운이 고른 그룹.
 *
 * 모양만 봅니다(UUID 인가). "내가 속한 그룹인가"는 여기서 검사하지 않습니다 —
 * getTodayPageData 가 내가 속한 그룹 목록에서 find 하고, 못 찾으면 첫 번째로
 * 돌아갑니다. 그래서 남의 그룹 id 를 URL 에 적어 넣어도 그 그룹의 무엇도
 * 보이지 않고, 진짜 방어선은 그 아래 RLS 입니다. 모양 검사는 오탈자를 DB 까지
 * 보내지 않으려는 예의일 뿐입니다.
 *
 * 반복된 파라미터(?g=a&g=b)는 배열로 옵니다 — 그때는 무시합니다.
 */
function groupParam(raw: string | string[] | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined
  return UUID_RE.test(raw) ? raw : undefined
}

/* ---------------------------------------------------------------------------
 * [0007] 고정해 둔 그룹 (profiles.default_group_id)
 * ------------------------------------------------------------------------ */

/**
 * "처음 보일 그룹" 고정값. 없으면 null.
 *
 * 0007 의 컬럼 주석이 이 값을 쓰는 곳으로 "홈 드롭다운 / 현황 화면"을 이름으로
 * 지목합니다. 고정은 /status 에서 하지만, 고정해 둔 그룹이 홈에서 안 열리면
 * 그 기능은 반쯤만 작동하는 셈입니다.
 *
 * ★ 절대 throw 하지 않고, 실패해도 배너를 띄우지 않습니다 ★ null 은 "고정
 * 안 됨"이고, 그때 화면은 0007 이전과 정확히 같습니다(첫 그룹). 보조 기능
 * 하나 때문에 오늘 목록을 오류 화면으로 바꿀 이유가 없습니다.
 *
 * ★ 왜 위의 profiles 조회에 컬럼을 하나 더 붙이지 않았나 ★ 그러면 0007 이
 * 아직 배포되지 않은 데이터베이스에서 42703 이 나면서 profileResult.error 로
 * 들어가고, 홈 전체가 "불러오지 못했어요"가 됩니다. 따로 떼어 두면 그 실패가
 * 여기서 끝납니다. 질의는 1회 늘지만 파(wave)는 늘지 않습니다 — 아래 호출부의
 * Promise.all 안에서 다른 두 갈래와 나란히 출발합니다.
 *
 * ★ 캐스트인 이유 ★ lib/supabase/types.ts 는 제 소유가 아니고, 이 글을 쓰는
 * 시점의 profiles Row 에는 아직 default_group_id 가 없습니다. DB 에는 실재하는
 * 컬럼이라 `.select('default_group_id')` 를 그냥 쓰면 tsc 가 깨집니다.
 * types.ts 에 컬럼이 생기면 이 캐스트를 지우세요 — app/status/page.tsx 의
 * getDefaultGroupId 도 같은 이유로 같은 모양을 하고 있습니다.
 *
 * `.eq('id', userId)` 는 생략 불가입니다. profiles 의 SELECT 정책은 "나 또는
 * 나와 그룹을 공유하는 사람"이라 조건 없이 부르면 동료의 행도 함께 옵니다.
 */
type ProfileDefaultGroupQuery = {
  select: (columns: string) => {
    eq: (
      column: string,
      value: string,
    ) => {
      maybeSingle: () => PromiseLike<{
        data: { default_group_id: string | null } | null
        error: { code?: string | null; message?: string } | null
      }>
    }
  }
}

async function getDefaultGroupId(userId: string): Promise<string | undefined> {
  const supabase = await createClient()

  // ★ select('*') 금지 ★ 0003 이 profiles 의 SELECT 를 컬럼 단위로 좁혔습니다.
  const profiles = supabase.from('profiles') as unknown as ProfileDefaultGroupQuery
  const { data, error } = await profiles
    .select('default_group_id')
    .eq('id', userId)
    .maybeSingle()

  if (error) {
    // 42703 = 0007 미배포. 그 외에는 진짜 실패. 어느 쪽이든 화면은 폴백합니다.
    if (error.code !== '42703') {
      console.error('[home] default_group_id 조회 실패', {
        code: error.code,
        message: error.message,
      })
    }
    return undefined
  }

  const value = data?.default_group_id
  return typeof value === 'string' && UUID_RE.test(value) ? value : undefined
}

/** ?c= / ?s= 는 액션이 만든 값이지만 URL 은 사용자가 고칠 수 있습니다. */
function countParam(raw: string | string[] | undefined): number {
  if (typeof raw !== 'string') return 0
  const value = Number.parseInt(raw, 10)
  if (!Number.isInteger(value) || value < 0 || value > 9999) return 0
  return value
}

const FILL_ERR_MESSAGES: Record<FillErrCode, string> = {
  auth: '로그인이 풀렸어요. 앱을 새로고침한 뒤 다시 시도해 주세요.',
  badrequest: '요청이 올바르지 않아요. 화면을 새로고침한 뒤 다시 시도해 주세요.',
  notdeployed: '이 기능이 아직 서버에 적용되지 않았어요. 잠시 후 다시 시도해 주세요.',
  fail: '불러오지 못했어요. 잠시 후 다시 시도해 주세요.',
}

/**
 * "3개 넣었어요 (2개는 이미 있어서 건너뜀)".
 *
 * ★ created 만 말하면 안 됩니다 ★ 전부 이미 있어서 0/N 이 돌아왔을 때 화면이
 * 조용하면, 사용자는 버튼이 고장 난 줄 알고 계속 누릅니다. 0/0 도 "없었어요"
 * 라고 분명히 말합니다.
 *
 * ※ app/templates/page.tsx 에도 같은 이름의 함수가 있습니다. 'use server'
 *    파일은 async 함수 외의 export 를 허용하지 않아 actions.ts 에 둘 수 없고,
 *    두 화면의 문구가 서로 달라도 되는 종류의 코드라 각자 소유합니다.
 */
function fillMessage(kind: FillKind, created: number, skipped: number): string {
  const what = kind === 'applied' ? '반복 할 일' : '어제 할 일'

  if (created === 0 && skipped === 0) {
    return kind === 'applied'
      ? '오늘 요일에 해당하는 반복 할 일이 없었어요.'
      : '가져올 할 일이 없었어요.'
  }
  if (created === 0) {
    return `${what} ${skipped}개가 이미 오늘 목록에 있어서 전부 건너뛰었어요.`
  }
  if (skipped === 0) {
    return `${what} ${created}개를 오늘 목록에 넣었어요.`
  }
  return `${what} ${created}개를 넣었어요. (${skipped}개는 이미 있어서 건너뜀)`
}

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

export default async function TodayPage({
  searchParams,
}: {
  /**
   * 읽는 것은 둘뿐입니다:
   *   · fill / c / s / fillerr — 0004 "오늘 채우기" 의 결과 알림
   *   · g                      — 헤더 드롭다운이 고른 그룹 (아래 groupParam)
   * 그 외 파라미터는 무시하고, 이 화면의 데이터 로딩에 아무 영향을 주지 않습니다.
   */
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const params = await searchParams

  const preferredGroupId = groupParam(params.g)

  const fillKind =
    params.fill === 'applied' || params.fill === 'copied' ? (params.fill as FillKind) : null
  const fillErrMessage =
    typeof params.fillerr === 'string' &&
    Object.prototype.hasOwnProperty.call(FILL_ERR_MESSAGES, params.fillerr)
      ? FILL_ERR_MESSAGES[params.fillerr as FillErrCode]
      : null

  const supabase = await createClient()

  // getClaims() verifies the JWT signature. getSession() would just echo the
  // cookie back, which is not an authorization check.
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims()
  const userId = claimsData?.claims.sub

  if (claimsError || typeof userId !== 'string' || !userId) {
    redirect('/login')
  }

  const [profileResult, data, defaultGroupId] = await Promise.all([
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
    //
    // ?g= 는 "먼저 보고 싶은 그룹"입니다. 로더가 내 그룹 목록에서 찾고, 없으면
    // 첫 번째로 돌아갑니다 — 그래서 링크를 잘못 눌러도 화면이 깨지지 않습니다.
    // lib/tasks.ts 는 손대지 않습니다(이미 이 인자를 받습니다).
    getTodayPageData(preferredGroupId),
    // [0007] 고정해 둔 그룹. 실패해도 undefined 일 뿐이라 이 파를 늦추지도,
    // 아래 어떤 분기도 바꾸지 않습니다.
    getDefaultGroupId(userId),
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

  /**
   * 어느 그룹을 펼쳐 볼 것인가. 우선순위는 셋입니다:
   *   1. ?g=  — 방금 드롭다운으로 고른 것. 언제나 이깁니다.
   *   2. 고정해 둔 그룹 (profiles.default_group_id, /status 에서 설정)
   *   3. 로더의 기본값 = 가장 먼저 가입한 그룹
   *
   * 1번은 이미 로더가 반영했습니다(getTodayPageData 에 넘겼습니다). 그래서
   * 여기서는 ?g= 가 없을 때만 2번을 얹습니다.
   *
   * ★ 이걸 로더 뒤에서 골라도 되는 이유 ★ 오늘 목록은 그룹으로 걸러지지
   * 않습니다 — getMyTasksAndStreak 는 user_id 와 날짜로만 조회합니다
   * (lib/tasks.ts). activeGroup 이 정하는 것은 "헤더에 어느 그룹 이름을
   * 쓰는가" 와 "새 할 일이 어느 그룹으로 들어가는가" 뿐이라, 조회를 다시
   * 하지 않고 여기서 바꿔도 화면과 데이터가 어긋나지 않습니다.
   *
   * 고정해 둔 그룹을 이미 나갔다면 목록에 없으므로 find 가 undefined 를
   * 돌려주고 조용히 3번으로 내려갑니다. (DB 쪽에도 같은 안전장치가 있습니다 —
   * 0007 의 clear_default_group_on_leave 트리거가 값을 NULL 로 되돌립니다.)
   */
  const activeGroup =
    (preferredGroupId || !defaultGroupId
      ? undefined
      : data.groups.find((group) => group.id === defaultGroupId)) ?? data.activeGroup

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

  // -------------------------------------------------------------------------
  // 오늘을 빠르게 채우기 — 추가 조회는 "오늘이 비어 있을 때만"
  //
  // ★ 왜 조건부인가 (두 가지 이유) ★
  //
  // 1) 화면. 이미 할 일을 적어 둔 사람에게 "불러오기" 카드는 목록과 자리를 다투는
  //    소음입니다. 하루 중 대부분의 방문이 이 상태(=목록을 확인하러 옴)이고,
  //    그때 필요한 것은 버튼이 아니라 목록입니다. 그래서 목록이 있을 때 이 카드는
  //    통째로 사라지고, /templates 로 가는 길만 아래 "이동" 블록에 상시로 남습니다
  //    (거기서 언제든 "오늘 채우기"를 누를 수 있습니다).
  //
  // 2) 왕복. 아래 두 질의는 getTodayPageData() 의 결과(오늘 날짜)에 의존해서
  //    같은 파에 못 넣습니다 -- 넣으려면 lib/tasks.ts 의 시그니처를 바꿔야 하고
  //    그건 제 소유 파일이 아닙니다. 그래서 순차 왕복이 1회 늘어나는데, 그 비용을
  //    "목록이 비어 있는" 경우에만 냅니다. 그때는 어차피 그릴 것도 적고, 이 카드가
  //    그 화면의 유일한 내용이라 값을 치를 이유가 있습니다. 할 일이 있는 흔한
  //    경로에서는 추가 비용이 정확히 0 입니다.
  //    (두 질의끼리는 서로 독립이라 Promise.all 로 한 파에 넣습니다.)
  // -------------------------------------------------------------------------
  const showQuickFill = !tasksFailed && todayTasks.length === 0
  const yesterday = ISO_DATE_RE.test(data.today) ? previousDate(data.today) : null

  let applicableTemplateCount = 0
  let yesterdayTaskCount = 0
  /** 0004 가 아직 이 환경에 적용되지 않았다 (PostgREST 스키마 캐시에 테이블 없음). */
  let quickFillUnavailable = false

  if (showQuickFill && yesterday) {
    const todayWeekday = weekdayOf(data.today)

    const [templatesResult, yesterdayResult] = await Promise.all([
      // 요일 필터를 SQL 로 보내지 않고 JS 에서 겁니다. 한 사람의 템플릿은 많아야
      // 수십 행이고, 배열 포함(`cs`) 필터를 문자열로 조립하는 것보다 인코딩 사고가
      // 날 여지가 없습니다.
      supabase
        .from('task_templates')
        .select('weekdays')
        .eq('user_id', userId)
        .eq('active', true)
        // RPC 도 "아직 가입 상태인 그룹" 만 대상으로 삼습니다. 이 필터를 빼면
        // 나간 그룹의 템플릿까지 세어서 "3개 불러오기"라 해 놓고 1개만 들어옵니다.
        .in(
          'group_id',
          data.groups.map((group) => group.id),
        ),
      // 어제 몇 개를 적었는지만 필요합니다. head: true 라 행은 오지 않습니다.
      supabase
        .from('tasks')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('task_date', yesterday),
    ])

    if (templatesResult.error) {
      const code = templatesResult.error.code
      quickFillUnavailable = code === 'PGRST205' || code === '42P01'
      // 그 밖의 실패는 조용히 0 으로 둡니다. 이 카드는 편의 기능이고, 여기서
      // 오류 배너를 띄우면 "오늘 할 일이 없다"는 정상 상태가 사고처럼 보입니다.
      // (실제로 눌러서 실패하면 그때는 ?fillerr= 로 분명히 말합니다.)
    } else {
      applicableTemplateCount = (templatesResult.data ?? []).filter((row) =>
        row.weekdays.includes(todayWeekday),
      ).length
    }

    yesterdayTaskCount = yesterdayResult.error ? 0 : (yesterdayResult.count ?? 0)
  }

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
        {/*
          그룹 선택. 그룹이 1개면 컴포넌트가 스스로 이름만 글자로 그리므로,
          예전의 "{이름} 외 N개" 줄과 정확히 같은 자리·같은 모양입니다.
          "외 N개"를 더 붙이지 않는 이유: 드롭다운을 열면 몇 개인지 보이고,
          숫자를 두 번 말하면 셀렉트가 무엇을 고르는 것인지 흐려집니다.
        */}
        <GroupSwitcher
          groups={data.groups.map((group) => ({ id: group.id, name: group.name }))}
          activeGroupId={activeGroup.id}
        />

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

        {/*
          예전에는 이 줄 오른쪽에 "기록 보기 →" 링크가 있었습니다. 지웠습니다 —
          /history 가 하단 탭('내기록')으로 올라갔고, 같은 화면으로 가는 길이
          두 개면 탭이 유일한 입구라는 사실이 흐려집니다.
        */}
        <p className="text-muted text-sm tabular-nums">{headerDate}</p>
      </header>

      {needsOnboarding && <OnboardingNudge />}

      {/* ---- 채우기 결과 ------------------------------------------------ */}
      {/*
        ★ 조건이 searchParams 뿐이고 목록 상태가 아닌 것이 중요합니다 ★
        불러오기가 성공하면 목록은 더 이상 비어 있지 않아서 아래 "빠르게 채우기"
        카드는 사라집니다. 그 결과 문장까지 같이 사라지면 방금 무슨 일이
        일어났는지 아무도 알 수 없습니다. 목록 바로 위에 두는 것은 바뀐 목록과
        설명이 같은 화면 안에 보이게 하기 위해서입니다.
      */}
      {fillKind && (
        <div className="border-line bg-surface rounded-2xl border p-4">
          <SuccessText>
            {fillMessage(fillKind, countParam(params.c), countParam(params.s))}
          </SuccessText>
        </div>
      )}
      {fillErrMessage && (
        <div className="border-danger rounded-2xl border p-4">
          <ErrorText>{fillErrMessage}</ErrorText>
        </div>
      )}

      {/* ---- 오늘을 빠르게 채우기 --------------------------------------- */}
      {/* 목록이 비어 있을 때만. 이유는 위 계산부의 주석 참고. */}
      {showQuickFill && (
        <Card title="오늘을 빠르게 채우기">
          {quickFillUnavailable ? (
            <Hint>
              반복 할 일 기능이 아직 서버에 적용되지 않았어요. 잠시 후 다시 열어봐
              주세요.
            </Hint>
          ) : applicableTemplateCount === 0 && yesterdayTaskCount === 0 ? (
            <>
              <Hint>
                매일 반복하는 일을 한 번만 등록해두면, 아침마다 버튼 하나로 오늘
                목록을 채울 수 있어요. 매번 같은 걸 다시 적지 않아도 돼요.
              </Hint>
              <LinkButton href="/templates" variant="secondary">
                반복 할 일 만들기
              </LinkButton>
            </>
          ) : (
            <>
              <Hint>오늘은 아직 비어 있어요. 한 번에 채워볼까요?</Hint>

              {applicableTemplateCount > 0 && (
                <form action={applyTemplatesAction}>
                  <input type="hidden" name="from" value="/" />
                  {/* groupId 는 보내지 않습니다 — 비우면 "내가 아직 속한 모든
                      그룹"이 대상이고, 이 화면의 오늘 목록도 그룹을 가리지 않습니다. */}
                  <Button type="submit" pendingLabel="불러오는 중…">
                    반복 할 일 {applicableTemplateCount}개 불러오기
                  </Button>
                </form>
              )}

              {yesterdayTaskCount > 0 && yesterday && (
                <form action={copyTasksFromAction}>
                  <input type="hidden" name="from" value="/" />
                  {/* 날짜는 DB 가 준 data.today 에서 하루 뺀 값입니다. 오늘/미래
                      여부는 RPC 가 자기 기준으로 한 번 더 판정합니다. */}
                  <input type="hidden" name="date" value={yesterday} />
                  <Button type="submit" variant="secondary" pendingLabel="가져오는 중…">
                    어제 적은 것 가져오기
                  </Button>
                </form>
              )}

              <Hint>
                {/* 버튼 라벨에 어제 개수를 넣지 않는 이유: 어제 같은 제목이 두 번
                    있으면 하나만 복사돼서, 라벨의 숫자가 결과보다 커집니다. */}
                {yesterdayTaskCount > 0 ? `어제는 ${yesterdayTaskCount}개를 적었어요. ` : ''}
                이미 오늘 목록에 있는 건 다시 만들지 않으니 여러 번 눌러도 안전해요.
                넣은 뒤에 지우거나 고칠 수 있어요.
              </Hint>
            </>
          )}
        </Card>
      )}

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
        {/*
          반복 할 일로 가는 상시 입구.
          /settings 아래로 넣지 않은 이유: 설정에 묻으면 아무도 못 찾습니다.
          위의 "빠르게 채우기" 카드는 목록이 비어 있을 때만 나타나므로, 이미
          할 일을 적어 둔 사람에게는 이 줄이 유일한 경로입니다. 하단 탭바에
          5번째 탭을 만들지 않은 이유는 375px 에서 5탭이면 한 칸이 75px 로
          좁아지고, 반복 할 일은 매일 여는 화면이 아니기 때문입니다.
        */}
        <LinkButton href="/templates" variant="secondary">
          반복 할 일 관리
        </LinkButton>
      </div>

      <p className="text-muted mt-auto text-xs">시간대 기준: {timeZone}</p>
    </Screen>
  )
}
