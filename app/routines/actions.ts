'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import type { PostgrestError } from '@supabase/supabase-js'

import { fetchRoutineAssignees } from '@/lib/routines'
import { createClient } from '@/lib/supabase/server'

/**
 * app/routines/actions.ts — 루틴(0011)의 쓰기 경로 전부.
 *
 * ---------------------------------------------------------------------------
 * 쓰기 문은 이 세 개뿐입니다 (0011 을 읽고 확인한 사실)
 * ---------------------------------------------------------------------------
 *   public.toggle_routine_checkin(p_routine_id uuid)
 *       -> returns table (checked boolean, done integer, target integer)
 *   public.upsert_routine(p_id, p_group_id, p_title, p_period, p_target_count, p_active)
 *       -> returns uuid   (조용히 무시되면 NULL)
 *   public.set_routine_assignees(p_routine_id uuid, p_user_ids uuid[])
 *       -> returns void   (전체 교체)
 *
 * routines / routine_assignments / routine_checkins 에는 authenticated 의
 * INSERT·UPDATE·DELETE **권한 자체가 없습니다**(0011 ⑤). 그래서 여기에
 * `.from(...).insert(...)` 같은 코드는 한 줄도 없고, 있어서도 안 됩니다.
 *
 * ---------------------------------------------------------------------------
 * 거절이 예외가 아니라 값이라는 것 (프로젝트 함정 6·8, 0011 ⑦ 머리말)
 * ---------------------------------------------------------------------------
 * · toggle_routine_checkin 은 없는/비활성/미배정/나간 그룹의 루틴에 대해
 *   예외가 아니라 **0행**을 돌려줍니다. 배열이 비면 아무 일도 일어나지
 *   않은 것이므로 화면에 그렇게 말해야 합니다 — 조용한 성공 금지(규칙 4).
 * · upsert_routine 은 관리자가 아니거나 그 그룹 멤버가 아니면 **NULL** 입니다.
 * · set_routine_assignees 는 returns void 라 성공 여부를 알 방법이 없습니다.
 *   그래서 호출 뒤 routine_assignments 를 **다시 읽어** 요청한 집합과 비교하고,
 *   다르면 그 사실을 그대로 알립니다(함정 2).
 *
 * 정상 경로는 애초에 버튼을 안 보여 주는 것입니다. /routines 는
 * get_my_routines 가 준 것만 그리고, /routines/admin 은 am_i_admin() 이
 * true 일 때만 편집 UI 를 렌더합니다. 아래 코드들이 다루는 것은 그 화면을
 * 우회했거나, 목록을 띄운 뒤 상태가 바뀐 경우입니다.
 *
 * ---------------------------------------------------------------------------
 * 왜 전부 <form action={...}> + redirect 인가
 * ---------------------------------------------------------------------------
 * app/templates/actions.ts 가 세운 관례 그대로입니다. 두 화면 다 Server
 * Component 로 남고, 결과는 새로고침할 수 있는 URL(`?ok=` / `?err=`)이 되며,
 * <Button> 과 <TaskCheckbox> 는 useFormStatus() 로 정직한 pending 상태를
 * 공짜로 얻습니다. 낙관적 토글은 쓰지 않습니다 — DB 가 조용히 0행을 돌려줄 수
 * 있는 자리에서 낙관적 갱신은 "눌렀는데 안 바뀐다" 를 "눌러서 바뀐 것처럼
 * 보이다가 되돌아간다" 로 바꿀 뿐입니다.
 *
 * ---------------------------------------------------------------------------
 * 왜 RPC 호출이 캐스트인가
 * ---------------------------------------------------------------------------
 * lib/supabase/types.ts 는 이 기능이 소유한 파일이 아니고 0011 의 함수가
 * 아직 없습니다. app/status/default-group-actions.ts 가 같은 이유로 같은
 * 처방을 씁니다: 부르는 함수 하나, 인자, 읽는 필드만 손으로 좁게 적습니다.
 */

