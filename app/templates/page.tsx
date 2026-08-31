import { redirect } from 'next/navigation'

import {
  Button,
  Card,
  ConfirmButton,
  EmptyState,
  ErrorText,
  Hint,
  Input,
  Label,
  LinkButton,
  PageHeader,
  SuccessText,
} from '@/components/ui'
import { createClient } from '@/lib/supabase/server'
import { TASK_TITLE_MAX, getLocalToday, getMyGroups } from '@/lib/tasks'
import type { Weekday } from '@/lib/supabase/types'

import {
  applyTemplatesAction,
  createTemplateAction,
  deleteTemplateAction,
  setTemplateActiveAction,
  updateTemplateAction,
  type FillErrCode,
  type FillKind,
  type TemplatesErrCode,
  type TemplatesOkCode,
} from './actions'

/**
 * /templates — 반복 할 일 관리.
 *
 * Server Component. 낙관적 목록도 컨트롤드 입력도 없으므로 클라이언트로
 * 내려가는 것은 components/ui.tsx 의 리프(Button / Input / ConfirmButton) 뿐이고,
 * 요일 선택은 순수 <input type="checkbox"> 라 자바스크립트가 붙기 전에도
 * 동작합니다. 액션이 값을 되돌려 줄 수 없는 대신 모든 결과가 ?ok= / ?err= /
 * ?fill= 로 URL 에 남습니다(app/groups/page.tsx 와 같은 관례).
 *
 * ---------------------------------------------------------------------------
 * 0004_templates.sql 을 읽고 확정한 것들 (기억이 아니라 SQL 이 근거)
 * ---------------------------------------------------------------------------
 * · weekdays 는 smallint[] 이고 0 = 일요일 .. 6 = 토요일 입니다. PostgreSQL 의
 *   date_part('dow', ...) 와 같은 규약이고, RPC 가 변환 없이 그대로 비교합니다.
 *   JS 의 Date#getUTCDay() 도 0=일요일이라 아래 weekdayOf() 가 그대로 맞습니다.
 * · 저장된 weekdays 는 DB 트리거가 정렬 + 중복 제거를 하므로 항상 오름차순입니다.
 *   그래서 화면은 정렬을 다시 하지 않고 그대로 씁니다.
 * · task_templates 의 SELECT 정책은 user_id = auth.uid() 입니다. tasks 와 달리
 *   ★ 같은 그룹 멤버도 남의 템플릿을 못 봅니다 ★ — 이 화면은 순전히 내 서랍입니다.
 * · SELECT 는 테이블 전체 grant 라 select('*') 도 통과하지만, 다른 조회 계층과
 *   일관되게 컬럼을 나열합니다.
 *
 * ---------------------------------------------------------------------------
 * "오늘" 을 여기서 만들지 않는 이유
 * ---------------------------------------------------------------------------
 * 아래 "오늘 채우기" 카드는 "오늘 몇 개가 적용되나" 를 미리 보여 주는데, 그
 * 요일은 rpc('current_user_local_date') 가 준 날짜 문자열에서 뽑습니다.
 * new Date() 로 만들면 01:30 KST 에 어제 요일이 나와서, 화면이 "2개" 라고 하고
 * 버튼을 누르면 다른 개수가 들어오는 상태가 됩니다. 실제 판정은 어차피 RPC 가
 * 자기 기준으로 다시 하므로, 화면이 다른 시계를 쓰면 그 차이가 그대로 거짓말이
 * 됩니다.
 */

// ---------------------------------------------------------------------------
// 요일
// ---------------------------------------------------------------------------

/** index 가 곧 DB 값입니다. 0 = 일요일. ★ 순서를 바꾸지 마세요 ★ */
const WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'] as const

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 'YYYY-MM-DD' -> 0(일)~6(토).
 *
 * ★ 여기서 Date 를 쓰는 것은 안전합니다 ★ — "지금" 을 읽지 않기 때문입니다.
 * 입력은 DB 가 이미 사용자 시간대로 계산해 준 날짜 문자열이고, Date.UTC 로
 * 순수 UTC 자정을 만들어 getUTCDay() 를 부를 뿐이라 로컬 시간대도 서머타임도
 * 개입하지 않습니다. 금지된 것은 new Date() 로 "오늘" 을 만드는 쪽입니다.
 * (lib/tasks.ts 의 shiftDate 가 같은 이유로 같은 방식을 씁니다.)
 */
