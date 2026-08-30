import { describe, expect, it } from 'vitest'

import {
  HISTORY_WINDOW_DAYS,
  STREAK_WINDOW_DAYS,
  WEEKDAY_LABELS,
  buildCalendar,
  buildHistorySummary,
  calcLongestStreak,
  daysInMonth,
  heatLevel,
  isIsoDate,
  isPerfectDay,
  shiftDate,
  tallyByDate,
  weekdayIndex,
} from '@/lib/history'
import type { DayCount, HistoryDay, HistoryMonth, HistoryRow } from '@/lib/history'
import { calcStreak } from '@/lib/tasks'

/**
 * tests/history.test.ts — lib/history.ts 의 순수 함수 전부.
 *
 * lib/history.ts 의 조회 계층(fetchWindowRows / getHistoryPageData)은 Supabase
 * 클라이언트를 잡으므로 여기서 건드리지 않습니다. 대신 그 계층이 얇게 감싸고
 * 있는 **집계·달력·날짜 산술**은 전부 순수 함수로 export 되어 있어 모킹 한 줄
 * 없이 검증할 수 있습니다. 이 파일은 그쪽만 봅니다.
 *
 * lib/history.ts 가 못 박은 규칙을 그대로 테스트로 옮깁니다:
 *   1. "완주한 날" = 그날 적은 할 일이 1개 이상이고 전부 done_at != null.
 *      (lib/tasks.ts calcStreak 와 **같은** 정의여야 합니다.)
 *   2. 최장 스트릭에는 "오늘은 진행 중이니 봐준다" 예외가 없습니다.
 *      단, today 이후(미래) 날짜는 세지 않습니다.
 *   3. 달력은 일요일 시작. 첫 주 앞칸과 마지막 주 뒷칸은 null 로 채워
 *      모든 주가 정확히 7칸입니다.
 *   4. 조회 창은 HISTORY_WINDOW_DAYS(180)일, 현재 스트릭은 그와 별개로
 *      STREAK_WINDOW_DAYS(120)일에서 잘립니다.
 */

/* ==========================================================================
 * 픽스처 헬퍼
 *
 * 날짜 산술은 shiftDate 로 하지 않습니다 — 그 함수도 이 파일의 검증 대상이라
 * 자기 자신으로 기대값을 만들면 같이 틀려도 알 수 없습니다. Date.UTC 로
 * 독립적으로 만듭니다.
 * ======================================================================== */

/** 완료된 할 일 n개. done_at 값 자체는 "null 이 아니다"만 의미가 있습니다. */
function doneDay(date: string, count = 1): HistoryRow[] {
  return Array.from({ length: count }, () => ({
    task_date: date,
    done_at: `${date}T12:00:00.000Z`,
  }))
}

/** 미완료 할 일 n개. */
function openDay(date: string, count = 1): HistoryRow[] {
  return Array.from({ length: count }, () => ({ task_date: date, done_at: null }))
}

/** 같은 날 완료 done 개 + 미완료 open 개. */
function mixedDay(date: string, done: number, open: number): HistoryRow[] {
  return [...doneDay(date, done), ...openDay(date, open)]
}

/** shiftDate 와 독립적인 날짜 산술. 기대값 계산 전용. */
function plusDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d) + days * 86_400_000).toISOString().slice(0, 10)
}

/** endDate 부터 과거로 n일 연속 완주. (endDate 포함) */
function consecutiveDone(endDate: string, days: number): HistoryRow[] {
  const rows: HistoryRow[] = []
  for (let i = 0; i < days; i += 1) {
    rows.push(...doneDay(plusDays(endDate, -i)))
  }
  return rows
}

/** { '2026-08-30': [총, 완료] } -> Map. buildCalendar 입력용. */
function countMap(entries: Record<string, [number, number]>): Map<string, DayCount> {
  return new Map(
    Object.entries(entries).map(([date, [total, done]]) => [date, { total, done }]),
  )
}

function monthByKey(months: HistoryMonth[], key: string): HistoryMonth {
  const found = months.find((m) => m.key === key)
  if (!found) {
    throw new Error(`달력에 ${key} 가 없습니다. 있는 달: ${months.map((m) => m.key).join(', ')}`)
  }
  return found
}

/** 주 구분을 없앤 42(또는 28/35)칸 배열. */
function cells(month: HistoryMonth): (HistoryDay | null)[] {
  return month.weeks.flat()
}

function cellByDate(month: HistoryMonth, date: string): HistoryDay {
  const found = cells(month).find((c) => c !== null && c.date === date)
  if (!found) throw new Error(`${month.key} 에 ${date} 칸이 없습니다.`)
  return found
}

/** 첫 칸부터 연속된 null 개수 = 그 달 1일 앞의 여백. */
function leadingBlanks(month: HistoryMonth): number {
  let n = 0
  for (const cell of cells(month)) {
    if (cell !== null) break
    n += 1
  }
  return n
}

/** 마지막 칸부터 거슬러 연속된 null 개수. */
function trailingBlanks(month: HistoryMonth): number {
  let n = 0
  const flat = cells(month)
  for (let i = flat.length - 1; i >= 0; i -= 1) {
    if (flat[i] !== null) break
    n += 1
  }
  return n
}

/* ==========================================================================
 * 1. 날짜 산술 — shiftDate / daysInMonth / weekdayIndex
 *
 * 달력 오프셋 계산의 바닥입니다. 여기가 하루 어긋나면 위의 모든 것이
 * 조용히 하루씩 밀립니다.
 * ======================================================================== */

