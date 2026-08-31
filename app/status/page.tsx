import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import {
  Button,
  Card,
  EmptyState,
  ErrorText,
  Hint,
  LinkButton,
  MemberProgressRow,
  PageHeader,
  SuccessText,
} from '@/components/ui'
import { getGroupPushStatus, isPushOff, type PushStatusMap } from '@/lib/push-status'
import { createClient } from '@/lib/supabase/server'
import {
  getStatusPageData,
  type MemberTodayStatus,
  type StatusPageData,
} from '@/lib/tasks'

import { nudgeAction, type StatusErrCode, type StatusOkCode } from './actions'
import { setDefaultGroupAction } from './default-group-actions'
import StatusRealtime from './realtime'

/**
 * /status — 오늘 현황. 이 앱의 사회적 압력이 나오는 화면.
 *
 * Server Component. The board itself comes from `getStatusPageData()` in
 * lib/tasks.ts (owned by the data layer), which already:
 *   - resolves "today" through `rpc('current_user_local_date')` — the SAME
 *     function that is the DEFAULT behind `tasks.task_date`, so the filter can
 *     never disagree with the rows the database wrote. A task added at 01:30
 *     KST must not land on a day this screen never shows, which is exactly what
 *     `new Date().toISOString().slice(0, 10)` would cause.
 *   - names every column it selects. `select('*')` is 42501 on `profiles`
 *     (0003 §11 narrowed it to columns) and on `groups` (0002 excludes
 *     `invite_code`).
 *   - pulls the whole group's tasks in ONE query and tallies per user in
 *     memory, because policy `tasks_select_group_members` makes every member's
 *     rows visible. That policy is the entire reason this screen can exist.
 *   - returns `error` as Korean copy instead of throwing.
 *
 * Everything about actually SENDING a nudge lives in ./actions.ts and, below
 * that, in `public.send_nudge`.
 *
 * WHETHER A FRIEND HAS NOTIFICATIONS ON  [0006]
 * ---------------------------------------------
 * This used to be unknowable here, and the comment that lived at this spot said
 * so: `push_subscriptions` is scoped to its owner by policy
 * `push_subscriptions_all_own` (`user_id = auth.uid()`), so there is no read
 * that would tell us in advance. That policy has NOT changed — widening it
 * would hand groupmates `endpoint` / `p256dh` / `auth`, which together are the
 * credential for pushing to somebody else's device.
 *
 * 0006 opened a keyhole instead: `public.group_push_status(p_group_id)` is
 * SECURITY DEFINER and returns nothing but `(user_id, has_push)` — a boolean
 * folded out of `exists()`, never a count, never an endpoint. lib/push-status.ts
 * wraps it and, crucially, never throws: an auxiliary badge must not be able to
 * take the board down with it.
 *
 * So the row can now say 알림 꺼둠 BEFORE the nudge. The `sent_pushoff` notice
 * below still exists and still tells the fuller story afterwards (that the
 * friend will see it when they open the app) — the badge deliberately does not
 * repeat that sentence.
 *
 * LIVE UPDATES  [0006]
 * --------------------
 * <StatusRealtime> subscribes to `tasks` and calls `router.refresh()`. It reads
 * no payload and renders no markup; see app/status/realtime.tsx for why (short
 * version: `tasks` is pinned to REPLICA IDENTITY DEFAULT because Postgres
 * Changes does not apply RLS to DELETE, and this screen shows an aggregate that
 * only a fresh server read can compute correctly).
 *
 * WHICH GROUP OPENS FIRST  [0007]
 * -------------------------------
 * Precedence, highest first:
 *
 *   1. `?group=<uuid>`             an explicit tap on a group chip
 *   2. `profiles.default_group_id` the pin, set from the toggle below
 *   3. the first group I joined    the behaviour that existed before 0007
 *
 * ★ The stale-pin case is handled by NOT handling it here. ★ A pinned group I
 * have since left — or been removed from by `remove_member()` — must fall back
 * to (3) rather than opening a board I am not on.
 *
 * 0007 cleans up first, and it is worth knowing exactly how much it covers. The
 * FK is `on delete set null`, which only fires when the GROUP is deleted; the
 * far commoner "the group is fine, I left" deletes a `group_members` row and
 * the FK sees nothing. So 0007 adds trigger `group_members_clear_default_group`
 * (AFTER DELETE ON group_members → `private.clear_default_group_on_leave`),
 * and membership loss has exactly one entrance — leaving, `remove_member()`,
 * group cascade, account cascade — so the trigger covers all of them.
 *
 * This screen still does not DEPEND on that having won the race, and 0007's own
 * header says to treat the column as a hint rather than a guarantee, for the
 * reason that the defence is free: `getStatusPageData(preferred)` in
 * lib/tasks.ts picks `groups.find(g => g.id === preferred) ?? groups[0]`, where
 * `groups` is MY memberships, already in hand. An id that is not mine simply
 * does not match and the fallback happens with no extra query — the same line
 * that already made a stale `?group=` bookmark degrade instead of erroring.
 * Nothing below re-checks membership, because a re-check would be a slower way
 * to reach the answer that fallback already gives.
 *
 * The toggle is drawn from the value we READ, never from what the last write
 * claimed — see app/status/default-group-actions.ts for why that distinction is
 * load-bearing (the RPC ignores a non-member group in silence).
 *
 * ENTRY POINT TO /groups  [0007]
 * ------------------------------
 * The 그룹 tab is gone from <BottomNav>, so 내 그룹 상세 보기 under the roster
 * is now the way there. It is a plain `/groups` link with no group id attached:
 * app/groups/page.tsx renders EVERY group I am in as its own <Card> and reads
 * only `?ok=` / `?err=` — it has no notion of a "current" group to open, so a
 * query parameter would be decoration that does nothing. Read, not assumed.
 */