function weekdayOf(isoDate: string): Weekday | null {
  if (!ISO_DATE_RE.test(isoDate)) return null
  const [year, month, day] = isoDate.split('-').map(Number)
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  return Number.isInteger(dow) ? (dow as Weekday) : null
}

/** "매일" / "평일(월~금)" / "주말(토·일)" / "월·수·금". */
function weekdaySummary(days: readonly Weekday[]): string {
  if (days.length === 0) return '요일 없음'
  if (days.length === 7) return '매일'

  const set = new Set<number>(days)
  if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => set.has(d))) return '평일(월~금)'
  if (days.length === 2 && set.has(0) && set.has(6)) return '주말(토·일)'

  return days.map((day) => WEEKDAY_LABELS[day]).join('·')
}

// ---------------------------------------------------------------------------
// 알림 문구
//
// actions.ts 가 내보내는 유니온을 Record 의 키로 받습니다. 거기에 코드를 하나
// 추가하면 여기에 문구가 생길 때까지 이 파일이 타입 체크를 통과하지 못합니다.
// ---------------------------------------------------------------------------

const OK_MESSAGES: Record<TemplatesOkCode, string> = {
  created: '반복 할 일을 만들었어요. 해당 요일에 “오늘 채우기”로 불러올 수 있어요.',
  updated: '저장했어요.',
  deleted: '반복 할 일을 지웠어요. 이미 만들어진 오늘 할 일은 그대로 남아 있어요.',
  enabled: '다시 켰어요. 이제 해당 요일에 불러올 수 있어요.',
  disabled: '잠시 껐어요. 지우지 않았으니 언제든 다시 켤 수 있어요.',
}

const ERR_MESSAGES: Record<TemplatesErrCode, string> = {
  auth: '로그인이 풀렸어요. 앱을 새로고침한 뒤 다시 시도해 주세요.',
  badrequest: '요청이 올바르지 않아요. 화면을 새로고침한 뒤 다시 시도해 주세요.',
  title: '할 일 이름을 한 글자 이상 적어주세요.',
  titlelong: `할 일 이름은 ${TASK_TITLE_MAX}자까지 쓸 수 있어요.`,
  weekday:
    '요일을 하나 이상 골라주세요. 잠시 쉬고 싶은 거라면 요일을 다 끄는 대신 “끄기”를 눌러주세요 — 요일이 하나도 없으면 영영 나타나지 않아요.',
  nogroup: '먼저 그룹을 만들거나 초대코드로 참여해 주세요.',
  notmember: '그 그룹의 멤버가 아니에요. 화면을 새로고침한 뒤 다시 시도해 주세요.',
  notfound: '그 반복 할 일을 찾을 수 없어요. 이미 지워졌을 수 있어요.',
  notdeployed: '이 기능이 아직 서버에 적용되지 않았어요. 잠시 후 다시 시도해 주세요.',
  fail: '처리하지 못했어요. 잠시 후 다시 시도해 주세요.',
}

const FILL_ERR_MESSAGES: Record<FillErrCode, string> = {
  auth: '로그인이 풀렸어요. 앱을 새로고침한 뒤 다시 시도해 주세요.',
  badrequest: '요청이 올바르지 않아요. 화면을 새로고침한 뒤 다시 시도해 주세요.',
  notdeployed: '이 기능이 아직 서버에 적용되지 않았어요. 잠시 후 다시 시도해 주세요.',
  fail: '불러오지 못했어요. 잠시 후 다시 시도해 주세요.',
}

function messageFor<K extends string>(
  table: Record<K, string>,
  raw: string | string[] | undefined,
): string | null {
  // 같은 파라미터가 두 번 오면 배열입니다. 모르는 코드는 빈 배너 대신 아무것도
  // 그리지 않아야 합니다.
  if (typeof raw !== 'string') return null
  return Object.prototype.hasOwnProperty.call(table, raw) ? table[raw as K] : null
}

