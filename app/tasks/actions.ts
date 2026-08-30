'use server'

/**
 * app/tasks/actions.ts — 오늘 할 일 쓰기 경로 (Phase 2)
 *
 * ---------------------------------------------------------------------------
 * 이 파일이 지키는 규칙
 * ---------------------------------------------------------------------------
 * 1. ★ task_date 를 절대 보내지 않습니다 ★
 *    컬럼 DEFAULT 가 public.current_user_local_date() 입니다(0001_init.sql:463).
 *    명시값은 언제나 DEFAULT 를 이기므로, 클라이언트가 계산한 날짜를 보내는
 *    순간 01:30 KST 에 적은 할 일이 "어제"로 들어갑니다.
 *    sort_order 도 마찬가지로 DEFAULT 0 에 맡깁니다.
 *
 * 2. 제약 위반을 400 으로 새게 두지 않습니다.
 *    tasks_title_len_chk 는 char_length(btrim(title)) between 1 and 200 입니다.
 *    JS 의 .length 는 UTF-16 코드 유닛이라 이모지를 2로 세지만, PG 의
 *    char_length 는 코드 포인트를 셉니다. 그래서 Array.from().length 로
 *    서버에서 먼저 검사합니다(23514 방지).
 *
 * 3. RLS 가 남의 할 일을 막지만, 서버에서도 소유권을 한 번 더 확인합니다.
 *    RLS 위반은 0행 UPDATE 로 조용히 성공한 것처럼 보일 수 있고, 그러면
 *    낙관적 업데이트가 되돌아오지 않아 화면과 DB 가 어긋납니다.
 *
 * 4. 모든 실패는 한국어 메시지. 조용한 무시 금지.
 *    성공하면 revalidatePath 로 / 와 /status 를 갱신합니다.
 */

import { revalidatePath } from 'next/cache'

import { createClient } from '@/lib/supabase/server'
import {
  TASK_TITLE_MAX,
  codePointLength,
  getMyGroups,
  getSessionUserId,
  toKoreanDbError,
  type ActionResult,
  type AddTaskResult,
} from '@/lib/tasks'

/* ==========================================================================
 * 반환 타입은 lib/tasks.ts 에 있습니다 (ActionResult / AddTaskResult /
 * TASK_TITLE_MAX). 'use server' 파일은 async 함수 외의 export 를 허용하지
 * 않으므로 여기에 둘 수 없습니다.
 * ======================================================================== */

/* ==========================================================================
 * 내부 유틸
 * ======================================================================== */

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error }
}

/** 성공한 쓰기 뒤에 오늘/현황 두 화면을 함께 갱신합니다. 서로 링크하니까요. */
function revalidateTaskViews(): void {
  revalidatePath('/')
  revalidatePath('/status')
}

/**
 * 제목 정규화 + 검증. DB 의 btrim + char_length 와 같은 규칙입니다.
 * 반환값이 문자열이면 통과한 제목, 아니면 한국어 오류.
 */
function normalizeTitle(raw: unknown): { title: string } | { error: string } {
  if (typeof raw !== 'string') {
    return { error: '할 일 내용을 입력해 주세요.' }
  }

  const title = raw.trim()

  if (title.length === 0) {
    return { error: '할 일 내용을 입력해 주세요.' }
  }
  if (codePointLength(title) > TASK_TITLE_MAX) {
    return { error: `할 일은 ${TASK_TITLE_MAX}자까지 쓸 수 있어요.` }
  }

  return { title }
}

/**
 * 할 일의 소유자를 확인합니다.
 *
 * RLS(tasks_select_group_members)는 같은 그룹 멤버의 행도 SELECT 를 허용하므로,
 * "조회에 성공했다 = 내 것이다" 가 아닙니다. user_id 를 직접 비교해야 합니다.
 */
async function loadOwnTask(
  taskId: string,
  userId: string
): Promise<{ task: { id: string; done_at: string | null } } | { error: string }> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('tasks')
    .select('id, user_id, done_at')
    .eq('id', taskId)
    .maybeSingle()

  if (error) {
    return { error: toKoreanDbError(error, '할 일을 찾지 못했습니다.') }
  }
  if (!data) {
    return { error: '할 일을 찾을 수 없습니다. 이미 지워졌을 수 있어요.' }
  }
  if (data.user_id !== userId) {
    return { error: '내 할 일만 수정할 수 있어요.' }
  }

  return { task: { id: data.id, done_at: data.done_at } }
}

/* ==========================================================================
 * Server Actions
 * ======================================================================== */

/**
 * 오늘 할 일 추가.
 *
 * @param title    할 일 내용 (앞뒤 공백 제거 후 1~200자)
 * @param groupId  넣을 그룹. 생략하면 가장 먼저 가입한 그룹에 넣습니다.
 *
 * task_date / sort_order 는 보내지 않습니다 — DB 기본값이 이겨야 합니다.
 */
