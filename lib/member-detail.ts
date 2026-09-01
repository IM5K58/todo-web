/**
 * lib/member-detail.ts — /members/[userId] (그룹원 한 명 상세) 전용 조회 계층
 *
 * ★ 이 파일은 Server Component / Server Action 에서만 import 하세요. ★
 * createClient() 가 next/headers 의 cookies() 를 쓰므로 클라이언트 번들에
 * 들어가면 빌드가 깨집니다.
 *
 * ---------------------------------------------------------------------------
 * 이걸 만들어도 되는지 SQL 로 먼저 확인했습니다
 * ---------------------------------------------------------------------------
 * supabase/migrations/0002_rls.sql:309~318
 *
 *   create policy tasks_select_group_members on public.tasks for select
 *     to authenticated
 *     using (user_id = (select auth.uid())
 *            or group_id in (select private.current_user_group_ids()));
 *
 * 즉 **같은 그룹의 tasks 는 남의 것도 읽힙니다**. 마이그레이션은 필요 없습니다.
 * 다만 조건이 `user_id` 가 아니라 `group_id` 라는 점이 이 파일의 설계를 전부
 * 결정합니다 — 아래 "왜 group_id 로 좁히는가" 참고.
 *
 * 같이 필요한 나머지도 이미 열려 있습니다:
 *   profiles      0002:186~193  profiles_select_self_or_groupmate
 *                 (컬럼 단위 GRANT 라 select('*') 는 42501 — 0003/0007)
 *   group_members 0002:261~265  group_members_select_same_group
 *                 → `where user_id = <상대>` 로 물으면 RLS 가 **내 그룹의 행만**
 *                   돌려줍니다. 그래서 이 질의 하나가 곧 "같은 그룹인가?" 판정이자
 *                   "함께 있는 그룹은 어디인가?" 목록입니다. 왕복이 늘지 않습니다.
 *   groups        0002:224~229  groups_select_members
 *                 (invite_code 는 컬럼 GRANT 밖 — id, name 만 읽습니다)
 *
 * ---------------------------------------------------------------------------
 * 왜 조회를 "함께 있는 그룹" 으로 좁히는가
 * ---------------------------------------------------------------------------
 * 정책이 `group_id in (내 그룹들)` 이므로, 상대가 내가 없는 다른 그룹에서 적은
 * 할 일은 어차피 한 줄도 오지 않습니다. 필터를 안 걸면 RLS 가 조용히 걸러 주고,
 * 화면에는 "그날 아무것도 안 했네" 로 보입니다 — 없는 실패보다 나쁜 거짓말입니다.
 *
 * 그래서 `.in('group_id', sharedGroupIds)` 를 **명시적으로** 겁니다. 결과는
 * 같지만 의도가 코드에 남고, 화면은 그 범위를 그대로 표시할 수 있습니다
 * ("○○ 그룹 기준"). 조회 범위는 숨기지 않고 말합니다.
 *
 * ---------------------------------------------------------------------------
 * 자기 자신은 여기서 처리하지 않습니다 ({ kind: 'self' })
 * ---------------------------------------------------------------------------
 * 내 id 로 들어오면 데이터를 만들지 않고 'self' 를 돌려주고, 화면이 /history 로
 * 보냅니다. 근거는 **숫자가 갈라지기 때문**입니다.
 *
 *   · /history 는 `user_id = 나` 전부를 셉니다 — 내가 나간 그룹에 적었던 것까지
 *     포함입니다(0002:315 의 주석 "그룹을 나가도 내가 쓴 기록은 계속 보입니다").
 *   · 이 화면은 함께 있는 그룹으로 좁힙니다.
 *
 * 나에게는 이 둘이 다른 값이 될 수 있습니다. 같은 사람의 "연속 일수" 가 화면마다
 * 다르면 사용자는 둘 다 못 믿습니다(lib/history.ts 가 calcStreak 을 재정의하지
 * 않는 것과 같은 이유). /history 가 더 풍부하기도 하므로 그쪽이 정답입니다.
 *
 * ---------------------------------------------------------------------------
 * 없는 사람 / 남남인 사람은 조용히 404
 * ---------------------------------------------------------------------------
 * "그런 사람 없음" 과 "있지만 당신 그룹이 아님" 을 **구분해서 알려 주지 않습니다**.
 * 둘 다 group_members 질의가 0행이고, 호출자는 notFound() 를 부릅니다. 예외를
 * 던지거나 다른 문구를 쓰면 uuid 를 넣어 보는 것만으로 계정 존재 여부를 알아낼
 * 수 있게 됩니다.
 *
 * ---------------------------------------------------------------------------
 * 집계는 한 줄도 새로 쓰지 않았습니다
 * ---------------------------------------------------------------------------
 * lib/history.ts 의 순수 함수를 그대로 씁니다 — tallyByDate / buildCalendar /
 * buildHistorySummary(안에서 calcLongestStreak · calcStreak) / shiftDate /
 * HISTORY_WINDOW_DAYS. 그 파일은 수정하지 않았습니다. 판정 규칙이 화면마다
 * 갈라지는 것을 막는 것이 이 재사용의 목적입니다.
 *
 * 딱 하나 재사용하지 못한 것: lib/history.ts 의 `fetchWindowRows` 는 export 되어
 * 있지 않고, 되어 있더라도 `user_id` 로만 좁혀서 이 화면에 필요한
 * `group_id in (…)` 를 걸 자리가 없습니다. 그래서 같은 규칙(페이지네이션,
 * 잘렸을 때 가장 오래된 하루를 통째로 버리기)을 아래에 다시 구현했습니다.
 *
 * ---------------------------------------------------------------------------
 * 규칙 (lib/tasks.ts 머리말과 동일)
 * ---------------------------------------------------------------------------
 * 1. "오늘"은 JS 가 만들지 않습니다. lib/tasks.ts 의 getLocalToday() 를 씁니다
 *    (rpc('current_user_local_date') — tasks.task_date 의 DEFAULT 와 같은 함수).
 * 2. select('*') 금지. profiles / groups 는 컬럼 단위 GRANT 입니다.
 * 3. 날짜별 쿼리 금지. 창 전체를 한 번에 긁어와 JS 에서 집계합니다.
 * 4. 조회 범위 상한 MEMBER_HISTORY_WINDOW_DAYS. 화면이 이 사실을 표시합니다.
 * 5. 예외를 던지지 않습니다. 결과를 유니온으로 돌려주고 화면이 분기합니다.
 * 6. 왕복은 세어서 씁니다. 파 2개 / 질의 6개:
 *      파1: [ rpc('current_user_local_date'), group_members ]
 *      파2: [ groups, profiles, tasks(창 180일), tasks(오늘 목록) ]
 *    파2 는 파1 의 `today` 와 `sharedGroupIds` 를 둘 다 필요로 하므로 더 줄일
 *    수 없습니다.
 */