/* ==========================================================================
 * 알림 코드
 *
 * 한국어 문구는 여기 두지 않습니다 — 'use server' 파일은 async 함수 외의 값
 * export 를 허용하지 않습니다. 대신 유니온을 type-only 로 내보내면(빌드 시
 * 지워집니다) 각 페이지가 그 유니온을 Record 의 키로 받습니다. 코드를 하나
 * 추가하는 순간 문구가 생길 때까지 페이지가 타입 체크를 통과하지 못합니다.
 * ======================================================================== */

/** /routines 의 `?err=`. */
export type RoutineErrCode =
  | 'auth'
  | 'badrequest'
  | 'notdeployed'
  | 'ignored'
  | 'fail'

/** /routines/admin 의 `?ok=`. */
export type AdminOkCode = 'created' | 'updated' | 'assigned'

/** /routines/admin 의 `?err=`. */
export type AdminErrCode =
  | 'auth'
  | 'badrequest'
  | 'notadmin'
  | 'notdeployed'
  | 'invalid'
  | 'assigndiff'
  | 'fail'

/* ==========================================================================
 * 배관
 * ======================================================================== */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 루틴 제목 상한. routines_title_len_chk 와 같은 값입니다(0011 ②-a). */
const ROUTINE_TITLE_MAX = 60

/**
 * uuid 가 아니면 null.
 *
 * 아니면 Postgres 가 22P02 "invalid input syntax for type uuid" 를 돌려주는데,
 * 그건 우리가 직접 쓸 수 있는 문구보다 나쁜 메시지입니다.
 */
function uuidField(formData: FormData, name: string): string | null {
  const raw = formData.get(name)
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  return UUID_RE.test(value) ? value : null
}

function textField(formData: FormData, name: string): string {
  const raw = formData.get(name)
  return typeof raw === 'string' ? raw.trim() : ''
}

/**
 * 정수 필드. 범위 검사는 하지 않습니다 — 상한이 period 에 따라 다르고(주 7 /
 * 월 31), 그 규칙의 단일 진실은 upsert_routine 안의 한국어 예외입니다.
 * 여기서 한 벌 더 적으면 언젠가 두 규칙이 갈라집니다.
 */
function intField(formData: FormData, name: string): number | null {
  const raw = formData.get(name)
  if (typeof raw !== 'string') return null
  const value = Number(raw.trim())
  return Number.isInteger(value) ? value : null
}

/**
 * `redirect()` 는 NEXT_REDIRECT 를 throw 하므로 절대 try 안에 두지 않습니다.
 * 아래 모든 액션에서 이 함수 호출이 그 경로의 마지막 문장입니다.
 */
function backToRoutines(code: RoutineErrCode | null): never {
  // 성공은 파라미터 없이 돌아갑니다. 그래야 직전 실패의 `?err=` 배너가 사라지고,
  // 체크박스 자체가 결과를 말하게 됩니다(매번 "체크했어요" 배너를 띄우면 소음).
  redirect(code ? `/routines?err=${code}` : '/routines')
}

/** 관리자 화면은 항상 보고 있던 그룹으로 돌아갑니다. */
function backToAdmin(
  groupId: string | null,
  result: { ok?: AdminOkCode; err?: AdminErrCode },
): never {
  const params = new URLSearchParams()
  if (groupId) params.set('group', groupId)
  if (result.ok) params.set('ok', result.ok)
  if (result.err) params.set('err', result.err)
  const query = params.toString()
  redirect(query ? `/routines/admin?${query}` : '/routines/admin')
}

/**
 * PostgrestError -> AdminErrCode.
 *
 * 22023 은 upsert_routine 이 **관리자 인증을 통과한 뒤에만** 던지는 입력
 * 오류입니다(0011 ⑦ 머리말의 순서 계약). 그래서 'invalid' 로 받아 관리자에게
 * 고칠 수 있는 문구를 보여 주는 것이 맞습니다.
 */
