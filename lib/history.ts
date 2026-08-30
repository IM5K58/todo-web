/**
 * lib/history.ts — /history (내 기록) 전용 조회·집계 계층
 *
 * ★ 이 파일은 Server Component / Server Action 에서만 import 하세요. ★
 * createClient() 가 next/headers 의 cookies() 를 쓰므로 클라이언트 번들에
 * 들어가면 빌드가 깨집니다.
 *
 * ---------------------------------------------------------------------------
 * 왜 lib/tasks.ts 가 아니라 별도 파일인가
 * ---------------------------------------------------------------------------
 * lib/tasks.ts 는 "오늘"만 봅니다. 기록 화면은 반년치를 봅니다. 쿼리 모양도
 * 실패 모드도(행 상한, 페이지네이션, 창 잘림) 다르기 때문에 조회는 여기에
 * 새로 씁니다. 다만 **판정 규칙은 절대 새로 만들지 않습니다** —
 * "완료한 날"의 정의와 현재 스트릭은 lib/tasks.ts 의 calcStreak() 를 그대로
 * 재사용합니다. 두 화면이 같은 사람의 같은 날을 다르게 판정하면 그 순간
 * 둘 다 신뢰를 잃습니다.
 *
 * ---------------------------------------------------------------------------
 * 이 파일이 지키는 규칙
 * ---------------------------------------------------------------------------
 * 1. "오늘"은 JS 가 만들지 않습니다. lib/tasks.ts 의 getLocalToday() 를 부르고,
 *    그건 rpc('current_user_local_date') 입니다 — tasks.task_date 의 DEFAULT 와
 *    같은 함수입니다. new Date().toISOString() 은 01:30 KST 에 어제를 줍니다.
 *
 * 2. 날짜별 쿼리 금지. 왕복 1회가 261~1431ms(대개 ~700ms)입니다. 180일치를
 *    날짜마다 돌면 그 자체로 화면이 죽습니다. 필요한 두 컬럼(task_date,
 *    done_at)만 한 번에 긁어와 JS 에서 Map 으로 집계합니다.
 *
 * 3. 조회 범위 상한 HISTORY_WINDOW_DAYS(180일). 화면이 이 사실을 표시합니다.
 *
 * 4. 조회 함수는 예외를 던지지 않습니다. { error: string | null } 로 돌려주고
 *    화면이 한국어 오류를 정직하게 렌더링합니다.
 *
 * 5. select('*') 금지. tasks 는 테이블 전체 SELECT 권한이 있지만(0002:135)
 *    다른 조회 계층과 일관되게 컬럼을 나열합니다.
 */

import { createClient } from '@/lib/supabase/server'
import { STREAK_WINDOW_DAYS, calcStreak, toKoreanDbError } from '@/lib/tasks'

/* ==========================================================================
 * 상수
 * ======================================================================== */

/**
 * 히트맵과 요약이 보는 과거 일수(오늘 포함).
 *
 * 왜 상한이 필요한가: 이 쿼리에는 상한이 없으면 계정 나이만큼 자랍니다.
 * 180일이면 달력 카드 7개(부분 달 포함) 정도라 스크롤로 읽을 수 있고,
 * 행 수도 한 번의 왕복에 대체로 들어갑니다.
 *
 * ★ 현재 스트릭은 이 창이 아니라 lib/tasks.ts 의 STREAK_WINDOW_DAYS(120일)에서
 * 잘립니다 ★ — 홈 화면과 숫자가 달라지면 안 되므로 계산을 통째로 재사용하기
 * 때문입니다. 최장 스트릭만 이 창(180일) 안에서 셉니다. 그래서 최장 ≥ 현재가
 * 항상 성립합니다(현재는 120에서 잘리고 최장은 그보다 길게 셀 수 있으므로).
 */
export const HISTORY_WINDOW_DAYS = 180

