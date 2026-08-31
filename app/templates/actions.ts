'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { createClient } from '@/lib/supabase/server'
import { TASK_TITLE_MAX, codePointLength } from '@/lib/tasks'
import type { Weekday } from '@/lib/supabase/types'

/**
 * app/templates/actions.ts — 반복 할 일(템플릿) 쓰기 경로 + "오늘 채우기" 2종.
 *
 * ---------------------------------------------------------------------------
 * 왜 전부 <form action={...}> + redirect 인가 (useActionState 아님)
 * ---------------------------------------------------------------------------
 * app/groups/manage-actions.ts 가 세운 관례를 그대로 따릅니다. /templates 에는
 * 낙관적 목록도 컨트롤드 입력도 없습니다. 그래서 페이지 전체가 Server Component
 * 로 남고, 요일 칩은 순수 <input type="checkbox"> 라 자바스크립트가 아직 안 붙은
 * 첫 페인트에서도 동작합니다. 대신 액션이 값을 되돌려 줄 방법이 없으므로 모든
 * 액션은 짧은 코드를 실은 redirect 로 끝나고, 화면이 그 코드를 한국어로 렌더링
 * 합니다. 결과가 "새로고침할 수 있는 URL" 이 되고, 어떤 실패도 조용히 삼켜지지
 * 않습니다.
 *
 * ---------------------------------------------------------------------------
 * 이 파일이 하지 않는 일 (0004_templates.sql 을 읽고 결정한 것들)
 * ---------------------------------------------------------------------------
 * 1. ★ 오늘 날짜도, 오늘 요일도 계산하지 않습니다 ★
 *    apply_today_templates 안에서 public.current_user_local_date() 로 판정합니다.
 *    여기서 요일을 계산해 인자로 넘기는 순간, 서버가 UTC 라 한국 시간 00~09시에
 *    "어제 요일" 템플릿이 들어옵니다. copy_tasks_from 도 마찬가지로 "오늘/미래
 *    거부" 판정을 DB 가 합니다.
 *
 * 2. task_date 도 template_id 도 보내지 않습니다.
 *    task_date 는 컬럼 DEFAULT 가 이겨야 하고(0001), template_id 는 애초에
 *    authenticated 에게 INSERT/UPDATE 컬럼 권한이 없습니다(0004 §7).
 *
 * 3. 중복 방지를 세지 않습니다.
 *    "오늘 이미 들어온 템플릿인가" 는 부분 유니크 인덱스
 *    tasks_user_date_template_uidx 가 판정하고, RPC 가 on conflict do nothing
 *    으로 skipped 에 집계합니다. 여기서 count-then-insert 를 하면 READ COMMITTED
 *    에서 연타 두 번이 둘 다 통과합니다.
 *
 * 4. sort_order 를 보내지 않습니다. 새 템플릿은 DEFAULT 0 이고 목록은
 *    (sort_order, created_at) 순이라 만든 순서대로 쌓입니다.
 *
 * 5. UPDATE / DELETE 는 .select('id') 로 영향 행을 확인합니다. RLS 는 행을
 *    막을 때 예외가 아니라 0행을 돌려주므로, 확인하지 않으면 "조용한 성공" 이
 *    됩니다.
 */

/* ==========================================================================
 * 알림 코드
 *
 * 한국어 문구는 여기 두지 않습니다. 'use server' 파일은 async 함수 외의 값
 * export 를 허용하지 않아서 룩업 테이블을 둘 수 없고, 대신 아래 유니온을
 * type-only 로 내보내면(빌드 시 지워집니다) 페이지가 그 유니온을 Record 의
 * 키로 받습니다 — 코드를 하나 추가하는 순간 문구가 생길 때까지 페이지가
 * 타입 체크를 통과하지 못합니다.
 * ======================================================================== */

export type TemplatesOkCode =
  /** 새 템플릿을 만들었다. */
  | 'created'
  /** 제목/요일/그룹을 저장했다. */
  | 'updated'
  /** 템플릿을 지웠다. */
  | 'deleted'
  /** active = true 로 켰다. */
  | 'enabled'
  /** active = false 로 껐다. */
  | 'disabled'

