import { afterEach, describe, expect, it, vi } from 'vitest'

import { STREAK_WINDOW_DAYS, calcStreak } from '@/lib/tasks'

/**
 * tests/streak.test.ts — calcStreak() 의 경계 전부.
 *
 * calcStreak 는 순수 함수입니다(rows + today -> number). Supabase 도 시계도
 * 건드리지 않으므로 모킹이 한 줄도 필요 없습니다.
 *
 * lib/tasks.ts 가 못 박은 규칙을 그대로 테스트로 옮깁니다:
 *   1. "완료한 날" = 그날 적은 할 일이 1개 이상이고 전부 done_at != null.
 *   2. 오늘이 미완료(또는 0개)여도 스트릭은 0이 되지 않는다. 어제부터 센다.
 *   3. 과거의 "할 일 0개인 날"은 스트릭을 끊는다.
 *   4. 최대 STREAK_WINDOW_DAYS 에서 잘린다.
 */

type Row = { task_date: string; done_at: string | null }

/** 완료된 할 일 n개. done_at 값 자체는 "null 이 아니다"만 의미가 있습니다. */
function doneDay(date: string, count = 1): Row[] {
  return Array.from({ length: count }, () => ({
    task_date: date,
    done_at: `${date}T12:00:00.000Z`,
  }))
}

/** 미완료 할 일 n개. */
function openDay(date: string, count = 1): Row[] {
  return Array.from({ length: count }, () => ({ task_date: date, done_at: null }))
}

/** today 부터 과거로 n일 연속 완료. (today 포함) */
function consecutiveDone(today: string, days: number): Row[] {
  const rows: Row[] = []
  const [y, m, d] = today.split('-').map(Number)
  for (let i = 0; i < days; i += 1) {
    const iso = new Date(Date.UTC(y, m - 1, d) - i * 86_400_000)
      .toISOString()
      .slice(0, 10)
    rows.push(...doneDay(iso))
  }
  return rows
}

describe('calcStreak — 기본', () => {
  it('할 일이 하나도 없으면 0일', () => {
    expect(calcStreak([], '2026-08-30')).toBe(0)
  })

  it('오늘 전부 완료하면 오늘부터 센다', () => {
    const rows = [...doneDay('2026-08-30', 3)]
    expect(calcStreak(rows, '2026-08-30')).toBe(1)
  })

  it('오늘·어제·그제 전부 완료면 3일', () => {
    const rows = [
      ...doneDay('2026-08-30'),
      ...doneDay('2026-08-29'),
      ...doneDay('2026-08-28'),
    ]
    expect(calcStreak(rows, '2026-08-30')).toBe(3)
  })

  it('하루에 여러 개를 적었어도 전부 완료여야 그날이 완료', () => {
    const rows = [...doneDay('2026-08-30', 4)]
    expect(calcStreak(rows, '2026-08-30')).toBe(1)
  })

  it('행 순서가 뒤섞여 있어도 결과가 같다', () => {
    const ordered = [
      ...doneDay('2026-08-30'),
      ...doneDay('2026-08-29'),
      ...doneDay('2026-08-28'),
    ]
    const shuffled = [ordered[2], ordered[0], ordered[1]]
    expect(calcStreak(shuffled, '2026-08-30')).toBe(calcStreak(ordered, '2026-08-30'))
    expect(calcStreak(shuffled, '2026-08-30')).toBe(3)
  })
})

/**
 * ★ 이 앱에서 가장 중요한 회귀 테스트 ★
 *
 * 아침 9시에 앱을 열었을 때 "어제까지 12일"이 "0일"로 보이면 기능이 죽습니다.
 * 오늘은 아직 진행 중이므로 스트릭을 끊는 근거가 될 수 없습니다.
 */
