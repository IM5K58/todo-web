import { Hint, LinkButton } from '@/components/ui'

/**
 * [0007] 하단 탭에서 그룹 탭이 사라졌으므로, /groups 로 가는 길은 이제
 * 여기입니다. 멤버 목록 "아래" 이고 카드 안입니다 — 초대 코드도 내보내기도
 * 그룹 나가기도 전부 이 명단에 대한 이야기라서, 명단에서 멀어질수록 무슨
 * 화면으로 가는지 알기 어려워집니다.
 *
 * 로스터 조회가 실패한 경우에도 일부러 남겨 둡니다. 그때야말로 /groups 가
 * 유일한 탈출구인데 오류 분기 안에 숨겨 두면 막다른 길이 됩니다. 그래서
 * page.tsx 에서 로스터 삼항 "밖에" 놓여 있습니다.
 *
 * 쿼리 없는 맨 /groups 입니다. app/groups/page.tsx 는 내가 속한 그룹을
 * 전부 카드로 그리고 `?ok=` / `?err=` 만 읽습니다 — "지금 보는 그룹"
 * 이라는 개념 자체가 없어서 `?group=` 을 붙여도 아무 일도 일어나지
 * 않습니다. 읽고 확인한 것이지 짐작이 아닙니다. (그래서 이 컴포넌트는
 * prop 을 받지 않습니다.)
 */
export function GroupDetailLink() {
  return (
    <div className="border-line flex flex-col gap-3 border-t pt-4">
      <LinkButton href="/groups" variant="secondary">
        내 그룹 상세 보기
      </LinkButton>
      <Hint>초대 코드, 멤버 내보내기, 그룹 나가기를 여기에서 할 수 있어요.</Hint>
    </div>
  )
}