export type TemplatesErrCode =
  /** 검증된 세션이 Postgres 까지 닿지 않았다. */
  | 'auth'
  /** 폼이 쓸 수 있는 uuid 를 안 실어 왔다. 사용자 잘못이 아니라 이쪽 버그다. */
  | 'badrequest'
  /** 제목이 비었다. */
  | 'title'
  /** 제목이 200자(코드 포인트)를 넘었다. 23514 도 여기로 접는다. */
  | 'titlelong'
  /** 요일을 하나도 안 골랐다. 22023 도 여기로 접는다. */
  | 'weekday'
  /** 그룹이 하나도 없다 — 템플릿을 넣을 곳이 없다. */
  | 'nogroup'
  /** 42501. 세션은 멀쩡하므로 "가입하지 않은 그룹" 이다. */
  | 'notmember'
  /** UPDATE/DELETE 가 0행. 이미 지워졌거나 내 것이 아니다. */
  | 'notfound'
  /** PGRST202/PGRST205/42P01 — 0004 마이그레이션이 아직 서버에 없다. */
  | 'notdeployed'
  /** 그 밖의 전부. */
  | 'fail'

/** "오늘 채우기" 두 버튼이 성공했을 때 어느 쪽이었는지. */
export type FillKind =
  /** apply_today_templates */
  | 'applied'
  /** copy_tasks_from */
  | 'copied'

export type FillErrCode = 'auth' | 'badrequest' | 'notdeployed' | 'fail'

/* ==========================================================================
 * 배관
 * ======================================================================== */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function uuidField(formData: FormData, name: string): string | null {
  const raw = formData.get(name)
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  // uuid 가 아닌 값을 그대로 보내면 22P02 "invalid input syntax" 가 돌아오는데,
  // 그건 우리가 직접 쓸 수 있는 문장보다 나쁩니다.
  return UUID_RE.test(value) ? value : null
}

/**
 * 돌아갈 화면.
 *
 * ★ 폼이 실어 온 문자열을 그대로 redirect 에 넣지 않습니다 ★ 허용 목록에
 * 없으면 /templates 로 보냅니다. 이 필드는 사용자가 만질 수 있고, 열린
 * 리다이렉트는 폼 하나로 생깁니다.
 */
function safeFrom(formData: FormData): '/' | '/templates' {
  return formData.get('from') === '/' ? '/' : '/templates'
}

/**
 * `redirect()` 는 NEXT_REDIRECT 를 throw 하므로 절대 try 안에 두지 않습니다.
 * 아래 모든 액션에서 이 함수 호출이 그 경로의 마지막 문장입니다.
 */
function back(path: string, query: string): never {
  redirect(`${path}?${query}`)
}

function fail(code: TemplatesErrCode): never {
  back('/templates', `err=${code}`)
}

/** 성공한 쓰기 뒤에 영향받는 화면을 전부 갱신합니다. Router Cache 는 클라이언트에
 *  살아 있어서, 갱신하지 않으면 소프트 내비게이션이 옛 목록을 보여 줍니다. */
function refreshTemplateViews(): void {
  revalidatePath('/templates')
  // 홈의 "불러오기" 버튼은 "적용 가능한 템플릿이 몇 개인가" 를 보고 나타납니다.
  revalidatePath('/')
}

/** 할 일이 실제로 생긴 뒤. /status 는 같은 tasks 행을 다른 각도로 봅니다. */
function refreshTaskViews(): void {
  revalidatePath('/')
  revalidatePath('/status')
  revalidatePath('/history')
  revalidatePath('/templates')
}

/**
 * 로그인한 사용자 id, 없으면 null.
 *
 * getClaims() 는 JWT 서명을 검증합니다 — getSession() 은 쿠키를 그대로 되돌려
 * 줄 뿐이라 인가 검사가 아닙니다.
 *
 * 실패 처리를 콜백으로 받지 않고 null 을 돌려주는 이유: `() => never` 인자를
 * 호출해도 TypeScript 의 제어 흐름 분석은 그 뒤를 unreachable 로 좁혀 주지
 * 않습니다(그 규칙은 const/함수 선언에만 적용됩니다). 호출부에서 `if (!userId)
 * fail('auth')` 로 함수 선언인 fail() 을 부르면 그때는 제대로 좁혀집니다.
 */
async function getUserId(): Promise<string | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.auth.getClaims()
  const userId = data?.claims.sub
  if (error || typeof userId !== 'string' || !userId) return null
  return userId
}

/** 마이그레이션이 아직 안 올라간 상태를 다른 실패와 구분합니다. */
function isNotDeployed(code: string | undefined): boolean {
  // PGRST202 = 함수 없음, PGRST205 = 테이블이 스키마 캐시에 없음, 42P01 = 테이블 없음.
  return code === 'PGRST202' || code === 'PGRST205' || code === '42P01'
}

