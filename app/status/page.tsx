import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { Screen } from '@/components/screen'
import { Card, EmptyState, ErrorText, LinkButton, PageHeader } from '@/components/ui'
import { requireUserId } from '@/lib/auth'
import { getGroupPushStatus, type PushStatusMap } from '@/lib/push-status'
import { createClient } from '@/lib/supabase/server'
import { getStatusPageData, type StatusPageData } from '@/lib/tasks'

import { BoardHeader } from './board-header'
import { GroupDetailLink } from './group-detail-link'
import { GroupSwitcher } from './group-switcher'
import { LoadFailure } from './load-failure'
import { MemberList } from './member-list'
import {
  DEFAULT_GROUP_MESSAGES,
  defaultGroupCode,
  isDefaultGroupError,
  nudgeErrMessage,
  nudgeOkMessage,
} from './messages'
import { Notice } from './notice'
import { NudgeRulesCard } from './nudge-rules-card'
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
 * WHAT LIVES WHERE
 * ----------------
 * 이 파일이 데이터 계층입니다: 파라미터를 읽고, 조회를 띄우고, 리다이렉트를
 * 결정하고, 결과를 아래 조각들에 prop 으로 내려보냅니다. 화면 조각은 전부
 * 같은 폴더에 있고 전부 Server Component 입니다(클라이언트 경계는 예나 지금이나
 * components/ui.tsx 의 `'use client'` 한 곳뿐입니다):
 *
 *   ./messages.ts            `?ok=` · `?err=` · `?dg=` 의 한국어 문구
 *   ./notice.tsx             그 문구를 담는 배너 한 줄
 *   ./load-failure.tsx       읽기가 실패했을 때의 화면 전체
 *   ./board-header.tsx       그룹 이름 + 조회한 날짜
 *   ./group-switcher.tsx     그룹 칩 + [0007] 기본 그룹 고정 토글
 *   ./member-list.tsx        명단, 콕 찌르기 버튼, [0006] 알림 꺼둠 각주
 *   ./group-detail-link.tsx  명단 아래 /groups 진입점
 *   ./nudge-rules-card.tsx   콕 찌르기 규칙 카드
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
 * in ./messages.ts still exists and still tells the fuller story afterwards
 * (that the friend will see it when they open the app) — the badge deliberately
 * does not repeat that sentence.
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
 *   2. `profiles.default_group_id` the pin, set from ./group-switcher.tsx
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
 * is now the way there — ./group-detail-link.tsx.
 */

export const metadata: Metadata = {
  title: '현황',
}

/**
 * [0007] app/status/default-group-actions.ts 가 `import type { DefaultGroupCode }
 * from './page'` 로 이 이름을 가져갑니다. 유니온의 정의는 ./messages.ts 로
 * 옮겼지만, 그 파일은 이 기능이 소유하지 않은 파일이라 import 경로를 그대로
 * 살려 둡니다. 타입 전용 re-export 라 컴파일 시점에 지워지고, 런타임 순환은
 * 생기지 않습니다.
 */
export type { DefaultGroupCode } from './messages'

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

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function StatusPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const params = await searchParams
  const okMessage = nudgeOkMessage(params.ok)
  const errMessage = nudgeErrMessage(params.err)

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
   * (같은 여섯 줄이 여섯 화면에 있었습니다 — 지금은 lib/auth.ts 한 곳입니다.)
   */
  const { userId: claimedUserId } = await requireUserId()

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

      <BoardHeader groupName={activeGroup.name} today={board.today} />

      {/*
        그룹이 여러 개일 때만. 하나뿐이면 고를 것도, [0007] 고정할 것도 없습니다
        — 어차피 그 그룹이 열리므로 "기본으로 고정" 은 아무것도 바꾸지 않는
        버튼이 됩니다. 그래서 칩과 토글이 같은 조건을 공유합니다.
      */}
      {board.groups.length > 1 && (
        <GroupSwitcher
          groups={board.groups}
          activeGroupId={activeGroup.id}
          isPinned={isPinned}
        />
      )}

      {okMessage && <Notice tone="ok">{okMessage}</Notice>}
      {errMessage && <Notice tone="error">{errMessage}</Notice>}

      {/*
        [0007] 고정 결과. 콕 찌르기 배너와 같은 모양이지만 파라미터가 달라
        (`?dg=`) 서로를 덮어쓰지 않습니다. 바로 위 토글이 이미 새 상태를 보여
        주고 있으므로, 이 문장은 "무엇이 바뀌었는지" 만 말하고 상태를 다시
        선언하지 않습니다.
      */}
      {dgCode && (
        <Notice tone={isDefaultGroupError(dgCode) ? 'error' : 'ok'}>
          {DEFAULT_GROUP_MESSAGES[dgCode]}
        </Notice>
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

            <MemberList
              members={members}
              groupId={activeGroup.id}
              pushStatuses={pushStatuses}
              boardIsEmpty={boardIsEmpty}
            />
          </>
        )}

        {/*
          로스터 조회가 실패해도 /groups 진입점은 남습니다 — 그래서 위 삼항
          "밖" 입니다. 이유는 ./group-detail-link.tsx 에 적어 두었습니다.
        */}
        <GroupDetailLink />
      </Card>

      <NudgeRulesCard />
    </Screen>
  )
}