/** ?c= / ?s= 는 액션이 만든 값이지만 URL 은 사용자가 고칠 수 있습니다. */
function countParam(raw: string | string[] | undefined): number {
  if (typeof raw !== 'string') return 0
  const value = Number.parseInt(raw, 10)
  if (!Number.isInteger(value) || value < 0 || value > 9999) return 0
  return value
}

/**
 * "3개 넣었어요 (2개는 이미 있어서 건너뜀)".
 *
 * ★ created 만 말하면 안 됩니다 ★ 전부 이미 있어서 0/N 이 돌아왔을 때 화면이
 * 조용하면, 사용자는 버튼이 고장 난 줄 알고 계속 누릅니다. 0/0 도 "없었어요"
 * 라고 분명히 말합니다.
 *
 * ※ 같은 함수가 app/page.tsx 에도 있습니다. 'use server' 파일은 async 함수 외의
 *    export 를 허용하지 않아 actions.ts 에 둘 수 없고, 두 화면의 문구가 서로
 *    달라도 되는(그리고 실제로 조금 다른) 종류의 코드라 공유 모듈을 새로 만드는
 *    대신 각자 소유합니다.
 */
function fillMessage(kind: FillKind, created: number, skipped: number): string {
  const what = kind === 'applied' ? '반복 할 일' : '어제 할 일'

  if (created === 0 && skipped === 0) {
    return kind === 'applied'
      ? '오늘 요일에 해당하는 반복 할 일이 없었어요.'
      : '가져올 할 일이 없었어요.'
  }
  if (created === 0) {
    return `${what} ${skipped}개가 이미 오늘 목록에 있어서 전부 건너뛰었어요.`
  }
  if (skipped === 0) {
    return `${what} ${created}개를 오늘 목록에 넣었어요.`
  }
  return `${what} ${created}개를 넣었어요. (${skipped}개는 이미 있어서 건너뜀)`
}

// ---------------------------------------------------------------------------
// 조각
// ---------------------------------------------------------------------------

/**
 * 일~토 칩 7개. `name="weekdays"` 체크박스 그룹입니다.
 *
 * 클라이언트 컴포넌트가 아닌 이유: 체크 상태는 브라우저가 이미 들고 있고,
 * 서버로는 폼 제출 때 한 번에 갑니다. 여기에 useState 를 넣으면 얻는 게 없이
 * 번들만 늘어납니다. peer / peer-checked 로 시각 상태를 CSS 가 그립니다.
 *
 * 칩 크기는 고정 px 대신 grid-cols-7 + aspect-square 입니다. 375px 화면에서
 * 카드 안쪽 폭이 약 335px 이라, 44px 고정으로 7개를 넣으면 gap 때문에 넘칩니다.
 * 이렇게 하면 그 폭에서 한 칸이 약 44px 로 떨어져 터치 목표를 지킵니다.
 */
function WeekdayChips({ selected }: { selected: readonly Weekday[] }) {
  const set = new Set<number>(selected)

  return (
    <fieldset>
      <legend className="text-fg text-sm font-medium">적용 요일</legend>
      <div className="mt-2 grid grid-cols-7 gap-1">
        {WEEKDAY_LABELS.map((label, index) => (
          <label key={label} className="block">
            <input
              type="checkbox"
              name="weekdays"
              value={index}
              defaultChecked={set.has(index)}
              className="peer sr-only"
            />
            <span className="border-line bg-surface-2 text-muted peer-checked:border-accent peer-checked:bg-accent peer-checked:text-accent-fg peer-focus-visible:ring-accent grid aspect-square w-full cursor-pointer place-items-center rounded-full border text-sm font-medium transition peer-focus-visible:ring-2">
              {label}
            </span>
          </label>
        ))}
      </div>
      <p className="text-muted mt-2 text-xs leading-relaxed [word-break:keep-all]">
        하나 이상 골라주세요. 잠시 쉬고 싶다면 요일을 다 끄지 말고 “끄기”를
        눌러주세요 — 요일이 하나도 없는 반복 할 일은 영영 나타나지 않아요.
      </p>
    </fieldset>
  )
}