function adminErrorCode(error: PostgrestError): AdminErrCode {
  if (error.code === '42501') return 'auth'
  if (error.code === '22023' || error.code === '23514') return 'invalid'
  if (error.code === 'PGRST202' || error.code === '42883' || error.code === '42703') {
    return 'notdeployed'
  }
  return 'fail'
}

/** 성공한 쓰기 뒤. Router Cache 가 클라이언트에 살아 있어 갱신하지 않으면
 *  소프트 내비게이션이 옛 목록을 보여 줍니다. */
function refreshRoutineViews(): void {
  revalidatePath('/routines')
  revalidatePath('/routines/admin')
}

/**
 * 로그인한 사용자 id, 없으면 null.
 *
 * getClaims() 는 JWT 서명을 검증합니다 — getSession() 은 쿠키를 그대로 돌려줄
 * 뿐이라 인가 검사가 아닙니다. 실패를 콜백이 아니라 null 로 돌려주는 이유는
 * app/templates/actions.ts 의 같은 함수 주석에 있습니다(제어 흐름 좁히기).
 */
async function getUserId(): Promise<string | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.auth.getClaims()
  const userId = data?.claims.sub
  if (error || typeof userId !== 'string' || !userId) return null
  return userId
}

/* ==========================================================================
 * 손으로 좁게 적은 RPC 모양
 * ======================================================================== */

type PgResult<T> = PromiseLike<{ data: T; error: PostgrestError | null }>

/** RETURNS TABLE 이라 배열입니다. **비어 있으면 거절된 것입니다**(0011 ⑧-a). */
type ToggleRoutineCheckinRpc = (
  fn: 'toggle_routine_checkin',
  args: { p_routine_id: string },
) => PgResult<{ checked: boolean; done: number; target: number }[] | null>

/** returns uuid. 조용히 무시되면 **NULL** 입니다(0011 ⑦-a). */
type UpsertRoutineRpc = (
  fn: 'upsert_routine',
  args: {
    p_id: string | null
    p_group_id: string
    p_title: string
    p_period: string
    p_target_count: number
    p_active: boolean
  },
) => PgResult<string | null>

/** returns void. 성공 여부를 알 수 없으니 호출 뒤 다시 읽습니다(함정 2). */
type SetRoutineAssigneesRpc = (
  fn: 'set_routine_assignees',
  args: { p_routine_id: string; p_user_ids: string[] },
) => PromiseLike<{ error: PostgrestError | null }>

/* ==========================================================================
 * ① 오늘 체크 토글 — 본인만 (/routines)
 * ======================================================================== */

/**
 * 오늘 날짜(사용자 로컬)로 체크를 켜거나 끕니다. 기대하는 필드는 하나입니다:
 *
 *   routineId  체크할 루틴 (uuid)
 *
 * ★ 대상 사용자를 보내지 않습니다 ★ toggle_routine_checkin 에는 그런 인자가
 * 아예 없고 언제나 auth.uid() 입니다. 남을 대신 체크하는 경로는 존재하지
 * 않습니다.
 *
 * ★ "오늘" 도 보내지 않습니다 ★ RPC 안에서 public.current_user_local_date()
 * 로 정합니다. 여기서 만들면 한국 시간 자정~오전 9시의 체크가 전날로
 * 기록되고 주 경계까지 밀립니다(0011 결정 3).
 *
 * 같은 날 두 번 눌러도 행이 두 개 생기지 않습니다 — 자문 잠금 +
 * unique(routine_id, user_id, checked_on) 이 DB 쪽에서 막습니다.
 */
