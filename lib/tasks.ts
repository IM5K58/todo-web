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
 *
 * 5. 왕복은 세어서 관리합니다. 추측이 아니라 측정값이 근거입니다.
 *    Vercel 함수 → Supabase 왕복 1회 = 261~1431ms (대개 ~700ms). 내 PC(한국)
 *    에서 같은 DB 는 ~50ms 입니다. 차이는 무료 플랜 함수의 기본 리전이 미국
 *    이었기 때문이고 vercel.json 의 "regions": ["icn1"] 로 고정했지만, 그래도
 *    왕복 1회는 공짜가 아닙니다. 그래서 아래 두 가지를 구분해서 셉니다.
 *      · 질의 수      = Supabase 로 나가는 요청의 총 개수
 *      · 순차 왕복 수 = 서로 기다리는 "파(wave)"의 개수 = 실제 벽시계 지연
 *    병렬로 띄운 두 질의는 질의 2회지만 파는 1개입니다.
 *
 *    ┌──────────────────┬───────────────┬───────────────┐
 *    │                  │ 변경 전       │ 변경 후       │
 *    ├──────────────────┼───────────────┼───────────────┤
 *    │ getTodayPageData │ 파 4 / 질의 6 │ 파 2 / 질의 4 │
 *    │ getStatusPageData│ 파 6 / 질의 7 │ 파 4 / 질의 6 │
 *    └──────────────────┴───────────────┴───────────────┘
 *    (변경 후의 "파" 는 auth.getClaims() 가 JWKS 캐시에 적중한 경우입니다.
 *     캐시가 비어 있는 콜드 스타트에서는 각각 +1 파. 캐시는 프로세스 전역이고
 *     TTL 10분이라 따뜻한 인스턴스에서는 거의 항상 적중합니다.)
 *
 *    새 질의를 추가할 때는 "이게 앞의 결과를 정말 필요로 하는가"를 먼저 물어
 *    보세요. 아니면 Promise.all 로 같은 파에 넣으세요.
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

/**
 * 로그인한 사용자 id. 없으면 null. getSession() 은 검증을 안 하므로 쓰지 않습니다.
 *
 * ── 왕복 1회 → 0회 (따뜻한 인스턴스 기준) ────────────────────────────────
 * 예전에는 auth.getUser() 였습니다. getUser() 는 *언제나* Auth 서버로
 * GET /auth/v1/user 를 보냅니다 — 캐시가 없습니다(auth-js 2.112.4).
 *
 * getClaims() 는 JWT 서명을 WebCrypto 로 로컬 검증합니다. 검증에 필요한
 * 공개키(JWKS)는 auth-js 의 모듈 전역 GLOBAL_JWKS 에 storageKey 별로 10분
 * (JWKS_TTL) 캐시됩니다 — createClient() 가 요청마다 새 클라이언트를 만들어도
 * 캐시는 프로세스가 공유하므로, 람다가 살아 있는 동안은 네트워크가 없습니다.
 *   node_modules/@supabase/auth-js/dist/main/GoTrueClient.js:49  GLOBAL_JWKS
 *   node_modules/@supabase/auth-js/dist/main/lib/constants.js:51 JWKS_TTL = 10분
 *
 * 대칭키(HS256) 프로젝트라면 getClaims() 가 내부에서 getUser() 로 폴백하므로
 * 최악의 경우에도 예전과 정확히 같은 비용입니다. 절대 느려지지 않습니다.
 *
 * 검증 강도는 그대로입니다. getClaims() 는 서명을 실제로 검증하고(getSession()
 * 처럼 쿠키를 그대로 되돌려주지 않습니다), 이 프로젝트의 다른 모든 진입점
 * (proxy.ts, app/page.tsx, app/groups/*, app/api/*) 이 이미 getClaims() 입니다.
 * 여기만 getUser() 였습니다. 그리고 진짜 방어선은 RLS 입니다.
 */
export async function getSessionUserId(): Promise<string | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.auth.getClaims()
  if (error) return null

  const sub = data?.claims.sub
  return typeof sub === 'string' && sub.length > 0 ? sub : null
}