/**
 * 한 번의 왕복으로 가져올 행 수.
 *
 * Supabase 는 PostgREST 의 max-rows 를 기본 1000 으로 둡니다. 그 상한에
 * 걸리면 응답이 조용히 잘리고, 잘린 쪽은 화면에서 "그날은 아무것도 안 적었네"
 * 로 보입니다 — 없는 실패보다 나쁜 거짓말입니다. 그래서 count: 'exact' 로
 * 전체 행 수를 함께 받아, 받은 행이 모자라면 그때만 다음 페이지를 부릅니다.
 * 보통 사용자는 페이지 1개(왕복 1회)로 끝납니다.
 */
const PAGE_SIZE = 1000

/** 페이지 상한. 3 x 1000 = 180일 동안 하루 16개까지. 넘으면 truncated 로 알립니다. */
const MAX_PAGES = 3

/** 요일 헤더용. 한국 달력은 일요일 시작입니다. */
export const WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'] as const

/* ==========================================================================
 * 타입
 * ======================================================================== */

/** 집계에 필요한 최소 단위. calcStreak() 의 입력과 같은 모양입니다. */
export type HistoryRow = {
  /** 'YYYY-MM-DD'. DB 가 정한 값입니다. */
  task_date: string
  /** NULL = 미완료. */
  done_at: string | null
}

/** 하루치 집계. */
export type DayCount = {
  total: number
  done: number
}

/** 달력 한 칸. */
export type HistoryDay = {
  /** 'YYYY-MM-DD'. */
  date: string
  dayOfMonth: number
  total: number
  done: number
  /** 조회 창(180일) 이전이거나 오늘 이후. 칸은 자리만 잡고 비워 둡니다. */
  outOfRange: boolean
  isToday: boolean
}

/** 7칸 고정. null 은 그 달에 속하지 않는 칸(요일 정렬용 여백)입니다. */
export type HistoryWeek = (HistoryDay | null)[]

export type HistoryMonth = {
  /** 'YYYY-MM'. React key 로 씁니다. */
  key: string
  year: number
  /** 1~12. */
  month: number
  /** '2026년 8월'. */
  label: string
  weeks: HistoryWeek[]
}

export type HistorySummary = {
  /** 창 안에서 적은 할 일 총 개수. */
  totalTasks: number
  /** 그중 끝낸 개수. */
  totalDone: number
  /** 적은 게 1개 이상이고 전부 끝낸 날의 수. */
  perfectDays: number
  /** 할 일을 1개라도 적은 날의 수. */
  recordedDays: number
  /** 홈 화면과 같은 값(lib/tasks.ts calcStreak). 최대 STREAK_WINDOW_DAYS. */
  currentStreak: number
  /** 창 안에서의 최장 연속. */
  longestStreak: number
}

/** 하루를 펼쳐 볼 때 쓰는 한 줄. 읽기 전용입니다. */
export type HistoryTask = {
  id: string
  title: string
  done: boolean
}

/** /history 화면이 한 번에 필요로 하는 전부. */
export type HistoryPageData = {
  /** null 이면 정상. 문자열이면 한국어 오류를 그대로 보여 주세요. */
  error: string | null
  /** 로그인하지 않았으면 null. */
  userId: string | null
  /** DB 가 계산한 내 로컬 오늘. 'YYYY-MM-DD'. */
  today: string
  /** 실제로 집계된 첫날. 보통 today - 179. */
  from: string
  /** 화면에 표시할 창 길이. */
  windowDays: number
  /** 행 상한에 걸려 from 이전을 못 읽었으면 true. 화면이 그렇다고 말해야 합니다. */
  truncated: boolean
  /** 최신 달이 앞에 옵니다. */
  months: HistoryMonth[]
  summary: HistorySummary
  /** ?d=YYYY-MM-DD 로 펼쳐 본 날짜. 없으면 null. */
  selectedDate: string | null
  selectedTasks: HistoryTask[]
  /** 그날 목록만 실패했을 때. 나머지 화면은 그대로 살아 있습니다. */
  selectedError: string | null
}