import { resolveAvatar, type ResolvedAvatar } from '@/lib/avatar'
import {
  HISTORY_WINDOW_DAYS,
  buildCalendar,
  buildHistorySummary,
  shiftDate,
  tallyByDate,
  type HistoryMonth,
  type HistoryRow,
  type HistorySummary,
  type HistoryTask,
} from '@/lib/history'
import { createClient } from '@/lib/supabase/server'
import {
  fetchMemberProfiles,
  getLocalToday,
  toKoreanDbError,
  type ProfilesReader,
} from '@/lib/tasks'

/* ==========================================================================
 * 상수
 * ======================================================================== */

/**
 * 이 화면이 되돌아보는 과거 일수(오늘 포함).
 *
 * /history 와 **같은 값**이어야 합니다. 다르면 "친구 화면의 최장 연속" 과
 * "내 화면의 최장 연속" 이 서로 다른 창에서 세어진 값이 되고, 둘을 나란히 놓고
 * 비교하는 순간 둘 다 의미를 잃습니다. 그래서 새 상수를 만들지 않고 lib/history.ts
 * 의 값을 그대로 다시 내보냅니다.
 */
export const MEMBER_HISTORY_WINDOW_DAYS = HISTORY_WINDOW_DAYS

/** 한 번의 왕복으로 가져올 행 수. PostgREST 의 기본 max-rows 와 같은 값입니다. */
const PAGE_SIZE = 1000