export async function toggleRoutineCheckinAction(formData: FormData): Promise<void> {
  const routineId = uuidField(formData, 'routineId')
  if (!routineId) backToRoutines('badrequest')

  const userId = await getUserId()
  if (!userId) backToRoutines('auth')

  const supabase = await createClient()
  const rpc = supabase.rpc as unknown as ToggleRoutineCheckinRpc

  const { data, error } = await rpc('toggle_routine_checkin', { p_routine_id: routineId })

  if (error) {
    // 42501 은 이 RPC 에서 "세션이 Postgres 까지 도달하지 못했다" 뿐입니다.
    if (error.code === '42501') backToRoutines('auth')
    if (error.code === 'PGRST202' || error.code === '42883') backToRoutines('notdeployed')
    console.error('[routines] toggle_routine_checkin 실패', {
      code: error.code,
      message: error.message,
    })
    backToRoutines('fail')
  }

  // ★ 0행 = 거절 ★ 없는/비활성/미배정/나간 그룹의 루틴입니다(0011 ⑧-a).
  // 사유는 알려 주지 않습니다(규칙 8). 화면이 목록을 다시 읽으면 그 루틴은
  // 대개 사라져 있습니다 — 그게 사용자에게 가장 정확한 설명입니다.
  if (!data || data.length === 0) {
    refreshRoutineViews()
    backToRoutines('ignored')
  }

  // data[0] 의 { checked, done, target } 은 일부러 쓰지 않습니다. 화면을 그리는
  // 값은 언제나 get_my_routines 를 **다시 읽은** 결과여야 하고(함정 2), 그래야
  // 토글 직후 숫자와 새로고침 뒤 숫자가 갈라질 자리 자체가 생기지 않습니다.
  refreshRoutineViews()
  backToRoutines(null)
}

/* ==========================================================================
 * ② 루틴 만들기 / 수정 — 관리자만 (/routines/admin)
 * ======================================================================== */

/**
 * upsert_routine 한 번. `routineId` 가 있으면 수정, 없으면 생성입니다.
 *
 * 기대하는 필드:
 *   groupId      루틴이 속한 그룹 (uuid, 필수)
 *   routineId    수정할 루틴 (uuid). 없으면 생성
 *   title        제목
 *   period       'week' | 'month'
 *   targetCount  목표 횟수
 *   active       '1' | '0'
 *
 * period 와 targetCount 의 유효성은 DB 가 판정합니다 — 상한이 주기에 따라
 * 다르고(주 1~7 / 월 1~31), 그 규칙은 CHECK 제약과 RPC 안의 한국어 예외
 * 두 겹으로 이미 존재합니다. 여기서 세 번째 사본을 만들지 않습니다.
 */
async function upsertRoutine(formData: FormData, isCreate: boolean): Promise<void> {
  const groupId = uuidField(formData, 'groupId')
  if (!groupId) backToAdmin(null, { err: 'badrequest' })

  const routineId = isCreate ? null : uuidField(formData, 'routineId')
  if (!isCreate && !routineId) backToAdmin(groupId, { err: 'badrequest' })

  const title = textField(formData, 'title')
  if (!title) backToAdmin(groupId, { err: 'invalid' })

  const period = textField(formData, 'period')
  if (period !== 'week' && period !== 'month') backToAdmin(groupId, { err: 'badrequest' })

  const targetCount = intField(formData, 'targetCount')
  if (targetCount === null) backToAdmin(groupId, { err: 'invalid' })

  const userId = await getUserId()
  if (!userId) backToAdmin(groupId, { err: 'auth' })

  const supabase = await createClient()
  const rpc = supabase.rpc as unknown as UpsertRoutineRpc

  const { data, error } = await rpc('upsert_routine', {
    p_id: routineId,
    p_group_id: groupId,
    // 60자 상한은 DB 가 left(...) 로 자르지만, 잘린 줄도 모르게 저장되는 것보다
    // 화면 쪽에서도 같은 상한을 걸어 두는 편이 낫습니다(maxLength 와 같은 값).
    p_title: title.slice(0, ROUTINE_TITLE_MAX),
    p_period: period,
    p_target_count: targetCount,
    p_active: formData.get('active') !== '0',
  })

  if (error) backToAdmin(groupId, { err: adminErrorCode(error) })

  // ★ NULL = 조용히 무시됨 ★ 관리자가 아니거나, 그 그룹의 멤버가 아니거나,
  // 수정하려는 루틴이 그 그룹의 것이 아닙니다(0011 ⑦-a). 어느 쪽인지는
  // 알려 주지 않습니다 — 알려 주면 루틴 id 를 훑어 실재 여부를 알 수 있습니다.
  if (!data) backToAdmin(groupId, { err: 'notadmin' })

  refreshRoutineViews()
  backToAdmin(groupId, { ok: isCreate ? 'created' : 'updated' })
}

