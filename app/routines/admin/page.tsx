import Link from 'next/link'

import { Screen } from '@/components/screen'
import {
  Button,
  Card,
  EmptyState,
  ErrorText,
  Hint,
  Input,
  Label,
  LinkButton,
  PageHeader,
  SuccessText,
} from '@/components/ui'
import { requireUserId } from '@/lib/auth'
import {
  getRoutinesAdminData,
  periodLabel,
  type AdminMember,
  type AdminRoutine,
} from '@/lib/routines'
import { messageFor } from '@/lib/search-params'
import type { MyGroup } from '@/lib/tasks'

import {
  createRoutineAction,
  setRoutineAssigneesAction,
  updateRoutineAction,
  type AdminErrCode,
  type AdminOkCode,
} from '../actions'

/**
 * /routines/admin — 루틴 만들기 · 수정 · 배정. **관리자 전용**.
 *
 * ---------------------------------------------------------------------------
 * ★ 관리자가 아니면 편집 UI 를 아예 렌더하지 않습니다 ★ (프로젝트 함정 6)
 * ---------------------------------------------------------------------------
 * upsert_routine 과 set_routine_assignees 는 비관리자에게 예외를 던지지 않고
 * **조용히 무동작**입니다(0011 ⑦ 머리말 — 예외를 던지면 특권 계정의 존재와
 * 그룹·루틴의 실재 여부가 샙니다). 그래서 버튼을 보여 주면 "저장했는데 안
 * 바뀐다" 가 됩니다. 정상 경로는 버튼이 없는 것이고, 여기서는 안내 한 줄만
 * 남깁니다.
 *
 * 판정은 public.am_i_admin() 입니다. 그건 화면 분기용 편의 함수일 뿐이고
 * 보안 경계가 아닙니다 — 진짜 강제는 각 RPC 안의 private.is_app_admin() 이라,
 * 이 화면을 우회해서 액션을 직접 호출해도 아무 일도 일어나지 않습니다.
 * lib/routines.ts 의 getRoutinesAdminData 는 비관리자면 그룹원 명단조차 읽지
 * 않습니다.
 *
 * ---------------------------------------------------------------------------
 * "어느 그룹의 루틴인가" 를 화면이 계속 말합니다
 * ---------------------------------------------------------------------------
 * routines.group_id 는 **수정할 수 없습니다** — upsert_routine 의 where 절에
 * group_id 가 함께 들어가서, 다른 그룹 id 를 주면 그룹 이동이 아니라 0행(무동작)
 * 입니다(0011 ⑦-a). 루틴을 옮기면 배정된 사람들이 그 그룹 멤버가 아니게 되어
 * 설명할 수 없는 상태가 되기 때문입니다.
 * 그래서 그룹은 위쪽 칩으로 **고르는** 것이고, 각 폼 안에서는 숨은 필드로
 * 따라다니기만 합니다. 카드 제목에도 그룹 이름을 적어 둡니다.
 *
 * ---------------------------------------------------------------------------
 * 저장 뒤에 화면이 그리는 값은 전부 "다시 읽은" 값입니다 (함정 2)
 * ---------------------------------------------------------------------------
 * 모든 액션은 redirect 로 끝나므로 이 페이지가 통째로 다시 실행되고,
 * routines / routine_assignments 를 새로 읽어서 그립니다. RPC 의 반환값을
 * 화면에 그대로 반영하는 경로는 없습니다.
 *
 * ---------------------------------------------------------------------------
 * 삭제 버튼이 없는 이유
 * ---------------------------------------------------------------------------
 * routine_checkins 의 FK 가 on delete cascade 라, 루틴을 지우면 사용자가 몇
 * 달에 걸쳐 쌓은 체크 기록이 전부 함께 사라집니다. 그래서 0011 은
 * authenticated 에게 DELETE 권한도 정책도 주지 않았고, "그만할래" 는
 * 상태를 **잠시 끔** 으로 바꾸는 것입니다. 목록에서만 빠지고 기록은 남습니다.
 */