/** 페이지 상한. lib/history.ts 와 같은 3 페이지 = 180일 동안 하루 16개까지. */
const MAX_PAGES = 3

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 프로필 행이 안 보이는 계정(가입 트리거가 실패한 경우)의 표시 이름. */
const UNKNOWN_MEMBER_NAME = '알 수 없는 친구'

/* ==========================================================================
 * 타입
 * ======================================================================== */

/** 함께 있는 그룹 하나. groups 는 (id, name) 만 읽습니다 — invite_code 는 못 읽습니다. */
export type SharedGroup = {
  id: string
  name: string
}

export type MemberDetail = {
  userId: string
  displayName: string
  /**
   * 이미 계산이 끝난 아바타.
   *
   * ⚠️ **userMetadata 는 절대 넘기지 않습니다** ⚠️ 남의 행이기 때문입니다.
   * 구글 사진은 내 JWT 에서만 읽히므로, 넘기면 내 사진이 친구 얼굴 자리에
   * 붙습니다(lib/avatar.ts 머리말 · lib/tasks-queries.ts 의 memberAvatar()).
   */
  avatar: ResolvedAvatar
  /** 나와 이 사람이 함께 속한 그룹. 이 화면의 조회 범위 그 자체입니다. */
  sharedGroups: SharedGroup[]
  /** DB 가 계산한 내 로컬 오늘. 'YYYY-MM-DD'. */
  today: string
  /** 실제로 집계된 첫날. 보통 today - 179. */
  from: string
  /** 화면에 표시할 창 길이. */
  windowDays: number
  /** 행 상한에 걸려 from 이전을 못 읽었으면 true. 화면이 그렇다고 말해야 합니다. */
  truncated: boolean
  /** 오늘 이 사람이 적은 할 일. 읽기 전용입니다. */
  todayTasks: HistoryTask[]
  /**
   * 오늘 목록만 실패했을 때. 달력과 요약은 그대로 살아 있습니다.
   * (lib/history.ts 의 selectedError 와 같은 판단)
   */
  todayError: string | null
  /** 최신 달이 앞에 옵니다. */
  months: HistoryMonth[]
  summary: HistorySummary
}

/**
 * 화면이 분기할 다섯 가지. 예외 대신 값입니다.
 *
 *   unauthenticated  로그인 안 됨            → redirect('/login')
 *   self             내 id                   → redirect('/history') (머리말 참고)
 *   not-found        없거나 남남             → notFound()  ★ 이유를 구분하지 않습니다 ★
 *   error            조회 실패               → 한국어 문구를 그대로 표시
 *   ok               정상
 */
export type MemberDetailResult =
  | { kind: 'unauthenticated' }
  | { kind: 'self' }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; detail: MemberDetail }

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

type WindowFetch = {
  rows: HistoryRow[]
  truncated: boolean
  /** truncated 일 때 "여기부터는 믿을 수 있다" 는 첫날. 아니면 null. */
  coveredFrom: string | null
  error: string | null
}

/* ==========================================================================
 * 조회
 * ======================================================================== */

/**
 * 창 전체의 (task_date, done_at).
 *
 * lib/history.ts 의 fetchWindowRows 와 같은 규칙입니다(그 함수는 export 되어
 * 있지 않고 user_id 로만 좁힙니다 — 머리말 참고):
 *
 *   · count: 'exact' 로 전체 행 수를 함께 받아, 받은 행이 모자랄 때만 다음
 *     페이지를 부릅니다. 보통 왕복 1회로 끝납니다.
 *   · 페이지네이션에는 전순서가 필요하므로 id 를 2차 정렬 키로 붙입니다.
 *   · 상한을 소진하면 가장 오래된 **날짜 하루를 통째로 버립니다**. 그 하루가
 *     다 읽혔다는 보장이 없어서, 남겨 두면 "3개 중 1개만 했네" 라고 잘못
 *     그리게 됩니다.
 */
