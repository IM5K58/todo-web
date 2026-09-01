import { Screen } from '@/components/screen'
import {
  Card,
  EmptyState,
  ErrorText,
  Hint,
  LinkButton,
  PageHeader,
  ProgressBar,
  TaskCheckbox,
} from '@/components/ui'
import { requireUserId } from '@/lib/auth'
import {
  formatPeriodRange,
  getRoutinesPageData,
  isPeriodAchieved,
  periodScopeLabel,
  progressLabel,
  type MyRoutine,
} from '@/lib/routines'
import { messageFor } from '@/lib/search-params'

import { toggleRoutineCheckinAction, type RoutineErrCode } from './actions'

/**
 * /routines — 내 루틴 + 오늘 체크.
 *
 * Server Component 입니다. 낙관적 목록도 컨트롤드 입력도 없으므로 클라이언트로
 * 내려가는 것은 components/ui.tsx 의 리프(TaskCheckbox / LinkButton) 뿐이고,
 * 체크는 순수 <form action={...}> 이라 자바스크립트가 붙기 전에도 동작합니다.
 *
 * ---------------------------------------------------------------------------
 * 이 화면이 그리는 값은 전부 get_my_routines() 가 준 것입니다
 * ---------------------------------------------------------------------------
 * 반환 컬럼은 정확히 아홉 개입니다(0011 ⑧-b):
 *   routine_id, group_id, title, period, target_count,
 *   done_count, checked_today, period_start, period_end
 *
 * 목록에는 **지금 나에게 배정된 + active 인 + 내가 아직 멤버인 그룹의** 루틴만
 * 옵니다. 그래서 여기 보이는 항목은 전부 실제로 체크할 수 있는 것이고,
 * toggle 이 0행을 돌려주는 경우(목록을 띄운 뒤 관리자가 배정을 해제한 경우)는
 * ?err=ignored 로 정직하게 말합니다.
 *
 * ---------------------------------------------------------------------------
 * ★ 주/월 경계를 이 화면이 계산하지 않습니다 ★
 * ---------------------------------------------------------------------------
 * period_start / period_end 가 이미 서버 계산값입니다. 'week' 는 ISO 8601
 * 기준 **월요일 시작**(date_trunc('week')) 이고 일요일에 끝나며, 'month' 는
 * 달력 1일부터 말일까지입니다. 양끝 모두 포함이고, 기준이 되는 "오늘" 은
 * public.current_user_local_date() 즉 사용자 시간대의 날짜입니다.
 *
 * 화면은 그 두 날짜를 '9/1 ~ 9/7' 로 **표시만** 합니다(lib/routines.ts 의
 * formatPeriodRange). 여기서 new Date() 로 주의 시작을 다시 구하면 월요일
 * 규칙이 TypeScript 에 한 벌 더 생기고, 한국 시간 자정~오전 9시에 서버와
 * 하루가 어긋납니다.
 *
 * ---------------------------------------------------------------------------
 * 진행 표시를 두 줄로 나눈 이유
 * ---------------------------------------------------------------------------
 *   1줄  [✓] 헬스장 가기                ← 탭 대상. 오늘 체크 여부가 곧 이 상태
 *   2줄  ▓▓▓▓░░░░  이번 주 1/2          ← "몇 번 중 몇 번" 을 한 눈에
 *   3줄  9/1 ~ 9/7 · 오늘은 아직 · 1번 더 하면 달성
 *
 * 2줄의 "이번 주 1/2" 가 사용자가 실제로 읽는 문장이고, 3줄은 그 숫자가 어느
 * 기간에 대한 것인지와 남은 횟수를 붙입니다. 날짜 범위를 2줄에 합치면 좁은
 * 화면에서 숫자가 밀려나서, 정작 제일 중요한 "1/2" 가 안 보입니다.
 */

// ---------------------------------------------------------------------------
// 배너 문구
// ---------------------------------------------------------------------------

/**
 * ./actions.ts 의 유니온을 키로 씁니다. 코드를 하나 추가하면 여기에 문구가
 * 생길 때까지 이 파일이 타입 체크를 통과하지 못합니다 — 그게 목적입니다.
 */
const ERR_MESSAGES: Record<RoutineErrCode, string> = {
  auth: '로그인이 풀렸어요. 앱을 새로고침한 뒤 다시 시도해 주세요.',
  badrequest: '요청이 올바르지 않아요. 화면을 새로고침한 뒤 다시 시도해 주세요.',
  notdeployed: '루틴 기능이 아직 서버에 적용되지 않았어요. 잠시 후 다시 시도해 주세요.',
  ignored:
    '체크하지 못했어요. 그 루틴이 꺼졌거나 배정이 해제된 것 같아요. 아래 목록을 다시 확인해 주세요.',
  fail: '체크하지 못했어요. 잠시 후 다시 시도해 주세요.',
}

// ---------------------------------------------------------------------------
// 한 줄
// ---------------------------------------------------------------------------