/** 읽기 실패. 빈 목록으로 삼키지 않습니다 — 완전히 다른 사건입니다. */
function LoadFailure({ message }: { message: string }) {
  return (
    <main className="screen-safe px-safe mx-auto flex w-full max-w-md flex-col gap-5 py-6">
      <PageHeader title="반복 할 일" backHref="/" backLabel="오늘로 돌아가기" />
      <Card>
        <ErrorText>{message}</ErrorText>
        {/* app/page.tsx 의 LoadError 와 같은 이유로 <Link> 가 아니라 <a> 입니다:
            지금 있는 라우트로의 소프트 내비게이션은 Router Cache 에서 그대로
            서빙될 수 있어서, 정작 필요한 순간에 아무 일도 안 일어납니다. */}
        <a
          href="/templates"
          className="border-line bg-surface text-fg inline-flex h-12 w-full shrink-0 items-center justify-center rounded-xl border px-4 text-base font-medium transition active:scale-[0.99]"
        >
          다시 불러오기
        </a>
      </Card>
      <div aria-hidden="true" className="h-28 shrink-0" />
    </main>
  )
}

// ---------------------------------------------------------------------------
// 페이지
// ---------------------------------------------------------------------------

export default async function TemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const params = await searchParams

  const okMessage = messageFor<TemplatesOkCode>(OK_MESSAGES, params.ok)
  const errMessage = messageFor<TemplatesErrCode>(ERR_MESSAGES, params.err)
  const fillErrMessage = messageFor<FillErrCode>(FILL_ERR_MESSAGES, params.fillerr)
  const fillKind =
    params.fill === 'applied' || params.fill === 'copied' ? (params.fill as FillKind) : null

  const supabase = await createClient()

  // getClaims() 는 JWT 서명을 검증합니다. getSession() 은 쿠키를 그대로 되돌려
  // 줄 뿐이라 인가 검사가 아닙니다.
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims()
  const userId = claimsData?.claims.sub
  if (claimsError || typeof userId !== 'string' || !userId) {
    redirect('/login')
  }

  /**
   * 셋 다 서로를 기다리지 않습니다. 순차로 await 하면 화면이 뜨기까지 왕복이
   * 두 번 더 늘어납니다(왕복 1회 = 261~1431ms, lib/tasks.ts 상단 표 참고).
   * getMyGroups 만 내부적으로 2파라, 전체는 2파입니다.
   */
  const [today, { groups, error: groupError }, templatesResult] = await Promise.all([
    getLocalToday(),
    getMyGroups(userId),
    supabase
      .from('task_templates')
      // ★ select('*') 금지 관례 ★ (0004 는 테이블 전체 grant 지만 일관성)
      .select('id, group_id, title, weekdays, active')
      .eq('user_id', userId)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true }),
  ])

  if (templatesResult.error) {
    const code = templatesResult.error.code
    return (
      <LoadFailure
        message={
          code === 'PGRST205' || code === '42P01'
            ? ERR_MESSAGES.notdeployed
            : '반복 할 일을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.'
        }
      />
    )
  }

  const templates = templatesResult.data ?? []
  const groupNameById = new Map(groups.map((group) => [group.id, group.name]))

  const todayWeekday = weekdayOf(today)
  const todayLabel = todayWeekday === null ? null : `${WEEKDAY_LABELS[todayWeekday]}요일`

  /**
   * 지금 "오늘 채우기" 를 누르면 대상이 되는 템플릿 수.
   *
   * RPC 와 같은 세 가지 조건을 그대로 봅니다: active, 오늘 요일 포함, 그리고
   * ★ 아직 가입 상태인 그룹 ★. 마지막 조건을 빼면 나간 그룹의 템플릿까지
   * 세어서 "3개 불러오기" 라고 해 놓고 1개만 들어옵니다.
   * (RPC 는 그런 템플릿을 에러가 아니라 무동작으로 조용히 건너뜁니다.)
   */
  const applicable =
    todayWeekday === null
      ? []
      : templates.filter(
          (template) =>
            template.active &&
            template.weekdays.includes(todayWeekday) &&
            groupNameById.has(template.group_id),
        )

  return (
    <main className="screen-safe px-safe mx-auto flex w-full max-w-md flex-col gap-5 py-6">
      <PageHeader
        title="반복 할 일"
        backHref="/"
        backLabel="오늘로 돌아가기"
        description="매일·매주 반복하는 일을 등록해두면, 아침에 버튼 하나로 오늘 목록에 넣을 수 있어요."
      />

      {/* ---- 알림 ------------------------------------------------------- */}
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
      {fillKind && (
        <div className="border-line bg-surface rounded-2xl border p-4">
          <SuccessText>
            {fillMessage(fillKind, countParam(params.c), countParam(params.s))}
          </SuccessText>
        </div>
      )}
      {fillErrMessage && (
        <div className="border-danger rounded-2xl border p-4">
          <ErrorText>{fillErrMessage}</ErrorText>
        </div>
      )}
      {groupError && (
        <div className="border-danger rounded-2xl border p-4">
          <ErrorText>{groupError}</ErrorText>
          <Hint>
            그룹 이름을 못 불러왔어요. 아래 목록은 그대로 정확하고, 새로 만들기만
            잠시 막아뒀어요.
          </Hint>
        </div>
      )}

      {/* ---- 오늘 채우기 ------------------------------------------------ */}
      {templates.length > 0 && (
        <Card title="오늘 채우기">
          {applicable.length > 0 ? (
            <>
              <Hint>
                {todayLabel ? `오늘은 ${todayLabel}이에요. ` : ''}
                지금 적용되는 반복 할 일이{' '}
                <strong className="text-fg">{applicable.length}개</strong> 있어요.
              </Hint>
              <form action={applyTemplatesAction}>
                <input type="hidden" name="from" value="/templates" />
                {/* groupId 는 보내지 않습니다 — 비우면 "내가 아직 속한 모든
                    그룹" 이 대상입니다. 홈의 오늘 목록도 그룹을 가리지 않아요. */}
                <Button type="submit" pendingLabel="불러오는 중…">
                  오늘 할 일로 {applicable.length}개 불러오기
                </Button>
              </form>
              <Hint>
                이미 오늘 목록에 있는 건 다시 만들지 않아요. 여러 번 눌러도 안전해요.
              </Hint>
            </>
          ) : (
            <Hint>
              {todayLabel ? `오늘은 ${todayLabel}이에요. ` : ''}
              오늘 적용되는 반복 할 일이 없어요. 아래에서 요일을 바꾸거나 꺼둔 걸
              다시 켜보세요.
            </Hint>
          )}
        </Card>
      )}

      {/* ---- 목록 -------------------------------------------------------- */}
      <Card title="내 반복 할 일">
        {templates.length === 0 ? (
          <EmptyState
            title="반복 할 일이 아직 없어요"
            description="매일 같은 걸 다시 적는 대신 한 번만 등록해두세요. 요일까지 정해두면 월·수·금만, 주말만 같은 것도 됩니다."
            action={
              // 바로 아래 카드로 보내는 앵커라 <Link> 가 아니라 <a> 입니다.
              <a
                href="#new-template"
                className="bg-accent text-accent-fg inline-flex h-12 w-full shrink-0 items-center justify-center rounded-xl px-4 text-base font-medium transition active:scale-[0.99]"
              >
                반복 할 일 추가하기
              </a>
            }
          />
        ) : (
          <ul className="flex flex-col">
            {templates.map((template) => {
              const groupName = groupNameById.get(template.group_id)

              return (
                <li
                  key={template.id}
                  className="border-line flex flex-col border-b py-3 last:border-b-0"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p
                        className={`truncate text-sm font-medium ${
                          template.active ? 'text-fg' : 'text-muted line-through'
                        }`}
                      >
                        {template.title}
                      </p>
                      <p className="text-muted mt-0.5 truncate text-xs">
                        {weekdaySummary(template.weekdays)}
                        {/* 그룹 이름은 그룹이 둘 이상일 때만 의미가 있습니다. */}
                        {groups.length > 1 && groupName ? ` · ${groupName}` : ''}
                        {!template.active ? ' · 꺼짐' : ''}
                      </p>
                    </div>

                    <form action={setTemplateActiveAction} className="shrink-0">
                      <input type="hidden" name="id" value={template.id} />
                      <input
                        type="hidden"
                        name="active"
                        value={template.active ? 'false' : 'true'}
                      />
                      <Button
                        type="submit"
                        size="sm"
                        variant="secondary"
                        pendingLabel="…"
                        aria-label={`${template.title} ${template.active ? '끄기' : '켜기'}`}
                      >
                        {template.active ? '끄기' : '켜기'}
                      </Button>
                    </form>
                  </div>

                  {/*
                    수정 폼은 접어 둡니다. 이 화면의 주된 동작은 "훑어보고 하나
                    켜고 끄기" 라서, 항목마다 입력창과 칩 7개가 펼쳐져 있으면
                    3개만 있어도 스크롤이 세 화면이 됩니다. <details> 라 자바
                    스크립트 없이 열립니다.
                  */}
                  <details className="mt-1">
                    <summary className="text-muted cursor-pointer py-3 text-sm underline-offset-4 hover:underline">
                      수정 · 삭제
                    </summary>

                    <form action={updateTemplateAction} className="flex flex-col gap-4 pb-2">
                      <input type="hidden" name="id" value={template.id} />
                      <Input
                        name="title"
                        label="할 일 이름"
                        defaultValue={template.title}
                        maxLength={TASK_TITLE_MAX}
                        autoComplete="off"
                        required
                      />
                      <WeekdayChips selected={template.weekdays} />
                      <Button type="submit" variant="secondary" pendingLabel="저장 중…">
                        저장
                      </Button>
                    </form>

                    <form action={deleteTemplateAction} className="pb-2">
                      <input type="hidden" name="id" value={template.id} />
                      <ConfirmButton
                        size="sm"
                        confirmLabel="네, 지울게요"
                        pendingLabel="지우는 중…"
                        confirmMessage={
                          <>
                            이 반복 할 일을 지울까요? 오늘 이미 만들어진 할 일은{' '}
                            <strong>그대로 남습니다</strong>. 잠시 쉬려는 거라면 지우는
                            것보다 “끄기”가 나아요 — 지웠다가 같은 이름으로 다시 만들면
                            하루에 두 번 들어올 수 있어요.
                          </>
                        }
                      >
                        삭제
                      </ConfirmButton>
                    </form>
                  </details>
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      {/* ---- 추가 -------------------------------------------------------- */}
      <Card title="새 반복 할 일" className="scroll-mt-4">
        {/* EmptyState 의 앵커 대상. Card 자체에 id 를 못 주므로 안쪽에 둡니다. */}
        <span id="new-template" className="sr-only" />

        {groups.length === 0 ? (
          <>
            <Hint>
              반복 할 일은 그룹 안에 기록돼요. 먼저 그룹을 만들거나 초대코드로
              참여해 주세요.
            </Hint>
            <LinkButton href="/groups/new">그룹 만들기</LinkButton>
            <LinkButton href="/groups/join" variant="secondary">
              초대코드로 참여하기
            </LinkButton>
          </>
        ) : (
          <form action={createTemplateAction} className="flex flex-col gap-4">
            {/* createTemplateAction 은 언제나 /templates 로 돌아오므로 from 필드가
                없습니다 — "오늘 채우기" 두 액션만 홈에서도 불립니다. */}
            <Input
              name="title"
              label="할 일 이름"
              placeholder="예: 물 2L 마시기"
              maxLength={TASK_TITLE_MAX}
              autoComplete="off"
              required
            />

            {groups.length > 1 ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="new-template-group">어느 그룹에 기록할까요?</Label>
                <select
                  id="new-template-group"
                  name="groupId"
                  defaultValue={groups[0].id}
                  className="border-line bg-surface-2 text-fg h-12 w-full rounded-xl border px-3 outline-none"
                >
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <input type="hidden" name="groupId" value={groups[0].id} />
            )}

            {/* 기본은 매일. 대부분의 반복 할 일이 매일이고, 줄이는 편이
                늘리는 것보다 쉽습니다. */}
            <WeekdayChips selected={[0, 1, 2, 3, 4, 5, 6]} />

            <Button type="submit" pendingLabel="만드는 중…">
              반복 할 일 추가
            </Button>
          </form>
        )}
      </Card>

      {/* 하단 고정 탭바(56px + safe-area) 가림 방지. screen-safe 가
          min-height:100dvh 라서 pb-28 을 쓰면 내용이 짧아도 무의미한 스크롤이
          생긴다. 그래서 패딩이 아니라 스페이서. */}
      <div aria-hidden="true" className="h-28 shrink-0" />
    </main>
  )
}
