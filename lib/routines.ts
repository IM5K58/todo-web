/**
 * lib/routines.ts — 루틴(0011) 조회 계층
 *
 * ★ 이 모듈은 Server Component / Server Action 에서만 import 하세요. ★
 * createClient() 가 next/headers 의 cookies() 를 쓰므로 클라이언트 번들에
 * 들어가면 빌드가 깨집니다. (lib/tasks.ts 머리말과 같은 규칙입니다.)
 *
 * 절대 throw 하지 않습니다. 실패는 { error: string | null } 로 돌려주고 화면이
 * 한국어로 렌더합니다 — 조용히 빈 목록으로 삼키지 않습니다.
 *
 * ---------------------------------------------------------------------------
 * 0011_routines.sql 을 읽고 확정한 것들 (기억이 아니라 SQL 이 근거)
 * ---------------------------------------------------------------------------
 * 1. ★ get_my_routines() 의 반환 컬럼은 정확히 이 아홉 개입니다 ★
 *      routine_id uuid, group_id uuid, title text, period text,
 *      target_count integer, done_count integer, checked_today boolean,
 *      period_start date, period_end date
 *    `achieved` 도 `today` 도 오지 않습니다. 달성 여부는 화면에서
 *    done_count >= target_count 로 계산합니다(SQL 주석의 명시적 결정).
 *
 * 2. ★ 주/월 경계를 TypeScript 가 다시 계산하지 않습니다 ★
 *    period_start / period_end 가 이미 서버 계산값입니다. week 는 ISO 8601
 *    기준 **월요일 시작**(private.routine_period_start 의 date_trunc('week')),
 *    month 는 달력 1일~말일이고, 양끝 포함입니다. "오늘" 도 서버가
 *    public.current_user_local_date() 로 정합니다. 여기서 new Date() 로 주
 *    경계를 만들면 월요일 규칙이 두 벌이 되고, 한국 시간 00~09시에 어긋납니다.
 *    아래 formatPeriodRange 는 **받은 문자열을 쪼개서 표시만** 합니다.
 *
 * 3. RETURNS TABLE 은 PostgREST 에서 배열입니다(프로젝트 규칙 2).
 *    get_my_routines 는 목록이므로 그대로 순회하고, toggle_routine_checkin 은
 *    한 행이므로 data[0] 입니다(그건 actions.ts 쪽 일입니다).
 *
 * 4. 쓰기 경로는 여기 없습니다. routines / routine_assignments /
 *    routine_checkins 에는 authenticated 의 INSERT·UPDATE·DELETE **권한 자체가
 *    없습니다**(0011 ⑤). 쓰기는 RPC 세 개뿐이고 app/routines/actions.ts 가 씁니다.
 *
 * 5. 관리자 판정은 public.am_i_admin() 입니다. 이건 **화면 분기용 편의 함수**
 *    이지 보안 경계가 아닙니다(0009 의 주석). 진짜 강제는 각 RPC 안의
 *    private.is_app_admin() 이고, 여기서 false 를 받으면 편집 UI 를 아예
 *    렌더하지 않는 것이 목적입니다 — 서버가 조용히 무시하므로 버튼을 보여주면
 *    "저장했는데 안 바뀐다" 가 됩니다(프로젝트 함정 6).
 *
 * ---------------------------------------------------------------------------
 * 왜 RPC 와 테이블 조회가 전부 캐스트인가
 * ---------------------------------------------------------------------------
 * lib/supabase/types.ts 는 손으로 쓴 파일이고 0001~0006 까지만 반영되어
 * 있습니다. 이 기능이 소유한 파일이 아니므로 0011 의 함수·테이블은 거기에
 * 없습니다. 타입이 붙은 채로 supabase.rpc('get_my_routines') 나
 * supabase.from('routines') 를 쓰면 **DB 에는 실재하는 것 때문에 빌드가
 * 깨집니다**. app/status/default-group-actions.ts 와 lib/tasks-model.ts 의
 * ProfilesReader 가 세운 처방을 그대로 따릅니다: 부르는 함수 하나, 인자 하나,
 * 읽는 컬럼만 손으로 좁게 적고 캐스트합니다.
 * types.ts 에 항목이 생기면 이 타입들과 캐스트를 지우세요 — 나머지는 그대로입니다.
 */

