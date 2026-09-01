/**
 * lib/tasks-queries.ts — Supabase 조회 (서버 전용)
 *
 * ★ 이 모듈은 Server Component / Server Action 에서만 import 하세요. ★
 * createClient() 가 next/headers 의 cookies() 를 쓰므로 클라이언트 번들에
 * 들어가면 빌드가 깨집니다.
 *
 * lib/tasks.ts 에서 갈라져 나온 조각입니다. 설계 규칙 전문(select('*') 금지,
 * task_date 는 DB 가 정한다, N+1 금지, 예외 대신 값, 왕복 세기)은 lib/tasks.ts
 * 머리말에 그대로 있습니다. 새 질의를 추가하기 전에 그 5개를 먼저 읽으세요.
 *
 * 여기 있는 함수는 예외를 던지지 않습니다. 실패는 한국어 문자열로 돌아갑니다.
 */

import type { PostgrestError } from '@supabase/supabase-js'

import { resolveAvatar, type ResolvedAvatar } from '@/lib/avatar'
import { toKoreanDbError } from '@/lib/db-error'
import { STREAK_WINDOW_DAYS, calcStreak, shiftDate } from '@/lib/streak'
import { createClient } from '@/lib/supabase/server'
import type {
  MemberAvatarProfile,
  MemberTodayStatus,
  MyGroup,
  ProfilesReader,
  TodayTask,
} from '@/lib/tasks-model'

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
 * (lib/tasks-page-data.ts 의 getTodayPageData / getStatusPageData 주석 참고).
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

/* --------------------------------------------------------------------------
 * 멤버 아바타 조회 (0007) — /status 와 /groups 가 같은 배관을 씁니다
 *
 * 반환 타입(MemberAvatarProfile)과 클라이언트 최소 모양(ProfilesReader)은
 * lib/tasks-model.ts 에 있습니다. 왜 캐스트가 필요한지도 거기 적혀 있습니다.
 * ------------------------------------------------------------------------ */

/** ★ select('*') 금지 ★ profiles 는 컬럼 단위 SELECT 권한입니다(0003/0007). */
const MEMBER_PROFILE_COLUMNS = 'id, display_name, avatar_emoji, avatar_url'
/** 0007 미배포(42703) 폴백. 사진만 빠지고 나머지 화면은 그대로 삽니다. */
const MEMBER_PROFILE_COLUMNS_LEGACY = 'id, display_name, avatar_emoji'

/**
 * 여러 명의 프로필을 한 번에. avatar_url 이 없는 DB 를 만나면 한 번만 물러섭니다.
 *
 * 왕복은 평소 1회입니다. 0007 이 배포되지 않은 DB 에서만 2회가 되고, 그건
 * "사진 기능이 아직 없는 환경" 이라는 뜻이라 영구적이지 않습니다. 42703 을
 * 그냥 오류로 두면 /status 와 /groups 의 **멤버 목록 전체가** 사라지므로,
 * 여기서 삼키는 편이 정직합니다(사진만 없어지고 이름은 나옵니다).
 *
 * client 는 caller 가 이미 만든 것을 넘기세요 — 새로 만들면 쿠키를 다시 읽습니다.
 */
export async function fetchMemberProfiles(
  client: ProfilesReader,
  userIds: string[],
): Promise<{ data: MemberAvatarProfile[]; error: PostgrestError | null }> {
  if (userIds.length === 0) return { data: [], error: null }

  const first = await client.from('profiles').select(MEMBER_PROFILE_COLUMNS).in('id', userIds)
  if (!first.error) return { data: first.data ?? [], error: null }

  // 42703 = undefined_column = 0007 미배포. 그 외에는 진짜 실패입니다.
  if (first.error.code !== '42703') {
    return { data: [], error: first.error as PostgrestError }
  }

  // ★ from() 을 다시 부릅니다 ★ postgrest-js 의 쿼리 빌더는 URL 객체를 재사용해
  // 필터를 append 합니다. 같은 빌더에 .in() 을 두 번 걸면 두 번째 요청에
  // `id=in.(…)` 이 두 개 실립니다(결과는 같지만 요청이 지저분해집니다).
  const legacy = await client
    .from('profiles')
    .select(MEMBER_PROFILE_COLUMNS_LEGACY)
    .in('id', userIds)
  return {
    data: legacy.data ?? [],
    error: legacy.error ? (legacy.error as PostgrestError) : null,
  }
}

/**
 * 남의 행 1개의 아바타. **이 함수에는 userMetadata 를 받는 자리가 없습니다.**
 *
 * ⚠️⚠️ 그게 이 함수가 존재하는 유일한 이유입니다 ⚠️⚠️
 * 구글 로그인 사진은 **내 JWT 의 user_metadata** 에서만 읽힙니다. 그룹 동료의
 * auth 메타데이터를 읽을 방법은 없습니다(lib/avatar.ts 머리말). 그러니 남의
 * 행을 그리면서 `resolveAvatar({ ..., userMetadata: myClaims })` 를 부르면
 *   1) 내 구글 사진이 **친구 얼굴 자리에** 붙고,
 *   2) user_metadata 는 `auth.updateUser({ data })` 로 본인이 자유롭게 쓰는
 *      값이라, "임의 https URL" 을 그리게 만드는 구멍이 **나만 보던 것에서
 *      그룹 전원이 보는 것으로** 넓어집니다(검토 FINDING #7).
 * 남의 행은 avatar_url + avatar_emoji, 이 둘만 씁니다.
 *
 * 본인 행도 여기서는 똑같이 취급합니다. /status 는 서버 컴포넌트가 아니라
 * 이 로더가 만든 값을 그대로 그리고, "내 행에만 구글 사진" 같은 예외를 두면
 * 목록 안에서 나 혼자 다른 규칙으로 그려집니다. 내 구글 사진을 친구들에게도
 * 보이려면 마이페이지에서 저장하면 됩니다 — 그러면 avatar_url 로 들어옵니다.
 */
function memberAvatar(profile: MemberAvatarProfile | undefined): ResolvedAvatar {
  return resolveAvatar({
    avatarUrl: profile?.avatar_url ?? null,
    // ★ userMetadata 를 넘기지 마세요 ★ 위 주석 참고. 자리 자체를 비워 둡니다.
    avatarEmoji: profile?.avatar_emoji ?? null,
  })
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

  // ★ select('*') 금지 ★ 컬럼 목록과 0007 폴백은 fetchMemberProfiles 안에 있습니다.
  const { data: profiles, error: profileError } = await fetchMemberProfiles(
    supabase as unknown as ProfilesReader,
    userIds,
  )

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
      // ⚠️ 남의 행입니다. userMetadata 는 절대 넘기지 않습니다 — memberAvatar() 참고.
      avatar: memberAvatar(profile),
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
 * 스트릭 조회 (계산 규칙 자체는 lib/streak.ts)
 * ======================================================================== */

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
 *
 * ★ lib/tasks.ts 는 이 함수를 재수출하지 않습니다 ★ 쪼개기 전에도 모듈
 * 내부 함수였습니다. 유일한 호출자는 lib/tasks-page-data.ts 입니다.
 */
export async function getMyTasksAndStreak(
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