/**
 * 루틴 한 개.
 *
 * <form> 이 항목마다 하나입니다. <TaskCheckbox> 는 useFormStatus() 를 읽어
 * pending 상태를 만드는데, 여러 항목을 한 form 에 담으면 하나를 누를 때
 * **전부** 스피너가 됩니다.
 *
 * 체크 대상은 name="routineId" 로 버튼 자신이 실어 보냅니다. 사용자 id 는
 * 어디에도 없습니다 — toggle_routine_checkin 에는 그런 인자가 아예 없고 언제나
 * auth.uid() 입니다(0011 ⑧-a).
 */
function RoutineRow({ routine }: { routine: MyRoutine }) {
  const achieved = isPeriodAchieved(routine)
  const remaining = Math.max(routine.target_count - routine.done_count, 0)

  return (
    <div className="border-line flex flex-col gap-2 border-b py-2 last:border-b-0">
      <form action={toggleRoutineCheckinAction}>
        <TaskCheckbox
          checked={routine.checked_today}
          name="routineId"
          value={routine.routine_id}
        >
          {routine.title}
        </TaskCheckbox>
      </form>

      {/* pl-10 = TaskCheckbox 의 px-1(4px) + 상자 24px + gap-3(12px). 제목과 왼쪽을 맞춥니다. */}
      <div className="flex items-center gap-2 pl-10">
        <ProgressBar
          value={routine.done_count}
          max={routine.target_count}
          label={`${routine.title} ${periodScopeLabel(routine.period)} 진행 상황`}
          className="min-w-0 flex-1"
        />
        <span
          className={`shrink-0 text-xs tabular-nums ${
            achieved ? 'text-accent font-medium' : 'text-muted'
          }`}
        >
          {progressLabel(routine)}
        </span>
      </div>

      <p className="text-muted pl-10 text-xs leading-relaxed [word-break:keep-all]">
        {formatPeriodRange(routine.period_start, routine.period_end)}
        {' · '}
        {routine.checked_today ? '오늘 체크함' : '오늘은 아직'}
        {' · '}
        {achieved ? '이번 주기 목표를 채웠어요' : `${remaining}번 더 하면 달성`}
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 화면
// ---------------------------------------------------------------------------

export default async function RoutinesPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const params = await searchParams
  const { userId } = await requireUserId()

  const { error, isAdmin, groups, routines } = await getRoutinesPageData(userId)
  const errMessage = messageFor<RoutineErrCode>(ERR_MESSAGES, params.err)

  /**
   * 그룹별로 묶습니다. get_my_routines 는 인자가 없어서 내가 속한 **모든**
   * 그룹의 루틴이 한 번에 오고, 그러면 "이게 어느 그룹 루틴이지" 가 됩니다.
   * 서버가 (created_at, id) 로 정렬해 주므로 Map 의 삽입 순서가 그대로
   * 안정적인 표시 순서가 됩니다 — 여기서 다시 정렬하지 않습니다.
   */
  const groupNameById = new Map(groups.map((g) => [g.id, g.name] as const))
  const sections = new Map<string, MyRoutine[]>()
  for (const routine of routines) {
    const bucket = sections.get(routine.group_id)
    if (bucket) bucket.push(routine)
    else sections.set(routine.group_id, [routine])
  }

  return (
    <Screen>
      <PageHeader
        title="내 루틴"
        backHref="/"
        backLabel="홈"
        description="주 단위 · 달 단위로 정해진 횟수를 채우는 습관이에요. 한 날에 한 번씩, 아무 날이나 체크하면 됩니다."
      />

      {errMessage && <ErrorText>{errMessage}</ErrorText>}
      {error && <ErrorText>{error}</ErrorText>}

      {sections.size === 0 ? (
        <Card>
          <EmptyState
            title="아직 배정된 루틴이 없어요."
            description="루틴은 관리자가 만들어서 그룹원에게 배정해요. 배정되면 여기에서 매일 체크할 수 있어요."
          />
        </Card>
      ) : (
        [...sections.entries()].map(([groupId, items]) => (
          <Card key={groupId} title={groupNameById.get(groupId) ?? '이름을 알 수 없는 그룹'}>
            {items.map((routine) => (
              <RoutineRow key={routine.routine_id} routine={routine} />
            ))}
          </Card>
        ))
      )}

      {/*
        ★ 관리자가 아니면 이 링크를 아예 렌더하지 않습니다 ★ (프로젝트 함정 6)
        /routines/admin 은 비관리자에게 안내 한 줄만 보여 주므로 열어도 아무
        일도 일어나지 않지만, 못 쓰는 화면으로 가는 문을 만들어 둘 이유가 없습니다.
      */}
      {isAdmin && (
        <Card title="관리자">
          <Hint>
            루틴을 만들고, 주기와 목표 횟수를 정하고, 그룹원에게 배정하는 화면이에요.
          </Hint>
          <LinkButton href="/routines/admin" variant="secondary">
            루틴 설정 열기
          </LinkButton>
        </Card>
      )}
    </Screen>
  )
}