describe('calcStreak — 오늘이 아직 안 끝났을 때 (스트릭이 0으로 떨어지면 안 됨)', () => {
  it('오늘 할 일이 전부 미완료여도 어제까지의 연속은 유지된다', () => {
    const rows = [
      ...openDay('2026-08-30', 2),
      ...doneDay('2026-08-29'),
      ...doneDay('2026-08-28'),
      ...doneDay('2026-08-27'),
    ]
    expect(calcStreak(rows, '2026-08-30')).toBe(3)
  })

  it('오늘 일부만 완료해도 어제까지의 연속은 유지된다', () => {
    const rows = [
      ...doneDay('2026-08-30', 1),
      ...openDay('2026-08-30', 1),
      ...doneDay('2026-08-29'),
      ...doneDay('2026-08-28'),
      ...doneDay('2026-08-27'),
    ]
    expect(calcStreak(rows, '2026-08-30')).toBe(3)
  })

  it('오늘 할 일을 아직 하나도 안 적었어도 어제까지의 연속은 유지된다', () => {
    const rows = [
      ...doneDay('2026-08-29'),
      ...doneDay('2026-08-28'),
      ...doneDay('2026-08-27'),
    ]
    expect(calcStreak(rows, '2026-08-30')).toBe(3)
  })

  it('오늘을 마저 끝내면 하루가 더해진다 (3일 -> 4일)', () => {
    const before = [
      ...openDay('2026-08-30'),
      ...doneDay('2026-08-29'),
      ...doneDay('2026-08-28'),
      ...doneDay('2026-08-27'),
    ]
    const after = [
      ...doneDay('2026-08-30'),
      ...doneDay('2026-08-29'),
      ...doneDay('2026-08-28'),
      ...doneDay('2026-08-27'),
    ]
    expect(calcStreak(before, '2026-08-30')).toBe(3)
    expect(calcStreak(after, '2026-08-30')).toBe(4)
  })

  it('12일 연속 뒤 오늘 아침(미완료)에도 12일이다 — 0일이 아니다', () => {
    const rows = [
      ...openDay('2026-08-30'),
      ...consecutiveDone('2026-08-29', 12),
    ]
    expect(calcStreak(rows, '2026-08-30')).toBe(12)
  })
})

describe('calcStreak — 끊김', () => {
  it('어제도 오늘도 미완료면 0일', () => {
    const rows = [
      ...openDay('2026-08-30'),
      ...openDay('2026-08-29'),
      ...doneDay('2026-08-28'),
    ]
    expect(calcStreak(rows, '2026-08-30')).toBe(0)
  })

  it('과거에 할 일을 하나도 안 적은 날은 스트릭을 끊는다', () => {
    // 8-28 은 행이 아예 없음. 규칙 3: 적지 않은 과거의 날은 실패로 본다.
    const rows = [
      ...doneDay('2026-08-30'),
      ...doneDay('2026-08-29'),
      ...doneDay('2026-08-27'),
      ...doneDay('2026-08-26'),
    ]
    expect(calcStreak(rows, '2026-08-30')).toBe(2)
  })

  it('과거에 일부만 완료한 날도 스트릭을 끊는다', () => {
    const rows = [
      ...doneDay('2026-08-30'),
      ...doneDay('2026-08-29'),
      ...doneDay('2026-08-28', 1),
      ...openDay('2026-08-28', 1),
      ...doneDay('2026-08-27'),
    ]
    expect(calcStreak(rows, '2026-08-30')).toBe(2)
  })

  it('오늘만 완료하고 어제가 비어 있으면 1일', () => {
    expect(calcStreak(doneDay('2026-08-30'), '2026-08-30')).toBe(1)
  })

  it('오늘 완료 + 어제 미완료면 1일 (어제에서 끊긴다)', () => {
    const rows = [
      ...doneDay('2026-08-30'),
      ...openDay('2026-08-29'),
      ...doneDay('2026-08-28'),
      ...doneDay('2026-08-27'),
    ]
    expect(calcStreak(rows, '2026-08-30')).toBe(1)
  })

  it('오래된 연속 기록은 사이가 끊겨 있으면 합산되지 않는다', () => {
    const rows = [
      ...consecutiveDone('2026-08-30', 2), // 8-30, 8-29
      // 8-28 없음
      ...consecutiveDone('2026-08-27', 20),
    ]
    expect(calcStreak(rows, '2026-08-30')).toBe(2)
  })
})

