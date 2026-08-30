/**
 * lib/tasks.ts — 서버 전용 조회 계층 (Phase 2)
 *
 * ★ 이 파일은 Server Component / Server Action 에서만 import 하세요. ★
 * createClient() 가 next/headers 의 cookies() 를 쓰므로 클라이언트 번들에
 * 들어가면 빌드가 깨집니다.
 *
 * ---------------------------------------------------------------------------
 * 설계 규칙 (0001~0003 SQL 을 읽고 결정한 것들 — 기억이 아니라 SQL 이 근거)
 * ---------------------------------------------------------------------------
 * 1. "오늘"은 JS 가 만들지 않습니다.
 *    tasks.task_date 의 DEFAULT 는 public.current_user_local_date() 이고,
 *    그 함수는 profiles.timezone 기준으로 날짜를 계산합니다.
 *    new Date().toISOString().slice(0,10) 은 01:30 KST 에 "어제"를 돌려줍니다.
 *    그래서 오늘 날짜는 항상 rpc('current_user_local_date') 로 DB 에 물어봅니다.
 *    (0001_init.sql 3번 섹션)
 *
 * 2. select('*') 금지.
 *    profiles 는 0003 에서, groups 는 0002 에서 컬럼 단위 GRANT 로 좁혀졌습니다.
 *    '*' 를 보내면 42501 이 납니다. 필요한 컬럼만 이름으로 나열합니다.
 *    tasks 는 테이블 전체 SELECT 가 있지만(0002:135) 일관성을 위해 나열합니다.
 *
 * 3. 그룹 요약은 N+1 금지.
 *    0002 의 tasks_select_group_members 정책이 "같은 그룹 멤버의 tasks SELECT"를
 *    허용하므로(0002:309~318), 그룹 전체의 오늘 할 일을 한 번에 긁어와
 *    메모리에서 사용자별로 집계합니다. 멤버당 쿼리를 돌리지 않습니다.
 *
 * 4. 조회 함수는 예외를 던지지 않습니다.
 *    페이지 로더(get*PageData)는 { error: string | null, ... } 를 돌려주고,
 *    화면이 한국어 오류를 정직하게 렌더링합니다. 조용한 무시는 하지 않습니다.
 */

import type { PostgrestError } from '@supabase/supabase-js'

import { createClient } from '@/lib/supabase/server'
import type { GroupRole } from '@/lib/supabase/types'

/* ==========================================================================
 * 타입
 * ======================================================================== */

/** 오늘 화면이 쓰는 할 일 한 줄. tasks 테이블의 부분 집합입니다. */
export type TodayTask = {
  id: string
  group_id: string
  title: string
  sort_order: number
  /** NULL = 미완료. timestamptz 문자열 = 완료 시각. */
  done_at: string | null
  /** 'YYYY-MM-DD'. DB 가 정한 값이지 클라이언트가 만든 값이 아닙니다. */
  task_date: string
}

/** 내가 속한 그룹 하나. groups 는 (id, name, created_by, created_at) 만 읽힙니다. */
export type MyGroup = {
  id: string
  name: string
  role: GroupRole
  /** group_members.joined_at. 활성 그룹 선택 순서의 기준입니다. */
  joined_at: string
}

/** /status 의 한 줄: 그룹원 1명의 오늘 진행 상황. */
export type MemberTodayStatus = {
  userId: string
  displayName: string
  avatarEmoji: string
  role: GroupRole
  /** 오늘 적은 할 일 총 개수. 0 이면 "아직 안 적었어요". */
  total: number
  /** 그중 done_at 이 채워진 개수. */
  done: number
  /** 본인 행인지. 콕 찌르기 버튼을 숨기는 데 씁니다(자기 자신에게는 못 보냅니다). */
  isMe: boolean
}

/**
 * 모든 Server Action 의 공통 반환값. 실패는 예외가 아니라 값입니다.
 *
 * ★ 왜 액션 파일이 아니라 여기에 있나 ★
 * app/tasks/actions.ts 는 'use server' 파일이고, 그런 파일은 async 함수 외의
 * export 를 허용하지 않습니다("Only async functions are allowed to be exported
 * in a 'use server' file"). 타입과 상수는 전부 이 파일에 둡니다.
 */