/* ==========================================================================
 * 날짜 유틸 (전부 순수 함수)
 *
 * ★ 여기서 Date 를 쓰는 것은 안전합니다 ★ — "지금"을 읽지 않기 때문입니다.
 * 입력은 DB 가 이미 사용자 시간대로 계산해 준 날짜 문자열이고, Date.UTC 로
 * 순수 UTC 자정을 만들어 하루(86400000ms)씩 더하고 뺄 뿐입니다. 서머타임도
 * 로컬 시간대도 개입하지 않습니다. 금지된 것은 new Date() 로 "오늘"을 만드는
 * 쪽이지 날짜 산술이 아닙니다. (lib/tasks.ts 의 shiftDate 와 같은 근거)
 * ======================================================================== */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

function parts(isoDate: string): [number, number, number] {
  const [y, m, d] = isoDate.split('-').map((part) => Number.parseInt(part, 10))
  return [y, m, d]
}

/** 'YYYY-MM-DD' 에 n일을 더합니다(음수면 뺍니다). */
export function shiftDate(isoDate: string, days: number): string {
  const [y, m, d] = parts(isoDate)
  const ms = Date.UTC(y, m - 1, d) + days * 86_400_000
  return new Date(ms).toISOString().slice(0, 10)
}

/** 그 달의 마지막 날짜. (year, month=1~12) */
export function daysInMonth(year: number, month: number): number {
  // Date.UTC(y, month, 0) = 그 달의 0일 = 전달의 마지막 날.
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** 0=일요일 … 6=토요일. 달력 정렬의 기준입니다. */
export function weekdayIndex(isoDate: string): number {
  const [y, m, d] = parts(isoDate)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/**
 * 'YYYY-MM-DD' 이면서 실제로 존재하는 날짜인지.
 *
 * 정규식만으로는 '2026-02-31' 과 '2026-13-01' 이 통과합니다. 이 값은 URL
 * 쿼리스트링(?d=)에서 오므로 형태만 믿을 수 없습니다.
 */
export function isIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false
  const [y, m, d] = parts(value)
  if (!Number.isFinite(y) || y < 1970 || y > 9999) return false
  if (m < 1 || m > 12) return false
  return d >= 1 && d <= daysInMonth(y, m)
}

/* ==========================================================================
 * 집계 (전부 순수 함수 — 다른 에이전트가 테스트할 수 있게 export)
 * ======================================================================== */

/** 날짜별 (총 개수, 완료 개수). 행 순서에 의존하지 않습니다. */
export function tallyByDate(rows: HistoryRow[]): Map<string, DayCount> {
  const byDate = new Map<string, DayCount>()
  for (const row of rows) {
    const bucket = byDate.get(row.task_date) ?? { total: 0, done: 0 }
    bucket.total += 1
    if (row.done_at !== null) bucket.done += 1
    byDate.set(row.task_date, bucket)
  }
  return byDate
}

/** 그날이 "완주한 날"인가. lib/tasks.ts calcStreak 의 판정과 같은 정의입니다. */
export function isPerfectDay(count: DayCount | undefined): boolean {
  return count !== undefined && count.total > 0 && count.done === count.total
}

/**
 * 최장 연속 완주 일수.
 *
 * ── 정의 (calcStreak 와 같은 "완료한 날"을 씁니다) ────────────────────────
 * "완주한 날" = 그날 적은 할 일이 1개 이상이고 전부 done_at is not null.
 *
 * 1. 완주한 날들만 남겨 오름차순으로 훑고, 하루씩 이어지는 구간의 최대 길이.
 * 2. 적지 않은 날과 적고 다 못 한 날은 똑같이 구간을 끊습니다.
 *    (calcStreak 규칙 3 과 동일 — 다르게 판정하면 두 숫자가 서로를 배신합니다.)
 * 3. today 를 주면 그 이후(미래) 날짜는 세지 않습니다. 백필이나 시간대 착오로
 *    내일 날짜 행이 섞여 들어와도 기록이 부풀지 않습니다.
 *    ★ calcStreak 와 달리 "오늘은 아직 진행 중이니 봐준다" 예외는 없습니다 ★ —
 *    최장 기록은 이미 지나간 사실이라 진행 중인 오늘을 봐줄 이유가 없고,
 *    오늘을 끝내면 그때 자연히 반영됩니다.
 * 4. 창 밖(호출자가 넘기지 않은 과거)은 셀 수 없으므로, 이 값은 넘겨받은
 *    rows 의 범위 안에서의 최댓값입니다.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 그룹은 구분하지 않습니다. 여러 그룹에 적은 할 일도 "그날의 내 할 일"입니다.
 */
export function calcLongestStreak(rows: HistoryRow[], today?: string): number {
  const byDate = tallyByDate(rows)

  const perfectDates: string[] = []
  for (const [date, count] of byDate) {
    if (today !== undefined && date > today) continue
    if (isPerfectDay(count)) perfectDates.push(date)
  }

  // 'YYYY-MM-DD' 는 사전순 = 시간순입니다.
  perfectDates.sort()

  let longest = 0
  let run = 0
  let previous: string | null = null

  for (const date of perfectDates) {
    run = previous !== null && shiftDate(date, -1) === previous ? run + 1 : 1
    previous = date
    if (run > longest) longest = run
  }

  return longest
}

/**
 * 요약 4종.
 *
 * currentStreak 은 여기서 다시 정의하지 않고 lib/tasks.ts 의 calcStreak 을
 * 그대로 부릅니다. 홈 화면의 🔥 배지와 이 화면의 "현재 연속"은 반드시 같은
 * 숫자여야 합니다 — 다르면 사용자는 둘 중 어느 쪽도 못 믿습니다.
 */
export function buildHistorySummary(rows: HistoryRow[], today: string): HistorySummary {
  const byDate = tallyByDate(rows)

  let totalTasks = 0
  let totalDone = 0
  let perfectDays = 0
  let recordedDays = 0

  for (const [date, count] of byDate) {
    if (date > today) continue // 미래 행은 집계하지 않습니다.
    if (count.total === 0) continue
    recordedDays += 1
    totalTasks += count.total
    totalDone += count.done
    if (isPerfectDay(count)) perfectDays += 1
  }

  return {
    totalTasks,
    totalDone,
    perfectDays,
    recordedDays,
    currentStreak: calcStreak(rows, today),
    longestStreak: calcLongestStreak(rows, today),
  }
}

/**
 * 히트맵 농도 0~4.
 *
 *   0 = 할 일을 적지 않은 날      (accent 를 아예 쓰지 않습니다 — 점선 테두리)
 *   1 = 적었지만 거의 못 끝낸 날  (0% 포함)
 *   2 = 절반쯤
 *   3 = 거의 다
 *   4 = 전부 끝낸 날              (accent 원색)
 *
 * ★ 0 과 1 의 차이가 이 화면의 핵심입니다 ★ — "쉰 날"과 "적었는데 못 끝낸 날"은
 * 전혀 다른 사실입니다. 그래서 둘의 차이를 투명도가 아니라 "accent 가 있는가
 * 없는가"로 만듭니다(화면 쪽 LEVEL_CLASS 참고). 옅은 색 두 단계로 구분하면
 * 야외 화면이나 색각 이상에서 그냥 같은 칸이 됩니다.
 */
export function heatLevel(day: { total: number; done: number }): 0 | 1 | 2 | 3 | 4 {
  if (day.total <= 0) return 0
  const ratio = day.done / day.total
  if (ratio >= 1) return 4
  if (ratio >= 2 / 3) return 3
  if (ratio >= 1 / 3) return 2
  return 1
}

/**
 * 달력 격자.
 *
 * - 일요일 시작(한국 달력 관례). 첫 주의 앞칸은 null 로 채워 요일을 맞춥니다.
 * - 마지막 주도 7칸으로 채웁니다. 그래야 grid-cols-7 가 어긋나지 않습니다.
 * - 표시할 달의 범위: **기록이 있는 가장 오래된 달 ~ 오늘의 달**.
 *   창이 180일이라고 무조건 달력 7개를 그리면, 어제 가입한 사람에게 텅 빈
 *   여섯 달을 보여 주게 됩니다. 그건 정보가 아니라 낙담입니다.
 * - 반환 순서는 **최신 달이 먼저**입니다. 모바일에서 스크롤 없이 이번 달이
 *   보여야 합니다.
 */
export function buildCalendar(
  counts: Map<string, DayCount>,
  from: string,
  today: string,
): HistoryMonth[] {
  let earliest: string | null = null
  for (const [date, count] of counts) {
    if (count.total === 0) continue
    if (date < from || date > today) continue
    if (earliest === null || date < earliest) earliest = date
  }

  const start = earliest ?? today
  const [startYear, startMonth] = parts(start)
  const [endYear, endMonth] = parts(today)

  const months: HistoryMonth[] = []
  let year = startYear
  let month = startMonth

  // earliest 는 [from, today] 안에서만 고르므로 시작 달 <= 오늘 달이 보장됩니다.
  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push(buildMonth(year, month, counts, from, today))
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }

  return months.reverse()
}

