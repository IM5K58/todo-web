/**
 * lib/tasks-model.ts — 도메인 모델: 타입, 상한, 그 상한을 재는 함수
 *
 * lib/tasks.ts 에서 갈라져 나온 조각입니다. 설계 규칙 전문은 lib/tasks.ts 머리말.
 *
 * 여기에는 질의가 없습니다. createClient() 도 next/headers 도 부르지 않으므로
 * 서버 전용이 아닙니다. "무엇을 주고받는가"만 정의합니다.
 */

import type { ResolvedAvatar } from '@/lib/avatar'
import type { GroupRole } from '@/lib/supabase/types'

/* ==========================================================================
 * 타입
 * ======================================================================== */

/** 오늘 화면이 쓰는 할 일 한 줄. tasks 테이블의 부분 집합입니다. */
export type TodayTask = {
  id: string
  group_id: string
  title: string
  sort_order: number
  /** NULL = 미완료. timestamptz 문자열 = 완료 시각. */
  done_at: string | null
  /** 'YYYY-MM-DD'. DB 가 정한 값이지 클라이언트가 만든 값이 아닙니다. */
  task_date: string
}

/** 내가 속한 그룹 하나. groups 는 (id, name, created_by, created_at) 만 읽힙니다. */
export type MyGroup = {
  id: string
  name: string
  role: GroupRole
  /** group_members.joined_at. 활성 그룹 선택 순서의 기준입니다. */
  joined_at: string
}

/** /status 의 한 줄: 그룹원 1명의 오늘 진행 상황. */
export type MemberTodayStatus = {
  userId: string
  displayName: string
  avatarEmoji: string
  /**
   * [0007] 이미 계산이 끝난 아바타. 화면은 이 값만 그리면 됩니다.
   *
   * ★ 왜 avatar_url 원본이 아니라 결과를 담는가 ★
   * 남의 행을 그릴 때 `resolveAvatar({ ..., userMetadata })` 를 부르는 실수를
   * 구조적으로 막기 위해서입니다. lib/tasks-queries.ts 의 memberAvatar() 에
   * 달린 긴 경고를 읽으세요 — 요약하면, 내 JWT 의 메타데이터를 남의 행에
   * 넘기면 내 사진이 친구 얼굴 자리에 붙습니다.
   *
   * ★ 옵셔널인 이유 ★ 이 필드를 아직 읽지 않는 화면(app/status/page.tsx)이
   * 그대로 컴파일돼야 하고, 0007 이 배포되지 않은 DB 에서는 avatar_url 을
   * 읽을 수 없어 이모지만 남습니다. 없으면 `avatarEmoji` 로 그리세요.
   * 런타임에는 이 함수가 언제나 채워 줍니다(최악의 경우 kind: 'emoji').
   */
  avatar?: ResolvedAvatar
  role: GroupRole
  /** 오늘 적은 할 일 총 개수. 0 이면 "아직 안 적었어요". */
  total: number
  /** 그중 done_at 이 채워진 개수. */
  done: number
  /** 본인 행인지. 콕 찌르기 버튼을 숨기는 데 씁니다(자기 자신에게는 못 보냅니다). */
  isMe: boolean
}

/**
 * 모든 Server Action 의 공통 반환값. 실패는 예외가 아니라 값입니다.
 *
 * ★ 왜 액션 파일이 아니라 여기에 있나 ★
 * app/tasks/actions.ts 는 'use server' 파일이고, 그런 파일은 async 함수 외의
 * export 를 허용하지 않습니다("Only async functions are allowed to be exported
 * in a 'use server' file"). 타입과 상수는 전부 이 모듈에 둡니다.
 */
export type ActionResult =
  | { ok: true; error?: undefined }
  | { ok: false; error: string }

/** addTask 만 성공 시 만들어진 행을 함께 돌려줍니다(낙관적 업데이트 정합용). */
export type AddTaskResult =
  | { ok: true; task: TodayTask; error?: undefined }
  | { ok: false; task?: undefined; error: string }

/** / (오늘) 페이지가 한 번에 필요로 하는 전부. */
export type TodayPageData = {
  /** null 이면 정상. 문자열이면 한국어 오류 메시지를 그대로 보여 주세요. */
  error: string | null
  /** 로그인하지 않았으면 null. */
  userId: string | null
  /** DB 가 계산한 내 로컬 오늘. 'YYYY-MM-DD'. */
  today: string
  groups: MyGroup[]
  /** groups 가 비어 있으면 null → "그룹에 먼저 참여해 주세요" 안내. */
  activeGroup: MyGroup | null
  tasks: TodayTask[]
  /** 연속 완료 일수. 계산 규칙은 calcStreak() 주석 참고. */
  streak: number
}

/** /status (현황) 페이지가 한 번에 필요로 하는 전부. */
export type StatusPageData = {
  error: string | null
  userId: string | null
  today: string
  groups: MyGroup[]
  activeGroup: MyGroup | null
  /** 완료율 내림차순 → 이름순. 빈 배열이면 멤버가 나뿐입니다. */
  members: MemberTodayStatus[]
}

/* --------------------------------------------------------------------------
 * 멤버 아바타 (0007) — /status 와 /groups 가 같은 배관을 씁니다
 * ------------------------------------------------------------------------ */

/** 멤버 목록 한 줄을 그리는 데 필요한 profiles 컬럼. `*` 는 42501 입니다. */
export type MemberAvatarProfile = {
  id: string
  display_name: string
  avatar_emoji: string
  /**
   * [0007] Storage 경로('<uuid>/<파일>.jpg') 또는 lh3 절대 URL.
   * 0007 미배포 DB 에서는 이 컬럼 없이 조회하므로 옵셔널입니다.
   */
  avatar_url?: string | null
}

/**
 * `supabase.from('profiles')` 의 최소 모양.
 *
 * ★ 캐스트가 필요한 이유 ★ lib/supabase/types.ts 는 제 소유가 아니고, 이 글을
 * 쓰는 시점의 profiles Row 에는 avatar_url 이 없습니다. 타입이 붙은 채로
 * `.select('… , avatar_url')` 을 쓰면 DB 에는 실재하는 컬럼 때문에 tsc 가
 * 깨집니다. types.ts 에 컬럼이 생기면 이 타입과 캐스트를 지우세요.
 * (app/page.tsx 의 getDefaultGroupId, app/me/page.tsx 가 같은 처방입니다.)
 */
export type ProfilesReader = {
  from: (table: string) => {
    select: (columns: string) => {
      in: (
        column: string,
        values: string[],
      ) => PromiseLike<{
        data: MemberAvatarProfile[] | null
        error: { code?: string | null; message?: string } | null
      }>
    }
  }
}

/* ==========================================================================
 * 제목 길이 — DB 제약과 같은 단위로 셉니다
 * ======================================================================== */

/** tasks_title_len_chk 와 동일한 상한. 입력창의 maxLength 에도 쓰세요. */
export const TASK_TITLE_MAX = 200

/** 문자열의 "글자 수". PG char_length 와 맞추려면 code point 단위여야 합니다. */
export function codePointLength(value: string): number {
  return Array.from(value).length
}