/** 새 루틴. p_id 는 언제나 null 입니다. */
export async function createRoutineAction(formData: FormData): Promise<void> {
  await upsertRoutine(formData, true)
}

/**
 * 기존 루틴 수정. 켜기/끄기도 이 경로입니다 — DELETE 는 만들지 않습니다.
 * routine_checkins 의 FK 가 on delete cascade 라, 루틴을 지우면 사용자가 몇 달에
 * 걸쳐 쌓은 체크 기록이 함께 사라집니다(0011 ②-a). "그만할래" 는 active=false 고,
 * 그러면 목록에서만 빠지고 기록은 남습니다.
 */
export async function updateRoutineAction(formData: FormData): Promise<void> {
  await upsertRoutine(formData, false)
}

/* ==========================================================================
 * ③ 배정 — 관리자만 (/routines/admin)
 * ======================================================================== */

/**
 * 배정 **전체 교체**. 체크된 사람만 남고 나머지는 해제됩니다.
 *
 * 기대하는 필드:
 *   groupId    돌아갈 그룹 (uuid)
 *   routineId  대상 루틴 (uuid)
 *   userId     체크된 그룹원 (uuid, 0개 이상 — 0개면 전원 해제)
 *
 * 전원 해제는 정상 입력입니다(0011 ⑦-b). 해제해도 routine_checkins 는 남습니다.
 *
 * ★ 호출 뒤 다시 읽습니다 ★ set_routine_assignees 는 returns void 라 성공을
 * 알 수 없고, 관리자가 아니면 조용히 무동작이며, 그룹 멤버가 아닌 uuid 는
 * 조용히 빠집니다. 그래서 실제 배정을 읽어 요청과 비교하고, 다르면 그 사실을
 * 알립니다 — 화면이 그리는 값은 어차피 이 재조회 이후의 진짜 DB 상태입니다.
 */
export async function setRoutineAssigneesAction(formData: FormData): Promise<void> {
  const groupId = uuidField(formData, 'groupId')
  if (!groupId) backToAdmin(null, { err: 'badrequest' })

  const routineId = uuidField(formData, 'routineId')
  if (!routineId) backToAdmin(groupId, { err: 'badrequest' })

  // 체크박스는 체크된 것만 전송됩니다. 하나도 없으면 빈 배열 = 전원 해제.
  const requested = new Set(
    formData
      .getAll('userId')
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim())
      .filter((v) => UUID_RE.test(v)),
  )

  const userId = await getUserId()
  if (!userId) backToAdmin(groupId, { err: 'auth' })

  const supabase = await createClient()
  const rpc = supabase.rpc as unknown as SetRoutineAssigneesRpc

  const { error } = await rpc('set_routine_assignees', {
    p_routine_id: routineId,
    p_user_ids: [...requested],
  })

  if (error) backToAdmin(groupId, { err: adminErrorCode(error) })

  refreshRoutineViews()

  // 실제로 저장된 배정을 읽어 확인합니다(위 주석). 재조회 자체가 실패하면
  // 쓰기의 성공 여부를 모르는 것이므로 "달라졌을 수 있다" 쪽으로 보고합니다.
  const { userIds, error: readError } = await fetchRoutineAssignees(routineId)
  if (readError) backToAdmin(groupId, { err: 'assigndiff' })

  const stored = new Set(userIds)
  const same =
    stored.size === requested.size && [...requested].every((id) => stored.has(id))

  backToAdmin(groupId, same ? { ok: 'assigned' } : { err: 'assigndiff' })
}