function buildMonth(
  year: number,
  month: number,
  counts: Map<string, DayCount>,
  from: string,
  today: string,
): HistoryMonth {
  const key = `${year}-${pad2(month)}`
  const last = daysInMonth(year, month)
  const lead = weekdayIndex(`${key}-01`)

  const cells: (HistoryDay | null)[] = Array.from({ length: lead }, () => null)

  for (let d = 1; d <= last; d += 1) {
    const date = `${key}-${pad2(d)}`
    const count = counts.get(date)
    cells.push({
      date,
      dayOfMonth: d,
      total: count?.total ?? 0,
      done: count?.done ?? 0,
      outOfRange: date < from || date > today,
      isToday: date === today,
    })
  }

  while (cells.length % 7 !== 0) cells.push(null)

  const weeks: HistoryWeek[] = []
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7))
  }

  return { key, year, month, label: `${year}년 ${month}월`, weeks }
}

/* ==========================================================================
 * 조회
 * ======================================================================== */

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

type WindowFetch = {
  rows: HistoryRow[]
  /** 행 상한에 걸려 더 못 읽었으면 true. */
  truncated: boolean
  /** truncated 일 때 "여기부터는 믿을 수 있다"는 첫날. 아니면 null. */
  coveredFrom: string | null
  error: string | null
}