/**
 * 내 로컬 오늘 ('YYYY-MM-DD').
 *
 * tasks.task_date 의 DEFAULT 와 같은 함수를 부르므로, 여기서 얻은 날짜는
 * "방금 INSERT 한 행의 task_date" 와 반드시 일치합니다. JS 로 만들면 어긋납니다.
 *
 * ── 검토했고, 바꾸지 않기로 한 것: profiles.timezone + Intl 로 대체 ────────
 * "profiles.timezone 을 읽어 Intl.DateTimeFormat('en-CA', { timeZone }) 로
 * JS 에서 만들면 rpc 왕복을 없앨 수 있다"를 실제로 재보고 기각했습니다.
 *
 * (1) 왕복이 줄지 않습니다. 이 모듈은 profiles 를 읽지 않습니다. 그러니
 *     rpc 1회를 profiles SELECT 1회로 바꾸는 1:1 교환일 뿐입니다.
 *     app/page.tsx 가 profiles(display_name, avatar_emoji, timezone) 를 읽긴
 *     하지만 그건 제가 소유하지 않은 파일이고, 이미 getTodayPageData() 와
 *     Promise.all 로 *동시에* 돌고 있어서 벽시계 시간도 0 입니다.
 *     (정말로 없애려면 페이지가 읽은 timezone 을 로더 인자로 내려보내야 하고,
 *      그건 export 시그니처 변경입니다 — 금지 사항.)
 *
 * (2) 이득이 0인데 새 어긋남이 2종 생깁니다. 0001_init.sql:164~190 의
 *     current_user_local_date() 는 `(now() at time zone v_tz)::date` 입니다.
 *     a. 시계 출처가 달라집니다. now() 는 DB 서버 시계, Intl 은 Vercel 함수
 *        시계입니다. 자정 근처에서 두 시계가 몇백 ms 만 어긋나도 조회 필터와
 *        INSERT 가 쓴 DEFAULT 가 서로 다른 날짜가 됩니다. 지금은 같은 시계
 *        하나만 쓰므로 이 어긋남이 원천적으로 불가능합니다.
 *     b. 시간대 DB 출처가 달라집니다. SQL 쪽 폴백 조건은 "pg_timezone_names
 *        에 없으면 Asia/Seoul" 이고, JS 쪽 폴백 조건은 "Intl 이 RangeError 를
 *        던지면" 입니다. 같은 술어가 아닙니다. profiles_validate_timezone
 *        트리거(0001_init.sql:114~144)는 pg_timezone_names 만 보증하는데,
 *        거기에는 Intl 이 거부하는 이름('localtime', 'posix/...')이 있습니다.
 *        그런 값이 저장된 계정은 DB 는 실제 존으로, JS 는 Asia/Seoul 로
 *        계산하게 됩니다.
 *
 * 요약: 왕복 이득 0, 새 실패 모드 2. 그래서 rpc 를 유지합니다. 대신 호출부에서
 * 이 rpc 가 *다른 질의와 병렬로* 돌게 만들어 벽시계 비용을 없앴습니다
 * (getTodayPageData / getStatusPageData 주석 참고).
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
 * 질의 3회. 멤버 수에 비례해 늘지 않습니다.
 *   - group_members : 0002 의 group_members_select_same_group 로 같은 그룹만 보임
 *   - profiles      : 0002 의 profiles_select_self_or_groupmate 로 그룹 동료만 보임
 *                     ★ 컬럼 나열 필수 ★ (0003 에서 SELECT 가 컬럼 단위로 축소됨)
 *   - tasks         : 0002 의 tasks_select_group_members 가 같은 그룹 멤버의 행을
 *                     허용하므로 group_id + task_date 한 방으로 전부 가져옵니다.
 *
 * ── 순차 왕복 3회 → 2회 (질의 수는 3회 그대로) ────────────────────────────
 * tasks 질의는 인자(groupId, today)만 쓰고 members 결과에 의존하지 않습니다.
 * 예전에는 group_members → profiles → tasks 를 줄줄이 await 해서, 멀쩡히
 * 독립인 tasks 가 앞의 두 개를 기다렸습니다. 이제 tasks 를 group_members 와
 * 같이 출발시킵니다. profiles 만 userIds 때문에 뒤에 남습니다.
 * 왕복 1회가 261~1431ms 이므로 /status 가 그만큼 빨라집니다.
 *
 * 오류 우선순위는 예전과 글자 그대로 같습니다:
 *   memberError → (멤버 0명이면 빈 배열) → profileError → taskError.
 * 달라지는 것은 "멤버 질의가 실패했을 때 tasks 질의도 이미 떠 있다"는 점뿐이고,
 * 그건 버려집니다(SELECT 라 부작용 없음).
 */
