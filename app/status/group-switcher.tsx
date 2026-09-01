import Link from 'next/link'

import { Button } from '@/components/ui'
import type { MyGroup } from '@/lib/tasks'

import { setDefaultGroupAction } from './default-group-actions'

/**
 * [0007] "이 그룹을 먼저 보여줘" — 기본 그룹 고정 토글.
 *
 * ★ Why a <form> and not a checkbox or a <Link> ★
 * A checkbox would need client state and would report success before the write
 * landed; a <Link> would make a GET that mutates. This is a Server Action form,
 * so <Button> gets a real pending label from useFormStatus(), it works without
 * JS, and the outcome comes back as a URL you can reload (`?dg=`).
 *
 * ★ Why the state is a <p> and only the verb is a button ★
 * "고정됨" as a button label reads as the thing the button will DO, which is the
 * opposite of what pressing it does. So the current state is stated in text and
 * the button carries the action — 기본으로 고정 / 고정 해제. Nobody has to guess
 * which of the two meanings the label is carrying.
 *
 * ★ Why `pin` is a separate hidden field ★
 * `groupId` is always the group on screen, in both directions, because the
 * action redirects back to it either way. See default-group-actions.ts.
 *
 * Rendered only when there is more than one group — <GroupSwitcher> below is
 * the only caller and page.tsx only mounts it under that condition.
 */
function DefaultGroupToggle({ groupId, isPinned }: { groupId: string; isPinned: boolean }) {
  return (
    <form
      action={setDefaultGroupAction}
      className="border-line bg-surface flex items-center justify-between gap-3 rounded-2xl border px-4 py-3"
    >
      <input type="hidden" name="groupId" value={groupId} />
      <input type="hidden" name="pin" value={isPinned ? '0' : '1'} />

      <p className="text-muted min-w-0 text-xs leading-relaxed [word-break:keep-all]">
        {isPinned ? (
          <>
            <span className="text-fg font-medium">기본 그룹으로 고정됨</span>
            <br />현황을 열면 이 그룹이 먼저 보여요.
          </>
        ) : (
          <>
            <span className="text-fg font-medium">기본 그룹 아님</span>
            <br />고정해 두면 현황을 열 때 이 그룹이 먼저 보여요.
          </>
        )}
      </p>

      <Button
        type="submit"
        size="sm"
        variant="secondary"
        pendingLabel={isPinned ? '해제하는 중…' : '고정하는 중…'}
      >
        {isPinned ? '고정 해제' : '기본으로 고정'}
      </Button>
    </form>
  )
}

/**
 * 그룹 칩 줄 + 그 아래 [0007] 고정 토글.
 *
 * 둘이 한 컴포넌트인 이유는 조건이 하나이기 때문입니다 — 그룹이 여러 개일
 * 때만 나옵니다. 칩은 고를 것이 있어야 의미가 있고, 토글은 어차피 열릴 그룹을
 * "기본으로 고정" 해 봐야 아무것도 바꾸지 않는 버튼이 됩니다. 조건 자체는
 * page.tsx 에 남아 있습니다(보드 데이터를 아는 쪽이 거기라서).
 *
 * ★ 칩은 <Link> 이고 `?group=` 을 붙입니다 ★ 그 파라미터가 고정보다 우선한다는
 * 것이 page.tsx 머리말의 우선순위 1번입니다. 여기서 다른 경로를 만들면 그
 * 규칙이 깨집니다.
 *
 * `isPinned` 는 방금 읽은 default_group_id 와 activeGroup.id 의 비교 결과를
 * 그대로 받습니다 — 직전 쓰기의 성공 여부가 아닙니다. 이유는 page.tsx 의
 * 해당 상수 주석에 있습니다.
 */
export function GroupSwitcher({
  groups,
  activeGroupId,
  isPinned,
}: {
  groups: MyGroup[]
  activeGroupId: string
  isPinned: boolean
}) {
  return (
    <div className="flex flex-col gap-3">
      <nav aria-label="그룹 고르기" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {groups.map((group) => {
          const active = group.id === activeGroupId
          return (
            <Link
              key={group.id}
              href={`/status?group=${group.id}`}
              aria-current={active ? 'page' : undefined}
              className={`inline-flex h-11 shrink-0 items-center rounded-full px-4 text-sm font-medium transition active:scale-[0.99] ${
                active
                  ? 'bg-accent text-accent-fg'
                  : 'border-line bg-surface text-muted border'
              }`}
            >
              {group.name}
            </Link>
          )
        })}
      </nav>

      <DefaultGroupToggle groupId={activeGroupId} isPinned={isPinned} />
    </div>
  )
}