import type { PostgrestError } from '@supabase/supabase-js'

import { createClient } from '@/lib/supabase/server'
import {
  fetchMemberProfiles,
  getMyGroups,
  toKoreanDbError,
  type MyGroup,
  type ProfilesReader,
} from '@/lib/tasks'

/* ==========================================================================
 * 타입
 * ======================================================================== */

/** routines.period. CHECK (period in ('week','month')) 가 강제합니다. */
export type RoutinePeriod = 'week' | 'month'

/**
 * public.get_my_routines() 한 행. ★ 컬럼 이름과 개수를 바꾸지 마세요 ★ —
 * 이름 하나만 어긋나도 undefined 가 화면에 조용히 흘러갑니다.
 *
 * period_start / period_end 는 `date` 라 PostgREST 가 'YYYY-MM-DD' 문자열로
 * 보냅니다. Date 로 파싱하지 마세요 — 표시 외에는 쓸 일이 없습니다.
 */
export type MyRoutine = {
  routine_id: string
  group_id: string
  title: string
  period: RoutinePeriod
  target_count: number
  done_count: number
  checked_today: boolean
  period_start: string
  period_end: string
}

/** 관리자 화면이 그리는 routines 한 행. `active` 가 곧 "삭제" 입니다(0011 ②-a). */
export type AdminRoutine = {
  id: string
  group_id: string
  title: string
  period: RoutinePeriod
  target_count: number
  active: boolean
}

/**
 * 배정 체크박스 한 줄.
 *
 * ★ 이모지만 씁니다 ★ 남의 행을 그리면서 resolveAvatar 에 userMetadata 를
 * 넘기면 내 구글 사진이 친구 얼굴 자리에 붙습니다(lib/tasks-queries.ts 의
 * memberAvatar 주석). 이 화면에는 사진이 필요 없으므로 그 경로를 아예 만들지
 * 않았습니다.
 */
export type AdminMember = {
  userId: string
  name: string
  emoji: string
}

/** /routines 화면 데이터. */
export type RoutinesPageData = {
  error: string | null
  isAdmin: boolean
  /** 그룹 이름을 붙이기 위한 목록. 루틴이 없어도 채워집니다. */
  groups: MyGroup[]
  routines: MyRoutine[]
}

/** /routines/admin 화면 데이터. isAdmin 이 false 면 나머지는 전부 빈 값입니다. */
export type RoutinesAdminData = {
  error: string | null
  isAdmin: boolean
  groups: MyGroup[]
  activeGroup: MyGroup | null
  routines: AdminRoutine[]
  members: AdminMember[]
  /** routine_id -> 지금 배정된 user_id 집합. */
  assigneesByRoutine: Map<string, Set<string>>
}

/* ==========================================================================
 * 손으로 좁게 적은 호출 모양 (머리말 "왜 전부 캐스트인가" 참고)
 * ======================================================================== */

type PgResult<T> = PromiseLike<{ data: T; error: PostgrestError | null }>

/** public.am_i_admin() -> boolean. 인자 없음 = 남에 대해 물어볼 수 없습니다. */
type AmIAdminRpc = (fn: 'am_i_admin') => PgResult<boolean | null>

/** public.get_my_routines() -> setof. RETURNS TABLE 이라 **배열**입니다. */
type GetMyRoutinesRpc = (fn: 'get_my_routines') => PgResult<MyRoutine[] | null>

/**
 * `from(...).select('...').eq(...).order(...)` 한 갈래만.
 *
 * ★ 캐스트가 `from()` 부터 시작하는 이유 ★ 타입이 붙은 클라이언트에서는
 * `from()` 의 인자가 Database['public']['Tables'] 의 키로 좁혀져 있어서,
 * 0011 의 테이블 이름을 넘기면 `'routines' is not assignable to 'never'` 가
 * 납니다. 그래서 반환값이 아니라 클라이언트 자체를 이 모양으로 캐스트합니다
 * (lib/tasks-model.ts 의 ProfilesReader 와 같은 처방).
 */