// ---------------------------------------------------------------------------
// 배너 문구 — ../actions.ts 의 유니온이 키입니다
// ---------------------------------------------------------------------------

const OK_MESSAGES: Record<AdminOkCode, string> = {
  created: '새 루틴을 만들었어요. 아래에서 그룹원에게 배정해 주세요.',
  updated: '루틴을 저장했어요.',
  assigned: '배정을 저장했어요.',
}

const ERR_MESSAGES: Record<AdminErrCode, string> = {
  auth: '로그인이 풀렸어요. 앱을 새로고침한 뒤 다시 시도해 주세요.',
  badrequest: '요청이 올바르지 않아요. 화면을 새로고침한 뒤 다시 시도해 주세요.',
  notadmin: '아무것도 바뀌지 않았어요. 이 그룹의 루틴을 바꿀 권한이 없어요.',
  notdeployed: '루틴 기능이 아직 서버에 적용되지 않았어요. 잠시 후 다시 시도해 주세요.',
  invalid:
    '입력한 값이 올바르지 않아요. 이름을 채웠는지, 목표 횟수가 주 루틴은 1~7, 달 루틴은 1~31 인지 확인해 주세요.',
  assigndiff:
    '저장한 배정이 고른 것과 달라요. 아래 체크 상태가 실제로 저장된 값이니 확인한 뒤 다시 저장해 주세요.',
  fail: '저장하지 못했어요. 잠시 후 다시 시도해 주세요.',
}

// ---------------------------------------------------------------------------
// 작은 조각들
// ---------------------------------------------------------------------------

const SELECT_CLASS =
  'border-line bg-surface-2 text-fg h-12 w-full rounded-xl border px-3 outline-none disabled:opacity-40'

/**
 * <select> 는 components/ui.tsx 에 없습니다. 프리미티브를 늘리는 것은 그 파일을
 * 소유한 쪽 일이라, 여기서는 <Input> 과 같은 클래스만 빌려 씁니다
 * (border-line / bg-surface-2 / h-12 / rounded-xl — 테마에 실재하는 토큰뿐입니다).
 *
 * 컨트롤드가 아니라 defaultValue 입니다. 이 화면에는 클라이언트 상태가 없고,
 * 폼은 Server Action 으로 통째로 제출됩니다.
 */
function Select({
  id,
  name,
  label,
  defaultValue,
  options,
}: {
  id: string
  name: string
  label: string
  defaultValue: string
  options: { value: string; label: string }[]
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select id={id} name={name} defaultValue={defaultValue} className={SELECT_CLASS}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  )
}

const PERIOD_OPTIONS = [
  { value: 'week', label: '주 (월요일 ~ 일요일)' },
  { value: 'month', label: '달 (1일 ~ 말일)' },
]

const ACTIVE_OPTIONS = [
  { value: '1', label: '사용 중' },
  { value: '0', label: '잠시 끔' },
]

/**
 * 그룹 칩. /status 의 GroupSwitcher 와 같은 모양이지만 그 컴포넌트는 그 화면이
 * 소유한 파일이고 기본 그룹 고정 토글이 함께 들어 있어서, 여기서는 칩 줄만
 * 같은 클래스로 다시 그립니다.
 */
function GroupChips({ groups, activeGroupId }: { groups: MyGroup[]; activeGroupId: string }) {
  return (
    <nav aria-label="그룹 고르기" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
      {groups.map((group) => {
        const active = group.id === activeGroupId
        return (
          <Link
            key={group.id}
            href={`/routines/admin?group=${group.id}`}
            aria-current={active ? 'page' : undefined}
            className={`inline-flex h-11 shrink-0 items-center rounded-full px-4 text-sm font-medium transition active:scale-[0.99] ${
              active ? 'bg-accent text-accent-fg' : 'border-line bg-surface text-muted border'
            }`}
          >
            {group.name}
          </Link>
        )
      })}
    </nav>
  )
}