describe('calcStreak — 미래 날짜', () => {
  it('내일 날짜의 행은 스트릭을 부풀리지 않는다', () => {
    // 백필/시간대 착오로 미래 행이 섞여 들어와도 오늘 이후는 세지 않아야 합니다.
    const rows = [
      ...doneDay('2026-08-31'), // 미래
      ...openDay('2026-08-30'), // 오늘 미완료
      ...doneDay('2026-08-29'),
      ...doneDay('2026-08-28'),
      ...doneDay('2026-08-27'),
    ]
    expect(calcStreak(rows, '2026-08-30')).toBe(3)
  })
})

describe('calcStreak — 날짜 산술 경계', () => {
  it('월 경계를 넘는다 (9-01 -> 8-31 -> 8-30)', () => {
    const rows = [
      ...doneDay('2026-09-01'),
      ...doneDay('2026-08-31'),
      ...doneDay('2026-08-30'),
    ]
    expect(calcStreak(rows, '2026-09-01')).toBe(3)
  })

  it('연 경계를 넘는다 (2026-01-01 -> 2025-12-31 -> 2025-12-30)', () => {
    const rows = [
      ...doneDay('2026-01-01'),
      ...doneDay('2025-12-31'),
      ...doneDay('2025-12-30'),
    ]
    expect(calcStreak(rows, '2026-01-01')).toBe(3)
  })

  it('윤년 2월 29일을 건너뛰지 않는다 (2024-03-01 -> 02-29 -> 02-28)', () => {
    const rows = [
      ...doneDay('2024-03-01'),
      ...doneDay('2024-02-29'),
      ...doneDay('2024-02-28'),
    ]
    expect(calcStreak(rows, '2024-03-01')).toBe(3)
  })

  it('평년 3월 1일의 전날은 2월 28일이다 (2026-02-29 는 존재하지 않는다)', () => {
    const rows = [
      ...doneDay('2026-03-01'),
      ...doneDay('2026-02-28'),
      ...doneDay('2026-02-27'),
    ]
    expect(calcStreak(rows, '2026-03-01')).toBe(3)
  })
})

/**
 * 시간대 경계.
 *
 * calcStreak 는 "지금"을 절대 읽지 않습니다 — today 는 DB 의
 * current_user_local_date() 가 사용자 프로필 시간대로 계산해 넘겨준 값입니다.
 * 아래 테스트들은 시스템 시계를 어떻게 흔들어도 결과가 바뀌지 않음을 못 박습니다.
 * (여기가 깨진다면 어딘가에서 new Date() 로 오늘을 만들고 있다는 뜻입니다.)
 */