export type ActionResult =
  | { ok: true; error?: undefined }
  | { ok: false; error: string }

/** addTask 만 성공 시 만들어진 행을 함께 돌려줍니다(낙관적 업데이트 정합용). */
export type AddTaskResult =
  | { ok: true; task: TodayTask; error?: undefined }
  | { ok: false; task?: undefined; error: string }

/** tasks_title_len_chk 와 동일한 상한. 입력창의 maxLength 에도 쓰세요. */
export const TASK_TITLE_MAX = 200

/** / (오늘) 페이지가 한 번에 필요로 하는 전부. */
export type TodayPageData = {
  /** null 이면 정상. 문자열이면 한국어 오류 메시지를 그대로 보여 주세요. */
  error: string | null
  /** 로그인하지 않았으면 null. */
  userId: string | null
  /** DB 가 계산한 내 로컬 오늘. 'YYYY-MM-DD'. */
  today: string
  groups: MyGroup[]
  /** groups 가 비어 있으면 null → "그룹에 먼저 참여해 주세요" 안내. */
  activeGroup: MyGroup | null
  tasks: TodayTask[]
  /** 연속 완료 일수. 계산 규칙은 calcStreak() 주석 참고. */
  streak: number
}

/** /status (현황) 페이지가 한 번에 필요로 하는 전부. */
export type StatusPageData = {
  error: string | null
  userId: string | null
  today: string
  groups: MyGroup[]
  activeGroup: MyGroup | null
  /** 완료율 내림차순 → 이름순. 빈 배열이면 멤버가 나뿐입니다. */
  members: MemberTodayStatus[]
}

/* ==========================================================================
 * 내부 유틸
 * ======================================================================== */

/**
 * PostgrestError 를 한국어 한 문장으로. 조용히 삼키지 않습니다.
 * 코드는 0001~0003 이 실제로 던지는 것들입니다.
 */
export function toKoreanDbError(
  error: PostgrestError | null,
  fallback: string
): string {
  if (!error) return fallback

  switch (error.code) {
    case '42501':
      return '권한이 없습니다. 다시 로그인해 주세요.'
    case '23514':
      return '입력한 값이 형식에 맞지 않습니다.'
    case '22023':
      return '입력한 값이 올바르지 않습니다.'
    case 'P0002':
      return '대상을 찾을 수 없습니다.'
    case 'PGRST202':
      return '서버 함수를 찾을 수 없습니다. 잠시 후 다시 시도해 주세요.'
    case '23505':
      return '이미 존재하는 값입니다.'
    default:
      return `${fallback} (${error.code ?? '알 수 없음'})`
  }
}

/**
 * 'YYYY-MM-DD' 에서 n일을 뺍니다.
 *
 * ★ 여기서 Date 를 쓰는 것은 안전합니다 ★ — "지금"을 읽지 않기 때문입니다.
 * 입력은 DB 가 이미 사용자 시간대로 계산해 준 날짜 문자열이고, Date.UTC 로
 * 정오도 자정도 아닌 순수 UTC 자정을 만들어 하루(86400000ms)씩 빼기만 합니다.
 * 서머타임도 로컬 시간대도 개입하지 않습니다.
 * 금지된 것은 new Date() 로 "오늘"을 만드는 쪽이지 날짜 산술이 아닙니다.
 */
function shiftDate(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map((part) => Number.parseInt(part, 10))
  const ms = Date.UTC(y, m - 1, d) + days * 86_400_000
  return new Date(ms).toISOString().slice(0, 10)
}

/** 문자열의 "글자 수". PG char_length 와 맞추려면 code point 단위여야 합니다. */
export function codePointLength(value: string): number {
  return Array.from(value).length
}

/** 스트릭을 계산할 최대 과거 일수. 3~6명 앱이라 이 정도면 충분합니다. */
export const STREAK_WINDOW_DAYS = 120

/* ==========================================================================
 * 기본 조회
 * ======================================================================== */

/** 로그인한 사용자 id. 없으면 null. getSession() 은 검증을 안 하므로 쓰지 않습니다. */
export async function getSessionUserId(): Promise<string | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.auth.getUser()
  if (error || !data.user) return null
  return data.user.id
}