/** 새 루틴 만들기. p_id 없이 upsert_routine 을 부르는 폼입니다. */
function NewRoutineForm({ groupId, groupName }: { groupId: string; groupName: string }) {
  return (
    <Card title="새 루틴 만들기">
      <Hint>
        {groupName} 그룹에 루틴을 추가해요. 예를 들어 “헬스장 가기”를 주 2회로 정하면, 배정된
        사람은 월요일부터 일요일 사이 아무 날에나 두 번 체크하면 됩니다.
      </Hint>

      <form action={createRoutineAction} className="flex flex-col gap-3">
        <input type="hidden" name="groupId" value={groupId} />

        <Input
          name="title"
          label="루틴 이름"
          placeholder="헬스장 가기"
          maxLength={60}
          required
        />

        <Select
          id="new-routine-period"
          name="period"
          label="주기"
          defaultValue="week"
          options={PERIOD_OPTIONS}
        />

        <Input
          name="targetCount"
          label="목표 횟수"
          type="number"
          inputMode="numeric"
          min={1}
          max={31}
          defaultValue={2}
          hint="한 주기에 몇 번 체크하면 달성인지예요. 주 루틴은 1~7, 달 루틴은 1~31."
          required
        />

        {/* 새로 만든 루틴은 언제나 사용 중입니다. 끄려면 만든 뒤에 바꿉니다. */}
        <input type="hidden" name="active" value="1" />

        <Button type="submit" pendingLabel="만드는 중…">
          루틴 만들기
        </Button>
      </form>
    </Card>
  )
}

/** 기존 루틴 한 개의 수정 폼. group_id 는 숨은 필드로 따라만 다닙니다. */
function RoutineEditForm({ routine }: { routine: AdminRoutine }) {
  return (
    <form action={updateRoutineAction} className="flex flex-col gap-3">
      <input type="hidden" name="groupId" value={routine.group_id} />
      <input type="hidden" name="routineId" value={routine.id} />

      <Input
        name="title"
        label="루틴 이름"
        defaultValue={routine.title}
        maxLength={60}
        required
      />

      <Select
        id={`period-${routine.id}`}
        name="period"
        label="주기"
        defaultValue={routine.period}
        options={PERIOD_OPTIONS}
      />

      <Input
        name="targetCount"
        label="목표 횟수"
        type="number"
        inputMode="numeric"
        min={1}
        max={31}
        defaultValue={routine.target_count}
        required
      />

      <Select
        id={`active-${routine.id}`}
        name="active"
        label="상태"
        defaultValue={routine.active ? '1' : '0'}
        options={ACTIVE_OPTIONS}
      />

      <Button type="submit" variant="secondary" pendingLabel="저장 중…">
        저장
      </Button>
    </form>
  )
}

/**
 * 배정 체크박스. **전체 교체**입니다 — 체크된 사람만 남고 나머지는 해제됩니다
 * (0011 ⑦-b). 하나도 안 고르고 저장하면 전원 해제이고, 그것도 정상 입력입니다.
 *
 * 배정을 풀어도 그 사람의 체크 기록은 지워지지 않습니다. 다시 배정하면 그
 * 주기의 진행이 이어집니다.
 */
