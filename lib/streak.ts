/**
 * lib/streak.ts — 연속 완료 일수와 날짜 산술 (순수 계산)
 *
 * lib/tasks.ts 에서 갈라져 나온 조각입니다. 설계 규칙 전문은 lib/tasks.ts 머리말.
 *
 * ★ 이 모듈에는 질의가 없습니다 ★ 입력은 이미 읽어 온 행 배열과 날짜 문자열
 * 뿐이고, 출력은 숫자입니다. "지금"을 읽지 않습니다(shiftDate 주석 참고).
 * 그래서 tests/streak.test.ts 가 DB 없이 이 규칙 전체를 검증할 수 있습니다.
 */

/** 스트릭을 계산할 최대 과거 일수. 3~6명 앱이라 이 정도면 충분합니다. */
export const STREAK_WINDOW_DAYS = 120

/**
 * 'YYYY-MM-DD' 에서 n일을 뺍니다.
 *
 * ★ 여기서 Date 를 쓰는 것은 안전합니다 ★ — "지금"을 읽지 않기 때문입니다.
 * 입력은 DB 가 이미 사용자 시간대로 계산해 준 날짜 문자열이고, Date.UTC 로
 * 정오도 자정도 아닌 순수 UTC 자정을 만들어 하루(86400000ms)씩 빼기만 합니다.
 * 서머타임도 로컬 시간대도 개입하지 않습니다.
 * 금지된 것은 new Date() 로 "오늘"을 만드는 쪽이지 날짜 산술이 아닙니다.
 *
 * ★ lib/tasks.ts 는 이 함수를 재수출하지 않습니다 ★ 쪼개기 전에도 모듈
 * 내부 함수였습니다. 조회 계층(lib/tasks-queries.ts)이 스트릭 창의 시작일을
 * 만들 때만 씁니다.
 */
export function shiftDate(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map((part) => Number.parseInt(part, 10))
  const ms = Date.UTC(y, m - 1, d) + days * 86_400_000
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * 연속 완료 일수.
 *
 * ── 정의 (경계를 여기서 못 박습니다) ─────────────────────────────────────
 * "완료한 날" = 그날 task_date 로 적은 할 일이 1개 이상이고, 그 전부가
 *               done_at is not null 인 날.
 *
 * 1) 오늘이 "완료한 날"이면 오늘부터 세기 시작합니다.
 * 2) 오늘이 아직 미완료이거나 오늘 적은 할 일이 0개면, 오늘은 세지 않고
 *    어제부터 셉니다. ★ 오늘 때문에 스트릭이 0으로 떨어지면 안 됩니다 ★
 *    (아침 9시에 앱을 열었더니 어제까지 12일이 0일이 되어 있는 것이
 *     이 기능을 죽이는 가장 확실한 방법입니다.)
 * 3) 할 일을 하나도 안 적은 과거의 날은 스트릭을 끊습니다. "적지 않은 날"과
 *    "적고 다 못 한 날"을 구분하지 않습니다 — 둘 다 그날은 실패입니다.
 *    (예외는 오직 오늘뿐이고, 그 이유는 2번입니다.)
 * 4) 조회 창은 STREAK_WINDOW_DAYS 일입니다. 그보다 긴 연속 기록은 창 끝에서
 *    잘려 최대 그 값으로 보고됩니다. 캐시 테이블은 만들지 않습니다.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 그룹은 구분하지 않습니다. 여러 그룹에 적은 할 일도 "그날의 내 할 일"입니다.
 */
export function calcStreak(
  rows: { task_date: string; done_at: string | null }[],
  today: string
): number {
  // 날짜별 (총 개수, 완료 개수)
  const byDate = new Map<string, { total: number; done: number }>()
  for (const row of rows) {
    const bucket = byDate.get(row.task_date) ?? { total: 0, done: 0 }
    bucket.total += 1
    if (row.done_at !== null) bucket.done += 1
    byDate.set(row.task_date, bucket)
  }

  const isComplete = (date: string): boolean => {
    const bucket = byDate.get(date)
    return bucket !== undefined && bucket.total > 0 && bucket.done === bucket.total
  }

  // 규칙 1·2: 오늘이 완료면 오늘부터, 아니면 어제부터.
  let cursor = isComplete(today) ? today : shiftDate(today, -1)
  let streak = 0

  while (streak < STREAK_WINDOW_DAYS && isComplete(cursor)) {
    streak += 1
    cursor = shiftDate(cursor, -1)
  }

  return streak
}