/**
 * 내 로컬 오늘 ('YYYY-MM-DD').
 *
 * tasks.task_date 의 DEFAULT 와 같은 함수를 부르므로, 여기서 얻은 날짜는
 * "방금 INSERT 한 행의 task_date" 와 반드시 일치합니다. JS 로 만들면 어긋납니다.
 */
export async function getLocalToday(): Promise<string> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('current_user_local_date')

  if (error || typeof data !== 'string') {
    // 폴백. 이 값으로 INSERT 하지는 않습니다(task_date 를 아예 안 보내니까).
    // 조회 필터로만 쓰이므로 최악의 경우 "오늘 목록이 잠깐 비어 보임"입니다.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date())
  }

  return data
}

/**
 * 내가 속한 그룹 목록 (가입 순).
 *
 * group_members 와 groups 를 각각 한 번씩, 총 2회 질의합니다. 멤버 수와
 * 무관한 상수 횟수라 N+1 이 아닙니다. 임베드(`groups(...)`) 대신 나눠 부르는
 * 이유는 groups 의 컬럼 단위 GRANT(invite_code 제외)와 임베드 타입 추론이
 * 얽혔을 때 진단이 어렵기 때문입니다.
 */
export async function getMyGroups(
  userId: string
): Promise<{ groups: MyGroup[]; error: string | null }> {
  const supabase = await createClient()

  const { data: memberships, error: memberError } = await supabase
    .from('group_members')
    .select('group_id, role, joined_at')
    .eq('user_id', userId)
    .order('joined_at', { ascending: true })

  if (memberError) {
    return { groups: [], error: toKoreanDbError(memberError, '그룹 목록을 불러오지 못했습니다.') }
  }
  if (!memberships || memberships.length === 0) {
    return { groups: [], error: null }
  }

  const ids = memberships.map((m) => m.group_id)

  // ★ select('*') 금지 ★ invite_code 는 authenticated 에게 컬럼 권한이 없습니다.
  const { data: groupRows, error: groupError } = await supabase
    .from('groups')
    .select('id, name')
    .in('id', ids)

  if (groupError) {
    return { groups: [], error: toKoreanDbError(groupError, '그룹 정보를 불러오지 못했습니다.') }
  }

  const nameById = new Map((groupRows ?? []).map((g) => [g.id, g.name]))

  const groups: MyGroup[] = memberships
    .filter((m) => nameById.has(m.group_id))
    .map((m) => ({
      id: m.group_id,
      name: nameById.get(m.group_id) as string,
      role: m.role,
      joined_at: m.joined_at,
    }))

  return { groups, error: null }
}

/**
 * 오늘 내 할 일 목록.
 *
 * 여러 그룹에 속해 있어도 "오늘 내가 적은 것 전부"를 돌려줍니다. 화면에서
 * 그룹별로 나누고 싶으면 group_id 로 거르세요.
 */
export async function getMyTodayTasks(
  userId: string,
  today: string
): Promise<{ tasks: TodayTask[]; error: string | null }> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('tasks')
    .select('id, group_id, title, sort_order, done_at, task_date')
    .eq('user_id', userId)
    .eq('task_date', today)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })

  if (error) {
    return { tasks: [], error: toKoreanDbError(error, '할 일을 불러오지 못했습니다.') }
  }

  return { tasks: data ?? [], error: null }
}

/**
 * 그룹원 전원의 오늘 요약.
 *
 * 질의 2회 (멤버+프로필, 오늘의 tasks). 멤버 수에 비례해 늘지 않습니다.
 *   - group_members : 0002 의 group_members_select_same_group 로 같은 그룹만 보임
 *   - profiles      : 0002 의 profiles_select_self_or_groupmate 로 그룹 동료만 보임
 *                     ★ 컬럼 나열 필수 ★ (0003 에서 SELECT 가 컬럼 단위로 축소됨)
 *   - tasks         : 0002 의 tasks_select_group_members 가 같은 그룹 멤버의 행을
 *                     허용하므로 group_id + task_date 한 방으로 전부 가져옵니다.
 */