async function fetchMemberWindowRows(
  supabase: SupabaseServerClient,
  targetUserId: string,
  groupIds: string[],
  from: string,
  today: string,
): Promise<WindowFetch> {
  const rows: HistoryRow[] = []
  let expected: number | null = null

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const start = page * PAGE_SIZE

    const { data, error, count } = await supabase
      .from('tasks')
      .select('task_date, done_at', { count: 'exact' })
      .eq('user_id', targetUserId)
      // ★ 정책이 group_id 로 걸려 있으므로 이 필터가 곧 조회 범위입니다 ★
      .in('group_id', groupIds)
      .gte('task_date', from)
      .lte('task_date', today)
      .order('task_date', { ascending: false })
      .order('id', { ascending: false })
      .range(start, start + PAGE_SIZE - 1)

    if (error) {
      return {
        rows: [],
        truncated: false,
        coveredFrom: null,
        error: toKoreanDbError(error, '기록을 불러오지 못했습니다.'),
      }
    }

    rows.push(...(data ?? []))
    if (typeof count === 'number') expected = count

    if ((data?.length ?? 0) === 0) break
    if (expected !== null && rows.length >= expected) break

    if (page === MAX_PAGES - 1) {
      let oldest: string | null = null
      for (const row of rows) {
        if (oldest === null || row.task_date < oldest) oldest = row.task_date
      }
      const cut = oldest
      return {
        rows: cut === null ? rows : rows.filter((row) => row.task_date > cut),
        truncated: true,
        coveredFrom: cut === null ? null : shiftDate(cut, 1),
        error: null,
      }
    }
  }

  return { rows, truncated: false, coveredFrom: null, error: null }
}

/**
 * 오늘 이 사람이 적은 할 일. 제목까지 필요한 유일한 질의입니다.
 *
 * 날짜 하나를 겨냥하지만 "달력을 그리려고 날짜마다 도는 것" 과는 다릅니다 —
 * 오늘 하루뿐이고, 창 조회와 **같은 파**에서 동시에 나갑니다.
 */
async function fetchMemberTodayTasks(
  supabase: SupabaseServerClient,
  targetUserId: string,
  groupIds: string[],
  today: string,
): Promise<{ tasks: HistoryTask[]; error: string | null }> {
  const { data, error } = await supabase
    .from('tasks')
    .select('id, title, done_at')
    .eq('user_id', targetUserId)
    .in('group_id', groupIds)
    .eq('task_date', today)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })

  if (error) {
    return { tasks: [], error: toKoreanDbError(error, '오늘 할 일을 불러오지 못했습니다.') }
  }

  return {
    tasks: (data ?? []).map((row) => ({
      id: row.id,
      title: row.title,
      done: row.done_at !== null,
    })),
    error: null,
  }
}

/* ==========================================================================
 * 페이지 로더 (Server Component 가 부르는 진입점)
 * ======================================================================== */

/**
 * /members/[userId] 화면 데이터.
 *
 * @param rawUserId URL 세그먼트 그대로. 검증은 여기서 합니다 — URL 은 못 믿습니다.
 *   uuid 모양이 아니면 질의를 한 번도 보내지 않고 'not-found' 입니다.
 */