/**
 * 창 하한을 JS 로 **넉넉하게** 잡습니다.
 *
 * ★ 이건 "오늘"을 JS 로 계산하는 것이 아닙니다 ★ — 진짜 오늘은 DB 의
 * current_user_local_date() 가 정하고, 이 값은 그 결과가 도착하기 전에 쿼리를
 * 같이 출발시키기 위한 **하한**일 뿐입니다. 받아 온 행은 나중에 진짜 today 로
 * [today-179, today] 에 다시 잘립니다.
 *
 * 왜 이렇게까지 하나: 오늘 날짜를 기다렸다가 범위 쿼리를 보내면 왕복이 직렬로
 * 두 번(약 1.4초)입니다. 하한을 미리 잡으면 두 쿼리가 동시에 출발해 한 번(약
 * 0.7초)으로 끝납니다.
 *
 * 시간대 오차 방어: 서울 기준 날짜는 어떤 IANA 존과도 최대 하루 차이입니다.
 * 그래서 이틀치 여유(+1)를 더 뺍니다. 하한은 조금 넉넉해도 아무 해가 없고
 * (뒤에서 자르니까), 모자라면 가장 오래된 하루가 통째로 사라집니다.
 */
function provisionalWindowStart(): string {
  const seoulToday = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())

  return shiftDate(seoulToday, -(HISTORY_WINDOW_DAYS + 1))
}