export const metadata: Metadata = {
  title: '현황',
}

// ---------------------------------------------------------------------------
// Notice copy
// ---------------------------------------------------------------------------

/**
 * Keyed by the unions ./actions.ts exports, so adding a code there breaks this
 * file until it has Korean copy. That is the point.
 */
const OK_MESSAGES: Record<StatusOkCode, string> = {
  sent: '콕 찔렀어요. 알림이 갔어요.',
  sent_pushoff:
    '콕 찔렀어요. 다만 그 친구는 아직 알림을 켜두지 않아서, 앱을 열어야 볼 수 있어요.',
  sent_undelivered:
    '콕 찔렀어요. 알림을 보내지는 못했어요. 그 친구가 앱을 열면 확인할 수 있어요.',
}

const ERR_MESSAGES: Record<StatusErrCode, string> = {
  auth: '로그인이 풀렸어요. 앱을 새로고침한 뒤 다시 시도해 주세요.',
  badrequest: '요청이 올바르지 않아요. 화면을 새로고침한 뒤 다시 시도해 주세요.',
  notmember: '같은 그룹이 아니에요. 화면을 새로고침해 주세요.',
  self: '자기 자신은 찌를 수 없어요.',
  ratehour: '방금 찔렀어요. 같은 사람은 한 시간에 한 번만 찌를 수 있어요.',
  rateday: '오늘은 이미 세 번 찔렀어요. 내일 다시 시도해 주세요.',
  notdeployed: '찌르기 기능이 아직 서버에 적용되지 않았어요. 잠시 후 다시 시도해 주세요.',
  fail: '찌르지 못했어요. 잠시 후 다시 시도해 주세요.',
}

/**
 * [0007] `?dg=` — the outcome of the 기본 그룹 고정 toggle.
 *
 * ★ Why a third parameter and not another `?ok=` / `?err=` code ★
 * Those two are keyed by the unions ./actions.ts exports, and that file is
 * 콕 찌르기's. Squeezing pin outcomes into them would mean either editing a
 * union this feature does not own, or accepting a code that renders as `null`
 * on the day someone reorders things. A separate parameter also means a pin and
 * a nudge can never overwrite each other's banner.
 *
 * ★ Why the type is exported ★
 * app/status/default-group-actions.ts is a `'use server'` file, and such files
 * may export nothing but async functions — the union cannot live there. So it
 * lives here and the action `import type`s it back (erased at compile time, no
 * runtime cycle). That keeps the property this codebase relies on everywhere
 * else: adding a code on one side stops the other side type-checking until it
 * has Korean copy.
 */
export type DefaultGroupCode =
  /** default_group_id now points at the group on screen. */
  | 'pinned'
  /** The pin was cleared; the first joined group opens again. */
  | 'unpinned'
  /** No verified session reached Postgres. */
  | 'e_auth'
  /** The form did not carry a usable uuid. A bug here, not user error. */
  | 'e_badrequest'
  /** 0007 is not on this database / not in PostgREST's schema cache yet. */
  | 'e_notdeployed'
  /**
   * set_default_group raised P0002 — the UPDATE matched 0 rows because there is
   * no `profiles` row for me at all (0001's `handle_new_user` failed and 0002's
   * `profiles_insert_self` safety valve has not run yet). 0007 raises rather
   * than reporting a 0-row UPDATE as success, so this must not be folded into
   * `e_fail`: "잠시 후 다시" is the wrong advice for a state that will never fix
   * itself on its own.
   */
  | 'e_noprofile'
  /** Anything else. */
  | 'e_fail'