type OrderedEqReader<TRow> = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => {
        order: (
          column: string,
          options: { ascending: boolean },
        ) => PgResult<TRow[] | null>
      }
    }
  }
}

/** `from(...).select('...').in(...)` 한 갈래만. 위와 같은 이유로 from() 부터입니다. */
type InReader<TRow> = {
  from: (table: string) => {
    select: (columns: string) => {
      in: (column: string, values: string[]) => PgResult<TRow[] | null>
    }
  }
}

type RoutineAssignmentRow = { routine_id: string; user_id: string }

/* ==========================================================================
 * 표시 도우미 — 전부 순수 함수입니다 (질의 없음, "지금" 을 읽지 않음)
 * ======================================================================== */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 'week' -> '주', 'month' -> '월'. */
export function periodLabel(period: string): string {
  return period === 'month' ? '월' : '주'
}

/**
 * 진행 문구의 앞머리. 'week' -> '이번 주', 'month' -> '이번 달'.
 * "이번 주 1/2" 처럼 사람이 바로 읽히게 하는 것이 목적입니다.
 */
export function periodScopeLabel(period: string): string {
  return period === 'month' ? '이번 달' : '이번 주'
}

/**
 * 'YYYY-MM-DD' 두 개를 '9/1 ~ 9/7' 로.
 *
 * ★ Date 를 만들지 않습니다 ★ 입력은 DB 가 사용자 시간대로 이미 계산해 준
 * 날짜 문자열이고, 여기서 필요한 것은 월·일 숫자뿐입니다. new Date(문자열) 은
 * 브라우저/런타임마다 타임존 해석이 달라 하루가 밀 수 있습니다.
 * 모양이 이상하면 받은 값을 그대로 이어 붙입니다(거짓 날짜를 지어내지 않습니다).
 */
export function formatPeriodRange(start: string, end: string): string {
  if (!ISO_DATE_RE.test(start) || !ISO_DATE_RE.test(end)) {
    return `${start} ~ ${end}`
  }
  const short = (iso: string) => {
    const [, month, day] = iso.split('-')
    return `${Number(month)}/${Number(day)}`
  }
  return `${short(start)} ~ ${short(end)}`
}

/** "이번 주 1/2" / "이번 달 3/5". 목록에서 한 눈에 읽히는 한 줄. */
export function progressLabel(routine: MyRoutine): string {
  return `${periodScopeLabel(routine.period)} ${routine.done_count}/${routine.target_count}`
}

/** 이번 주기를 채웠는가. ★ 서버가 보내는 값이 아니라 여기서 계산합니다 ★ */
export function isPeriodAchieved(routine: MyRoutine): boolean {
  return routine.done_count >= routine.target_count
}

/** period 값이 실제로 week/month 인지. DB CHECK 이 강제하지만 읽을 때 좁힙니다. */
function asPeriod(value: unknown): RoutinePeriod {
  return value === 'month' ? 'month' : 'week'
}

/* ==========================================================================
 * 조회
 * ======================================================================== */

/**
 * 호출자가 앱 관리자인가. **화면 분기용입니다.**
 *
 * 실패하면 false 입니다 — 그리고 그게 옳습니다. 이 값의 유일한 용도가 "편집
 * UI 를 보여줄까" 이고, 모르면 안 보여주는 쪽이 안전합니다(못 보이는 버튼은
 * 불편하고, 눌러도 서버가 무시하는 버튼은 고장입니다). 진짜 권한 강제는
 * 각 RPC 안의 private.is_app_admin() 이므로 여기서 틀려도 권한이 새지 않습니다.
 */
export async function amIAdmin(): Promise<boolean> {
  const supabase = await createClient()
  const rpc = supabase.rpc.bind(supabase) as unknown as AmIAdminRpc

  const { data, error } = await rpc('am_i_admin')

  if (error) {
    // PGRST202 = 0009 미배포. 그 외는 진짜 실패. 어느 쪽이든 "관리자 아님".
    console.error('[routines] am_i_admin 실패', {
      code: error.code,
      message: error.message,
    })
    return false
  }

  return data === true
}

