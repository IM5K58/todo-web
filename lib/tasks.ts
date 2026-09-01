/**
 * lib/tasks.ts — 서버 전용 조회 계층 (Phase 2)
 *
 * ★ 이 파일은 Server Component / Server Action 에서만 import 하세요. ★
 * createClient() 가 next/headers 의 cookies() 를 쓰므로 클라이언트 번들에
 * 들어가면 빌드가 깨집니다.
 *
 * ---------------------------------------------------------------------------
 * 구성 (2026-09 리팩토링 — 동작은 그대로, 파일만 나눴습니다)
 * ---------------------------------------------------------------------------
 * 이 파일은 이제 **재수출 지점**입니다. 구현은 아래 다섯 모듈에 있습니다.
 * 앱 코드와 테스트는 계속 `@/lib/tasks` 에서 import 하면 됩니다 — 이름도
 * 시그니처도 쪼개기 전과 한 글자도 다르지 않습니다.
 *
 *   lib/tasks-model.ts      타입 · TASK_TITLE_MAX · codePointLength
 *                           (질의 없음. 서버 전용 아님)
 *   lib/db-error.ts         toKoreanDbError — PostgrestError 한국어 매핑
 *                           (질의 없음. 서버 전용 아님)
 *   lib/streak.ts           calcStreak · STREAK_WINDOW_DAYS · shiftDate
 *                           (순수 계산. tests/streak.test.ts 가 덮는 규칙)
 *   lib/tasks-queries.ts    Supabase 조회. ★ 서버 전용 ★
 *   lib/tasks-page-data.ts  getTodayPageData / getStatusPageData. ★ 서버 전용 ★
 *
 * 재수출하지 않는 것이 둘 있습니다. 쪼개기 전에도 모듈 내부 함수였으니
 * 공개 표면을 넓히지 않기 위해서입니다: streak.ts 의 shiftDate,
 * tasks-queries.ts 의 getMyTasksAndStreak.
 *
 * ---------------------------------------------------------------------------
 * 설계 규칙 (0001~0003 SQL 을 읽고 결정한 것들 — 기억이 아니라 SQL 이 근거)
 * ---------------------------------------------------------------------------
 * 1. "오늘"은 JS 가 만들지 않습니다.
 *    tasks.task_date 의 DEFAULT 는 public.current_user_local_date() 이고,
 *    그 함수는 profiles.timezone 기준으로 날짜를 계산합니다.
 *    new Date().toISOString().slice(0,10) 은 01:30 KST 에 "어제"를 돌려줍니다.
 *    그래서 오늘 날짜는 항상 rpc('current_user_local_date') 로 DB 에 물어봅니다.
 *    (0001_init.sql 3번 섹션)
 *
 * 2. select('*') 금지.
 *    profiles 는 0003 에서, groups 는 0002 에서 컬럼 단위 GRANT 로 좁혀졌습니다.
 *    '*' 를 보내면 42501 이 납니다. 필요한 컬럼만 이름으로 나열합니다.
 *    tasks 는 테이블 전체 SELECT 가 있지만(0002:135) 일관성을 위해 나열합니다.
 *
 * 3. 그룹 요약은 N+1 금지.
 *    0002 의 tasks_select_group_members 정책이 "같은 그룹 멤버의 tasks SELECT"를
 *    허용하므로(0002:309~318), 그룹 전체의 오늘 할 일을 한 번에 긁어와
 *    메모리에서 사용자별로 집계합니다. 멤버당 쿼리를 돌리지 않습니다.
 *
 * 4. 조회 함수는 예외를 던지지 않습니다.
 *    페이지 로더(get*PageData)는 { error: string | null, ... } 를 돌려주고,
 *    화면이 한국어 오류를 정직하게 렌더링합니다. 조용한 무시는 하지 않습니다.
 *
 * 5. 왕복은 세어서 관리합니다. 추측이 아니라 측정값이 근거입니다.
 *    Vercel 함수 → Supabase 왕복 1회 = 261~1431ms (대개 ~700ms). 내 PC(한국)
 *    에서 같은 DB 는 ~50ms 입니다. 차이는 무료 플랜 함수의 기본 리전이 미국
 *    이었기 때문이고 vercel.json 의 "regions": ["icn1"] 로 고정했지만, 그래도
 *    왕복 1회는 공짜가 아닙니다. 그래서 아래 두 가지를 구분해서 셉니다.
 *      · 질의 수      = Supabase 로 나가는 요청의 총 개수
 *      · 순차 왕복 수 = 서로 기다리는 "파(wave)"의 개수 = 실제 벽시계 지연
 *    병렬로 띄운 두 질의는 질의 2회지만 파는 1개입니다.
 *
 *    ┌──────────────────┬───────────────┬───────────────┐
 *    │                  │ 변경 전       │ 변경 후       │
 *    ├──────────────────┼───────────────┼───────────────┤
 *    │ getTodayPageData │ 파 4 / 질의 6 │ 파 2 / 질의 4 │
 *    │ getStatusPageData│ 파 6 / 질의 7 │ 파 4 / 질의 6 │
 *    └──────────────────┴───────────────┴───────────────┘
 *    (변경 후의 "파" 는 auth.getClaims() 가 JWKS 캐시에 적중한 경우입니다.
 *     캐시가 비어 있는 콜드 스타트에서는 각각 +1 파. 캐시는 프로세스 전역이고
 *     TTL 10분이라 따뜻한 인스턴스에서는 거의 항상 적중합니다.)
 *
 *    새 질의를 추가할 때는 "이게 앞의 결과를 정말 필요로 하는가"를 먼저 물어
 *    보세요. 아니면 Promise.all 로 같은 파에 넣으세요.
 */

/* ==========================================================================
 * 타입 · 상한 (lib/tasks-model.ts)
 * ======================================================================== */

export type {
  ActionResult,
  AddTaskResult,
  MemberAvatarProfile,
  MemberTodayStatus,
  MyGroup,
  ProfilesReader,
  StatusPageData,
  TodayPageData,
  TodayTask,
} from '@/lib/tasks-model'

export { TASK_TITLE_MAX, codePointLength } from '@/lib/tasks-model'

/* ==========================================================================
 * 한국어 오류 매핑 (lib/db-error.ts)
 * ======================================================================== */

export { toKoreanDbError } from '@/lib/db-error'

/* ==========================================================================
 * 스트릭 계산 (lib/streak.ts) — shiftDate 는 내부용이라 내보내지 않습니다
 * ======================================================================== */

export { STREAK_WINDOW_DAYS, calcStreak } from '@/lib/streak'

/* ==========================================================================
 * 조회 (lib/tasks-queries.ts) — getMyTasksAndStreak 는 내부용입니다
 * ======================================================================== */

export {
  fetchMemberProfiles,
  getGroupTodayStatus,
  getLocalToday,
  getMyGroups,
  getMyStreak,
  getMyTodayTasks,
  getSessionUserId,
} from '@/lib/tasks-queries'

/* ==========================================================================
 * 페이지 로더 (lib/tasks-page-data.ts)
 * ======================================================================== */

export { getStatusPageData, getTodayPageData } from '@/lib/tasks-page-data'
