import { describe, expect, it } from 'vitest'

import { WEEKDAY_LABELS, weekdayIndex } from '@/lib/history'
import type {
  BulkFillResult,
  FunctionArgs,
  FunctionReturns,
  Task,
  TaskInsert,
  TaskTemplate,
  TaskTemplateInsert,
  TaskTemplateUpdate,
  Weekday,
} from '@/lib/supabase/types'

/**
 * tests/templates.test.ts — 반복 할 일(0004_templates.sql)의 요일 규약 + 계약.
 *
 * ---------------------------------------------------------------------------
 * ★ 먼저 읽어 주세요: 이 기능의 로직이 실제로 어디에 사는가 ★
 * ---------------------------------------------------------------------------
 * "오늘 요일에 걸리는 템플릿을 골라 넣고 created / skipped 를 센다"는 판단은
 * **전부 SQL 안에** 있습니다. TypeScript 쪽에 같은 계산이 없습니다.
 *
 *   · 요일 판정   : apply_today_templates 의
 *                   `v_dow := date_part('dow', v_today)` + `v_dow = any (tt.weekdays)`
 *   · 중복 방지   : 부분 유니크 인덱스 tasks_user_date_template_uidx
 *                   + `on conflict do nothing`
 *   · created/skipped : 같은 RPC 안의 `count(*)` 두 개
 *                       (created = 실제 insert, skipped = 대상 총수 - created)
 *   · 배열 검증/정규화 : task_templates_weekdays_chk (범위·개수)
 *                        + BEFORE 트리거 normalize_task_template_weekdays
 *                          (정렬 + 중복 제거, 빈 값/범위 밖은 22023)
 *
 * 그래서 "몇 개 만들어지고 몇 개 건너뛰는가"의 경계는 여기서 테스트하지
 * 않습니다 — Postgres 없이 실행할 수 있는 코드가 아닙니다. 그걸 흉내 낸 함수를
 * 이 파일에 새로 적으면, 검증되는 대상은 SQL 이 아니라 그 흉내가 됩니다.
 *
 * TypeScript 쪽 요일 코드도 전부 모듈 밖에서 부를 수 없습니다:
 *   · app/templates/actions.ts 의 parseWeekdays  → 'use server' 파일은 async
 *     함수 외의 export 를 허용하지 않습니다.
 *   · app/templates/page.tsx 의 weekdayOf / weekdaySummary / fillMessage,
 *     app/page.tsx 의 weekdayOf → 모듈 내부 함수입니다(둘은 서로의 복사본).
 *
 * ---------------------------------------------------------------------------
 * 그래서 이 파일이 실제로 지키는 것
 * ---------------------------------------------------------------------------
 *   1. **0 = 일요일 규약** — lib/history.ts 의 weekdayIndex() 로 확인합니다.
 *      위 세 벌의 weekdayOf() 가 전부 같은 식(`Date.UTC(...).getUTCDay()`)의
 *      손복사이고, SQL 의 dow 도 같은 규약입니다. 이 규약이 흔들리면 일요일
 *      템플릿이 통째로 사라지고 나머지가 하루씩 밀립니다.
 *   2. **컴파일 타임 계약** — Weekday / TaskTemplate / BulkFillResult 등.
 *      `@ts-expect-error` 는 `tsc --noEmit` 게이트에서 검사되므로, 아래 블록은
 *      런타임 assert 가 아니라 **타입이 방어선을 유지하는지**를 못 박습니다.
 *      (기대한 오류가 사라지면 tsc 가 "Unused '@ts-expect-error'" 로 터집니다.)
 *
 * ★ 요일 규약의 근거 ★
 * PostgreSQL 문서: "dow — The day of the week as Sunday (0) to Saturday (6)".
 * 0004_templates.sql 의 검산: `date_part('dow', date '2026-08-30') = 0`,
 * 그리고 2026-08-30 은 실제로 일요일입니다. JS 의 Date#getUTCDay() 도 0=일요일
 * 이라 변환이 필요 없습니다. isodow(월=1..일=7)로 바꾸면 전부 어긋납니다.
 */

/* ==========================================================================
 * 1. 요일 매칭 — 0 = 일요일
 * ======================================================================== */

/** 2026-08-30(일)부터 2026-09-05(토)까지, 실제로 존재하는 한 주. */
const WEEK = [
  '2026-08-30', // 일
  '2026-08-31', // 월
  '2026-09-01', // 화
  '2026-09-02', // 수
  '2026-09-03', // 목
  '2026-09-04', // 금
  '2026-09-05', // 토
] as const