/**
 * 내게 배정된 활성 루틴 + 이번 주기 진행.
 *
 * 인자가 없는 RPC 라 여러 그룹의 루틴이 한 번에 옵니다(0011 ⑧-b). 정렬은
 * 서버가 (created_at, id) 로 고정해 주므로 여기서 다시 정렬하지 않습니다 —
 * 새로고침마다 순서가 흔들리지 않게 하려는 서버 쪽 결정입니다.
 */
export async function getMyRoutines(): Promise<{
  routines: MyRoutine[]
  error: string | null
}> {
  const supabase = await createClient()
  const rpc = supabase.rpc.bind(supabase) as unknown as GetMyRoutinesRpc

  const { data, error } = await rpc('get_my_routines')

  if (error) {
    return {
      routines: [],
      error: toKoreanDbError(error, '루틴을 불러오지 못했습니다.'),
    }
  }

  // period 만 좁힙니다. 나머지는 RETURNS TABLE 이 모양을 보장합니다.
  const routines = (data ?? []).map((row) => ({
    ...row,
    period: asPeriod(row.period),
  }))

  return { routines, error: null }
}

/**
 * 한 루틴에 지금 배정된 사람들. Server Action 이 쓰기 **뒤에 다시 읽으려고**
 * 부릅니다 (프로젝트 함정 2 — returns void 는 성공 여부를 알 수 없습니다).
 */
export async function fetchRoutineAssignees(
  routineId: string,
): Promise<{ userIds: string[]; error: string | null }> {
  const supabase = await createClient()
  const db = supabase as unknown as InReader<RoutineAssignmentRow>

  const { data, error } = await db
    .from('routine_assignments')
    .select('routine_id, user_id')
    .in('routine_id', [routineId])

  if (error) {
    return { userIds: [], error: toKoreanDbError(error, '배정을 확인하지 못했습니다.') }
  }

  return { userIds: (data ?? []).map((row) => row.user_id), error: null }
}

/**
 * /routines 화면 데이터.
 *
 * ── 파(wave) 계산 (lib/tasks.ts 머리말 5번) ────────────────────────────────
 *   1) [ get_my_routines | am_i_admin | group_members ]
 *   2) [ groups ]                            ← getMyGroups 의 두 번째 질의
 * 세 갈래가 서로를 기다리지 않으므로 Promise.all 로 같은 파에 넣습니다.
 * 그룹 이름은 루틴 카드의 제목에만 쓰이지만, 루틴이 여러 그룹에서 오므로
 * (인자 없는 RPC 입니다) "어느 그룹의 루틴인지" 를 말하려면 필요합니다.
 */
export async function getRoutinesPageData(userId: string): Promise<RoutinesPageData> {
  const [{ routines, error: routineError }, isAdmin, { groups, error: groupError }] =
    await Promise.all([getMyRoutines(), amIAdmin(), getMyGroups(userId)])

  return {
    // 루틴 조회 실패가 더 중요한 실패입니다. 그룹 이름은 없어도 화면이 섭니다.
    error: routineError ?? groupError,
    isAdmin,
    groups,
    routines,
  }
}

/**
 * /routines/admin 화면 데이터.
 *
 * ★ 관리자가 아니면 여기서 끝냅니다 ★ 목록도 멤버도 읽지 않습니다. 편집 UI 를
 * 렌더하지 않기로 한 이상(함정 6) 그리지 않을 데이터를 읽을 이유가 없고,
 * 관리자만 보는 화면에서 비관리자에게 그룹원 명단을 만들어 줄 이유도 없습니다.
 *
 * ── 파 계산 ───────────────────────────────────────────────────────────────
 *   1) [ am_i_admin | group_members ]
 *   2) [ groups ]
 *   3) [ routines(그 그룹) | group_members(그 그룹) ]
 *   4) [ profiles | routine_assignments ]
 */