const DEFAULT_GROUP_MESSAGES: Record<DefaultGroupCode, string> = {
  pinned: '이 그룹을 기본으로 고정했어요. 이제 현황을 열면 이 그룹이 먼저 보여요.',
  unpinned: '고정을 해제했어요. 이제 처음 들어간 그룹이 먼저 보여요.',
  e_auth: '로그인이 풀렸어요. 앱을 새로고침한 뒤 다시 시도해 주세요.',
  e_badrequest: '요청이 올바르지 않아요. 화면을 새로고침한 뒤 다시 시도해 주세요.',
  e_notdeployed: '기본 그룹 고정이 아직 서버에 적용되지 않았어요. 잠시 후 다시 시도해 주세요.',
  e_noprofile: '프로필을 찾지 못했어요. 로그아웃한 뒤 다시 로그인해 주세요.',
  e_fail: '기본 그룹을 바꾸지 못했어요. 잠시 후 다시 시도해 주세요.',
}

/** `pinned` / `unpinned` are good news; every `e_` code is not. */
function isDefaultGroupError(code: DefaultGroupCode): boolean {
  return code.startsWith('e_')
}

function messageFor<K extends string>(
  table: Record<K, string>,
  raw: string | string[] | undefined,
): string | null {
  // A repeated param arrives as an array; an unknown code must render nothing
  // rather than an empty banner.
  if (typeof raw !== 'string') return null
  return Object.prototype.hasOwnProperty.call(table, raw) ? table[raw as K] : null
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function firstParam(raw: string | string[] | undefined): string | null {
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) return raw[0] ?? null
  return null
}

/** The `?dg=` code, if it is one we know. Unknown codes render nothing. */
function defaultGroupCode(raw: string | string[] | undefined): DefaultGroupCode | null {
  if (typeof raw !== 'string') return null
  return Object.prototype.hasOwnProperty.call(DEFAULT_GROUP_MESSAGES, raw)
    ? (raw as DefaultGroupCode)
    : null
}

/**
 * [0007] 내가 고정해 둔 그룹의 id. 없으면 null.
 *
 * ── 왕복 한 번을 씁니다. 그리고 그게 어디에 붙는지가 중요합니다 ────────────
 * `?group=` 이 붙어 있으면 이 값은 *선택* 에 쓰이지 않습니다 — URL 이 이깁니다.
 * 토글의 "고정됨/안 고정됨" 표시에만 필요하고, 그건 보드와 아무 관계가 없으니
 * getStatusPageData() 와 나란히 띄울 수 있습니다(파 증가 0).
 *
 * `?group=` 이 없을 때만 이 값이 preferredGroupId 가 되므로, 그때는 보드보다
 * 먼저 도착해야 합니다(파 +1). 그룹 탭을 눌러 들어오는 흔한 경로가 하필 그
 * 경우라 아깝지만, 대안은 전부 더 나쁩니다:
 *   · 보드를 먼저 띄우고 고정 그룹이 다르면 다시 조회 → 고정한 사람에게
 *     "질의 한 번 낭비 + 파 +1" 이라 지금보다 확실히 나쁩니다.
 *   · lib/tasks.ts 가 이 컬럼을 직접 읽게 하기 → 그 파일은 이 기능 소유가
 *     아니고, getStatusPageData 의 반환 모양을 바꾸는 일입니다.
 * 그래서 컬럼 하나짜리 단일 행 조회로 최소화만 해 뒀습니다.
 *
 * ★ 절대 throw 하지 않습니다 ★ 실패하면 null 을 돌려주고, null 은 "고정 안 됨"
 * 이라 0007 이전과 정확히 같은 화면이 나옵니다. 배너도 띄우지 않습니다 — 보드도
 * 콕 찌르기도 멀쩡한데 보조 기능 하나로 오류 화면을 만들 이유가 없습니다
 * (lib/push-status.ts 가 같은 이유로 빈 Map 을 돌려주는 것과 같은 판단).
 *
 * ★ 읽어도 되는 컬럼입니다 ★ 0007 ①-b 가 profiles 의 컬럼 단위 SELECT GRANT
 * 목록을 다시 쓰면서 default_group_id 를 넣었습니다(0003 이 auto_nudge_* 를
 * 감춘 것과 반대 결정 — 새어 나가는 것이 아무 데도 못 쓰는 uuid 하나뿐이라).
 * 반면 UPDATE GRANT 에는 일부러 넣지 않았으므로, 쓰기는 set_default_group()
 * 뿐입니다. 여기서 읽고, 쓰기는 default-group-actions.ts 가 RPC 로 합니다.
 *
 * `.eq('id', userId)` 는 생략할 수 없습니다. profiles 의 SELECT 정책은 "나
 * 자신 또는 나와 그룹을 공유하는 사람" 이라 조건 없이 부르면 그룹 동료의 행도
 * 함께 옵니다.
 *
 * ★ 캐스트인 이유 ★ lib/supabase/types.ts 는 이 기능이 소유한 파일이 아니고,
 * 이 글을 쓰는 시점의 ProfilesRow 에는 아직 default_group_id 가 없습니다.
 * 타입이 있는 채로 `.select('default_group_id')` 를 쓰면 DB 에는 실재하는
 * 컬럼 때문에 빌드가 깨집니다. 게다가 42703(컬럼 없음) 을 다른 실패와 똑같이
 * null 로 흡수하므로, 0007 이 아직 배포되지 않은 데이터베이스에서도 화면은
 * 0007 이전과 똑같이 동작합니다. types.ts 에 컬럼이 생기면 캐스트를 지우고
 * `.select('default_group_id')` 를 그대로 부르면 됩니다 — 다른 곳은 그대로.
 */
