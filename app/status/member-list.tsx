import Link from 'next/link'

import { Button, MemberProgressRow } from '@/components/ui'
import { isPushOff, type PushStatusMap } from '@/lib/push-status'
import type { MemberTodayStatus } from '@/lib/tasks'

import { nudgeAction } from './actions'

/** Why a member's 콕 찌르기 button is not on offer right now. */
type NudgeBlock = 'self' | null

function blockFor(member: MemberTodayStatus): NudgeBlock {
  // 자기 자신에게는 버튼이 아예 없습니다. send_nudge 가 self_nudge 로 거절하고
  // (0003 §8), 그 아래 nudges_no_self_nudge_chk CHECK 이 한 번 더 막습니다.
  if (member.isMe) return 'self'
  // 다 끝낸 사람도 찌를 수 있습니다. 다 했다고 뜨는데 못 찌르면 약 올리기가
  // 막히고, 이 화면의 사회적 압력이 절반만 작동합니다.
  //
  // 배지(다 했어요)도 뺐습니다: 완료는 이미 세 군데가 말하고 있습니다 —
  // ProgressBar 가 꽉 차고, 카운터가 text-accent 로 3/3 을 띄우고
  // (components/ui.tsx MemberProgressRow), page.tsx 가 "N명 중 M명이 오늘을
  // 끝냈어요" 로 한 번 더 말합니다. 375px 에서 배지와 버튼이 한 행에 같이
  // 들어가면 이름과 진행률이 눌립니다. 버튼이 이 행의 유일한 고유 기능입니다.
  // [0005] 횟수 제한 해제. 예전에는 여기서 시간당 1회 / 하루 3회를 세어 버튼을
  // 감췄지만, send_nudge 의 상수가 0(무제한)이 된 뒤로는 화면만 막는 꼴이 된다.
  // 되살리려면 0005 의 c_hourly_limit / c_daily_limit 와 이 검사를 함께 되돌릴 것.
  return null
}


/**
 * [0006] "알림 꺼둠" — a small auxiliary marker under a member row.
 *
 * ★ Why it is NOT in MemberProgressRow's `action` slot ★
 * That slot holds the 콕 찌르기 button, which is the point of the row. A third thing elbowing in there would
 * shrink the name and the progress bar on a 360px screen to buy space for a
 * detail nobody came for. `note` is no good either — it only renders when the
 * member has zero tasks, and "wrote nothing" and "notifications off" are
 * independent facts that can both be true.
 *
 * So it goes on its own line inside the <li>, indented to line up with the text
 * column (40px avatar + 12px gap = 52px = pl-13). It reads as a footnote to the
 * row above it, which is exactly its weight.
 *
 * ★ What it must never say ★ How many devices, which device, when. 0006 folds
 * all of that into one boolean on purpose. And it does not re-explain what
 * happens if you nudge this person anyway — the `sent_pushoff` copy in
 * ./messages.ts already says that, at the moment it actually matters.
 */
function PushOffNote({ name, isSelf }: { name: string; isSelf: boolean }) {
  return (
    <p className="text-muted -mt-1 pb-3 pl-13 text-xs [word-break:keep-all]">
      {isSelf ? (
        <>
          {/*
            자기 자신에게는 사실 통보가 아니라 다음 행동을 줍니다. 여기서
            "내가 안 켰다"를 알게 되는 것 자체가 /settings 로 갈 유일한 계기고,
            그렇지 않으면 이 화면은 남의 상태만 알려주고 끝납니다.
          */}
          <span className="mr-1">알림 꺼둠</span>
          <Link href="/settings" className="text-fg underline underline-offset-4">
            알림 켜러 가기
          </Link>
        </>
      ) : (
        <>
          {/* 이름을 눈에는 반복하지 않되, 스크린 리더에는 어느 행의 각주인지
              들려줍니다. 시각적으로는 바로 위 행이 곧 맥락입니다. */}
          <span className="sr-only">{name}님은 </span>알림 꺼둠
        </>
      )}
    </p>
  )
}


/**
 * 그룹원 한 명 = <li> 하나. 진행률 행 + (있다면) 알림 꺼둠 각주 + 상세 보기.
 *
 * ★ 구분선이 MemberProgressRow 가 아니라 <li> 에 있는 이유 ★
 * The divider lives on the <li>, not on MemberProgressRow: the row's own
 * `border-b last:border-b-0` sees itself as the last child of its <li> every
 * time, so it would never draw. (app/groups/page.tsx does the same with
 * ListRow.)
 *
 * ★ avatarEmoji 만 넘깁니다 ★ 남의 행에 내 userMetadata 가 흘러들 자리를 만들지
 * 않기 위해서입니다. lib/tasks.ts 가 이미 `member.avatar` 를 계산해 두었고,
 * 이 행은 그중 이모지만 씁니다 — 넘길 수 있는 것이 애초에 없어야 안전합니다.
 */
function MemberRow({
  member,
  groupId,
  pushOff,
}: {
  member: MemberTodayStatus
  groupId: string
  pushOff: boolean
}) {
  const block = blockFor(member)

  return (
    <li className="border-line flex flex-col border-b last:border-b-0">
      <MemberProgressRow
        emoji={member.avatarEmoji}
        name={member.displayName}
        nameHref={`/members/${member.userId}`}
        isSelf={member.isMe}
        done={member.done}
        total={member.total}
        action={
          block === 'self' ? undefined : (
            <form action={nudgeAction}>
              <input type="hidden" name="groupId" value={groupId} />
              <input type="hidden" name="userId" value={member.userId} />
              <Button type="submit" size="sm" variant="secondary" pendingLabel="찌르는 중…">
                콕 찌르기
              </Button>
            </form>
          )
        }
      />
      {pushOff && <PushOffNote name={member.displayName} isSelf={member.isMe} />}
    </li>
  )
}

/**
 * 오늘의 명단. 순서는 lib/tasks.ts 가 정한 그대로(완료율 내림차순 → 이름순)라
 * 여기서 다시 정렬하지 않습니다.
 *
 * `boardIsEmpty` 는 위쪽 <EmptyState> 와 이 목록 사이의 경계선 하나에만 쓰입니다
 * — 아무도 안 적은 날에도 명단 자체는 그립니다. "누가 있는지" 는 "누가 적었는지"
 * 와 별개이고, 콕 찌를 대상이 사라지면 이 화면이 할 일이 없어집니다.
 */
export function MemberList({
  members,
  groupId,
  pushStatuses,
  boardIsEmpty,
}: {
  members: MemberTodayStatus[]
  groupId: string
  pushStatuses: PushStatusMap
  boardIsEmpty: boolean
}) {
  return (
    <ul className={`flex flex-col ${boardIsEmpty ? 'border-line border-t pt-1' : ''}`}>
      {members.map((member) => (
        <MemberRow
          key={member.userId}
          member={member}
          groupId={groupId}
          // `=== false` 로 좁힌 판정입니다(isPushOff). `!get(id)` 로 쓰면
          // 조회가 실패한 날 전원에게 "알림 꺼둠" 이 붙습니다.
          pushOff={isPushOff(pushStatuses, member.userId)}
        />
      ))}
    </ul>
  )
}