/** 화면이 보여주는 이름과 DB 값이 같은 축에 있는지 확인할 때 씁니다. */
const NAMES = ['일', '월', '화', '수', '목', '금', '토'] as const

function weekdayOf(isoDate: string): Weekday {
  return weekdayIndex(isoDate) as Weekday
}

describe('요일 규약 — 0=일요일 .. 6=토요일 (isodow 아님)', () => {
  it('★ 일요일은 0이다 — 여기가 7이나 1이면 weekdays 인코딩 전체가 틀린 것 ★', () => {
    // 0004_templates.sql 이 적어 둔 검산과 같은 날짜입니다.
    expect(weekdayIndex('2026-08-30')).toBe(0)
    expect(weekdayIndex('2026-08-30')).not.toBe(7)
  })

  it('한 주가 0..6 으로 순서대로 나온다', () => {
    expect(WEEK.map(weekdayIndex)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('★ 토요일 → 일요일 경계에서 6 다음이 0이다 (7로 넘어가지 않는다) ★', () => {
    // 한 주의 끝과 다음 주의 시작. 여기서 7이 나오면 배열 인덱스가 범위를
    // 벗어나고, `any (weekdays)` 비교는 어떤 템플릿과도 맞지 않게 됩니다.
    expect(weekdayIndex('2026-08-29')).toBe(6) // 토
    expect(weekdayIndex('2026-08-30')).toBe(0) // 일 — 감소합니다
    expect(weekdayIndex('2026-09-05')).toBe(6) // 토
    expect(weekdayIndex('2026-09-06')).toBe(0) // 일
  })

  it('월이 바뀌어도 요일은 이어진다 (8/31 월 → 9/1 화)', () => {
    expect(weekdayIndex('2026-08-31')).toBe(1)
    expect(weekdayIndex('2026-09-01')).toBe(2)
  })

  it('해가 바뀌어도 이어진다 (2026-12-31 목 → 2027-01-01 금)', () => {
    expect(weekdayIndex('2026-12-31')).toBe(4)
    expect(weekdayIndex('2027-01-01')).toBe(5)
  })

  it('윤년 2월 29일도 정상 (2028-02-29 는 화요일)', () => {
    expect(weekdayIndex('2028-02-28')).toBe(1)
    expect(weekdayIndex('2028-02-29')).toBe(2)
    expect(weekdayIndex('2028-03-01')).toBe(3)
  })

  it('화면 라벨이 같은 축에 있다 — WEEKDAY_LABELS[요일값] 이 그 요일 이름이다', () => {
    // app/templates/page.tsx 와 app/page.tsx 가 같은 배열을 손으로 복사해
    // 갖고 있습니다. 순서를 월요일 시작으로 바꾸면 저장은 멀쩡한데 화면만
    // 하루씩 밀리는, 제일 알아채기 어려운 고장이 됩니다.
    expect(WEEKDAY_LABELS).toEqual(NAMES)
    for (const date of WEEK) {
      expect(WEEKDAY_LABELS[weekdayOf(date)]).toBe(NAMES[weekdayOf(date)])
    }
    expect(WEEKDAY_LABELS[weekdayOf('2026-08-30')]).toBe('일')
    expect(WEEKDAY_LABELS[weekdayOf('2026-09-05')]).toBe('토')
  })
})

/* ==========================================================================
 * 2. 설정별로 "오늘"이 걸리는가
 *
 * `weekdays.includes(오늘요일)` 은 app/page.tsx 가 "반복 할 일 N개 불러오기"
 * 배지를 만들 때 실제로 도는 한 줄이고, SQL 의 `v_dow = any (tt.weekdays)` 와
 * 같은 판단입니다. 여기서 확인하는 것은 그 한 줄이 아니라 **0=일요일 규약으로
 * 만든 요일 값이 흔한 설정들에 대해 옳은 답을 주는가** 입니다.
 * ======================================================================== */

/** 저장된 weekdays 는 트리거가 정렬 + 중복 제거를 하므로 항상 이 모양입니다. */
const EVERY_DAY: Weekday[] = [0, 1, 2, 3, 4, 5, 6]
const WEEKDAYS_ONLY: Weekday[] = [1, 2, 3, 4, 5] // 평일(월~금)
const WEEKEND_ONLY: Weekday[] = [0, 6] // 주말(토·일)
const MON_WED_FRI: Weekday[] = [1, 3, 5]
const SUNDAY_ONLY: Weekday[] = [0]

describe('설정별 오늘 포함 여부 — 한 주 전체를 훑는다', () => {
  it('"매일" 은 7일 모두 걸린다', () => {
    expect(WEEK.map((date) => EVERY_DAY.includes(weekdayOf(date)))).toEqual([
      true, true, true, true, true, true, true,
    ])
  })

  it('"평일(월~금)" 은 월~금만 걸린다 — 일·토는 빠진다', () => {
    expect(WEEK.map((date) => WEEKDAYS_ONLY.includes(weekdayOf(date)))).toEqual([
      false, true, true, true, true, true, false,
    ])
  })

  it('★ "주말(토·일)" 은 토·일만 걸린다 — isodow 로 밀렸다면 일요일이 빠진다 ★', () => {
    // isodow(월=1..일=7)로 계산했다면 일요일이 7이 되어 {0,6} 에 안 걸리고,
    // 대신 금요일(isodow 5 vs dow 5)만 우연히 맞는 식으로 조용히 어긋납니다.
    expect(WEEK.map((date) => WEEKEND_ONLY.includes(weekdayOf(date)))).toEqual([
      true, false, false, false, false, false, true,
    ])
  })

  it('"월·수·금" 은 셋만 걸린다', () => {
    expect(WEEK.map((date) => MON_WED_FRI.includes(weekdayOf(date)))).toEqual([
      false, true, false, true, false, true, false,
    ])
  })

  it('★ "일요일만" 템플릿이 일요일에 실제로 걸린다 — 규약이 틀리면 영영 안 나타난다 ★', () => {
    expect(WEEK.map((date) => SUNDAY_ONLY.includes(weekdayOf(date)))).toEqual([
      true, false, false, false, false, false, false,
    ])
  })

  it('어떤 요일에도 "매일" 과 "평일 + 주말" 은 같은 결론을 낸다 (7일 분할이 빠짐없다)', () => {
    for (const date of WEEK) {
      const day = weekdayOf(date)
      expect(WEEKDAYS_ONLY.includes(day) || WEEKEND_ONLY.includes(day)).toBe(
        EVERY_DAY.includes(day)
      )
    }
  })
})

/* ==========================================================================
 * 3. weekdays 배열 검증 — 어디가 막고 어디가 못 막는가
 *
 * ★ 결론부터: 타입은 "범위"만 막습니다. "빈 배열"과 "중복"은 못 막습니다. ★
 * 그래서 실제 방어선은 DB 쪽이고, 이 절은 그 분담을 코드로 못 박습니다.
 * 여기서 타입이 조용히 넓어지면(`number[]` 등) 클라이언트가 7 을 보내고
 * 런타임 22023 을 만나게 됩니다.
 * ======================================================================== */

describe('weekdays 배열 — 타입이 막는 것 (범위)', () => {
  it('0~6 은 전부 유효한 Weekday 다', () => {
    const all: Weekday[] = [0, 1, 2, 3, 4, 5, 6]
    expect(all).toHaveLength(7)
  })

  it('★ 7 은 타입 단계에서 막힌다 — isodow 값을 그대로 보내는 사고를 컴파일에서 잡는다 ★', () => {
    // @ts-expect-error 7 은 Weekday 가 아닙니다 (일요일은 0, isodow 아님).
    const outOfRange: Weekday[] = [7]
    expect(outOfRange).toHaveLength(1)
  })

  it('음수도 타입 단계에서 막힌다', () => {
    // @ts-expect-error -1 은 Weekday 가 아닙니다.
    const negative: Weekday[] = [-1]
    expect(negative).toHaveLength(1)
  })

  it('정수가 아닌 값도 막힌다', () => {
    // @ts-expect-error 0.5 는 Weekday 가 아닙니다 (smallint 컬럼입니다).
    const fractional: Weekday[] = [0.5]
    expect(fractional).toHaveLength(1)
  })

  it("문자열도 막힌다 — 폼의 '1' 을 그대로 넘기면 안 된다", () => {
    // @ts-expect-error FormData 는 문자열을 줍니다. parseInt 를 거쳐야 합니다.
    const stringly: Weekday[] = ['1']
    expect(stringly).toHaveLength(1)
  })
})

describe('weekdays 배열 — 타입이 못 막는 것 (DB 담당)', () => {
  it('★ 빈 배열은 타입을 통과한다 → 그래서 DB 트리거가 22023 으로 거부한다 ★', () => {
    // 이 줄이 컴파일된다는 사실 자체가 테스트입니다. 어느 요일에도 안 걸리는
    // 유령 템플릿을 타입으로는 막을 수 없으므로, 방어선이 두 겹 필요합니다:
    //   1. app/templates/actions.ts 의 parseWeekdays 가 빈 선택을 null 로 돌려
    //      서버에 보내지 않고 "요일을 하나 이상 골라 주세요"로 안내하고,
    //   2. 그래도 넘어오면 task_templates_weekdays_chk(cardinality 1~7)와
    //      normalize_task_template_weekdays 트리거가 22023 을 던집니다.
    // 잠시 쉬게 하려면 weekdays 를 비우지 말고 active = false 를 쓰세요.
    const empty: Weekday[] = []
    expect(empty).toHaveLength(0)

    const insert: TaskTemplateInsert = {
      user_id: '11111111-1111-4111-8111-111111111111',
      group_id: '22222222-2222-4222-8222-222222222222',
      title: '유령 템플릿',
      weekdays: [],
    }
    expect(insert.weekdays).toEqual([])
  })

  it('중복과 뒤죽박죽 순서도 타입을 통과한다 → DB 트리거가 정렬 + 중복 제거한다', () => {
    // 보낼 때는 자유입니다. 읽어 온 값은 언제나 오름차순·중복 없음입니다.
    const messy: Weekday[] = [3, 1, 1, 6, 0, 3]
    expect(messy).toHaveLength(6)

    // 트리거가 정규화한 뒤의 모양. Row 타입이 이 상태를 나타냅니다.
    const normalized: TaskTemplate['weekdays'] = [0, 1, 3, 6]
    expect(normalized).toEqual([...normalized].sort((a, b) => a - b))
    expect(new Set(normalized).size).toBe(normalized.length)
  })

  it('7개를 넘길 수는 없다 — 중복 제거 뒤 최대 7개(cardinality 1~7)', () => {
    const normalized: Weekday[] = [0, 1, 2, 3, 4, 5, 6]
    expect(new Set(normalized).size).toBeLessThanOrEqual(7)
  })

  it('요일을 비우는 대신 active 를 끈다 — Update 타입이 두 길을 모두 연다', () => {
    const rest: TaskTemplateUpdate = { active: false }
    expect(rest.active).toBe(false)
    expect(rest.weekdays).toBeUndefined()
  })
})

/* ==========================================================================
 * 4. "오늘 채우기" RPC 의 반환 계약
 *
 * ★ RETURNS TABLE 인 RPC 는 배열로 옵니다 — data[0] ★
 * 이 프로젝트에서 실제로 터졌던 함정입니다. 객체로 받는 코드는 타입 체크는
 * 통과하고 런타임에 `undefined` 를 렌더링합니다("0개 불러왔어요"라는 거짓말).
 * ======================================================================== */

describe('apply_today_templates / copy_tasks_from — 반환 형태', () => {
  it('★ Returns 는 배열이다 ★', () => {
    const rows: FunctionReturns<'apply_today_templates'> = [{ created: 2, skipped: 1 }]
    expect(Array.isArray(rows)).toBe(true)
    expect(rows[0].created).toBe(2)
  })

  it('★ 객체 하나로 받으면 컴파일에서 막힌다 ★', () => {
    // @ts-expect-error RETURNS TABLE 은 배열입니다. data[0] 을 보세요.
    const wrong: FunctionReturns<'apply_today_templates'> = { created: 2, skipped: 1 }
    expect(wrong).toBeDefined()
  })

  it('BulkFillResult 는 그 배열의 한 줄이다 (created / skipped 둘 다 number)', () => {
    const row: BulkFillResult = { created: 0, skipped: 3 }
    expect(typeof row.created).toBe('number')
    expect(typeof row.skipped).toBe('number')
  })

  it('copy_tasks_from 도 같은 모양이다 — 두 버튼이 한 렌더링 코드를 공유한다', () => {
    const rows: FunctionReturns<'copy_tasks_from'> = [{ created: 4, skipped: 0 }]
    const row: BulkFillResult = rows[0]
    expect(row).toEqual({ created: 4, skipped: 0 })
  })

  it('빈 배열이 올 수 있다 — data[0] 은 undefined 이고, 0/0 으로 접어야 한다', () => {
    // RPC 가 조기 return 하거나 RLS 가 행을 막으면 배열이 비어 옵니다.
    // `data[0].created` 를 그대로 읽으면 그 자리에서 TypeError 입니다.
    const rows: BulkFillResult[] = []
    const created = rows[0]?.created ?? 0
    const skipped = rows[0]?.skipped ?? 0
    expect([created, skipped]).toEqual([0, 0])
  })

  it('거부는 예외가 아니라 값이다 — 오늘/미래/NULL 은 created=0, skipped=0', () => {
    // copy_tasks_from 은 reason 을 돌려주지 않습니다. 화면은 0/0 을
    // "복사할 게 없었어요"로 렌더링해야 하고, 빨간 오류로 띄우면 안 됩니다.
    const refused: BulkFillResult = { created: 0, skipped: 0 }
    expect(refused.created + refused.skipped).toBe(0)
  })
})

describe('RPC 인자 계약 — 대상은 언제나 auth.uid()', () => {
  it('apply_today_templates 의 p_group_id 는 선택이다 (없으면 전체 그룹)', () => {
    const all: FunctionArgs<'apply_today_templates'> = {}
    const one: FunctionArgs<'apply_today_templates'> = {
      p_group_id: '22222222-2222-4222-8222-222222222222',
    }
    expect(all.p_group_id).toBeUndefined()
    expect(one.p_group_id).toBeTruthy()
  })

  it('copy_tasks_from 의 p_date 는 필수다', () => {
    const args: FunctionArgs<'copy_tasks_from'> = { p_date: '2026-08-30' }
    expect(args.p_date).toBe('2026-08-30')
  })

  it('★ 남의 id 를 인자로 넘길 길이 없다 — p_user_id 는 존재하지 않는다 ★', () => {
    const args: FunctionArgs<'copy_tasks_from'> = {
      p_date: '2026-08-30',
      // @ts-expect-error 이런 인자를 추가하면 SECURITY DEFINER 가 우회 통로가 됩니다.
      p_user_id: '11111111-1111-4111-8111-111111111111',
    }
    expect(args.p_date).toBe('2026-08-30')
  })
})

/* ==========================================================================
 * 5. tasks.template_id — 클라이언트에서 읽기 전용
 *
 * 0002 의 컬럼 grant 를 일부러 넓히지 않았습니다. 클라이언트가 template_id 를
 * 심을 수 있으면 tasks_user_date_template_uidx 의 자리를 선점해서 자기 템플릿이
 * 영영 적용되지 않게 만들 수 있습니다.
 * ======================================================================== */

describe('tasks.template_id', () => {
  it('읽기는 된다 — "반복" 배지를 그리려면 필요하다 (없으면 null)', () => {
    const fromTemplate: Task['template_id'] = '33333333-3333-4333-8333-333333333333'
    const handTyped: Task['template_id'] = null
    expect(fromTemplate).toBeTruthy()
    expect(handTyped).toBeNull()
  })

  it('★ INSERT 로는 보낼 수 없다 — 보내면 42501 permission denied ★', () => {
    const insert: TaskInsert = {
      user_id: '11111111-1111-4111-8111-111111111111',
      group_id: '22222222-2222-4222-8222-222222222222',
      title: '손으로 적은 할 일',
      // @ts-expect-error template_id 는 Insert 에 없습니다. RPC 가 유일한 쓰기 경로입니다.
      template_id: '33333333-3333-4333-8333-333333333333',
    }
    expect(insert.title).toBe('손으로 적은 할 일')
  })

  it('★ task_date 도 보내지 않는다 — 컬럼 DEFAULT(current_user_local_date)가 이겨야 한다 ★', () => {
    // 이 프로젝트에서 실제로 터졌던 함정 1번. new Date().toISOString() 은
    // 01:30 KST 에 전날을 반환합니다. Insert 타입에서 선택 필드인 것은
    // 백필용이고, 평소에는 생략하는 것이 옳습니다.
    const insert: TaskInsert = {
      user_id: '11111111-1111-4111-8111-111111111111',
      group_id: '22222222-2222-4222-8222-222222222222',
      title: '오늘 할 일',
    }
    expect(insert.task_date).toBeUndefined()
  })
})