type ProfileDefaultGroupRow = { default_group_id: string | null }

type ProfileDefaultGroupQuery = {
  select: (columns: string) => {
    eq: (column: string, value: string) => {
      maybeSingle: () => PromiseLike<{
        data: ProfileDefaultGroupRow | null
        error: { code?: string | null; message?: string } | null
      }>
    }
  }
}

async function getDefaultGroupId(userId: string): Promise<string | null> {
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
      console.error('[status] default_group_id 조회 실패', {
        code: error.code,
        message: error.message,
      })
    }
    return null
  }

  const value = data?.default_group_id
  // UUID 검사를 한 번 더 하는 이유: 이 값은 곧바로 preferredGroupId 로 흘러가고,
  // 거기서 문자열 비교로만 쓰이지만 URL(`?group=`) 조립에도 다시 등장합니다.
  return typeof value === 'string' && UUID_RE.test(value) ? value : null
}

/**
 * '2026-08-30' -> '8월 30일 토요일'.
 *
 * Formats the DATE STRING the query actually used, never `new Date()`, so the
 * header cannot disagree with the rows under it. Rendered as a UTC instant on
 * purpose: the string is already a calendar date in the user's own timezone, so
 * re-projecting it through any zone would shift it by a day.
 */
function formatBoardDate(isoDate: string): string {
  const [rawYear, rawMonth, rawDay] = isoDate.split('-')
  const year = Number(rawYear)
  const month = Number(rawMonth)
  const day = Number(rawDay)

  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return isoDate
  }

  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(new Date(Date.UTC(year, month - 1, day)))
}

/** Why a member's 콕 찌르기 button is not on offer right now. */
type NudgeBlock = 'self' | 'complete' | null

function blockFor(member: MemberTodayStatus): NudgeBlock {
  // 자기 자신에게는 버튼이 아예 없습니다. send_nudge 가 self_nudge 로 거절하고
  // (0003 §8), 그 아래 nudges_no_self_nudge_chk CHECK 이 한 번 더 막습니다.
  if (member.isMe) return 'self'
  // 다 끝낸 사람은 찌를 이유가 없습니다.
  if (member.total > 0 && member.done >= member.total) return 'complete'
  // [0005] 횟수 제한 해제. 예전에는 여기서 시간당 1회 / 하루 3회를 세어 버튼을
  // 감췄지만, send_nudge 의 상수가 0(무제한)이 된 뒤로는 화면만 막는 꼴이 된다.
  // 되살리려면 0005 의 c_hourly_limit / c_daily_limit 와 이 검사를 함께 되돌릴 것.
  return null
}

// ---------------------------------------------------------------------------
// Presentation pieces
// ---------------------------------------------------------------------------

/**
 * Page wrapper + clearance for the fixed <BottomNav> (56px tall plus the iOS
 * home-indicator inset).
 *
 * The clearance is a spacer element rather than `pb-28` on the <main>, for the
 * reason app/page.tsx already documents: `screen-safe` also sets
 * `padding-bottom`, and which of the two utilities wins the cascade is not
 * something to leave to chance. A sibling <div> has no such ambiguity.
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
 * A read failed. Deliberately NOT an empty state: "아무도 안 적었어요" for a
 * query that errored is a lie, and it is precisely the lie that would send
 * someone off to nudge a friend who had in fact already finished.
 */