export async function getGroupTodayStatus(
  groupId: string,
  today: string,
  currentUserId: string
): Promise<{ members: MemberTodayStatus[]; error: string | null }> {
  const supabase = await createClient()

  const { data: members, error: memberError } = await supabase
    .from('group_members')
    .select('user_id, role')
    .eq('group_id', groupId)

  if (memberError) {
    return { members: [], error: toKoreanDbError(memberError, '그룹원을 불러오지 못했습니다.') }
  }
  if (!members || members.length === 0) {
    return { members: [], error: null }
  }

  const userIds = members.map((m) => m.user_id)

  const { data: profiles, error: profileError } = await supabase
    .from('profiles')
    .select('id, display_name, avatar_emoji')
    .in('id', userIds)

  if (profileError) {
    return { members: [], error: toKoreanDbError(profileError, '프로필을 불러오지 못했습니다.') }
  }

  const { data: taskRows, error: taskError } = await supabase
    .from('tasks')
    .select('user_id, done_at')
    .eq('group_id', groupId)
    .eq('task_date', today)

  if (taskError) {
    return { members: [], error: toKoreanDbError(taskError, '진행 상황을 불러오지 못했습니다.') }
  }

  const tally = new Map<string, { total: number; done: number }>()
  for (const row of taskRows ?? []) {
    const bucket = tally.get(row.user_id) ?? { total: 0, done: 0 }
    bucket.total += 1
    if (row.done_at !== null) bucket.done += 1
    tally.set(row.user_id, bucket)
  }

  const profileById = new Map((profiles ?? []).map((p) => [p.id, p]))

  const result: MemberTodayStatus[] = members.map((m) => {
    const profile = profileById.get(m.user_id)
    const counts = tally.get(m.user_id) ?? { total: 0, done: 0 }
    return {
      userId: m.user_id,
      // 프로필이 안 보이는 경우(가입 트리거가 실패한 계정)도 정직하게 표시합니다.
      displayName: profile?.display_name ?? '알 수 없는 친구',
      avatarEmoji: profile?.avatar_emoji ?? '🙂',
      role: m.role,
      total: counts.total,
      done: counts.done,
      isMe: m.user_id === currentUserId,
    }
  })

  // 완료율 내림차순 → 완료 개수 내림차순 → 이름순. 본인을 위로 올리지는 않습니다
  // (다 같이 보는 화면이라 순위가 뒤섞이면 오히려 읽기 어렵습니다).
  result.sort((a, b) => {
    const ra = a.total === 0 ? -1 : a.done / a.total
    const rb = b.total === 0 ? -1 : b.done / b.total
    if (rb !== ra) return rb - ra
    if (b.done !== a.done) return b.done - a.done
    return a.displayName.localeCompare(b.displayName, 'ko')
  })

  return { members: result, error: null }
}

/* ==========================================================================
 * 스트릭
 * ======================================================================== */

/**
 * 연속 완료 일수.
 *
 * ── 정의 (경계를 여기서 못 박습니다) ─────────────────────────────────────
 * "완료한 날" = 그날 task_date 로 적은 할 일이 1개 이상이고, 그 전부가
 *               done_at is not null 인 날.
 *
 * 1) 오늘이 "완료한 날"이면 오늘부터 세기 시작합니다.
 * 2) 오늘이 아직 미완료이거나 오늘 적은 할 일이 0개면, 오늘은 세지 않고
 *    어제부터 셉니다. ★ 오늘 때문에 스트릭이 0으로 떨어지면 안 됩니다 ★
 *    (아침 9시에 앱을 열었더니 어제까지 12일이 0일이 되어 있는 것이
 *     이 기능을 죽이는 가장 확실한 방법입니다.)
 * 3) 할 일을 하나도 안 적은 과거의 날은 스트릭을 끊습니다. "적지 않은 날"과
 *    "적고 다 못 한 날"을 구분하지 않습니다 — 둘 다 그날은 실패입니다.
 *    (예외는 오직 오늘뿐이고, 그 이유는 2번입니다.)
 * 4) 조회 창은 STREAK_WINDOW_DAYS 일입니다. 그보다 긴 연속 기록은 창 끝에서
 *    잘려 최대 그 값으로 보고됩니다. 캐시 테이블은 만들지 않습니다.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 그룹은 구분하지 않습니다. 여러 그룹에 적은 할 일도 "그날의 내 할 일"입니다.
 */