export async function addTask(
  title: string,
  groupId?: string | null
): Promise<AddTaskResult> {
  const userId = await getSessionUserId()
  if (!userId) return fail('로그인이 필요합니다.')

  const normalized = normalizeTitle(title)
  if ('error' in normalized) return fail(normalized.error)

  let targetGroupId = groupId ?? null

  if (!targetGroupId) {
    const { groups, error } = await getMyGroups(userId)
    if (error) return fail(error)
    if (groups.length === 0) {
      return fail('먼저 그룹에 참여해 주세요.')
    }
    targetGroupId = groups[0].id
  }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from('tasks')
    // ★ task_date 와 sort_order 없음 ★ (파일 상단 규칙 1)
    .insert({ user_id: userId, group_id: targetGroupId, title: normalized.title })
    .select('id, group_id, title, sort_order, done_at, task_date')
    .single()

  if (error) {
    return fail(toKoreanDbError(error, '할 일을 추가하지 못했습니다.'))
  }
  if (!data) {
    return fail('할 일을 추가하지 못했습니다.')
  }

  revalidateTaskViews()
  return { ok: true, task: data }
}

/**
 * <form action={...}> 용 얇은 래퍼. 자바스크립트가 아직 안 붙은 상태에서도
 * 추가가 되도록 두 경로를 모두 열어 둡니다.
 *
 * 필드: title (필수), groupId (선택)
 */
export async function addTaskFromForm(formData: FormData): Promise<AddTaskResult> {
  const title = formData.get('title')
  const groupId = formData.get('groupId')

  return addTask(
    typeof title === 'string' ? title : '',
    typeof groupId === 'string' && groupId.length > 0 ? groupId : null
  )
}

/**
 * 완료/미완료 토글. done_at 을 now() ↔ null 로 바꿉니다.
 *
 * @param nextDone 생략하면 현재 상태를 뒤집습니다. 낙관적 업데이트를 쓰는
 *                 화면이라면 원하는 결과 상태를 명시적으로 넘기세요.
 *                 (두 번 눌린 요청이 서로를 되돌리는 일이 없어집니다.)
 *
 * done_at 은 timestamptz(시점)이라 클라이언트 시계로 만들어도 안전합니다.
 * 시간대에 의존하는 값은 task_date 쪽이고, 그건 여기서 건드리지 않습니다.
 */
export async function toggleTask(
  taskId: string,
  nextDone?: boolean
): Promise<ActionResult> {
  const userId = await getSessionUserId()
  if (!userId) return fail('로그인이 필요합니다.')

  if (typeof taskId !== 'string' || taskId.length === 0) {
    return fail('할 일을 찾을 수 없습니다.')
  }

  const loaded = await loadOwnTask(taskId, userId)
  if ('error' in loaded) return fail(loaded.error)

  const shouldBeDone = nextDone ?? loaded.task.done_at === null
  const doneAt = shouldBeDone ? new Date().toISOString() : null

  const supabase = await createClient()

  const { data, error } = await supabase
    .from('tasks')
    .update({ done_at: doneAt })
    .eq('id', taskId)
    .eq('user_id', userId) // RLS 와 별개로 한 번 더. 0행이면 아래에서 잡힙니다.
    .select('id')

  if (error) {
    return fail(toKoreanDbError(error, '상태를 바꾸지 못했습니다.'))
  }
  if (!data || data.length === 0) {
    return fail('상태를 바꾸지 못했습니다. 화면을 새로고침해 주세요.')
  }

  revalidateTaskViews()
  return { ok: true }
}

/** 할 일 삭제. 본인 행만. */
export async function deleteTask(taskId: string): Promise<ActionResult> {
  const userId = await getSessionUserId()
  if (!userId) return fail('로그인이 필요합니다.')

  if (typeof taskId !== 'string' || taskId.length === 0) {
    return fail('할 일을 찾을 수 없습니다.')
  }

  const loaded = await loadOwnTask(taskId, userId)
  if ('error' in loaded) return fail(loaded.error)

  const supabase = await createClient()

  const { data, error } = await supabase
    .from('tasks')
    .delete()
    .eq('id', taskId)
    .eq('user_id', userId)
    .select('id')

  if (error) {
    return fail(toKoreanDbError(error, '할 일을 지우지 못했습니다.'))
  }
  if (!data || data.length === 0) {
    return fail('할 일을 지우지 못했습니다. 화면을 새로고침해 주세요.')
  }

  revalidateTaskViews()
  return { ok: true }
}

/** 할 일 제목 수정. 본인 행만. 검증 규칙은 addTask 와 동일합니다. */
export async function renameTask(
  taskId: string,
  title: string
): Promise<ActionResult> {
  const userId = await getSessionUserId()
  if (!userId) return fail('로그인이 필요합니다.')

  if (typeof taskId !== 'string' || taskId.length === 0) {
    return fail('할 일을 찾을 수 없습니다.')
  }

  const normalized = normalizeTitle(title)
  if ('error' in normalized) return fail(normalized.error)

  const loaded = await loadOwnTask(taskId, userId)
  if ('error' in loaded) return fail(loaded.error)

  const supabase = await createClient()

  const { data, error } = await supabase
    .from('tasks')
    .update({ title: normalized.title })
    .eq('id', taskId)
    .eq('user_id', userId)
    .select('id')

  if (error) {
    return fail(toKoreanDbError(error, '할 일을 수정하지 못했습니다.'))
  }
  if (!data || data.length === 0) {
    return fail('할 일을 수정하지 못했습니다. 화면을 새로고침해 주세요.')
  }

  revalidateTaskViews()
  return { ok: true }
}