/** 세션이 멀쩡하다는 전제 하에 Postgres 오류 코드를 알림 코드로. */
function classify(code: string | undefined): TemplatesErrCode {
  if (isNotDeployed(code)) return 'notdeployed'
  switch (code) {
    case '42501':
      // 세션은 위에서 이미 확인했으므로, 남는 원인은 정책의 WITH CHECK
      // (private.is_group_member) 이거나 그룹 이동 가드 트리거입니다.
      return 'notmember'
    case '23514':
      // task_templates_title_len_chk / sort_order_range_chk.
      return 'titlelong'
    case '22023':
      // normalize_task_template_weekdays 가 던지는 코드.
      return 'weekday'
    default:
      return 'fail'
  }
}

/**
 * 제목 정규화 + 검증. DB 의 `char_length(btrim(title)) between 1 and 200` 과
 * 같은 규칙입니다. JS 의 .length 는 UTF-16 코드 유닛이라 이모지를 2로 세지만
 * PG 는 코드 포인트를 셉니다 — 그래서 codePointLength 로 셉니다(23514 방지).
 */
function normalizeTitle(raw: unknown): { title: string } | { error: TemplatesErrCode } {
  if (typeof raw !== 'string') return { error: 'title' }
  const title = raw.trim()
  if (title.length === 0) return { error: 'title' }
  if (codePointLength(title) > TASK_TITLE_MAX) return { error: 'titlelong' }
  return { title }
}

/**
 * 체크박스 7개 -> smallint[].
 *
 * DB 트리거가 정렬 + 중복 제거를 다시 하지만, 여기서도 해 둡니다. 그래야
 * "체크한 순서대로 보냈는데 저장값이 다르다" 같은 착시가 없고, 무엇보다
 * **빈 배열을 서버까지 보내지 않고 여기서 잡아** 22023 대신 사람이 읽을 수 있는
 * 안내로 돌려줄 수 있습니다.
 *
 * ★ 전부 끄기는 허용하지 않습니다 ★ 어느 요일에도 안 걸리는 템플릿은 영영
 * 나타나지 않는 유령이 됩니다. 잠시 쉬려면 active 를 끄는 게 맞고, 화면도
 * 그렇게 안내합니다.
 */
function parseWeekdays(formData: FormData): Weekday[] | null {
  const seen = new Set<number>()

  for (const raw of formData.getAll('weekdays')) {
    if (typeof raw !== 'string') continue
    const value = Number.parseInt(raw, 10)
    if (!Number.isInteger(value) || value < 0 || value > 6) continue
    seen.add(value)
  }

  if (seen.size === 0) return null
  return [...seen].sort((a, b) => a - b) as Weekday[]
}

/* ==========================================================================
 * 템플릿 CRUD
 * ======================================================================== */

/**
 * 새 반복 할 일.
 *
 * 필드: groupId (필수, uuid), title (필수), weekdays (체크박스, 1개 이상)
 *
 * sort_order 는 보내지 않습니다 — DEFAULT 0 에 맡기고 목록은 created_at 으로
 * 갈립니다. user_id 는 반드시 실어 보냅니다: INSERT 정책의 WITH CHECK 이
 * auth.uid() 와 비교하므로, 남의 id 를 넣으면 그 자리에서 막힙니다.
 */
export async function createTemplateAction(formData: FormData): Promise<void> {
  const groupId = uuidField(formData, 'groupId')
  if (!groupId) fail('nogroup')

  const normalized = normalizeTitle(formData.get('title'))
  if ('error' in normalized) fail(normalized.error)

  const weekdays = parseWeekdays(formData)
  if (!weekdays) fail('weekday')

  const userId = await getUserId()
  if (!userId) fail('auth')

  const supabase = await createClient()
  const { error } = await supabase.from('task_templates').insert({
    user_id: userId,
    group_id: groupId,
    title: normalized.title,
    weekdays,
    // active 는 DEFAULT true. 만들자마자 꺼져 있으면 아무도 안 켭니다.
  })

  if (error) fail(classify(error.code))

  refreshTemplateViews()
  back('/templates', 'ok=created')
}

/**
 * 제목 · 요일 수정.
 *
 * 필드: id (필수, uuid), title (필수), weekdays (1개 이상)
 *
 * group_id 는 일부러 건드리지 않습니다. 그룹을 바꾸면 이미 그 템플릿으로 만들어진
 * 오늘 할 일과 새로 만들어질 할 일이 서로 다른 그룹에 흩어지고, 되돌릴 방법이
 * 화면에 없습니다. 그룹을 바꾸고 싶으면 지우고 다시 만드는 게 정직합니다.
 */