describe('calcStreak — 시간대 / 시계 독립성', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('시스템 시계가 UTC 로 이미 다음 날이어도 today 인자를 따른다', () => {
    // 2026-08-30T15:30:00Z = 2026-08-31 00:30 KST.
    // UTC 기준 날짜(08-30)와 KST 기준 날짜(08-31)가 갈리는 순간입니다.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-30T15:30:00.000Z'))

    const rows = [
      ...doneDay('2026-08-31'),
      ...doneDay('2026-08-30'),
      ...doneDay('2026-08-29'),
    ]
    // DB 가 KST 로 계산해 준 오늘은 08-31 입니다.
    expect(calcStreak(rows, '2026-08-31')).toBe(3)
  })

  it('시스템 시계가 UTC 로 아직 전날이어도 today 인자를 따른다', () => {
    // 2026-08-30T14:00:00Z = 2026-08-30 07:00 in America/Los_Angeles(-07:00)
    // 이지만 UTC 로는 이미 08-30 저녁입니다. 어느 쪽이든 today 가 이깁니다.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-30T14:00:00.000Z'))

    const rows = [...openDay('2026-08-29'), ...doneDay('2026-08-28')]
    // today=2026-08-29 로 물어보면 어제(08-28)만 세어 1일.
    expect(calcStreak(rows, '2026-08-29')).toBe(1)
  })

  it('시계를 몇 년 뒤로 옮겨도 과거 날짜에 대해 같은 답을 준다', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2031-01-01T00:00:00.000Z'))

    const rows = consecutiveDone('2019-06-15', 5)
    expect(calcStreak(rows, '2019-06-15')).toBe(5)
  })

  it('DST 전환일(2026-03-08, 미국 서머타임 시작)을 건너뛰거나 겹치지 않는다', () => {
    // 날짜 산술이 로컬 시간대의 23시간/25시간짜리 하루에 끌려가면
    // 3-08 이 통째로 사라지거나 두 번 세어집니다.
    const rows = [
      ...doneDay('2026-03-09'),
      ...doneDay('2026-03-08'),
      ...doneDay('2026-03-07'),
      ...doneDay('2026-03-06'),
    ]
    expect(calcStreak(rows, '2026-03-09')).toBe(4)
  })

  it('DST 종료일(2026-11-01)도 마찬가지', () => {
    const rows = [
      ...doneDay('2026-11-02'),
      ...doneDay('2026-11-01'),
      ...doneDay('2026-10-31'),
    ]
    expect(calcStreak(rows, '2026-11-02')).toBe(3)
  })
})

describe('calcStreak — 조회 창 상한', () => {
  it('STREAK_WINDOW_DAYS 는 120일', () => {
    expect(STREAK_WINDOW_DAYS).toBe(120)
  })

  it('창 안쪽이면 그대로 센다', () => {
    const rows = consecutiveDone('2026-08-30', STREAK_WINDOW_DAYS - 1)
    expect(calcStreak(rows, '2026-08-30')).toBe(STREAK_WINDOW_DAYS - 1)
  })

  it('창보다 긴 연속 기록은 STREAK_WINDOW_DAYS 에서 잘린다', () => {
    const rows = consecutiveDone('2026-08-30', STREAK_WINDOW_DAYS + 40)
    expect(calcStreak(rows, '2026-08-30')).toBe(STREAK_WINDOW_DAYS)
  })

  it('오늘이 미완료여도 상한은 STREAK_WINDOW_DAYS 를 넘지 않는다', () => {
    const rows = [
      ...openDay('2026-08-30'),
      ...consecutiveDone('2026-08-29', STREAK_WINDOW_DAYS + 10),
    ]
    expect(calcStreak(rows, '2026-08-30')).toBe(STREAK_WINDOW_DAYS)
  })
})

describe('calcStreak — 그룹 구분 없음', () => {
  it('여러 그룹에 적은 할 일도 "그날의 내 할 일"로 합쳐 판정한다', () => {
    // 같은 날 두 그룹에 하나씩. 한쪽이 미완료면 그날은 완료가 아닙니다.
    const rows: Row[] = [
      { task_date: '2026-08-30', done_at: '2026-08-30T10:00:00.000Z' },
      { task_date: '2026-08-30', done_at: null },
      ...doneDay('2026-08-29'),
      ...doneDay('2026-08-28'),
    ]
    expect(calcStreak(rows, '2026-08-30')).toBe(2)
  })

  it('두 그룹 모두 완료하면 그날이 완료로 잡힌다', () => {
    const rows: Row[] = [
      { task_date: '2026-08-30', done_at: '2026-08-30T10:00:00.000Z' },
      { task_date: '2026-08-30', done_at: '2026-08-30T11:00:00.000Z' },
      ...doneDay('2026-08-29'),
    ]
    expect(calcStreak(rows, '2026-08-30')).toBe(2)
  })
})