export function calcStreak(
  rows: { task_date: string; done_at: string | null }[],
  today: string
): number {
  // 날짜별 (총 개수, 완료 개수)
  const byDate = new Map<string, { total: number; done: number }>()
  for (const row of rows) {
    const bucket = byDate.get(row.task_date) ?? { total: 0, done: 0 }
    bucket.total += 1
    if (row.done_at !== null) bucket.done += 1
    byDate.set(row.task_date, bucket)
  }

  const isComplete = (date: string): boolean => {
    const bucket = byDate.get(date)
    return bucket !== undefined && bucket.total > 0 && bucket.done === bucket.total
  }

  // 규칙 1·2: 오늘이 완료면 오늘부터, 아니면 어제부터.
  let cursor = isComplete(today) ? today : shiftDate(today, -1)
  let streak = 0

  while (streak < STREAK_WINDOW_DAYS && isComplete(cursor)) {
    streak += 1
    cursor = shiftDate(cursor, -1)
  }

  return streak
}

/** 스트릭 계산에 필요한 최소 컬럼만 긁어와 calcStreak 에 넘깁니다. */
export async function getMyStreak(
  userId: string,
  today: string
): Promise<{ streak: number; error: string | null }> {
  const supabase = await createClient()

  const from = shiftDate(today, -STREAK_WINDOW_DAYS)

  const { data, error } = await supabase
    .from('tasks')
    .select('task_date, done_at')
    .eq('user_id', userId)
    .gte('task_date', from)
    .lte('task_date', today)

  if (error) {
    return { streak: 0, error: toKoreanDbError(error, '연속 기록을 불러오지 못했습니다.') }
  }

  return { streak: calcStreak(data ?? [], today), error: null }
}

/* ==========================================================================
 * 페이지 로더 (Server Component 가 부르는 진입점)
 *
 * 절대 throw 하지 않습니다. error 가 문자열이면 그대로 화면에 보여 주세요.
 * ======================================================================== */

/** / (오늘) 화면 데이터. */
export async function getTodayPageData(
  preferredGroupId?: string
): Promise<TodayPageData> {
  const empty: TodayPageData = {
    error: null,
    userId: null,
    today: '',
    groups: [],
    activeGroup: null,
    tasks: [],
    streak: 0,
  }

  const userId = await getSessionUserId()
  if (!userId) {
    return { ...empty, error: '로그인이 필요합니다.' }
  }

  const today = await getLocalToday()

  const [{ groups, error: groupError }, tasksResult, streakResult] = await Promise.all([
    getMyGroups(userId),
    getMyTodayTasks(userId, today),
    getMyStreak(userId, today),
  ])

  const activeGroup =
    groups.find((g) => g.id === preferredGroupId) ?? groups[0] ?? null

  return {
    error: groupError ?? tasksResult.error ?? streakResult.error,
    userId,
    today,
    groups,
    activeGroup,
    tasks: tasksResult.tasks,
    streak: streakResult.streak,
  }
}

/** /status (현황) 화면 데이터. */
export async function getStatusPageData(
  preferredGroupId?: string
): Promise<StatusPageData> {
  const empty: StatusPageData = {
    error: null,
    userId: null,
    today: '',
    groups: [],
    activeGroup: null,
    members: [],
  }

  const userId = await getSessionUserId()
  if (!userId) {
    return { ...empty, error: '로그인이 필요합니다.' }
  }

  // 이 둘은 서로 의존하지 않는다. 순차로 await 하면 화면이 뜨기까지
  // 왕복이 한 번 더 늘어난다 (탭 전환 때 체감되는 지연).
  const [today, { groups, error: groupError }] = await Promise.all([
    getLocalToday(),
    getMyGroups(userId),
  ])

  if (groupError) {
    return { ...empty, userId, today, error: groupError }
  }

  const activeGroup =
    groups.find((g) => g.id === preferredGroupId) ?? groups[0] ?? null

  if (!activeGroup) {
    return { ...empty, userId, today, groups, activeGroup: null }
  }

  const { members, error } = await getGroupTodayStatus(activeGroup.id, today, userId)

  return { error, userId, today, groups, activeGroup, members }
}