export async function updateTemplateAction(formData: FormData): Promise<void> {
  const id = uuidField(formData, 'id')
  if (!id) fail('badrequest')

  const normalized = normalizeTitle(formData.get('title'))
  if ('error' in normalized) fail(normalized.error)

  const weekdays = parseWeekdays(formData)
  if (!weekdays) fail('weekday')

  const userId = await getUserId()
  if (!userId) fail('auth')

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('task_templates')
    .update({ title: normalized.title, weekdays })
    .eq('id', id)
    .eq('user_id', userId) // RLS 와 별개로 한 번 더. 0행이면 아래에서 잡힙니다.
    .select('id')

  if (error) fail(classify(error.code))
  // RLS 는 남의 행을 예외가 아니라 "0행" 으로 막습니다. 확인하지 않으면
  // 아무것도 안 바뀌었는데 "저장했어요" 라고 말하게 됩니다.
  if (!data || data.length === 0) fail('notfound')

  refreshTemplateViews()
  back('/templates', 'ok=updated')
}

/**
 * 켜기 / 끄기.
 *
 * 필드: id (필수, uuid), active ('true' | 'false')
 *
 * 삭제가 아니라 이걸 권하는 이유는 0004 의 컬럼 주석 그대로입니다:
 * tasks.template_id 가 ON DELETE SET NULL 이라, 템플릿을 지우면 오늘 이미
 * 만들어진 할 일의 연결이 끊기고 같은 템플릿을 다시 만들었을 때 부분 유니크
 * 인덱스가 중복을 못 막습니다.
 */
export async function setTemplateActiveAction(formData: FormData): Promise<void> {
  const id = uuidField(formData, 'id')
  if (!id) fail('badrequest')

  const raw = formData.get('active')
  if (raw !== 'true' && raw !== 'false') fail('badrequest')
  const active = raw === 'true'

  const userId = await getUserId()
  if (!userId) fail('auth')

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('task_templates')
    .update({ active })
    .eq('id', id)
    .eq('user_id', userId)
    .select('id')

  if (error) fail(classify(error.code))
  if (!data || data.length === 0) fail('notfound')

  refreshTemplateViews()
  back('/templates', `ok=${active ? 'enabled' : 'disabled'}`)
}

/**
 * 삭제.
 *
 * 필드: id (필수, uuid)
 *
 * 이미 오늘 만들어진 할 일은 남습니다(FK 가 ON DELETE SET NULL). 그래서 화면의
 * 확인 문구가 "오늘 이미 만들어진 할 일은 그대로 남아요" 라고 먼저 말합니다.
 */
export async function deleteTemplateAction(formData: FormData): Promise<void> {
  const id = uuidField(formData, 'id')
  if (!id) fail('badrequest')

  const userId = await getUserId()
  if (!userId) fail('auth')

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('task_templates')
    .delete()
    .eq('id', id)
    .eq('user_id', userId)
    .select('id')

  if (error) fail(classify(error.code))
  if (!data || data.length === 0) fail('notfound')

  refreshTemplateViews()
  back('/templates', 'ok=deleted')
}

/* ==========================================================================
 * 오늘 채우기 (홈과 /templates 가 같이 씁니다)
 *
 * 두 액션 모두 `from` 필드로 돌아갈 화면을 정하고, 결과를 세 개의 쿼리
 * 파라미터로 싣습니다:
 *   fill    = 'applied' | 'copied'
 *   c       = created  (만들어진 개수)
 *   s       = skipped  (이미 있어서 건너뛴 개수)
 * 실패는 fillerr=<code>.
 *
 * ★ created 만 보여 주면 안 됩니다 ★ 전부 이미 있어서 0/N 이 돌아온 경우,
 * 화면이 조용하면 사용자는 버튼이 고장 났다고 생각하고 계속 누릅니다.
 * ======================================================================== */

/**
 * `returns table (created integer, skipped integer)` 는 행 집합입니다.
 * PostgREST 는 배열로 주지만, Database 타입이 어떻게 모델링되어 있느냐에 따라
 * supabase-js 가 단일 객체로 좁혀 주기도 합니다. app/status/actions.ts 의
 * firstRow() 와 같은 이유로 양쪽을 모두 정규화합니다 — 한쪽에 걸면 언젠가
 * "성공했는데 0개 라고 말하는" 버그가 됩니다.
 */