/**
 * 창 전체의 (task_date, done_at) 을 가져옵니다.
 *
 * 보통은 왕복 1회입니다. count: 'exact' 로 받은 전체 행 수가 가져온 행보다
 * 많을 때만 다음 페이지를 부릅니다. max-rows 가 몇으로 설정돼 있든(1000 이든
 * 500 이든) count 와 비교하므로 조용히 잘리지 않습니다.
 *
 * 페이지네이션에는 전순서(total order)가 필요합니다. task_date 만으로 정렬하면
 * 같은 날짜 안에서의 순서가 정해지지 않아 페이지 경계에서 행이 중복되거나
 * 빠질 수 있습니다. id 를 2차 정렬 키로 붙여 순서를 확정합니다.
 */
async function fetchWindowRows(
  supabase: SupabaseServerClient,
  userId: string,
  lowerBound: string,
): Promise<WindowFetch> {
  const rows: HistoryRow[] = []
  let expected: number | null = null

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const start = page * PAGE_SIZE

    const { data, error, count } = await supabase
      .from('tasks')
      .select('task_date, done_at', { count: 'exact' })
      .eq('user_id', userId)
      .gte('task_date', lowerBound)
      .order('task_date', { ascending: false })
      .order('id', { ascending: false })
      .range(start, start + PAGE_SIZE - 1)

    if (error) {
      return {
        rows: [],
        truncated: false,
        coveredFrom: null,
        error: toKoreanDbError(error, '기록을 불러오지 못했습니다.'),
      }
    }

    rows.push(...(data ?? []))
    if (typeof count === 'number') expected = count

    // 다 읽었거나, 더 줄 게 없거나.
    if ((data?.length ?? 0) === 0) break
    if (expected !== null && rows.length >= expected) break
    if (page === MAX_PAGES - 1) {
      // 상한 소진. 가장 오래된 날짜는 그 하루가 통째로 읽혔다는 보장이 없으므로
      // 아예 버립니다. "3개 중 1개만 했네"라고 잘못 그리는 것보다 낫습니다.
      let oldest: string | null = null
      for (const row of rows) {
        if (oldest === null || row.task_date < oldest) oldest = row.task_date
      }
      const cut = oldest
      return {
        rows: cut === null ? rows : rows.filter((row) => row.task_date > cut),
        truncated: true,
        coveredFrom: cut === null ? null : shiftDate(cut, 1),
        error: null,
      }
    }
  }

  return { rows, truncated: false, coveredFrom: null, error: null }
}

/**
 * 하루치 할 일 목록. 달력의 한 칸을 눌렀을 때만 부릅니다.
 *
 * 이게 이 화면에서 유일하게 "날짜 하나"를 겨냥하는 쿼리이고, 사용자가 실제로
 * 탭했을 때만, 그리고 창 전체 쿼리와 **동시에** 나갑니다. 달력을 그리려고
 * 날짜마다 도는 것과는 다릅니다.
 */
async function fetchDayTasks(
  supabase: SupabaseServerClient,
  userId: string,
  date: string,
): Promise<{ tasks: HistoryTask[]; error: string | null }> {
  const { data, error } = await supabase
    .from('tasks')
    .select('id, title, done_at')
    .eq('user_id', userId)
    .eq('task_date', date)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })

  if (error) {
    return { tasks: [], error: toKoreanDbError(error, '그날 할 일을 불러오지 못했습니다.') }
  }

  return {
    tasks: (data ?? []).map((row) => ({
      id: row.id,
      title: row.title,
      done: row.done_at !== null,
    })),
    error: null,
  }
}

/* ==========================================================================
 * 페이지 로더 (Server Component 가 부르는 진입점)
 *
 * 절대 throw 하지 않습니다. error 가 문자열이면 그대로 화면에 보여 주세요.
 * ======================================================================== */

/**
 * /history 화면 데이터.
 *
 * 왕복 횟수(보통):
 *   1. getClaims()  — 대칭키가 아니면 로컬 검증이라 네트워크 0회
 *   2. Promise.all([ rpc('current_user_local_date'), tasks 창 조회,
 *                    (탭했다면) 그날 목록 ])  — 동시에 나가므로 체감 1회
 *
 * @param selectedDate ?d= 로 받은 값. 검증은 여기서 합니다(URL 은 못 믿습니다).
 */