function LoadFailure({ message }: { message: string }) {
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

/** The pill that stands in for the button when there is nothing to press. */
function Pill({ tone, children }: { tone: 'accent' | 'muted'; children: React.ReactNode }) {
  const base = 'inline-flex h-8 shrink-0 items-center rounded-full px-3 text-xs font-medium'
  return (
    <span
      className={
        tone === 'accent'
          ? `bg-accent text-accent-fg ${base}`
          : `border-line text-muted border ${base}`
      }
    >
      {children}
    </span>
  )
}

/**
 * [0006] "알림 꺼둠" — a small auxiliary marker under a member row.
 *
 * ★ Why it is NOT in MemberProgressRow's `action` slot ★
 * That slot already holds either the 콕 찌르기 button or the 다 했어요 pill, and
 * those two are the point of the row. A third thing elbowing in there would
 * shrink the name and the progress bar on a 360px screen to buy space for a
 * detail nobody came for. `note` is no good either — it only renders when the
 * member has zero tasks, and "wrote nothing" and "notifications off" are
 * independent facts that can both be true.
 *
 * So it goes on its own line inside the <li>, indented to line up with the text
 * column (40px avatar + 12px gap = 52px = pl-13). It reads as a footnote to the
 * row above it, which is exactly its weight.
 *
 * ★ What it must never say ★ How many devices, which device, when. 0006 folds
 * all of that into one boolean on purpose. And it does not re-explain what
 * happens if you nudge this person anyway — OK_MESSAGES.sent_pushoff above
 * already says that, at the moment it actually matters.
 */
function PushOffNote({ name, isSelf }: { name: string; isSelf: boolean }) {
  return (
    <p className="text-muted -mt-1 pb-3 pl-13 text-xs [word-break:keep-all]">
      {isSelf ? (
        <>
          {/*
            자기 자신에게는 사실 통보가 아니라 다음 행동을 줍니다. 여기서
            "내가 안 켰다"를 알게 되는 것 자체가 /settings 로 갈 유일한 계기고,
            그렇지 않으면 이 화면은 남의 상태만 알려주고 끝납니다.
          */}
          <span className="mr-1">알림 꺼둠</span>
          <Link href="/settings" className="text-fg underline underline-offset-4">
            알림 켜러 가기
          </Link>
        </>
      ) : (
        <>
          {/* 이름을 눈에는 반복하지 않되, 스크린 리더에는 어느 행의 각주인지
              들려줍니다. 시각적으로는 바로 위 행이 곧 맥락입니다. */}
          <span className="sr-only">{name}님은 </span>알림 꺼둠
        </>
      )}
    </p>
  )
}

/**
 * [0007] "이 그룹을 먼저 보여줘" — 기본 그룹 고정 토글.
 *
 * ★ Why a <form> and not a checkbox or a <Link> ★
 * A checkbox would need client state and would report success before the write
 * landed; a <Link> would make a GET that mutates. This is a Server Action form,
 * so <Button> gets a real pending label from useFormStatus(), it works without
 * JS, and the outcome comes back as a URL you can reload (`?dg=`).
 *
 * ★ Why the state is a <p> and only the verb is a button ★
 * "고정됨" as a button label reads as the thing the button will DO, which is the
 * opposite of what pressing it does. So the current state is stated in text and
 * the button carries the action — 기본으로 고정 / 고정 해제. Nobody has to guess
 * which of the two meanings the label is carrying.
 *
 * ★ Why `pin` is a separate hidden field ★
 * `groupId` is always the group on screen, in both directions, because the
 * action redirects back to it either way. See default-group-actions.ts.
 *
 * Rendered only when there is more than one group — the caller enforces that.
 */
function DefaultGroupToggle({ groupId, isPinned }: { groupId: string; isPinned: boolean }) {
  return (
    <form
      action={setDefaultGroupAction}
      className="border-line bg-surface flex items-center justify-between gap-3 rounded-2xl border px-4 py-3"
    >
      <input type="hidden" name="groupId" value={groupId} />
      <input type="hidden" name="pin" value={isPinned ? '0' : '1'} />

      <p className="text-muted min-w-0 text-xs leading-relaxed [word-break:keep-all]">
        {isPinned ? (
          <>
            <span className="text-fg font-medium">기본 그룹으로 고정됨</span>
            <br />현황을 열면 이 그룹이 먼저 보여요.
          </>
        ) : (
          <>
            <span className="text-fg font-medium">기본 그룹 아님</span>
            <br />고정해 두면 현황을 열 때 이 그룹이 먼저 보여요.
          </>
        )}
      </p>

      <Button
        type="submit"
        size="sm"
        variant="secondary"
        pendingLabel={isPinned ? '해제하는 중…' : '고정하는 중…'}
      >
        {isPinned ? '고정 해제' : '기본으로 고정'}
      </Button>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function StatusPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const params = await searchParams
  const okMessage = messageFor<StatusOkCode>(OK_MESSAGES, params.ok)
  const errMessage = messageFor<StatusErrCode>(ERR_MESSAGES, params.err)

  const dgCode = defaultGroupCode(params.dg)

  const requestedGroupId = firstParam(params.group)
  const urlGroupId =
    requestedGroupId && UUID_RE.test(requestedGroupId) ? requestedGroupId : undefined

  /**
   * [0007] 프로필의 고정 그룹을 읽으려면 내 id 가 먼저 필요합니다.
   *
   * getStatusPageData() 도 내부에서 같은 판정을 하지만 그 결과는 보드가 다
   * 끝난 뒤에야 나오고, 아래 분기는 보드를 *부르기 전에* userId 를 요구합니다.
   * 중복 비용은 사실상 0 입니다 — getClaims() 는 JWT 서명을 로컬에서 검증하고
   * JWKS 는 auth-js 의 모듈 전역에 10분 캐시되므로, 따뜻한 인스턴스에서는
   * 네트워크가 나가지 않습니다(lib/tasks.ts 의 getSessionUserId 주석 참고).
   * getSession() 은 쿠키를 그대로 되돌려줄 뿐 검증이 아니라서 쓰지 않습니다.
   */
  const supabase = await createClient()
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims()
  const claimedUserId = claimsData?.claims.sub
  if (claimsError || typeof claimedUserId !== 'string' || !claimedUserId) {
    redirect('/login')
  }

  /**
   * 고정 그룹과 보드. 순서가 두 갈래인 이유는 getDefaultGroupId() 주석에 있고,
   * 요약하면 "URL 이 이기는 경우에는 두 조회가 서로를 기다릴 필요가 없다" 입니다.
   *
   * getStatusPageData 는 선호 id 가 내 그룹이 아니면 첫 그룹으로 폴백하므로,
   * 낡은 북마크든 내가 나간 뒤 남은 고정이든 여기서 따로 막지 않아도 됩니다.
   */
  let defaultGroupId: string | null
  let board: StatusPageData

  if (urlGroupId) {
    ;[defaultGroupId, board] = await Promise.all([
      getDefaultGroupId(claimedUserId),
      getStatusPageData(urlGroupId),
    ])
  } else {
    defaultGroupId = await getDefaultGroupId(claimedUserId)
    board = await getStatusPageData(defaultGroupId ?? undefined)
  }

  if (!board.userId) {
    redirect('/login')
  }
  if (board.error) {
    return <LoadFailure message={board.error} />
  }
  if (!board.activeGroup) {
    // No group at all. An empty board is a dead end, so hand them the one
    // action that helps.
    redirect('/groups/new')
  }

  const activeGroup = board.activeGroup
  const userId = board.userId

  /**
   * [0007] 지금 보고 있는 그룹이 곧 고정된 그룹인가.
   *
   * ★ 방금 누른 버튼의 결과가 아니라 방금 읽은 값입니다 ★ set_default_group 은
   * 내 그룹이 아니면 조용히 무시하도록(예외를 던지지 않도록) 설계돼 있어서,
   * "에러 없음" 이 "고정됨" 을 뜻하지 않습니다. 그래서 토글은 항상 이 비교로
   * 그립니다. 고정해 둔 그룹에서 내가 빠진 경우 activeGroup 은 폴백 그룹이고
   * defaultGroupId 는 거기에 맞지 않으므로, 토글은 정직하게 "안 고정됨" 으로
   * 보입니다 — 폴백이 일어났다는 사실이 화면에 그대로 드러납니다.
   */
  const isPinned = defaultGroupId !== null && defaultGroupId === activeGroup.id

  // [0005] 넛지 쿼터 집계 쿼리 제거.
  //   send_nudge 의 제한이 해제되어 셀 것이 없어졌다. 부수 효과로 이 화면의
  //   DB 왕복이 하나 줄었다. 제한을 되살리면 이 블록도 함께 되살려야 한다
  //   (git 이력: 0005 이전 버전).

  /**
   * [0006] 알림 켬/끔.
   *
   * ── 왕복 한 번을 더 씁니다. 알고 쓰는 것입니다 ────────────────────────────
   * `p_group_id` 가 필요하고, 그 값은 getStatusPageData() 가 "선호 그룹이 내
   * 그룹이 아니면 첫 번째 그룹" 규칙으로 정합니다. 그러니 board 보다 먼저
   * 출발시킬 수 없습니다 — preferredGroupId 로 미리 쏘면 폴백이 일어난 경우
   * 엉뚱한 그룹의 답을 받게 됩니다.
   *
   * 정말로 없애려면 이 RPC 가 lib/tasks.ts 의 getGroupTodayStatus 안에서
   * group_members/tasks 와 같은 파에 들어가야 하는데, 그건 그 파일의 반환
   * 모양을 바꾸는 일이고 /history 등 다른 화면이 그 시그니처를 씁니다.
   * 소유하지 않은 파일이라 하지 않습니다.
   *
   * 대신 비싼 쪽을 값싸게 만들어 뒀습니다: 이 조회는 실패해도 throw 하지 않고
   * 빈 Map 을 돌려주며, 빈 Map 은 "전원 알림 꺼짐" 이 아니라 "모르겠음" 이라
   * 아무 배지도 붙지 않습니다. 그리고 board.error 로 이미 되돌아간 경로에서는
   * 애초에 여기까지 오지 않으므로, 화면이 깨진 상태로 이 왕복을 쓰는 일은
   * 없습니다.
   *
   * push.error 는 일부러 화면에 쓰지 않습니다. 진행률도 콕 찌르기도 멀쩡한데
   * 배지 하나 때문에 오류 배너를 띄우면, 사용자는 보드를 믿지 못하게 됩니다.
   */
  const push = await getGroupPushStatus(activeGroup.id)
  const pushStatuses: PushStatusMap = push.statuses

  const members = board.members
  const boardIsEmpty = members.every((member) => member.total === 0)
  const finishedCount = members.filter(
    (member) => member.total > 0 && member.done >= member.total,
  ).length

  // ---- render -------------------------------------------------------------
  return (
    <Screen>
      {/*
        [0006] 렌더링하는 것이 없는 컴포넌트입니다. `tasks` 를 구독하다가
        그룹원의 체크/추가/삭제가 오면 router.refresh() 로 이 서버 컴포넌트를
        다시 받습니다. key 없이도 groupId prop 변경으로 재구독하지만, 그룹 칩
        전환이 곧 "다른 채널" 이라는 걸 읽는 사람에게도 분명히 해 둡니다.
        Realtime 이 안 되는 환경에서는 아무 일도 일어나지 않습니다(에러 없음).
      */}
      <StatusRealtime key={activeGroup.id} groupId={activeGroup.id} />

      <PageHeader title="오늘 현황" backHref="/" backLabel="오늘로 돌아가기" />

      <header className="flex flex-col gap-1">
        <p className="text-fg truncate text-base font-semibold">{activeGroup.name}</p>
        <p className="text-muted text-sm tabular-nums">{formatBoardDate(board.today)}</p>
      </header>

      {/*
        그룹이 여러 개일 때만. 하나뿐이면 고를 것도, [0007] 고정할 것도 없습니다
        — 어차피 그 그룹이 열리므로 "기본으로 고정" 은 아무것도 바꾸지 않는
        버튼이 됩니다. 그래서 칩과 토글이 같은 조건을 공유합니다.
      */}
      {board.groups.length > 1 && (
        <div className="flex flex-col gap-3">
          <nav aria-label="그룹 고르기" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
            {board.groups.map((group) => {
              const active = group.id === activeGroup.id
              return (
                <Link
                  key={group.id}
                  href={`/status?group=${group.id}`}
                  aria-current={active ? 'page' : undefined}
                  className={`inline-flex h-11 shrink-0 items-center rounded-full px-4 text-sm font-medium transition active:scale-[0.99] ${
                    active
                      ? 'bg-accent text-accent-fg'
                      : 'border-line bg-surface text-muted border'
                  }`}
                >
                  {group.name}
                </Link>
              )
            })}
          </nav>

          <DefaultGroupToggle groupId={activeGroup.id} isPinned={isPinned} />
        </div>
      )}

      {okMessage && (
        <div className="border-line bg-surface rounded-2xl border p-4">
          <SuccessText>{okMessage}</SuccessText>
        </div>
      )}
      {errMessage && (
        <div className="border-danger rounded-2xl border p-4">
          <ErrorText>{errMessage}</ErrorText>
        </div>
      )}

      {/*
        [0007] 고정 결과. 콕 찌르기 배너와 같은 모양이지만 파라미터가 달라
        (`?dg=`) 서로를 덮어쓰지 않습니다. 바로 위 토글이 이미 새 상태를 보여
        주고 있으므로, 이 문장은 "무엇이 바뀌었는지" 만 말하고 상태를 다시
        선언하지 않습니다.
      */}
      {dgCode &&
        (isDefaultGroupError(dgCode) ? (
          <div className="border-danger rounded-2xl border p-4">
            <ErrorText>{DEFAULT_GROUP_MESSAGES[dgCode]}</ErrorText>
          </div>
        ) : (
          <div className="border-line bg-surface rounded-2xl border p-4">
            <SuccessText>{DEFAULT_GROUP_MESSAGES[dgCode]}</SuccessText>
          </div>
        ))}

      <Card>
        {members.length === 0 ? (
          // I am always a member of my own active group, so an empty roster is
          // a read that came back wrong — not a group with nobody in it.
          <ErrorText>
            그룹원을 불러오지 못했어요. 화면을 새로고침한 뒤 다시 시도해 주세요.
          </ErrorText>
        ) : (
          <>
            {boardIsEmpty ? (
              <EmptyState
                title="아직 아무도 오늘 할 일을 적지 않았어요"
                description="가장 먼저 적어서 시작해 보세요. 아래에서 친구들을 콕 찔러 깨울 수도 있어요."
                action={<LinkButton href="/">내 할 일 적으러 가기</LinkButton>}
              />
            ) : (
              <p className="text-muted text-xs">
                {members.length}명 중 {finishedCount}명이 오늘을 끝냈어요
              </p>
            )}

            <ul className={`flex flex-col ${boardIsEmpty ? 'border-line border-t pt-1' : ''}`}>
              {members.map((member) => {
                const block = blockFor(member)
                // `=== false` 로 좁힌 판정입니다(isPushOff). `!get(id)` 로 쓰면
                // 조회가 실패한 날 전원에게 "알림 꺼둠" 이 붙습니다.
                const pushOff = isPushOff(pushStatuses, member.userId)

                return (
                  /*
                    The divider lives on the <li>, not on MemberProgressRow: the
                    row's own `border-b last:border-b-0` sees itself as the last
                    child of its <li> every time, so it would never draw.
                    (app/groups/page.tsx does the same with ListRow.)
                  */
                  <li
                    key={member.userId}
                    className="border-line flex flex-col border-b last:border-b-0"
                  >
                    <MemberProgressRow
                      emoji={member.avatarEmoji}
                      name={member.displayName}
                      isSelf={member.isMe}
                      done={member.done}
                      total={member.total}
                      action={
                        block === 'self' ? undefined : block === 'complete' ? (
                          <Pill tone="accent">다 했어요</Pill>
                        ) : (
                          <form action={nudgeAction}>
                            <input type="hidden" name="groupId" value={activeGroup.id} />
                            <input type="hidden" name="userId" value={member.userId} />
                            <Button
                              type="submit"
                              size="sm"
                              variant="secondary"
                              pendingLabel="찌르는 중…"
                            >
                              콕 찌르기
                            </Button>
                          </form>
                        )
                      }
                    />
                    {pushOff && (
                      <PushOffNote name={member.displayName} isSelf={member.isMe} />
                    )}
                  </li>
                )
              })}
            </ul>
          </>
        )}

        {/*
          [0007] 하단 탭에서 그룹 탭이 사라졌으므로, /groups 로 가는 길은 이제
          여기입니다. 멤버 목록 "아래" 이고 카드 안입니다 — 초대 코드도 내보내기도
          그룹 나가기도 전부 이 명단에 대한 이야기라서, 명단에서 멀어질수록 무슨
          화면으로 가는지 알기 어려워집니다.

          로스터 조회가 실패한 경우에도 일부러 남겨 둡니다. 그때야말로 /groups 가
          유일한 탈출구인데 오류 분기 안에 숨겨 두면 막다른 길이 됩니다. 그래서
          위 삼항 밖에 있습니다.

          쿼리 없는 맨 /groups 입니다. app/groups/page.tsx 는 내가 속한 그룹을
          전부 카드로 그리고 `?ok=` / `?err=` 만 읽습니다 — "지금 보는 그룹"
          이라는 개념 자체가 없어서 `?group=` 을 붙여도 아무 일도 일어나지
          않습니다. 읽고 확인한 것이지 짐작이 아닙니다.
        */}
        <div className="border-line flex flex-col gap-3 border-t pt-4">
          <LinkButton href="/groups" variant="secondary">
            내 그룹 상세 보기
          </LinkButton>
          <Hint>초대 코드, 멤버 내보내기, 그룹 나가기를 여기에서 할 수 있어요.</Hint>
        </div>
      </Card>

      <Card title="콕 찌르기 규칙">
        <Hint>
          횟수 제한 없이 찌를 수 있어요. 다만 상대가 알림을 켜두지 않았다면 알림은 가지
          않고, 그 친구가 앱을 열었을 때만 보여요.
        </Hint>
        {/*
          [0007] 여기 있던 "멤버 관리" (→ /groups) 는 지웠습니다. 같은 목적지로
          가는 버튼이 한 화면에 둘이면 둘 다 덜 믿음직해 보이고, 그룹 얘기는
          멤버 명단 바로 아래에 있는 쪽이 맞습니다.

          "내 알림 설정" 은 남깁니다. 알림 설정의 주 진입점은 이제 마이페이지
          이지만, 이 카드는 방금 "상대가 알림을 켜두지 않았다면" 을 설명한
          참이고 위쪽 행에는 내 이름 밑에 알림 꺼둠 각주가 붙어 있을 수도
          있습니다. 그 맥락에서 한 번에 갈 수 있는 것이 중복보다 낫습니다.
        */}
        <LinkButton href="/settings" variant="secondary">
          내 알림 설정
        </LinkButton>
      </Card>
    </Screen>
  )
}