function AssignForm({
  routine,
  members,
  assigned,
}: {
  routine: AdminRoutine
  members: AdminMember[]
  assigned: Set<string>
}) {
  if (members.length === 0) {
    return <Hint>이 그룹에 아직 다른 멤버가 없어요.</Hint>
  }

  return (
    <form action={setRoutineAssigneesAction} className="flex flex-col gap-3">
      <input type="hidden" name="groupId" value={routine.group_id} />
      <input type="hidden" name="routineId" value={routine.id} />

      <fieldset className="flex flex-col gap-1">
        <legend className="text-fg text-sm font-medium">배정할 그룹원</legend>
        {members.map((member) => (
          <label
            key={member.userId}
            className="border-line flex min-h-11 items-center gap-3 border-b py-2 last:border-b-0"
          >
            <input
              type="checkbox"
              name="userId"
              value={member.userId}
              defaultChecked={assigned.has(member.userId)}
              className="accent-accent size-5 shrink-0"
            />
            <span aria-hidden="true" className="text-lg">
              {member.emoji}
            </span>
            <span className="text-fg min-w-0 flex-1 truncate text-sm">{member.name}</span>
          </label>
        ))}
      </fieldset>

      <Hint>
        체크한 사람만 남습니다. 체크를 풀어도 그 사람이 지금까지 체크한 기록은 지워지지 않아요.
      </Hint>

      <Button type="submit" variant="secondary" pendingLabel="저장 중…">
        배정 저장
      </Button>
    </form>
  )
}

// ---------------------------------------------------------------------------
// 화면
// ---------------------------------------------------------------------------

export default async function RoutinesAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const params = await searchParams
  const { userId } = await requireUserId()

  const preferredGroupId = typeof params.group === 'string' ? params.group : undefined
  const { error, isAdmin, groups, activeGroup, routines, members, assigneesByRoutine } =
    await getRoutinesAdminData(userId, preferredGroupId)

  const header = (
    <PageHeader title="루틴 설정" backHref="/routines" backLabel="내 루틴" />
  )

  // ★ 함정 6 ★ 관리자가 아니면 편집 UI 를 한 조각도 렌더하지 않습니다.
  if (!isAdmin) {
    return (
      <Screen>
        {header}
        <Card>
          <Hint>
            이 화면은 앱 관리자만 쓸 수 있어요. 루틴을 만들거나 배정을 바꾸고 싶으면 관리자에게
            말해 주세요.
          </Hint>
          <LinkButton href="/routines" variant="secondary">
            내 루틴으로 돌아가기
          </LinkButton>
        </Card>
      </Screen>
    )
  }

  const okMessage = messageFor<AdminOkCode>(OK_MESSAGES, params.ok)
  const errMessage = messageFor<AdminErrCode>(ERR_MESSAGES, params.err)

  return (
    <Screen>
      {header}

      {okMessage && <SuccessText>{okMessage}</SuccessText>}
      {errMessage && <ErrorText>{errMessage}</ErrorText>}
      {error && <ErrorText>{error}</ErrorText>}

      {groups.length > 1 && activeGroup && (
        <GroupChips groups={groups} activeGroupId={activeGroup.id} />
      )}

      {!activeGroup ? (
        <Card>
          <EmptyState
            title="아직 속한 그룹이 없어요."
            description="루틴은 그룹에 속합니다. 먼저 그룹을 만들거나 참여해 주세요."
            action={<LinkButton href="/groups">그룹으로 가기</LinkButton>}
          />
        </Card>
      ) : (
        <>
          <NewRoutineForm groupId={activeGroup.id} groupName={activeGroup.name} />

          {routines.length === 0 ? (
            <Card title={`${activeGroup.name} 그룹의 루틴`}>
              <EmptyState
                title="아직 루틴이 없어요."
                description="위에서 첫 루틴을 만들어 보세요."
              />
            </Card>
          ) : (
            routines.map((routine) => {
              const assigned = assigneesByRoutine.get(routine.id) ?? new Set<string>()
              return (
                <Card key={routine.id} title={routine.title}>
                  <p className="text-muted text-xs leading-relaxed [word-break:keep-all]">
                    {activeGroup.name} 그룹 · {periodLabel(routine.period)} {routine.target_count}
                    회 · {routine.active ? '사용 중' : '잠시 끔'} · 배정 {assigned.size}명
                  </p>

                  <RoutineEditForm routine={routine} />

                  <div className="border-line border-t pt-3">
                    <AssignForm routine={routine} members={members} assigned={assigned} />
                  </div>
                </Card>
              )
            })
          )}
        </>
      )}
    </Screen>
  )
}