describe('shiftDate', () => {
  it('0일은 그대로', () => {
    expect(shiftDate('2026-08-30', 0)).toBe('2026-08-30')
  })

  it('하루 앞뒤', () => {
    expect(shiftDate('2026-08-30', 1)).toBe('2026-08-31')
    expect(shiftDate('2026-08-30', -1)).toBe('2026-08-29')
  })

  it('월 경계 (8-31 -> 9-01, 9-01 -> 8-31)', () => {
    expect(shiftDate('2026-08-31', 1)).toBe('2026-09-01')
    expect(shiftDate('2026-09-01', -1)).toBe('2026-08-31')
  })

  it('연 경계 (2025-12-31 -> 2026-01-01)', () => {
    expect(shiftDate('2025-12-31', 1)).toBe('2026-01-01')
    expect(shiftDate('2026-01-01', -1)).toBe('2025-12-31')
  })

  it('윤년 2월 29일을 건너뛰지 않는다 (2024-02-28 -> 02-29 -> 03-01)', () => {
    expect(shiftDate('2024-02-28', 1)).toBe('2024-02-29')
    expect(shiftDate('2024-02-29', 1)).toBe('2024-03-01')
    expect(shiftDate('2024-03-01', -1)).toBe('2024-02-29')
  })

  it('평년에는 2월 29일이 없다 (2026-02-28 -> 03-01)', () => {
    expect(shiftDate('2026-02-28', 1)).toBe('2026-03-01')
    expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('창 하한 계산: -179 하면 오늘 포함 정확히 180일', () => {
    const today = '2026-08-30'
    const from = shiftDate(today, -(HISTORY_WINDOW_DAYS - 1))
    expect(from).toBe('2026-03-04')

    // from 부터 하루씩 더해 today 에 닿기까지 179번 = 총 180일.
    let steps = 0
    let cursor = from
    while (cursor !== today) {
      cursor = shiftDate(cursor, 1)
      steps += 1
      if (steps > 400) throw new Error('창 하한이 today 에 닿지 않습니다.')
    }
    expect(steps).toBe(HISTORY_WINDOW_DAYS - 1)
  })

  it('DST 전환일을 삼키거나 겹치지 않는다 (UTC 자정 산술이므로)', () => {
    // 로컬 시간대의 23시간/25시간짜리 하루에 끌려가면 3-08 이 사라지거나
    // 두 번 나옵니다.
    expect(shiftDate('2026-03-07', 1)).toBe('2026-03-08')
    expect(shiftDate('2026-03-08', 1)).toBe('2026-03-09')
    expect(shiftDate('2026-11-01', 1)).toBe('2026-11-02')
  })
})

describe('daysInMonth', () => {
  it('31일 달', () => {
    expect(daysInMonth(2026, 1)).toBe(31)
    expect(daysInMonth(2026, 8)).toBe(31)
    expect(daysInMonth(2026, 12)).toBe(31)
  })

  it('30일 달', () => {
    expect(daysInMonth(2026, 4)).toBe(30)
    expect(daysInMonth(2026, 11)).toBe(30)
  })

  it('평년 2월은 28일', () => {
    expect(daysInMonth(2026, 2)).toBe(28)
    expect(daysInMonth(2025, 2)).toBe(28)
  })

  it('윤년 2월은 29일', () => {
    expect(daysInMonth(2024, 2)).toBe(29)
    expect(daysInMonth(2028, 2)).toBe(29)
  })

  it('100년 규칙: 1900 은 평년, 2000 은 윤년', () => {
    expect(daysInMonth(1900, 2)).toBe(28)
    expect(daysInMonth(2000, 2)).toBe(29)
  })
})

describe('weekdayIndex — 0=일 … 6=토', () => {
  it('2026-08-30 은 일요일(0)', () => {
    expect(weekdayIndex('2026-08-30')).toBe(0)
  })

  it('한 주를 통째로 훑으면 0..6 이 순서대로 나온다', () => {
    const week = [
      '2026-08-30', // 일
      '2026-08-31', // 월
      '2026-09-01', // 화
      '2026-09-02', // 수
      '2026-09-03', // 목
      '2026-09-04', // 금
      '2026-09-05', // 토
    ]
    expect(week.map(weekdayIndex)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('★ 2026-02-01 은 일요일 — 달력 앞 여백이 0칸인 달 ★', () => {
    expect(weekdayIndex('2026-02-01')).toBe(0)
  })

  it('★ 2026-08-01 은 토요일 — 달력 앞 여백이 6칸인 달 ★', () => {
    expect(weekdayIndex('2026-08-01')).toBe(6)
  })

  it('로컬 시간대에 끌려가지 않는다 (UTC 기준 고정)', () => {
    // getDay() 였다면 UTC-x 환경에서 하루 밀립니다.
    expect(weekdayIndex('2000-01-01')).toBe(6) // 토요일
    expect(weekdayIndex('1970-01-01')).toBe(4) // 목요일
  })

  it('WEEKDAY_LABELS 는 일요일 시작 7개', () => {
    expect(WEEKDAY_LABELS).toHaveLength(7)
    expect(WEEKDAY_LABELS[0]).toBe('일')
    expect(WEEKDAY_LABELS[6]).toBe('토')
  })
})

describe('isIsoDate — ?d= 쿼리스트링은 못 믿는다', () => {
  it('정상적인 날짜는 통과', () => {
    expect(isIsoDate('2026-08-30')).toBe(true)
    expect(isIsoDate('2024-02-29')).toBe(true) // 윤년
    expect(isIsoDate('1970-01-01')).toBe(true)
  })

  it('★ 형태는 맞지만 존재하지 않는 날짜는 거부 ★', () => {
    expect(isIsoDate('2026-02-29')).toBe(false) // 평년
    expect(isIsoDate('2026-02-31')).toBe(false)
    expect(isIsoDate('2026-04-31')).toBe(false) // 4월은 30일까지
    expect(isIsoDate('2026-13-01')).toBe(false)
    expect(isIsoDate('2026-00-10')).toBe(false)
    expect(isIsoDate('2026-08-00')).toBe(false)
    expect(isIsoDate('2026-08-32')).toBe(false)
  })

  it('형식이 어긋나면 거부', () => {
    expect(isIsoDate('')).toBe(false)
    expect(isIsoDate('2026-8-30')).toBe(false) // 0 패딩 없음
    expect(isIsoDate('26-08-30')).toBe(false)
    expect(isIsoDate('2026/08/30')).toBe(false)
    expect(isIsoDate('2026-08-30T00:00:00Z')).toBe(false)
    expect(isIsoDate('오늘')).toBe(false)
    expect(isIsoDate('2026-08-30 ')).toBe(false) // 뒤 공백
  })

  it('연도 하한 밖은 거부 (1969 이하)', () => {
    expect(isIsoDate('1969-12-31')).toBe(false)
    expect(isIsoDate('0001-01-01')).toBe(false)
  })

  it('던지지 않는다 — 어떤 쓰레기가 와도 boolean 이 나온다', () => {
    for (const junk of ['--', '9999-99-99', 'null', '0000-00-00', '２０２６-０８-３０']) {
      expect(() => isIsoDate(junk)).not.toThrow()
      expect(typeof isIsoDate(junk)).toBe('boolean')
    }
  })
})

/* ==========================================================================
 * 2. 날짜별 집계 — tallyByDate / isPerfectDay
 * ======================================================================== */

describe('tallyByDate', () => {
  it('기록이 없으면 빈 Map', () => {
    expect(tallyByDate([]).size).toBe(0)
  })

  it('같은 날 여러 할 일을 하나로 모은다', () => {
    const map = tallyByDate(doneDay('2026-08-30', 4))
    expect(map.size).toBe(1)
    expect(map.get('2026-08-30')).toEqual({ total: 4, done: 4 })
  })

  it('완료·미완료가 섞이면 total 과 done 이 갈린다', () => {
    const map = tallyByDate(mixedDay('2026-08-30', 2, 3))
    expect(map.get('2026-08-30')).toEqual({ total: 5, done: 2 })
  })

  it('전부 미완료면 done 은 0 (그래도 total 은 남는다)', () => {
    const map = tallyByDate(openDay('2026-08-30', 3))
    expect(map.get('2026-08-30')).toEqual({ total: 3, done: 0 })
  })

  it('★ 할 일이 0개인 날은 키 자체가 없다 ★ — "쉰 날"과 "0/3"은 다른 사실', () => {
    const map = tallyByDate([...doneDay('2026-08-30'), ...doneDay('2026-08-28')])
    expect(map.has('2026-08-29')).toBe(false)
    expect(map.get('2026-08-29')).toBeUndefined()
    expect(map.size).toBe(2)
  })

  it('여러 날이 서로 섞이지 않는다', () => {
    const map = tallyByDate([
      ...mixedDay('2026-08-30', 1, 1),
      ...doneDay('2026-08-29', 3),
      ...openDay('2026-08-28', 2),
    ])
    expect(map.get('2026-08-30')).toEqual({ total: 2, done: 1 })
    expect(map.get('2026-08-29')).toEqual({ total: 3, done: 3 })
    expect(map.get('2026-08-28')).toEqual({ total: 2, done: 0 })
  })

  it('행 순서에 의존하지 않는다', () => {
    const ordered = [...mixedDay('2026-08-30', 2, 1), ...doneDay('2026-08-29')]
    const shuffled = [ordered[3], ordered[1], ordered[2], ordered[0]]
    expect(Object.fromEntries(tallyByDate(shuffled))).toEqual(
      Object.fromEntries(tallyByDate(ordered)),
    )
  })

  it('여러 그룹의 할 일도 "그날의 내 할 일"로 합친다', () => {
    // group_id 는 아예 보지 않습니다. 같은 날이면 한 칸입니다.
    const rows: HistoryRow[] = [
      { task_date: '2026-08-30', done_at: '2026-08-30T10:00:00.000Z' },
      { task_date: '2026-08-30', done_at: null },
    ]
    expect(tallyByDate(rows).get('2026-08-30')).toEqual({ total: 2, done: 1 })
  })
})

describe('isPerfectDay — calcStreak 와 같은 "완료한 날" 정의', () => {
  it('적지 않은 날(undefined)은 완주가 아니다', () => {
    expect(isPerfectDay(undefined)).toBe(false)
  })

  it('total 0 은 완주가 아니다 — 0/0 을 100% 로 치지 않는다', () => {
    expect(isPerfectDay({ total: 0, done: 0 })).toBe(false)
  })

  it('전부 끝낸 날만 완주', () => {
    expect(isPerfectDay({ total: 1, done: 1 })).toBe(true)
    expect(isPerfectDay({ total: 5, done: 5 })).toBe(true)
  })

  it('하나라도 남으면 완주가 아니다', () => {
    expect(isPerfectDay({ total: 5, done: 4 })).toBe(false)
    expect(isPerfectDay({ total: 1, done: 0 })).toBe(false)
  })
})

/* ==========================================================================
 * 3. 최장 스트릭 — calcLongestStreak
 * ======================================================================== */

describe('calcLongestStreak — 기본', () => {
  it('기록이 0일이면 0', () => {
    expect(calcLongestStreak([], '2026-08-30')).toBe(0)
  })

  it('완주한 날이 하나도 없으면 0 (적기만 하고 못 끝낸 날들)', () => {
    const rows = [
      ...openDay('2026-08-30', 2),
      ...mixedDay('2026-08-29', 1, 1),
      ...openDay('2026-08-28'),
    ]
    expect(calcLongestStreak(rows, '2026-08-30')).toBe(0)
  })

  it('하루짜리 구간은 1', () => {
    expect(calcLongestStreak(doneDay('2026-05-14'), '2026-08-30')).toBe(1)
  })

  it('★ 전부 끊긴 경우(하루씩 띄엄띄엄)는 1 ★ — 합산되지 않는다', () => {
    const rows = [
      ...doneDay('2026-08-30'),
      // 8-29 없음
      ...doneDay('2026-08-28'),
      // 8-27 없음
      ...doneDay('2026-08-26'),
      // 8-25 없음
      ...doneDay('2026-08-24'),
    ]
    expect(calcLongestStreak(rows, '2026-08-30')).toBe(1)
  })

  it('연속 구간이 여러 개면 가장 긴 것', () => {
    const rows = [
      ...consecutiveDone('2026-08-30', 3), // 8-28 ~ 8-30 : 3일
      // 8-27 없음
      ...consecutiveDone('2026-08-26', 7), // 8-20 ~ 8-26 : 7일  ★ 최장 ★
      // 8-19 미완료로 끊김
      ...openDay('2026-08-19'),
      ...consecutiveDone('2026-08-18', 5), // 8-14 ~ 8-18 : 5일
    ]
    expect(calcLongestStreak(rows, '2026-08-30')).toBe(7)
  })

  it('가장 긴 구간이 맨 앞(가장 오래된 쪽)에 있어도 찾아낸다', () => {
    const rows = [
      ...consecutiveDone('2026-08-30', 2),
      ...consecutiveDone('2026-06-10', 11), // ★ 최장 ★
      ...consecutiveDone('2026-07-15', 4),
    ]
    expect(calcLongestStreak(rows, '2026-08-30')).toBe(11)
  })

  it('행 순서를 뒤집어도 결과가 같다', () => {
    const rows = [
      ...consecutiveDone('2026-08-30', 3),
      ...consecutiveDone('2026-08-26', 7),
    ]
    expect(calcLongestStreak([...rows].reverse(), '2026-08-30')).toBe(
      calcLongestStreak(rows, '2026-08-30'),
    )
    expect(calcLongestStreak([...rows].reverse(), '2026-08-30')).toBe(7)
  })

  it('적지 않은 날과 적고 다 못 한 날은 똑같이 구간을 끊는다', () => {
    const gap = [...doneDay('2026-08-30'), ...doneDay('2026-08-28')] // 8-29 없음
    const partial = [
      ...doneDay('2026-08-30'),
      ...mixedDay('2026-08-29', 1, 1), // 적었지만 다 못 함
      ...doneDay('2026-08-28'),
    ]
    expect(calcLongestStreak(gap, '2026-08-30')).toBe(1)
    expect(calcLongestStreak(partial, '2026-08-30')).toBe(1)
  })

  it('월·연 경계를 넘어 이어진다', () => {
    const rows = [
      ...doneDay('2026-01-02'),
      ...doneDay('2026-01-01'),
      ...doneDay('2025-12-31'),
      ...doneDay('2025-12-30'),
    ]
    expect(calcLongestStreak(rows, '2026-01-02')).toBe(4)
  })

  it('윤년 2월 29일을 건너뛰지 않는다', () => {
    const rows = [
      ...doneDay('2024-03-01'),
      ...doneDay('2024-02-29'),
      ...doneDay('2024-02-28'),
    ]
    expect(calcLongestStreak(rows, '2024-03-01')).toBe(3)
  })
})

describe('calcLongestStreak — 오늘이 진행 중인 구간에 포함될 때', () => {
  it('오늘까지 완주했으면 오늘도 구간에 들어간다', () => {
    const rows = consecutiveDone('2026-08-30', 5)
    expect(calcLongestStreak(rows, '2026-08-30')).toBe(5)
  })

  it('★ 오늘이 아직 미완료면 최장은 어제까지만 센다 ★', () => {
    // calcStreak 와 달리 "오늘은 봐준다" 예외가 없습니다. 최장 기록은 이미
    // 지나간 사실이라 진행 중인 오늘을 얹어 줄 이유가 없습니다.
    const rows = [...openDay('2026-08-30', 2), ...consecutiveDone('2026-08-29', 6)]
    expect(calcLongestStreak(rows, '2026-08-30')).toBe(6)
  })

  it('오늘 할 일을 아직 안 적었어도 어제까지의 구간이 최장으로 남는다', () => {
    const rows = consecutiveDone('2026-08-29', 6) // 오늘(8-30) 행 자체가 없음
    expect(calcLongestStreak(rows, '2026-08-30')).toBe(6)
  })

  it('오늘을 마저 끝내면 최장이 하루 늘어난다 (6 -> 7)', () => {
    const before = [...openDay('2026-08-30'), ...consecutiveDone('2026-08-29', 6)]
    const after = consecutiveDone('2026-08-30', 7)
    expect(calcLongestStreak(before, '2026-08-30')).toBe(6)
    expect(calcLongestStreak(after, '2026-08-30')).toBe(7)
  })

  it('진행 중인 구간이 과거 최고 기록보다 짧으면 과거 기록이 이긴다', () => {
    const rows = [
      ...consecutiveDone('2026-08-30', 3), // 진행 중 3일
      ...consecutiveDone('2026-07-01', 9), // 과거 9일 ★
    ]
    expect(calcLongestStreak(rows, '2026-08-30')).toBe(9)
  })
})

describe('calcLongestStreak — 미래 날짜', () => {
  it('today 를 주면 그 이후 행은 세지 않는다', () => {
    const rows = [
      ...doneDay('2026-09-02'), // 미래
      ...doneDay('2026-09-01'), // 미래
      ...doneDay('2026-08-31'), // 미래
      ...consecutiveDone('2026-08-30', 2),
    ]
    expect(calcLongestStreak(rows, '2026-08-30')).toBe(2)
  })

  it('미래 행이 과거 구간과 이어져 보여도 부풀지 않는다', () => {
    const rows = consecutiveDone('2026-09-05', 10) // 8-27 ~ 9-05
    // today 가 8-30 이면 8-27 ~ 8-30 의 4일까지만 인정됩니다.
    expect(calcLongestStreak(rows, '2026-08-30')).toBe(4)
  })

  it('today 를 생략하면 상한 없이 rows 전체를 센다 (호출자가 이미 잘랐을 때)', () => {
    const rows = consecutiveDone('2026-09-05', 10)
    expect(calcLongestStreak(rows)).toBe(10)
  })
})

describe('calcLongestStreak — 창 상한(180일) 경계', () => {
  const today = '2026-08-30'
  const from = plusDays(today, -(HISTORY_WINDOW_DAYS - 1))

  it('HISTORY_WINDOW_DAYS 는 180일이고 STREAK_WINDOW_DAYS(120)보다 넓다', () => {
    expect(HISTORY_WINDOW_DAYS).toBe(180)
    expect(STREAK_WINDOW_DAYS).toBe(120)
    expect(HISTORY_WINDOW_DAYS).toBeGreaterThan(STREAK_WINDOW_DAYS)
  })

  it('창을 정확히 가득 채운 연속 기록은 180 으로 보고된다', () => {
    const rows = consecutiveDone(today, HISTORY_WINDOW_DAYS)
    expect(rows[rows.length - 1].task_date).toBe(from)
    expect(calcLongestStreak(rows, today)).toBe(HISTORY_WINDOW_DAYS)
  })

  it('창보다 긴 기록도, 호출자가 창으로 자른 뒤라면 180 을 넘지 않는다', () => {
    // getHistoryPageData 는 rows.filter(task_date >= from) 로 자른 뒤 넘깁니다.
    const raw = consecutiveDone(today, HISTORY_WINDOW_DAYS + 60)
    const clipped = raw.filter((row) => row.task_date >= from)
    expect(calcLongestStreak(clipped, today)).toBe(HISTORY_WINDOW_DAYS)
  })

  it('창 경계 하루 안쪽(179일)은 그대로 179', () => {
    const rows = consecutiveDone(today, HISTORY_WINDOW_DAYS - 1)
    expect(calcLongestStreak(rows, today)).toBe(HISTORY_WINDOW_DAYS - 1)
  })

  it('★ 최장은 창(180) 안에서 세므로 현재(120 상한)보다 길 수 있다 ★', () => {
    // 150일 연속. 현재 스트릭은 STREAK_WINDOW_DAYS 에서 잘리고, 최장은 안 잘립니다.
    const rows = consecutiveDone(today, 150)
    expect(calcStreak(rows, today)).toBe(STREAK_WINDOW_DAYS)
    expect(calcLongestStreak(rows, today)).toBe(150)
    expect(calcLongestStreak(rows, today)).toBeGreaterThan(calcStreak(rows, today))
  })
})

describe('calcLongestStreak — calcStreak 와 판정이 갈리지 않는다', () => {
  const today = '2026-08-30'

  it('최장 >= 현재 가 항상 성립한다 (여러 형태에 대해)', () => {
    const cases: HistoryRow[][] = [
      [],
      doneDay(today),
      openDay(today),
      consecutiveDone(today, 12),
      [...openDay(today), ...consecutiveDone(plusDays(today, -1), 12)],
      [...mixedDay(today, 1, 1), ...consecutiveDone(plusDays(today, -1), 3)],
      [...consecutiveDone(today, 2), ...consecutiveDone(plusDays(today, -5), 20)],
      [...doneDay(today), ...openDay(plusDays(today, -1)), ...consecutiveDone(plusDays(today, -2), 9)],
    ]

    for (const rows of cases) {
      expect(calcLongestStreak(rows, today)).toBeGreaterThanOrEqual(calcStreak(rows, today))
    }
  })

  it('두 함수가 같은 날을 완주로 본다 (부분 완료는 양쪽 모두 실패)', () => {
    const rows = [
      ...mixedDay(today, 3, 1), // 오늘은 미완료
      ...doneDay(plusDays(today, -1), 2),
      ...mixedDay(plusDays(today, -2), 1, 1), // 여기서 양쪽 다 끊겨야 함
      ...doneDay(plusDays(today, -3)),
    ]
    expect(calcStreak(rows, today)).toBe(1)
    expect(calcLongestStreak(rows, today)).toBe(1)
  })
})

/* ==========================================================================
 * 4. 요약 — buildHistorySummary
 * ======================================================================== */

describe('buildHistorySummary', () => {
  const today = '2026-08-30'

  it('기록이 0일이면 전부 0', () => {
    expect(buildHistorySummary([], today)).toEqual({
      totalTasks: 0,
      totalDone: 0,
      perfectDays: 0,
      recordedDays: 0,
      currentStreak: 0,
      longestStreak: 0,
    })
  })

  it('같은 날 여러 할 일이 개수로 합산된다', () => {
    const summary = buildHistorySummary(mixedDay(today, 2, 3), today)
    expect(summary.totalTasks).toBe(5)
    expect(summary.totalDone).toBe(2)
    expect(summary.recordedDays).toBe(1)
    expect(summary.perfectDays).toBe(0)
  })

  it('완료/미완료가 섞인 여러 날을 정확히 센다', () => {
    const rows = [
      ...doneDay(today, 2), // 완주
      ...mixedDay(plusDays(today, -1), 1, 2), // 3개 중 1개
      ...openDay(plusDays(today, -2), 4), // 4개 중 0개
      ...doneDay(plusDays(today, -3), 1), // 완주
    ]
    const summary = buildHistorySummary(rows, today)
    expect(summary.totalTasks).toBe(10)
    expect(summary.totalDone).toBe(4)
    expect(summary.recordedDays).toBe(4)
    expect(summary.perfectDays).toBe(2)
  })

  it('★ 할 일이 0개인 날은 recordedDays 에 들어가지 않는다 ★', () => {
    // 8-29 는 행이 아예 없습니다. "쉰 날"은 기록한 날이 아닙니다.
    const rows = [...doneDay(today), ...doneDay(plusDays(today, -2))]
    const summary = buildHistorySummary(rows, today)
    expect(summary.recordedDays).toBe(2)
    expect(summary.perfectDays).toBe(2)
  })

  it('미래 행은 집계에서 빠진다', () => {
    const rows = [
      ...doneDay('2026-09-01', 5), // 미래 — 세면 안 됨
      ...doneDay(today, 2),
    ]
    const summary = buildHistorySummary(rows, today)
    expect(summary.totalTasks).toBe(2)
    expect(summary.totalDone).toBe(2)
    expect(summary.recordedDays).toBe(1)
    expect(summary.perfectDays).toBe(1)
    expect(summary.longestStreak).toBe(1)
  })

  it('★ currentStreak 은 홈 화면(calcStreak)과 글자 그대로 같은 값 ★', () => {
    const rows = [...openDay(today), ...consecutiveDone(plusDays(today, -1), 12)]
    expect(buildHistorySummary(rows, today).currentStreak).toBe(calcStreak(rows, today))
    expect(buildHistorySummary(rows, today).currentStreak).toBe(12)
  })

  it('longestStreak 은 calcLongestStreak 과 같은 값', () => {
    const rows = [
      ...consecutiveDone(today, 3),
      ...consecutiveDone(plusDays(today, -5), 8),
    ]
    const summary = buildHistorySummary(rows, today)
    expect(summary.longestStreak).toBe(calcLongestStreak(rows, today))
    expect(summary.longestStreak).toBe(8)
    expect(summary.currentStreak).toBe(3)
  })

  it('totalDone 은 절대 totalTasks 를 넘지 않는다', () => {
    const rows = [
      ...mixedDay(today, 3, 0),
      ...mixedDay(plusDays(today, -1), 0, 3),
      ...mixedDay(plusDays(today, -2), 2, 2),
    ]
    const summary = buildHistorySummary(rows, today)
    expect(summary.totalDone).toBeLessThanOrEqual(summary.totalTasks)
    expect(summary.perfectDays).toBeLessThanOrEqual(summary.recordedDays)
  })
})

/* ==========================================================================
 * 5. 히트맵 농도 — heatLevel
 * ======================================================================== */

describe('heatLevel', () => {
  it('★ 적지 않은 날은 0, 적었지만 하나도 못 끝낸 날은 1 ★', () => {
    // 이 둘이 같은 값이 되면 "쉰 날"과 "실패한 날"이 화면에서 구분되지 않습니다.
    expect(heatLevel({ total: 0, done: 0 })).toBe(0)
    expect(heatLevel({ total: 3, done: 0 })).toBe(1)
    expect(heatLevel({ total: 0, done: 0 })).not.toBe(heatLevel({ total: 3, done: 0 }))
  })

  it('전부 끝낸 날은 4', () => {
    expect(heatLevel({ total: 1, done: 1 })).toBe(4)
    expect(heatLevel({ total: 9, done: 9 })).toBe(4)
  })

  it('1/3 경계는 2, 그 바로 아래는 1', () => {
    expect(heatLevel({ total: 3, done: 1 })).toBe(2) // 정확히 1/3
    expect(heatLevel({ total: 4, done: 1 })).toBe(1) // 0.25
  })

  it('2/3 경계는 3, 그 바로 아래는 2', () => {
    expect(heatLevel({ total: 3, done: 2 })).toBe(3) // 정확히 2/3
    expect(heatLevel({ total: 6, done: 4 })).toBe(3) // 부동소수점으로도 같은 값
    expect(heatLevel({ total: 2, done: 1 })).toBe(2) // 0.5
  })

  it('중간 구간', () => {
    expect(heatLevel({ total: 6, done: 5 })).toBe(3)
    expect(heatLevel({ total: 10, done: 4 })).toBe(2)
    expect(heatLevel({ total: 10, done: 2 })).toBe(1)
  })

  it('완주 직전(마지막 하나)은 4 가 아니다 — 4 는 완주 전용', () => {
    expect(heatLevel({ total: 20, done: 19 })).toBe(3)
    expect(heatLevel({ total: 2, done: 1 })).not.toBe(4)
  })

  it('done 이 total 을 넘겨도 4 를 넘지 않는다 (오래된 카운트 방어)', () => {
    expect(heatLevel({ total: 2, done: 5 })).toBe(4)
  })

  it('total 이 음수여도 0 (NaN 이 새지 않는다)', () => {
    expect(heatLevel({ total: -1, done: 0 })).toBe(0)
  })

  it('언제나 0~4 안에 있다', () => {
    for (let total = 0; total <= 12; total += 1) {
      for (let done = 0; done <= total; done += 1) {
        const level = heatLevel({ total, done })
        expect(level).toBeGreaterThanOrEqual(0)
        expect(level).toBeLessThanOrEqual(4)
        expect(Number.isInteger(level)).toBe(true)
      }
    }
  })

  it('같은 total 안에서 done 이 늘면 농도는 줄지 않는다 (단조 증가)', () => {
    for (let total = 1; total <= 12; total += 1) {
      let previous = -1
      for (let done = 0; done <= total; done += 1) {
        const level = heatLevel({ total, done })
        expect(level).toBeGreaterThanOrEqual(previous)
        previous = level
      }
    }
  })
})

/* ==========================================================================
 * 6. 달력 격자 — buildCalendar
 *
 * ★ 손으로 짜면 반드시 틀리는 부분 ★
 * 앞 여백 칸수 = 그 달 1일의 요일 인덱스(일=0). 아래 기대값은 전부
 * 실제 달력에서 확인한 값입니다:
 *   2026-02-01 = 일요일 → 여백 0칸, 28일 → 정확히 4주, null 이 하나도 없음
 *   2026-08-01 = 토요일 → 여백 6칸, 31일 → 6주(42칸), 뒤 여백 5칸
 *   2025-02-01 = 토요일 → 여백 6칸, 28일 → 5주(35칸), 뒤 여백 1칸
 *   2026-03-01 = 일요일 → 여백 0칸, 31일 → 5주(35칸), 뒤 여백 4칸
 * ======================================================================== */

describe('buildCalendar — 월 시작 요일에 따른 빈 칸', () => {
  it('★ 1일이 일요일인 달(2026-02): 앞 여백 0칸 ★', () => {
    const months = buildCalendar(
      countMap({ '2026-02-10': [1, 1] }),
      '2026-02-01',
      '2026-02-28',
    )
    const feb = monthByKey(months, '2026-02')

    expect(leadingBlanks(feb)).toBe(0)
    expect(feb.weeks[0][0]?.date).toBe('2026-02-01')
  })

  it('★ 1일이 일요일이고 28일인 달은 null 이 하나도 없다 (정확히 4주) ★', () => {
    // 달력 격자에서 유일하게 여백이 0인 모양입니다. 여기서 어긋나면
    // 오프셋 계산이 근본적으로 틀린 것입니다.
    const months = buildCalendar(
      countMap({ '2026-02-10': [1, 1] }),
      '2026-02-01',
      '2026-02-28',
    )
    const feb = monthByKey(months, '2026-02')

    expect(feb.weeks).toHaveLength(4)
    expect(cells(feb)).toHaveLength(28)
    expect(cells(feb).every((cell) => cell !== null)).toBe(true)
    expect(cells(feb)[27]?.date).toBe('2026-02-28')
  })

  it('★ 1일이 토요일인 달(2026-08): 앞 여백 6칸 ★', () => {
    const months = buildCalendar(
      countMap({ '2026-08-10': [1, 1] }),
      '2026-08-01',
      '2026-08-31',
    )
    const aug = monthByKey(months, '2026-08')

    expect(leadingBlanks(aug)).toBe(6)
    expect(aug.weeks[0].slice(0, 6)).toEqual([null, null, null, null, null, null])
    expect(aug.weeks[0][6]?.date).toBe('2026-08-01') // 첫 주의 마지막 칸(토)
  })

  it('★ 1일이 토요일 + 31일이면 6주(42칸)로 늘어난다 ★', () => {
    // 6 + 31 = 37칸 → 42칸으로 채워집니다. 달력이 가질 수 있는 최대 크기이고,
    // 5주로 잘라 버리면 마지막 날들이 통째로 사라집니다.
    const months = buildCalendar(
      countMap({ '2026-08-10': [1, 1] }),
      '2026-08-01',
      '2026-08-31',
    )
    const aug = monthByKey(months, '2026-08')

    expect(aug.weeks).toHaveLength(6)
    expect(cells(aug)).toHaveLength(42)
    expect(trailingBlanks(aug)).toBe(5)
    expect(cellByDate(aug, '2026-08-31').dayOfMonth).toBe(31)
  })

  it('1일이 토요일 + 28일인 달(2025-02)은 5주, 뒤 여백 1칸', () => {
    const months = buildCalendar(
      countMap({ '2025-02-10': [1, 1] }),
      '2025-02-01',
      '2025-02-28',
    )
    const feb = monthByKey(months, '2025-02')

    expect(leadingBlanks(feb)).toBe(6)
    expect(feb.weeks).toHaveLength(5)
    expect(trailingBlanks(feb)).toBe(1)
  })

  it('1일이 일요일 + 31일인 달(2026-03)은 5주, 뒤 여백 4칸', () => {
    const months = buildCalendar(
      countMap({ '2026-03-10': [1, 1] }),
      '2026-03-01',
      '2026-03-31',
    )
    const mar = monthByKey(months, '2026-03')

    expect(leadingBlanks(mar)).toBe(0)
    expect(mar.weeks).toHaveLength(5)
    expect(trailingBlanks(mar)).toBe(4)
  })

  it('★ 어떤 달이든 모든 주가 정확히 7칸이다 ★', () => {
    // grid-cols-7 이 어긋나면 화면 전체가 비뚤어집니다.
    // 20개 달(2025-01 ~ 2026-08)을 한 번에 훑습니다 — 시작 요일 7가지와
    // 28/29/30/31일이 전부 섞여 있습니다.
    const months = buildCalendar(countMap({ '2025-01-05': [1, 1] }), '2025-01-01', '2026-08-30')
    expect(months).toHaveLength(20)
    for (const month of months) {
      for (const week of month.weeks) {
        expect(week).toHaveLength(7)
      }
    }
  })

  it('★ 모든 칸의 요일이 열 위치와 일치한다 (일=0 열) ★', () => {
    // 앞 여백이 한 칸이라도 어긋나면 여기서 잡힙니다. 20개 달 전부 검사합니다.
    const months = buildCalendar(countMap({ '2025-01-05': [1, 1] }), '2025-01-01', '2026-08-30')
    expect(months).toHaveLength(20)
    for (const month of months) {
      for (const week of month.weeks) {
        week.forEach((cell, column) => {
          if (cell !== null) expect(weekdayIndex(cell.date)).toBe(column)
        })
      }
    }
  })

  it('null 은 달 앞뒤에만 있고 중간에는 없다', () => {
    const months = buildCalendar(countMap({ '2025-01-05': [1, 1] }), '2025-01-01', '2026-08-30')
    expect(months).toHaveLength(20)
    for (const month of months) {
      const flat = cells(month)
      const first = flat.findIndex((cell) => cell !== null)
      const last = flat.length - 1 - [...flat].reverse().findIndex((cell) => cell !== null)
      for (let i = first; i <= last; i += 1) {
        expect(flat[i]).not.toBeNull()
      }
    }
  })
})

describe('buildCalendar — 달의 날짜 수', () => {
  it('윤년 2월에는 29일 칸이 있다', () => {
    const months = buildCalendar(
      countMap({ '2024-02-10': [1, 1] }),
      '2024-02-01',
      '2024-02-29',
    )
    const feb = monthByKey(months, '2024-02')
    const days = cells(feb).filter((cell) => cell !== null)

    expect(days).toHaveLength(29)
    expect(cellByDate(feb, '2024-02-29').dayOfMonth).toBe(29)
  })

  it('평년 2월에는 29일 칸이 없다', () => {
    const months = buildCalendar(
      countMap({ '2026-02-10': [1, 1] }),
      '2026-02-01',
      '2026-02-28',
    )
    const feb = monthByKey(months, '2026-02')
    const days = cells(feb).filter((cell) => cell !== null)

    expect(days).toHaveLength(28)
    expect(cells(feb).some((cell) => cell?.date === '2026-02-29')).toBe(false)
  })

  it('30일 달과 31일 달의 칸 수가 다르다', () => {
    const months = buildCalendar(
      countMap({ '2026-04-05': [1, 1] }),
      '2026-04-01',
      '2026-05-31',
    )
    expect(cells(monthByKey(months, '2026-04')).filter((c) => c !== null)).toHaveLength(30)
    expect(cells(monthByKey(months, '2026-05')).filter((c) => c !== null)).toHaveLength(31)
  })

  it('dayOfMonth 는 1부터 마지막 날까지 빠짐없이 순서대로', () => {
    const months = buildCalendar(countMap({}), '2026-08-01', '2026-08-31')
    const days = cells(monthByKey(months, '2026-08')).filter(
      (cell): cell is HistoryDay => cell !== null,
    )
    expect(days.map((d) => d.dayOfMonth)).toEqual(
      Array.from({ length: 31 }, (_, i) => i + 1),
    )
  })
})

describe('buildCalendar — 표시할 달의 범위', () => {
  const today = '2026-08-30'

  it('기록이 없으면 오늘의 달 하나만 (텅 빈 여섯 달을 보여 주지 않는다)', () => {
    const months = buildCalendar(countMap({}), plusDays(today, -179), today)
    expect(months).toHaveLength(1)
    expect(months[0].key).toBe('2026-08')
  })

  it('가장 오래된 기록의 달부터 오늘의 달까지', () => {
    const months = buildCalendar(
      countMap({ '2026-06-15': [1, 1], '2026-08-02': [2, 1] }),
      plusDays(today, -179),
      today,
    )
    expect(months.map((m) => m.key)).toEqual(['2026-08', '2026-07', '2026-06'])
  })

  it('★ 최신 달이 맨 앞이다 (모바일에서 스크롤 없이 이번 달이 보여야 한다) ★', () => {
    const months = buildCalendar(
      countMap({ '2026-05-01': [1, 1] }),
      plusDays(today, -179),
      today,
    )
    expect(months[0].key).toBe('2026-08')
    expect(months[months.length - 1].key).toBe('2026-05')
  })

  it('연 경계를 넘는다', () => {
    const months = buildCalendar(
      countMap({ '2025-12-20': [1, 1] }),
      '2025-08-15',
      '2026-02-10',
    )
    expect(months.map((m) => m.key)).toEqual(['2026-02', '2026-01', '2025-12'])
    expect(monthByKey(months, '2025-12').year).toBe(2025)
    expect(monthByKey(months, '2025-12').month).toBe(12)
  })

  it('label 은 한국어 "YYYY년 M월" (월에 0 을 붙이지 않는다)', () => {
    const months = buildCalendar(countMap({ '2026-08-01': [1, 1] }), '2026-08-01', today)
    expect(monthByKey(months, '2026-08').label).toBe('2026년 8월')

    const early = buildCalendar(countMap({ '2026-01-05': [1, 1] }), '2026-01-01', '2026-01-31')
    expect(monthByKey(early, '2026-01').label).toBe('2026년 1월')
    expect(monthByKey(early, '2026-01').key).toBe('2026-01') // key 는 0 패딩
  })

  it('할 일 0개(total 0)인 항목은 "가장 오래된 기록"으로 치지 않는다', () => {
    const months = buildCalendar(
      countMap({ '2026-04-01': [0, 0], '2026-08-01': [1, 1] }),
      plusDays(today, -179),
      today,
    )
    expect(months.map((m) => m.key)).toEqual(['2026-08'])
  })

  it('창(from) 이전의 기록은 달 범위를 넓히지 않는다', () => {
    const from = plusDays(today, -179) // 2026-03-04
    const months = buildCalendar(
      countMap({ '2025-11-11': [3, 3], '2026-07-01': [1, 1] }),
      from,
      today,
    )
    expect(months.map((m) => m.key)).toEqual(['2026-08', '2026-07'])
  })

  it('미래 기록도 달 범위를 넓히지 않는다', () => {
    const months = buildCalendar(
      countMap({ '2026-12-25': [5, 5], '2026-08-01': [1, 1] }),
      plusDays(today, -179),
      today,
    )
    expect(months.map((m) => m.key)).toEqual(['2026-08'])
  })

  it('오늘 하루만 기록해도 그 달 한 개가 온전히 그려진다', () => {
    const months = buildCalendar(countMap({ [today]: [2, 2] }), plusDays(today, -179), today)
    expect(months).toHaveLength(1)
    expect(cells(months[0]).filter((c) => c !== null)).toHaveLength(31)
  })
})

describe('buildCalendar — 칸의 내용', () => {
  const today = '2026-08-30'
  const from = plusDays(today, -179) // 2026-03-04

  const months = buildCalendar(
    countMap({
      '2026-08-30': [3, 3],
      '2026-08-29': [4, 1],
      '2026-08-27': [2, 0],
      // 창(from) 이 걸쳐 있는 달까지 그려지도록 가장 오래된 기록을 하나 둡니다.
      '2026-03-10': [1, 1],
    }),
    from,
    today,
  )
  const aug = monthByKey(months, '2026-08')

  it('집계된 날은 total/done 이 그대로 실린다', () => {
    expect(cellByDate(aug, '2026-08-30')).toMatchObject({ total: 3, done: 3 })
    expect(cellByDate(aug, '2026-08-29')).toMatchObject({ total: 4, done: 1 })
    expect(cellByDate(aug, '2026-08-27')).toMatchObject({ total: 2, done: 0 })
  })

  it('★ 할 일이 0개인 날도 칸은 있고 0/0 으로 그린다 (칸을 지우지 않는다) ★', () => {
    const idle = cellByDate(aug, '2026-08-28')
    expect(idle.total).toBe(0)
    expect(idle.done).toBe(0)
    expect(idle.outOfRange).toBe(false) // 창 안이라 "그냥 쉰 날"입니다
    expect(heatLevel(idle)).toBe(0)
  })

  it('isToday 는 오늘 한 칸에만 붙는다', () => {
    const flagged = cells(aug).filter((cell) => cell?.isToday === true)
    expect(flagged).toHaveLength(1)
    expect(flagged[0]?.date).toBe(today)
  })

  it('오늘 이후는 outOfRange', () => {
    expect(cellByDate(aug, '2026-08-31').outOfRange).toBe(true)
    expect(cellByDate(aug, '2026-08-30').outOfRange).toBe(false)
  })

  it('창 시작(from) 이전은 outOfRange — 같은 달 안에서 갈린다', () => {
    const mar = monthByKey(months, '2026-03')
    expect(cellByDate(mar, '2026-03-03').outOfRange).toBe(true) // from 하루 전
    expect(cellByDate(mar, '2026-03-04').outOfRange).toBe(false) // from 당일
    expect(cellByDate(mar, '2026-03-01').outOfRange).toBe(true)
  })

  it('date 는 그 칸의 key 와 dayOfMonth 로 다시 조립된다', () => {
    for (const month of months) {
      for (const cell of cells(month)) {
        if (cell === null) continue
        expect(cell.date.startsWith(month.key)).toBe(true)
        expect(Number(cell.date.slice(8))).toBe(cell.dayOfMonth)
      }
    }
  })

  it('done 은 어떤 칸에서도 total 을 넘지 않는다', () => {
    for (const month of months) {
      for (const cell of cells(month)) {
        if (cell === null) continue
        expect(cell.done).toBeLessThanOrEqual(cell.total)
      }
    }
  })
})

/* ==========================================================================
 * 7. 집계 -> 달력 연결 (tallyByDate 의 출력이 buildCalendar 의 입력)
 * ======================================================================== */

describe('tallyByDate -> buildCalendar 파이프라인', () => {
  const today = '2026-08-30'
  const from = plusDays(today, -179)

  it('행 목록 하나로 요약과 달력이 같은 사실을 말한다', () => {
    const rows = [
      ...doneDay(today, 2), // 완주
      ...mixedDay('2026-08-29', 1, 2), // 3개 중 1개
      // 8-28 쉼
      ...doneDay('2026-08-27', 1), // 완주
    ]

    const summary = buildHistorySummary(rows, today)
    const aug = monthByKey(buildCalendar(tallyByDate(rows), from, today), '2026-08')

    expect(summary.recordedDays).toBe(3)
    expect(summary.perfectDays).toBe(2)
    expect(summary.totalTasks).toBe(6)
    expect(summary.totalDone).toBe(4)

    // 달력 칸의 합이 요약과 어긋나면 둘 중 하나가 거짓말을 하는 것입니다.
    const inWindow = cells(aug).filter(
      (cell): cell is HistoryDay => cell !== null && !cell.outOfRange,
    )
    expect(inWindow.reduce((sum, cell) => sum + cell.total, 0)).toBe(summary.totalTasks)
    expect(inWindow.reduce((sum, cell) => sum + cell.done, 0)).toBe(summary.totalDone)
    expect(inWindow.filter((cell) => heatLevel(cell) === 4)).toHaveLength(summary.perfectDays)
  })

  it('창을 가득 채운 기록도 달력이 전부 담는다 (7개 달)', () => {
    const rows = consecutiveDone(today, HISTORY_WINDOW_DAYS)
    const months = buildCalendar(tallyByDate(rows), from, today)

    // 2026-03-04 ~ 2026-08-30 = 3,4,5,6,7,8월 6개 달.
    expect(months.map((m) => m.key)).toEqual([
      '2026-08',
      '2026-07',
      '2026-06',
      '2026-05',
      '2026-04',
      '2026-03',
    ])

    const filled = months
      .flatMap((m) => cells(m))
      .filter((cell): cell is HistoryDay => cell !== null && cell.total > 0)
    expect(filled).toHaveLength(HISTORY_WINDOW_DAYS)
    expect(buildHistorySummary(rows, today).longestStreak).toBe(HISTORY_WINDOW_DAYS)
  })
})
