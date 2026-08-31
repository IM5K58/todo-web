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
import { getStatusPageData, type MemberTodayStatus } from '@/lib/tasks'

import { nudgeAction, type StatusErrCode, type StatusOkCode } from './actions'

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
 * The only read this file adds is the nudge quota, because `nudges` is not part
 * of the task data layer. Everything about actually SENDING a nudge lives in
 * ./actions.ts and, below that, in `public.send_nudge`.
 *
 * WHAT THIS SCREEN CANNOT KNOW
 * ---------------------------
 * Whether a friend has notifications switched on. `push_subscriptions` is
 * scoped to its owner by policy `push_subscriptions_all_own`
 * (`user_id = auth.uid()`), so there is no read that would tell us in advance
 * and no honest way to badge a row. The nudge action reports it AFTERWARDS
 * from the push fan-out result — see the `sent_pushoff` notice below.
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

  const requestedGroupId = firstParam(params.group)
  const preferredGroupId =
    requestedGroupId && UUID_RE.test(requestedGroupId) ? requestedGroupId : undefined

  // getStatusPageData falls back to the first joined group when the preferred
  // id is not one of mine, so a stale bookmark degrades instead of erroring.
  const board = await getStatusPageData(preferredGroupId)

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

  // [0005] 넛지 쿼터 집계 쿼리 제거.
  //   send_nudge 의 제한이 해제되어 셀 것이 없어졌다. 부수 효과로 이 화면의
  //   DB 왕복이 하나 줄었다. 제한을 되살리면 이 블록도 함께 되살려야 한다
  //   (git 이력: 0005 이전 버전).

  const members = board.members
  const boardIsEmpty = members.every((member) => member.total === 0)
  const finishedCount = members.filter(
    (member) => member.total > 0 && member.done >= member.total,
  ).length

  // ---- render -------------------------------------------------------------
  return (
    <Screen>
      <PageHeader title="오늘 현황" backHref="/" backLabel="오늘로 돌아가기" />

      <header className="flex flex-col gap-1">
        <p className="text-fg truncate text-base font-semibold">{activeGroup.name}</p>
        <p className="text-muted text-sm tabular-nums">{formatBoardDate(board.today)}</p>
      </header>

      {/* 그룹이 여러 개일 때만. 하나뿐이면 고를 것이 없습니다. */}
      {board.groups.length > 1 && (
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
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </Card>

      <Card title="콕 찌르기 규칙">
        <Hint>
          횟수 제한 없이 찌를 수 있어요. 다만 상대가 알림을 켜두지 않았다면 알림은 가지
          않고, 그 친구가 앱을 열었을 때만 보여요.
        </Hint>
        <LinkButton href="/settings" variant="secondary">
          내 알림 설정
        </LinkButton>
        <LinkButton href="/groups" variant="secondary">
          멤버 관리
        </LinkButton>
      </Card>
    </Screen>
  )
}