export async function getMemberDetail(rawUserId: string): Promise<MemberDetailResult> {
  const targetUserId = typeof rawUserId === 'string' ? rawUserId.trim() : ''

  // 모양이 틀린 값에 DB 왕복을 쓰지 않습니다. 22P02(invalid uuid)를 오류 화면으로
  // 흘리면 "형식은 맞았다" 는 사실이 새어 나가기도 합니다.
  if (!UUID_RE.test(targetUserId)) return { kind: 'not-found' }

  const supabase = await createClient()

  // getClaims() 는 JWT 서명을 로컬 검증합니다. getSession() 은 쿠키를 그대로
  // 되돌려줄 뿐이라 인가 검사가 아닙니다.
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims()
  const viewerId = claimsData?.claims.sub

  if (claimsError || typeof viewerId !== 'string' || !viewerId) {
    return { kind: 'unauthenticated' }
  }

  // 내 id 면 여기서 끝냅니다. 이유는 머리말 "자기 자신은 여기서 처리하지 않습니다".
  if (targetUserId === viewerId) return { kind: 'self' }

  /* ---- 파 1: 오늘 + "같은 그룹인가 / 어디서 같은가" ---------------------- */
  const [today, membership] = await Promise.all([
    getLocalToday(),
    supabase.from('group_members').select('group_id').eq('user_id', targetUserId),
  ])

  if (membership.error) {
    return {
      kind: 'error',
      message: toKoreanDbError(membership.error, '그룹원 정보를 불러오지 못했습니다.'),
    }
  }

  const groupIds = Array.from(new Set((membership.data ?? []).map((row) => row.group_id)))

  // 0행 = 계정이 없거나, 있어도 나와 겹치는 그룹이 없음. 둘을 구분하지 않습니다.
  if (groupIds.length === 0) return { kind: 'not-found' }

  /* ---- 파 2: 그룹 이름 · 프로필 · 창 180일 · 오늘 목록 -------------------- */
  const from = shiftDate(today, -(MEMBER_HISTORY_WINDOW_DAYS - 1))

  const [groupResult, profileResult, windowResult, todayResult] = await Promise.all([
    // ★ select('*') 금지 ★ invite_code 는 authenticated 에게 컬럼 권한이 없습니다.
    supabase.from('groups').select('id, name').in('id', groupIds),
    // ★ select('*') 금지 ★ 컬럼 목록과 0007 미배포 폴백은 이 함수 안에 있습니다.
    fetchMemberProfiles(supabase as unknown as ProfilesReader, [targetUserId]),
    fetchMemberWindowRows(supabase, targetUserId, groupIds, from, today),
    fetchMemberTodayTasks(supabase, targetUserId, groupIds, today),
  ])

  if (groupResult.error) {
    return {
      kind: 'error',
      message: toKoreanDbError(groupResult.error, '그룹 정보를 불러오지 못했습니다.'),
    }
  }
  if (profileResult.error) {
    return {
      kind: 'error',
      message: toKoreanDbError(profileResult.error, '프로필을 불러오지 못했습니다.'),
    }
  }
  if (windowResult.error) {
    return { kind: 'error', message: windowResult.error }
  }

  const profile = profileResult.data.find((row) => row.id === targetUserId)

  /*
   * 창을 정확히 자릅니다. 상한에 걸려 잘렸으면 "믿을 수 있는 첫날" 이 뒤로
   * 밀리고, 화면은 그 날짜를 그대로 말합니다.
   */
  const effectiveFrom =
    windowResult.coveredFrom !== null && windowResult.coveredFrom > from
      ? windowResult.coveredFrom
      : from

  const rows = windowResult.rows.filter(
    (row) => row.task_date >= effectiveFrom && row.task_date <= today,
  )

  const counts = tallyByDate(rows)

  const sharedGroups: SharedGroup[] = (groupResult.data ?? [])
    .map((row) => ({ id: row.id, name: row.name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'))

  return {
    kind: 'ok',
    detail: {
      userId: targetUserId,
      displayName: profile?.display_name ?? UNKNOWN_MEMBER_NAME,
      // ⚠️ 남의 행입니다. userMetadata 를 넘길 자리를 만들지 않습니다.
      avatar: resolveAvatar({
        avatarUrl: profile?.avatar_url ?? null,
        avatarEmoji: profile?.avatar_emoji ?? null,
      }),
      sharedGroups,
      today,
      from: effectiveFrom,
      windowDays: MEMBER_HISTORY_WINDOW_DAYS,
      truncated: windowResult.truncated,
      todayTasks: todayResult.tasks,
      todayError: todayResult.error,
      // 집계는 전부 lib/history.ts 의 순수 함수입니다. 여기서 새로 만들지 않습니다.
      months: buildCalendar(counts, effectiveFrom, today),
      summary: buildHistorySummary(rows, today),
    },
  }
}