export async function getRoutinesAdminData(
  userId: string,
  preferredGroupId?: string,
): Promise<RoutinesAdminData> {
  const empty: RoutinesAdminData = {
    error: null,
    isAdmin: false,
    groups: [],
    activeGroup: null,
    routines: [],
    members: [],
    assigneesByRoutine: new Map(),
  }

  const [isAdmin, { groups, error: groupError }] = await Promise.all([
    amIAdmin(),
    getMyGroups(userId),
  ])

  if (!isAdmin) return empty
  if (groupError) return { ...empty, isAdmin: true, error: groupError }

  const activeGroup = groups.find((g) => g.id === preferredGroupId) ?? groups[0] ?? null
  if (!activeGroup) {
    return { ...empty, isAdmin: true, groups }
  }

  const supabase = await createClient()

  // ★ select('*') 금지 ★ 새 테이블이라 전체 SELECT grant 가 있지만(0011 ⑤),
  // 다른 조회 계층과 같은 규칙으로 컬럼을 나열합니다.
  const routinesDb = supabase as unknown as OrderedEqReader<{
    id: string
    group_id: string
    title: string
    period: string
    target_count: number
    active: boolean
  }>

  const [routineResult, memberResult] = await Promise.all([
    routinesDb
      .from('routines')
      .select('id, group_id, title, period, target_count, active')
      .eq('group_id', activeGroup.id)
      .order('created_at', { ascending: true }),
    supabase.from('group_members').select('user_id, role').eq('group_id', activeGroup.id),
  ])

  if (routineResult.error) {
    return {
      ...empty,
      isAdmin: true,
      groups,
      activeGroup,
      error: toKoreanDbError(routineResult.error, '루틴 목록을 불러오지 못했습니다.'),
    }
  }
  if (memberResult.error) {
    return {
      ...empty,
      isAdmin: true,
      groups,
      activeGroup,
      error: toKoreanDbError(memberResult.error, '그룹원을 불러오지 못했습니다.'),
    }
  }

  const routines: AdminRoutine[] = (routineResult.data ?? []).map((row) => ({
    id: row.id,
    group_id: row.group_id,
    title: row.title,
    period: asPeriod(row.period),
    target_count: row.target_count,
    active: row.active,
  }))

  const memberIds = (memberResult.data ?? []).map((row) => row.user_id)
  const routineIds = routines.map((r) => r.id)

  const assignmentsDb = supabase as unknown as InReader<RoutineAssignmentRow>

  const [profileResult, assignmentResult] = await Promise.all([
    fetchMemberProfiles(supabase as unknown as ProfilesReader, memberIds),
    routineIds.length > 0
      ? assignmentsDb
          .from('routine_assignments')
          .select('routine_id, user_id')
          .in('routine_id', routineIds)
      : Promise.resolve({
          data: [] as RoutineAssignmentRow[],
          error: null as PostgrestError | null,
        }),
  ])

  if (assignmentResult.error) {
    return {
      ...empty,
      isAdmin: true,
      groups,
      activeGroup,
      routines,
      error: toKoreanDbError(assignmentResult.error, '배정 현황을 불러오지 못했습니다.'),
    }
  }

  // 프로필 조회 실패는 화면을 죽이지 않습니다 — 이름 자리가 비고 배정은 됩니다.
  // (fetchMemberProfiles 가 0007 미배포 폴백까지 이미 흡수합니다.)
  const profileById = new Map(
    (profileResult.data ?? []).map((p) => [p.id, p] as const),
  )

  const members: AdminMember[] = memberIds.map((id) => {
    const profile = profileById.get(id)
    return {
      userId: id,
      name: profile?.display_name ?? '이름 없는 멤버',
      // ★ userMetadata 를 넘기지 않습니다 ★ (AdminMember 주석 참고)
      emoji: profile?.avatar_emoji ?? '🙂',
    }
  })

  const assigneesByRoutine = new Map<string, Set<string>>()
  for (const id of routineIds) assigneesByRoutine.set(id, new Set())
  for (const row of assignmentResult.data ?? []) {
    assigneesByRoutine.get(row.routine_id)?.add(row.user_id)
  }

  return {
    error: profileResult.error
      ? toKoreanDbError(profileResult.error, '그룹원 이름을 불러오지 못했습니다.')
      : null,
    isAdmin: true,
    groups,
    activeGroup,
    routines,
    members,
    assigneesByRoutine,
  }
}