function firstFillRow(data: unknown): { created: number; skipped: number } | null {
  const row = Array.isArray(data) ? data[0] : data
  if (!row || typeof row !== 'object') return null

  const candidate = row as { created?: unknown; skipped?: unknown }
  const created = Number(candidate.created)
  const skipped = Number(candidate.skipped)

  if (!Number.isFinite(created) || !Number.isFinite(skipped)) return null

  // 음수는 있을 수 없지만, URL 에 실릴 값이라 여기서 바닥을 깝니다.
  return { created: Math.max(0, Math.trunc(created)), skipped: Math.max(0, Math.trunc(skipped)) }
}

function fillBack(from: '/' | '/templates', kind: FillKind, created: number, skipped: number): never {
  back(from, `fill=${kind}&c=${created}&s=${skipped}`)
}

function fillFail(from: '/' | '/templates', code: FillErrCode): never {
  back(from, `fillerr=${code}`)
}

/**
 * "반복 할 일 N개 불러오기" — public.apply_today_templates.
 *
 * 필드: from (선택), groupId (선택, uuid)
 *
 * groupId 는 **대상이 아니라 필터**입니다. 비우면 내가 아직 속해 있는 모든
 * 그룹의 템플릿이 대상입니다. 홈에서는 비워 보냅니다 — 홈의 "오늘 할 일" 목록도
 * 그룹을 가리지 않고 내가 오늘 적은 전부이기 때문입니다.
 *
 * 오늘이 무슨 요일인지 여기서 계산하지 않습니다(파일 상단 규칙 1).
 */
export async function applyTemplatesAction(formData: FormData): Promise<void> {
  const from = safeFrom(formData)
  const groupId = uuidField(formData, 'groupId')

  const userId = await getUserId()
  if (!userId) fillFail(from, 'auth')

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('apply_today_templates', {
    p_group_id: groupId,
  })

  if (error) {
    // 함수는 auth.uid() 가 null 일 때만 42501 을 던집니다. 쿠키는 파싱됐는데
    // JWT 가 Postgres 까지 못 간 경우이므로 인증 문제로 보고합니다.
    if (error.code === '42501') fillFail(from, 'auth')
    if (isNotDeployed(error.code)) fillFail(from, 'notdeployed')
    console.error('[templates/apply] apply_today_templates rpc failed', {
      code: error.code,
      message: error.message,
    })
    fillFail(from, 'fail')
  }

  const result = firstFillRow(data)
  if (!result) {
    console.error('[templates/apply] apply_today_templates returned an unexpected shape')
    fillFail(from, 'fail')
  }

  refreshTaskViews()
  fillBack(from, 'applied', result.created, result.skipped)
}

/**
 * "어제 것 가져오기" — public.copy_tasks_from.
 *
 * 필드: from (선택), date (필수, 'YYYY-MM-DD')
 *
 * ★ 날짜는 화면이 만들지 않습니다 ★ 홈이 넘기는 값은 DB 가 준 오늘
 * (getTodayPageData().today) 에서 하루를 뺀 것이고, 그 하루 빼기는 순수한
 * 날짜 산술입니다("지금"을 읽지 않습니다). 그리고 오늘/미래인지의 최종 판정은
 * RPC 가 자기 기준(current_user_local_date)으로 다시 합니다 — 거기서 걸리면
 * 예외가 아니라 created=0, skipped=0 이 돌아옵니다.
 */
export async function copyTasksFromAction(formData: FormData): Promise<void> {
  const from = safeFrom(formData)

  const rawDate = formData.get('date')
  const date = typeof rawDate === 'string' ? rawDate.trim() : ''
  if (!ISO_DATE_RE.test(date)) fillFail(from, 'badrequest')

  const userId = await getUserId()
  if (!userId) fillFail(from, 'auth')

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('copy_tasks_from', { p_date: date })

  if (error) {
    if (error.code === '42501') fillFail(from, 'auth')
    if (isNotDeployed(error.code)) fillFail(from, 'notdeployed')
    console.error('[templates/copy] copy_tasks_from rpc failed', {
      code: error.code,
      message: error.message,
    })
    fillFail(from, 'fail')
  }

  const result = firstFillRow(data)
  if (!result) {
    console.error('[templates/copy] copy_tasks_from returned an unexpected shape')
    fillFail(from, 'fail')
  }

  refreshTaskViews()
  fillBack(from, 'copied', result.created, result.skipped)
}
