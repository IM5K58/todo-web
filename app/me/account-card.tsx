'use client'

import { Button, Card, ErrorText, Hint, Input } from '@/components/ui'

import { signOutAction } from './actions'

/**
 * 「계정」 카드 — 로그아웃과 탈퇴. app/me/page.tsx 의 JSX 를 그대로 옮긴
 * 것입니다.
 *
 * ★ 확인 문자열 검증은 여기 없습니다 ★ `armed` 는 page.tsx 가
 * normalizeForCompare() 로 판정해 내려보내는 값이고, 진짜 관문은
 * app/api/account/delete/route.ts 가 서버에서 같은 규칙으로 다시 맞춰 보는
 * 쪽입니다. 이 파일에서 조건을 다시 쓰면 규칙이 세 군데로 갈라집니다.
 */
export function AccountCard({
  displayName,
  deleteOpen,
  onOpenDelete,
  deleteDraft,
  onDeleteDraftChange,
  deleteArmed,
  deleting,
  deleteError,
  onCancelDelete,
  onConfirmDelete,
}: {
  displayName: string
  deleteOpen: boolean
  onOpenDelete: () => void
  deleteDraft: string
  onDeleteDraftChange: (value: string) => void
  /** page.tsx 가 판정한 "이름을 정확히 옮겨 적었는가". 여기서 다시 세지 않습니다. */
  deleteArmed: boolean
  deleting: boolean
  deleteError: string | null
  onCancelDelete: () => void
  onConfirmDelete: () => void
}) {
  return (
    <Card title="계정">
      {/*
        로그아웃은 Server Action 입니다. 브라우저에서 signOut() 만 부르면
        document.cookie 는 지워져도 이미 받아 둔 서버 컴포넌트 페이로드가
        라우터 캐시에 남아, 뒤로가기 한 번에 로그인된 화면이 되살아납니다.
      */}
      <form action={signOutAction}>
        <Button type="submit" variant="secondary" pendingLabel="로그아웃 중…">
          로그아웃
        </Button>
      </form>

      <div className="border-line mt-2 border-t pt-4">
        {!deleteOpen ? (
          <div className="flex flex-col gap-2">
            <Hint>
              탈퇴하면 계정과 내 기록이 모두 사라져요. 되돌릴 수 없어요.
            </Hint>
            <Button type="button" variant="danger" onClick={onOpenDelete}>
              탈퇴하기
            </Button>
          </div>
        ) : (
          <DeleteConfirm
            displayName={displayName}
            draft={deleteDraft}
            onDraftChange={onDeleteDraftChange}
            armed={deleteArmed}
            busy={deleting}
            error={deleteError}
            onCancel={onCancelDelete}
            onConfirm={onConfirmDelete}
          />
        )}
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// 탈퇴 확인
// ---------------------------------------------------------------------------

/**
 * 되돌릴 수 없는 삭제의 관문.
 *
 * window.confirm() 을 쓰지 않는 이유는 components/ui.tsx 의 ConfirmButton 과
 * 같습니다 — 일부 standalone PWA 컨텍스트에서 막히고, 페이지 전체를 멈춥니다.
 * 그리고 confirm 창에는 "무엇이 지워지는가" 를 이만큼 적을 수 없습니다.
 *
 * 활성화 조건은 **표시 이름을 정확히 옮겨 적기** 입니다. 체크박스나 두 번 누르기
 * 보다 강한 이유는, 다른 사람의 화면을 잠깐 잡은 사람이나 실수로 스크롤하다
 * 누른 사람이 통과할 수 없기 때문입니다. 물론 이건 UI 이고, 진짜 관문은
 * app/api/account/delete/route.ts 가 같은 문자열을 서버에서 다시 맞춰 보는
 * 쪽입니다.
 *
 * 【아래 목록의 출처】 추측이 아니라 supabase/migrations 의 ON DELETE 절입니다.
 *   tasks / task_templates / group_members / push_subscriptions / nudges
 *     → profiles(id) ON DELETE CASCADE            (0001, 0004)
 *   groups.created_by → profiles(id) ON DELETE SET NULL  (0001:207)
 *     = 내가 만든 그룹은 남고, '만든 사람' 칸만 비워집니다.
 *   마지막 소유자였다면 private.ensure_group_has_owner() (0001 §6b) 가 가장
 *     오래된 남은 멤버에게 소유권을 넘깁니다. 남은 멤버가 없으면 빈 그룹이
 *     남습니다.
 */
function DeleteConfirm({
  displayName,
  draft,
  onDraftChange,
  armed,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  displayName: string
  draft: string
  onDraftChange: (value: string) => void
  armed: boolean
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="border-danger flex flex-col gap-3 rounded-xl border p-4">
      <h3 className="text-danger text-sm font-semibold" role="alert">
        정말 탈퇴할까요? 되돌릴 수 없어요.
      </h3>

      <div className="flex flex-col gap-2">
        <p className="text-fg text-sm font-medium">지워지는 것</p>
        <ul className="text-muted flex list-disc flex-col gap-1 pl-5 text-sm leading-relaxed [word-break:keep-all]">
          <li>지금까지 적은 할 일과 기록 전부 (친구들의 현황·기록 화면에서도 사라져요)</li>
          <li>반복 할 일 템플릿</li>
          <li>모든 그룹에서의 참여 (그룹 자체는 남아요)</li>
          <li>알림 구독 — 이 계정으로는 더 이상 알림이 오지 않아요</li>
          <li>주고받은 콕 찌르기 기록</li>
          <li>프로필 — 이름, 올린 사진, 이모지</li>
        </ul>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-fg text-sm font-medium">남는 것</p>
        <ul className="text-muted flex list-disc flex-col gap-1 pl-5 text-sm leading-relaxed [word-break:keep-all]">
          <li>내가 만든 그룹은 그대로 남아요. &lsquo;만든 사람&rsquo; 표시만 비워져요.</li>
          <li>친구들이 적은 할 일과 기록은 그대로예요.</li>
          <li>
            내가 유일한 방장인 그룹은 가장 오래 있던 다른 멤버가 자동으로 방장이 돼요.
            남은 멤버가 아무도 없으면 그 그룹은 빈 채로 남아요.
          </li>
        </ul>
      </div>

      <Hint>
        다시 쓰고 싶어지면 같은 구글 계정으로 새로 가입할 수 있지만, 지워진 기록은
        돌아오지 않아요.
      </Hint>

      <Input
        id="delete-confirm"
        type="text"
        label="확인"
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        // autoComplete='off' + 자동 대문자/교정 끄기: 이름을 정확히 옮겨 적어야
        // 하는 칸에서 모바일 키보드가 첫 글자를 바꿔 놓으면 사용자는 왜 버튼이
        // 안 켜지는지 알 수 없습니다.
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="done"
        disabled={busy}
        placeholder={displayName}
        hint={
          <>
            탈퇴하려면 내 이름 <strong className="text-fg">{displayName}</strong> 을(를)
            그대로 입력해 주세요.
          </>
        }
      />

      <ErrorText>{error}</ErrorText>

      <div className="flex gap-2">
        <Button
          type="button"
          variant="danger"
          disabled={!armed}
          pending={busy}
          pendingLabel="탈퇴 중…"
          onClick={onConfirm}
          className="flex-1"
        >
          영구 삭제
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={onCancel}
          className="flex-1"
        >
          취소
        </Button>
      </div>
    </div>
  )
}
