import { messageFor } from '@/lib/search-params'

import type { StatusErrCode, StatusOkCode } from './actions'

/**
 * /status 의 배너 문구 전부. 화면을 그리는 코드에서 떼어 낸 것뿐이고, 문구도
 * 코드도 page.tsx 에 있던 것과 글자 하나 같습니다.
 *
 * ★ 왜 문구가 한 파일에 모이는가 ★ 세 종류(`?ok=` · `?err=` · `?dg=`)가 모두
 * "URL 파라미터를 한국어 한 문장으로" 라는 같은 일을 하고, 셋 다 유니온에
 * 키가 묶여 있어 코드가 늘면 여기서 타입 에러가 납니다. 그 성질이 이 파일의
 * 존재 이유라, 문구를 화면 쪽에 흩어 두면 셋 중 하나만 빠뜨리기 쉬워집니다.
 */

// ---------------------------------------------------------------------------
// 콕 찌르기 — ./actions.ts 의 유니온
// ---------------------------------------------------------------------------

/**
 * Keyed by the unions ./actions.ts exports, so adding a code there breaks this
 * file until it has Korean copy. That is the point.
 */
const OK_MESSAGES: Record<StatusOkCode, string> = {
  sent: '콕 찔렀어요. 알림이 갔어요.',
  sent_pushoff:
    '콕 찔렀어요. 다만 그 친구는 아직 알림을 켜두지 않아서, 앱을 열어야 볼 수 있어요.',
  sent_undelivered:
    '콕 찔렀어요. 알림을 보내지는 못했어요. 그 친구가 앱을 열면 확인할 수 있어요.',
}

const ERR_MESSAGES: Record<StatusErrCode, string> = {
  auth: '로그인이 풀렸어요. 앱을 새로고침한 뒤 다시 시도해 주세요.',
  badrequest: '요청이 올바르지 않아요. 화면을 새로고침한 뒤 다시 시도해 주세요.',
  notmember: '같은 그룹이 아니에요. 화면을 새로고침해 주세요.',
  self: '자기 자신은 찌를 수 없어요.',
  ratehour: '방금 찔렀어요. 같은 사람은 한 시간에 한 번만 찌를 수 있어요.',
  rateday: '오늘은 이미 세 번 찔렀어요. 내일 다시 시도해 주세요.',
  notdeployed: '찌르기 기능이 아직 서버에 적용되지 않았어요. 잠시 후 다시 시도해 주세요.',
  fail: '찌르지 못했어요. 잠시 후 다시 시도해 주세요.',
}

/** `?ok=` 의 한국어 문구. 모르는 코드면 null. */
export function nudgeOkMessage(raw: string | string[] | undefined): string | null {
  return messageFor<StatusOkCode>(OK_MESSAGES, raw)
}

/** `?err=` 의 한국어 문구. 모르는 코드면 null. */
export function nudgeErrMessage(raw: string | string[] | undefined): string | null {
  return messageFor<StatusErrCode>(ERR_MESSAGES, raw)
}

// ---------------------------------------------------------------------------
// 기본 그룹 고정 — `?dg=`
// ---------------------------------------------------------------------------

/**
 * [0007] `?dg=` — the outcome of the 기본 그룹 고정 toggle.
 *
 * ★ Why a third parameter and not another `?ok=` / `?err=` code ★
 * Those two are keyed by the unions ./actions.ts exports, and that file is
 * 콕 찌르기's. Squeezing pin outcomes into them would mean either editing a
 * union this feature does not own, or accepting a code that renders as `null`
 * on the day someone reorders things. A separate parameter also means a pin and
 * a nudge can never overwrite each other's banner.
 *
 * ★ Why the type is exported, and why page.tsx re-exports it ★
 * app/status/default-group-actions.ts is a `'use server'` file, and such files
 * may export nothing but async functions — the union cannot live there. It used
 * to live in app/status/page.tsx and the action `import type`s it from './page';
 * that import still resolves because page.tsx re-exports this type verbatim
 * (`export type { DefaultGroupCode } from './messages'`). The re-export is
 * erased at compile time, so there is no runtime cycle, and default-group-
 * actions.ts — which this feature does not own — did not have to change.
 *
 * Either way the property this codebase relies on everywhere else holds: adding
 * a code on one side stops the other side type-checking until it has Korean
 * copy.
 */
export type DefaultGroupCode =
  /** default_group_id now points at the group on screen. */
  | 'pinned'
  /** The pin was cleared; the first joined group opens again. */
  | 'unpinned'
  /** No verified session reached Postgres. */
  | 'e_auth'
  /** The form did not carry a usable uuid. A bug here, not user error. */
  | 'e_badrequest'
  /** 0007 is not on this database / not in PostgREST's schema cache yet. */
  | 'e_notdeployed'
  /**
   * set_default_group raised P0002 — the UPDATE matched 0 rows because there is
   * no `profiles` row for me at all (0001's `handle_new_user` failed and 0002's
   * `profiles_insert_self` safety valve has not run yet). 0007 raises rather
   * than reporting a 0-row UPDATE as success, so this must not be folded into
   * `e_fail`: "잠시 후 다시" is the wrong advice for a state that will never fix
   * itself on its own.
   */
  | 'e_noprofile'
  /** Anything else. */
  | 'e_fail'

export const DEFAULT_GROUP_MESSAGES: Record<DefaultGroupCode, string> = {
  pinned: '이 그룹을 기본으로 고정했어요. 이제 현황을 열면 이 그룹이 먼저 보여요.',
  unpinned: '고정을 해제했어요. 이제 처음 들어간 그룹이 먼저 보여요.',
  e_auth: '로그인이 풀렸어요. 앱을 새로고침한 뒤 다시 시도해 주세요.',
  e_badrequest: '요청이 올바르지 않아요. 화면을 새로고침한 뒤 다시 시도해 주세요.',
  e_notdeployed: '기본 그룹 고정이 아직 서버에 적용되지 않았어요. 잠시 후 다시 시도해 주세요.',
  e_noprofile: '프로필을 찾지 못했어요. 로그아웃한 뒤 다시 로그인해 주세요.',
  e_fail: '기본 그룹을 바꾸지 못했어요. 잠시 후 다시 시도해 주세요.',
}

/** `pinned` / `unpinned` are good news; every `e_` code is not. */
export function isDefaultGroupError(code: DefaultGroupCode): boolean {
  return code.startsWith('e_')
}

/** The `?dg=` code, if it is one we know. Unknown codes render nothing. */
export function defaultGroupCode(
  raw: string | string[] | undefined,
): DefaultGroupCode | null {
  if (typeof raw !== 'string') return null
  return Object.prototype.hasOwnProperty.call(DEFAULT_GROUP_MESSAGES, raw)
    ? (raw as DefaultGroupCode)
    : null
}