export async function getHistoryPageData(
  selectedDate?: string,
): Promise<HistoryPageData> {
  const empty: HistoryPageData = {
    error: null,
    userId: null,
    today: '',
    from: '',
    windowDays: HISTORY_WINDOW_DAYS,
    truncated: false,
    months: [],
    summary: {
      totalTasks: 0,
      totalDone: 0,
      perfectDays: 0,
      recordedDays: 0,
      currentStreak: 0,
      longestStreak: 0,
    },
    selectedDate: null,
    selectedTasks: [],
    selectedError: null,
  }

  const supabase = await createClient()

  // getClaims() 는 JWT 서명을 검증합니다. getSession() 은 쿠키를 그대로
  // 되돌려줄 뿐이라 인가 검사가 아닙니다.
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims()
  const userId = claimsData?.claims.sub

  if (claimsError || typeof userId !== 'string' || !userId) {
    return { ...empty, error: '로그인이 필요합니다.' }
  }

  const wanted =
    typeof selectedDate === 'string' && isIsoDate(selectedDate) ? selectedDate : null

  const [today, windowResult, dayResult] = await Promise.all([
    getLocalTodayForHistory(supabase),
    fetchWindowRows(supabase, userId, provisionalWindowStart()),
    wanted ? fetchDayTasks(supabase, userId, wanted) : Promise.resolve(null),
  ])

  if (windowResult.error) {
    return { ...empty, userId, today, from: today, error: windowResult.error }
  }

  // 진짜 오늘이 도착했으니 여기서 창을 정확히 자릅니다.
  const windowFrom = shiftDate(today, -(HISTORY_WINDOW_DAYS - 1))
  const from =
    windowResult.coveredFrom !== null && windowResult.coveredFrom > windowFrom
      ? windowResult.coveredFrom
      : windowFrom

  const rows = windowResult.rows.filter(
    (row) => row.task_date >= from && row.task_date <= today,
  )

  const counts = tallyByDate(rows)

  // 미래 날짜를 눌러 보려는 시도는 조용히 무시합니다(달력이 링크를 만들지
  // 않지만 URL 은 직접 칠 수 있습니다).
  const selected = wanted !== null && wanted <= today ? wanted : null

  return {
    error: null,
    userId,
    today,
    from,
    windowDays: HISTORY_WINDOW_DAYS,
    truncated: windowResult.truncated,
    months: buildCalendar(counts, from, today),
    summary: buildHistorySummary(rows, today),
    selectedDate: selected,
    selectedTasks: selected !== null ? (dayResult?.tasks ?? []) : [],
    selectedError: selected !== null ? (dayResult?.error ?? null) : null,
  }
}

/**
 * 내 로컬 오늘 ('YYYY-MM-DD').
 *
 * lib/tasks.ts 의 getLocalToday() 와 같은 RPC 를 부르되, 이미 만들어 둔
 * 클라이언트를 재사용합니다(그쪽은 자기 클라이언트를 새로 만듭니다).
 * 폴백도 같은 값이라 두 화면이 어긋나지 않습니다.
 *
 * ★ tasks.task_date 의 DEFAULT 와 같은 함수입니다 ★ — 그래서 여기서 얻은
 * 날짜는 방금 INSERT 된 행의 task_date 와 반드시 일치합니다.
 */
async function getLocalTodayForHistory(supabase: SupabaseServerClient): Promise<string> {
  const { data, error } = await supabase.rpc('current_user_local_date')

  if (error || typeof data !== 'string') {
    // 조회 필터로만 쓰이므로 최악의 경우 "하루가 밀려 보임"입니다.
    // 이 값으로 INSERT 하는 경로는 이 화면에 없습니다.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date())
  }

  return data
}

/** 화면이 "120일+" 같은 표기를 만들 때 씁니다. 홈 화면과 같은 상한입니다. */
export { STREAK_WINDOW_DAYS }
