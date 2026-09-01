/**
 * lib/tasks-page-data.ts — 페이지 로더 (Server Component 가 부르는 진입점)
 *
 * ★ 이 모듈은 Server Component / Server Action 에서만 import 하세요. ★
 * lib/tasks-queries.ts 를 거쳐 createClient() 를 쓰므로 클라이언트 번들에
 * 들어가면 빌드가 깨집니다.
 *
 * 절대 throw 하지 않습니다. error 가 문자열이면 그대로 화면에 보여 주세요.
 *
 * ── 왕복은 세어서 관리합니다 (lib/tasks.ts 머리말 5번) ────────────────────
 *    ┌──────────────────┬───────────────┬───────────────┐
 *    │                  │ 변경 전       │ 변경 후       │
 *    ├──────────────────┼───────────────┼───────────────┤
 *    │ getTodayPageData │ 파 4 / 질의 6 │ 파 2 / 질의 4 │
 *    │ getStatusPageData│ 파 6 / 질의 7 │ 파 4 / 질의 6 │
 *    └──────────────────┴───────────────┴───────────────┘
 *    (변경 후의 "파" 는 auth.getClaims() 가 JWKS 캐시에 적중한 경우입니다.
 *     캐시가 비어 있는 콜드 스타트에서는 각각 +1 파.)
 *
 * 새 질의를 추가할 때는 "이게 앞의 결과를 정말 필요로 하는가"를 먼저 물어
 * 보세요. 아니면 Promise.all 로 같은 파에 넣으세요.
 */

import type { StatusPageData, TodayPageData } from '@/lib/tasks-model'
import {
  getGroupTodayStatus,
  getLocalToday,
  getMyGroups,
  getMyTasksAndStreak,
  getSessionUserId,
} from '@/lib/tasks-queries'

/** / (오늘) 화면 데이터. */
export async function getTodayPageData(
  preferredGroupId?: string
): Promise<TodayPageData> {
  const empty: TodayPageData = {
    error: null,
    userId: null,
    today: '',
    groups: [],
    activeGroup: null,
    tasks: [],
    streak: 0,
  }

  const userId = await getSessionUserId()
  if (!userId) {
    return { ...empty, error: '로그인이 필요합니다.' }
  }

  /**
   * ── 순차 왕복 4회 → 2회, 질의 6회 → 4회 ─────────────────────────────────
   * 예전 순서:
   *   1) getSessionUserId  → auth.getUser()      네트워크 1회
   *   2) await getLocalToday()                   ← 혼자 한 파를 다 잡아먹음
   *   3) [group_members, tasks, streak]
   *   4) groups            (getMyGroups 의 두 번째 질의)
   *
   * getLocalToday() 는 getMyGroups() 와 서로 아무 관계가 없는데도 앞에서
   * 통째로 기다리고 있었습니다. /status 는 이미 이 둘을 Promise.all 로 묶어
   * 뒀는데(아래) 여기만 빠져 있었습니다. 같은 모양으로 맞춥니다.
   *
   * 지금 순서:
   *   1) getSessionUserId  → auth.getClaims()    JWKS 캐시 적중 시 네트워크 0회
   *   2) [current_user_local_date rpc | group_members]
   *   3) [내 할 일 창(오늘+스트릭 한 방) | groups]
   *
   * 두 갈래가 서로를 기다리지 않는 게 핵심입니다. 그래서 `Promise.all([today,
   * groups])` 로 묶고 나서 tasks 를 부르면 안 됩니다 — 그러면 tasks 가 관계도
   * 없는 groups 질의까지 기다려서 파가 3개가 됩니다. 아래처럼 "오늘 → 내 할 일"
   * 갈래를 하나의 async 함수로 만들어 groups 갈래와 통째로 병렬시켜야
   * 2)와 3)에 각각 두 질의가 나란히 들어갑니다.
   */
  const ownTasksBranch = async () => {
    const today = await getLocalToday()
    return { today, ...(await getMyTasksAndStreak(userId, today)) }
  }

  const [{ groups, error: groupError }, own] = await Promise.all([
    getMyGroups(userId),
    ownTasksBranch(),
  ])

  const activeGroup =
    groups.find((g) => g.id === preferredGroupId) ?? groups[0] ?? null

  return {
    error: groupError ?? own.error,
    userId,
    today: own.today,
    groups,
    activeGroup,
    tasks: own.tasks,
    streak: own.streak,
  }
}

/** /status (현황) 화면 데이터. */
export async function getStatusPageData(
  preferredGroupId?: string
): Promise<StatusPageData> {
  const empty: StatusPageData = {
    error: null,
    userId: null,
    today: '',
    groups: [],
    activeGroup: null,
    members: [],
  }

  const userId = await getSessionUserId()
  if (!userId) {
    return { ...empty, error: '로그인이 필요합니다.' }
  }

  /**
   * 이 둘은 서로 의존하지 않는다. 순차로 await 하면 화면이 뜨기까지
   * 왕복이 한 번 더 늘어난다 (탭 전환 때 체감되는 지연).
   *
   * ── 순차 왕복 6회 → 4회, 질의 7회 → 6회 ─────────────────────────────────
   * 여기(로더)는 이미 옳게 묶여 있었다. 줄어든 건 두 군데다:
   *   - getSessionUserId 가 getUser()(항상 네트워크) → getClaims()(JWKS 캐시
   *     적중 시 네트워크 0회) 로 바뀌어 맨 앞의 한 파가 사라졌다.
   *   - getGroupTodayStatus 안에서 tasks 질의가 group_members 와 병렬이 됐다.
   *
   * 남은 파:
   *   1) [rpc | group_members]  2) [groups]
   *   3) [그룹 group_members | 그룹 tasks]  4) [profiles]
   *
   * 2)를 더 줄이려면 activeGroup 을 membership 행만으로 고르고 groups 이름
   * 조회를 화면 렌더와 겹쳐야 하는데, 그러려면 getMyGroups 의 반환 모양을
   * 바꿔야 한다. lib/history.ts 가 이 시그니처를 쓰므로 하지 않는다.
   */
  const [today, { groups, error: groupError }] = await Promise.all([
    getLocalToday(),
    getMyGroups(userId),
  ])

  if (groupError) {
    return { ...empty, userId, today, error: groupError }
  }

  const activeGroup =
    groups.find((g) => g.id === preferredGroupId) ?? groups[0] ?? null

  if (!activeGroup) {
    return { ...empty, userId, today, groups, activeGroup: null }
  }

  const { members, error } = await getGroupTodayStatus(activeGroup.id, today, userId)

  return { error, userId, today, groups, activeGroup, members }
}