export async function getGroupTodayStatus(
  groupId: string,
  today: string,
  currentUserId: string
): Promise<{ members: MemberTodayStatus[]; error: string | null }> {
  const supabase = await createClient()

  const [
    { data: members, error: memberError },
    { data: taskRows, error: taskError },
  ] = await Promise.all([
    supabase.from('group_members').select('user_id, role').eq('group_id', groupId),
    supabase
      .from('tasks')
      .select('user_id, done_at')
      .eq('group_id', groupId)
      .eq('task_date', today),
  ])

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

/**
 * 오늘 목록 + 스트릭을 질의 **1회**로.
 *
 * ── 왕복 2회 → 1회 ───────────────────────────────────────────────────────
 * getMyTodayTasks 는 `user_id = 나 AND task_date = 오늘`,
 * getMyStreak 는   `user_id = 나 AND task_date BETWEEN 오늘-120 AND 오늘`.
 * 뒤엣것이 앞엣것의 **진부분집합이 아니라 초집합**입니다. 같은 테이블, 같은
 * 정책(tasks_select_own), 같은 인덱스를 두 번 긁을 이유가 없습니다. 창 전체를
 * 한 번 가져와 메모리에서 오늘 것만 걸러냅니다.
 *
 * 두 함수를 지우지 않고 남겨 둔 이유: 둘 다 export 라 lib/history.ts 등
 * 다른 호출자가 쓸 수 있습니다. 시그니처는 건드리지 않습니다.
 *
 * 정렬 주의: sort_order, created_at 순으로 받아옵니다. 날짜로 필터해도 남은
 * 행들의 상대 순서는 보존되므로 오늘 목록의 순서는 getMyTodayTasks 와 동일합니다.
 * calcStreak 는 순서를 보지 않습니다(날짜별로 집계만 함).
 *
 * 페이로드는 늘어납니다(창 전체 행이 title/id 까지 들고 옴). 3~6명 앱의
 * 120일치라 수십 KB 수준이고, vercel.json 이 함수를 icn1 로 고정해 DB 와 같은
 * 리전이라 전송 시간보다 왕복 1회(261~1431ms)가 훨씬 비쌉니다.
 */
async function getMyTasksAndStreak(
  userId: string,
  today: string
): Promise<{ tasks: TodayTask[]; streak: number; error: string | null }> {
  const supabase = await createClient()

  const from = shiftDate(today, -STREAK_WINDOW_DAYS)

  const { data, error } = await supabase
    .from('tasks')
    .select('id, group_id, title, sort_order, done_at, task_date')
    .eq('user_id', userId)
    .gte('task_date', from)
    .lte('task_date', today)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })

  if (error) {
    return {
      tasks: [],
      streak: 0,
      error: toKoreanDbError(error, '할 일을 불러오지 못했습니다.'),
    }
  }

  const rows = data ?? []

  return {
    tasks: rows.filter((row) => row.task_date === today),
    streak: calcStreak(rows, today),
    error: null,
  }
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

  /**
   * ── 순차 왕복 4회 → 2회, 질의 6회 → 4회 ─────────────────────────────────
   * 예전 순서:
   *   1) getSessionUserId  → auth.getUser()      네트워크 1회
   *   2) await getLocalToday()                   ← 혼자 한 파를 다 잡아먹음
   *   3) [group_members, tasks, streak]
   *   4) groups            (getMyGroups 의 두 번째 질의)
   *
   * getLocalToday() 는 getMyGroups() 와 서로 아무 관계가 없는데도 앞에서
   * 통째로 기다리고 있었습니다. /status 는 이미 이 둘을 Promise.all 로 묶어
   * 뒀는데(아래) 여기만 빠져 있었습니다. 같은 모양으로 맞춥니다.
   *
   * 지금 순서:
   *   1) getSessionUserId  → auth.getClaims()    JWKS 캐시 적중 시 네트워크 0회
   *   2) [current_user_local_date rpc | group_members]
   *   3) [내 할 일 창(오늘+스트릭 한 방) | groups]
   *
   * 두 갈래가 서로를 기다리지 않는 게 핵심입니다. 그래서 `Promise.all([today,
   * groups])` 로 묶고 나서 tasks 를 부르면 안 됩니다 — 그러면 tasks 가 관계도
   * 없는 groups 질의까지 기다려서 파가 3개가 됩니다. 아래처럼 "오늘 → 내 할 일"
   * 갈래를 하나의 async 함수로 만들어 groups 갈래와 통째로 병렬시켜야
   * 2)와 3)에 각각 두 질의가 나란히 들어갑니다.
   */
  const ownTasksBranch = async () => {
    const today = await getLocalToday()
    return { today, ...(await getMyTasksAndStreak(userId, today)) }
  }

  const [{ groups, error: groupError }, own] = await Promise.all([
    getMyGroups(userId),
    ownTasksBranch(),
  ])

  const activeGroup =
    groups.find((g) => g.id === preferredGroupId) ?? groups[0] ?? null

  return {
    error: groupError ?? own.error,
    userId,
    today: own.today,
    groups,
    activeGroup,
    tasks: own.tasks,
    streak: own.streak,
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

  /**
   * 이 둘은 서로 의존하지 않는다. 순차로 await 하면 화면이 뜨기까지
   * 왕복이 한 번 더 늘어난다 (탭 전환 때 체감되는 지연).
   *
   * ── 순차 왕복 6회 → 4회, 질의 7회 → 6회 ─────────────────────────────────
   * 여기(로더)는 이미 옳게 묶여 있었다. 줄어든 건 두 군데다:
   *   - getSessionUserId 가 getUser()(항상 네트워크) → getClaims()(JWKS 캐시
   *     적중 시 네트워크 0회) 로 바뀌어 맨 앞의 한 파가 사라졌다.
   *   - getGroupTodayStatus 안에서 tasks 질의가 group_members 와 병렬이 됐다.
   *
   * 남은 파:
   *   1) [rpc | group_members]  2) [groups]
   *   3) [그룹 group_members | 그룹 tasks]  4) [profiles]
   *
   * 2)를 더 줄이려면 activeGroup 을 membership 행만으로 고르고 groups 이름
   * 조회를 화면 렌더와 겹쳐야 하는데, 그러려면 getMyGroups 의 반환 모양을
   * 바꿔야 한다. lib/history.ts 가 이 시그니처를 쓰므로 하지 않는다.
   */
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
