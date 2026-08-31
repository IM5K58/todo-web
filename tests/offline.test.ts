import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  NETWORK_PROBE_URL,
  OFFLINE_SNAPSHOT_KEY,
  SNAPSHOT_MAX_TASKS,
  SNAPSHOT_VERSION,
  clearTodaySnapshot,
  deviceLocalDate,
  probeNetwork,
  readTodaySnapshot,
  saveTodaySnapshot,
  type OfflineTask,
} from '@/lib/offline'
import { TASK_TITLE_MAX } from '@/lib/tasks'

/**
 * tests/offline.test.ts — lib/offline.ts 의 스냅샷 저장소 + 연결 확인.
 *
 * 이 모듈이 지켜야 하는 약속은 셋뿐이고, 셋 다 "조용한 거짓말"을 막는 것입니다.
 *
 *   1. ★ 어제 목록을 오늘 것처럼 보여주지 않는다 ★
 *      오프라인 화면이 할 수 있는 최악의 고장입니다. "어제 다 했는데 왜 미완료
 *      로 뜨지?" 는 사용자가 원인을 알아낼 수 없는 종류의 버그입니다.
 *   2. 저장소가 없거나 던져도 앱은 그냥 흘러간다. localStorage 접근은 실재하는
 *      환경(사이트 데이터 차단, 인앱 웹뷰, iOS 옛 프라이빗 모드)에서 getter
 *      자체가 SecurityError 를 냅니다.
 *   3. 저장된 값을 믿지 않는다. localStorage 는 사용자도, 옛 버전의 우리도
 *      고칠 수 있습니다.
 *
 * ── 모킹 방침 ─────────────────────────────────────────────────────────────
 * 왕복 테스트는 jsdom 이 주는 진짜 localStorage 를 씁니다. 가짜 Storage 를
 * 새로 쓰면 검증하는 대상이 우리 mock 이 되어 버립니다. globalThis 를 건드리는
 * 것은 "저장소가 고장난 환경"을 흉내 낼 때뿐이고, 그때도 defineProperty 한
 * 줄입니다. now 는 함수 인자로 받게 설계돼 있어서 시계 모킹이 아예 없습니다.
 * ─────────────────────────────────────────────────────────────────────────
 */

/* ==========================================================================
 * 저장소 스텁 — 고장난 환경을 흉내 낼 때만 씁니다
 * ======================================================================== */

/**
 * 원래 서술자를 기억해 뒀다가 되돌립니다.
 *
 * jsdom/vitest 조합에 따라 localStorage 가 globalThis 의 own property 일 수도,
 * 프로토타입에 있을 수도 있습니다. own 이 없었다면 `delete` 로 우리가 덮어쓴
 * 것만 걷어내면 원래 접근 경로가 되살아납니다. 양쪽 다 처리합니다.
 */
const ORIGINAL_STORAGE = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')

function stubStorage(descriptor: PropertyDescriptor): void {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, ...descriptor })
}

function restoreStorage(): void {
  if (ORIGINAL_STORAGE) {
    Object.defineProperty(globalThis, 'localStorage', ORIGINAL_STORAGE)
  } else {
    delete (globalThis as { localStorage?: unknown }).localStorage
  }
}

/** 접근하는 순간 던지는 저장소. 사이트 데이터를 막은 브라우저가 이렇습니다. */
function stubThrowingStorageGetter(): void {
  stubStorage({
    get() {
      throw new Error('SecurityError: localStorage 접근이 차단되었습니다')
    },
  })
}

/** 저장소 자체가 없는 환경(서비스워커, 아주 오래된 웹뷰). */
function stubMissingStorage(): void {
  stubStorage({ value: undefined, writable: true })
}

/** 값은 있는데 메서드가 던지는 저장소. 용량 초과(QuotaExceededError)가 이 모양입니다. */
function stubStorageWhere(overrides: Partial<Storage>): void {
  const real = new Map<string, string>()
  const base: Storage = {
    get length() {
      return real.size
    },
    clear: () => real.clear(),
    getItem: (key: string) => real.get(key) ?? null,
    key: (index: number) => [...real.keys()][index] ?? null,
    removeItem: (key: string) => {
      real.delete(key)
    },
    setItem: (key: string, value: string) => {
      real.set(key, value)
    },
  }
  stubStorage({ value: { ...base, ...overrides } satisfies Storage, writable: true })
}

/* ==========================================================================
 * 도우미
 * ======================================================================== */

function task(id: string, title: string, done = false): OfflineTask {
  return { id, title, done }
}

/** 검증을 우회해 원하는 모양의 값을 저장소에 직접 밀어넣습니다. */
function writeRaw(raw: string): void {
  globalThis.localStorage.setItem(OFFLINE_SNAPSHOT_KEY, raw)
}

function readRaw(): string | null {
  return globalThis.localStorage.getItem(OFFLINE_SNAPSHOT_KEY)
}

/**
 * 로컬 시각으로 Date 를 만듭니다. `new Date(y, m, d, ...)` 는 언제나 실행
 * 환경의 시간대로 해석되고 deviceLocalDate 도 같은 시간대로 포맷하므로, 테스트가
 * 어느 시간대에서 돌아도 아래 날짜 문자열은 그대로 나옵니다.
 */
function localTime(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0
): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0)
}

beforeEach(() => {
  globalThis.localStorage.clear()
})

afterEach(() => {
  restoreStorage()
  vi.unstubAllGlobals()
  globalThis.localStorage.clear()
})

/* ==========================================================================
 * 1. deviceLocalDate — 하루 경계 판정의 기준
 * ======================================================================== */

describe('deviceLocalDate — 기기 시간대 기준 오늘', () => {
  it("'YYYY-MM-DD' 형식이다 (en-CA 로케일이 정확히 이 형식)", () => {
    expect(deviceLocalDate(localTime(2026, 8, 31, 9, 0))).toBe('2026-08-31')
  })

  it('한 자리 월·일을 0으로 채운다 — 문자열 비교가 판정이라 자릿수가 틀리면 전부 어긋난다', () => {
    expect(deviceLocalDate(localTime(2026, 1, 5, 12, 0))).toBe('2026-01-05')
    expect(deviceLocalDate(localTime(2026, 9, 9, 12, 0))).toBe('2026-09-09')
  })

  it('로컬 자정 직전과 직후는 다른 날이다', () => {
    expect(deviceLocalDate(localTime(2026, 8, 30, 23, 59))).toBe('2026-08-30')
    expect(deviceLocalDate(localTime(2026, 8, 31, 0, 0))).toBe('2026-08-31')
  })

  it('★ 01:30 에도 "그날"을 돌려준다 — toISOString().slice(0,10) 이 KST 에서 저지르는 실수 ★', () => {
    // new Date(...).toISOString() 은 UTC 로 접기 때문에 KST 01:30 에 전날을
    // 내놓습니다. lib/tasks.ts 가 못 박은 함정 1번과 같은 계열의 버그입니다.
    // 이 값은 서버로 전송되지 않지만, 여기서 하루가 밀리면 아침에 앱을 연
    // 사용자가 오프라인 화면에서 "어제 목록"을 보게 됩니다.
    expect(deviceLocalDate(localTime(2026, 8, 31, 1, 30))).toBe('2026-08-31')
  })

  it('윤년 2월 29일도 그대로', () => {
    expect(deviceLocalDate(localTime(2028, 2, 29, 12, 0))).toBe('2028-02-29')
  })

  it('인자 없이 불러도 던지지 않고 형식을 지킨다', () => {
    expect(deviceLocalDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

/* ==========================================================================
 * 2. 저장 → 복원 왕복
 * ======================================================================== */

describe('saveTodaySnapshot / readTodaySnapshot — 왕복', () => {
  it('저장한 목록이 그대로 돌아온다', () => {
    const now = localTime(2026, 8, 31, 9, 0)
    const tasks = [task('a', '물 마시기', true), task('b', '산책', false)]

    expect(saveTodaySnapshot({ tasks, groupName: '아침조', now })).toBe(true)

    const snapshot = readTodaySnapshot(now)
    expect(snapshot).not.toBeNull()
    expect(snapshot?.v).toBe(SNAPSHOT_VERSION)
    expect(snapshot?.date).toBe('2026-08-31')
    expect(snapshot?.savedAt).toBe(now.getTime())
    expect(snapshot?.groupName).toBe('아침조')
    expect(snapshot?.tasks).toEqual(tasks)
  })

  it('아무것도 저장한 적이 없으면 null (예외가 아니다)', () => {
    expect(readTodaySnapshot(localTime(2026, 8, 31, 9, 0))).toBeNull()
  })

  it('빈 목록도 정상적으로 저장·복원된다 — "오늘 할 일이 0개"는 유효한 사실이다', () => {
    const now = localTime(2026, 8, 31, 9, 0)
    expect(saveTodaySnapshot({ tasks: [], now })).toBe(true)

    const snapshot = readTodaySnapshot(now)
    expect(snapshot).not.toBeNull()
    expect(snapshot?.tasks).toEqual([])
  })

  it('groupName 을 생략하면 빈 문자열 (undefined 가 새어 나가지 않는다)', () => {
    const now = localTime(2026, 8, 31, 9, 0)
    saveTodaySnapshot({ tasks: [task('a', '산책')], now })
    expect(readTodaySnapshot(now)?.groupName).toBe('')
  })

  it('다시 저장하면 덮어쓴다 — 목록이 누적되지 않는다', () => {
    const now = localTime(2026, 8, 31, 9, 0)
    saveTodaySnapshot({ tasks: [task('a', '옛날 것')], now })
    saveTodaySnapshot({ tasks: [task('b', '새 것')], now })

    const snapshot = readTodaySnapshot(now)
    expect(snapshot?.tasks).toHaveLength(1)
    expect(snapshot?.tasks[0].title).toBe('새 것')
  })

  it('저장 후 하루가 끝날 때까지(같은 날 23:59) 계속 읽힌다', () => {
    const saved = localTime(2026, 8, 31, 8, 0)
    saveTodaySnapshot({ tasks: [task('a', '산책')], now: saved })
    expect(readTodaySnapshot(localTime(2026, 8, 31, 23, 59))).not.toBeNull()
  })

  it('clearTodaySnapshot 이 지운다 — 로그아웃 때 남의 목록이 남으면 안 된다', () => {
    const now = localTime(2026, 8, 31, 9, 0)
    saveTodaySnapshot({ tasks: [task('a', '산책')], now })
    expect(readTodaySnapshot(now)).not.toBeNull()

    clearTodaySnapshot()

    expect(readTodaySnapshot(now)).toBeNull()
    expect(readRaw()).toBeNull()
  })

  it('저장된 적 없어도 clearTodaySnapshot 은 조용히 성공한다', () => {
    expect(() => clearTodaySnapshot()).not.toThrow()
  })
})

/* ==========================================================================
 * 3. ★ 날짜가 다르면 버린다 ★ — 이 파일에서 가장 중요한 절
 *
 * "어제 목록이 오늘 것으로 복원되면 안 된다"는 요구를 여러 각도에서 못 박습니다.
 * 나이(36시간)로 걸러지는 것과 날짜로 걸러지는 것을 반드시 분리해서 봐야
 * 합니다 — 어제 23:50 에 저장한 목록은 오늘 00:10 기준으로 겨우 20분 된
 * 신선한 값이라, 나이만 보는 구현은 이것을 통과시킵니다.
 * ======================================================================== */

describe('readTodaySnapshot — 날짜가 다르면 버린다', () => {
  it('★ 어제 23:50 에 저장한 목록은 오늘 00:10 에 복원되지 않는다 (20분밖에 안 됐어도) ★', () => {
    const savedAt = localTime(2026, 8, 30, 23, 50)
    const readAt = localTime(2026, 8, 31, 0, 10)

    // 나이로는 절대 걸러지지 않는 값입니다. 오직 날짜 비교만이 이걸 막습니다.
    expect(readAt.getTime() - savedAt.getTime()).toBe(20 * 60 * 1000)
    expect(deviceLocalDate(savedAt)).toBe('2026-08-30')
    expect(deviceLocalDate(readAt)).toBe('2026-08-31')

    saveTodaySnapshot({ tasks: [task('a', '어제 할 일')], now: savedAt })

    expect(readTodaySnapshot(readAt)).toBeNull()
  })

  it('어제 아침에 저장한 목록도 오늘은 안 나온다', () => {
    const savedAt = localTime(2026, 8, 30, 9, 0)
    saveTodaySnapshot({ tasks: [task('a', '어제 할 일')], now: savedAt })
    expect(readTodaySnapshot(localTime(2026, 8, 31, 9, 0))).toBeNull()
  })

  it('내일 날짜로 저장된 값도 오늘은 안 나온다 (시계를 앞당겼다 되돌린 경우)', () => {
    const now = localTime(2026, 8, 31, 9, 0)
    writeRaw(
      JSON.stringify({
        v: SNAPSHOT_VERSION,
        date: '2026-09-01',
        savedAt: now.getTime(),
        groupName: '',
        tasks: [task('a', '내일 할 일')],
      })
    )
    expect(readTodaySnapshot(now)).toBeNull()
  })

  it('버릴 때 예외가 아니라 null 이다 — 화면은 "저장된 목록이 없어요"로 흘러간다', () => {
    saveTodaySnapshot({ tasks: [task('a', '어제')], now: localTime(2026, 8, 30, 9, 0) })
    expect(() => readTodaySnapshot(localTime(2026, 8, 31, 9, 0))).not.toThrow()
  })

  it('월이 바뀌는 경계에서도 다른 날이다 (8/31 → 9/1)', () => {
    saveTodaySnapshot({ tasks: [task('a', '8월 마지막')], now: localTime(2026, 8, 31, 23, 30) })
    expect(readTodaySnapshot(localTime(2026, 9, 1, 0, 30))).toBeNull()
  })

  it('해가 바뀌는 경계에서도 다른 날이다 (12/31 → 1/1)', () => {
    saveTodaySnapshot({ tasks: [task('a', '올해 마지막')], now: localTime(2026, 12, 31, 23, 30) })
    expect(readTodaySnapshot(localTime(2027, 1, 1, 0, 30))).toBeNull()
  })
})

/* ==========================================================================
 * 4. 나이 — 날짜가 같아도 너무 오래됐으면 버린다
 *
 * 날짜 문자열이 같은데 36시간이 지났다는 것은 기기 시계나 시간대가 바뀌었다는
 * 뜻입니다. 정상 사용(하루 안)은 절대 여기 걸리지 않습니다.
 * ======================================================================== */

describe('readTodaySnapshot — 나이(36시간)와 미래 시각', () => {
  const now = localTime(2026, 8, 31, 12, 0)

  /** date 는 오늘로 맞추고 savedAt 만 원하는 값으로 심습니다. */
  function seedWithAge(ageMs: number): void {
    writeRaw(
      JSON.stringify({
        v: SNAPSHOT_VERSION,
        date: deviceLocalDate(now),
        savedAt: now.getTime() - ageMs,
        groupName: '',
        tasks: [task('a', '산책')],
      })
    )
  }

  const MAX_AGE = 36 * 60 * 60 * 1000

  it('갓 저장한 값은 통과', () => {
    seedWithAge(0)
    expect(readTodaySnapshot(now)).not.toBeNull()
  })

  it('정확히 36시간은 아직 통과 (경계는 초과일 때만 버린다)', () => {
    seedWithAge(MAX_AGE)
    expect(readTodaySnapshot(now)).not.toBeNull()
  })

  it('36시간 + 1ms 는 버린다', () => {
    seedWithAge(MAX_AGE + 1)
    expect(readTodaySnapshot(now)).toBeNull()
  })

  it('시계를 되돌려 savedAt 이 미래가 되면 버린다 (5분 미래)', () => {
    seedWithAge(-5 * 60 * 1000)
    expect(readTodaySnapshot(now)).toBeNull()
  })

  it('60초 이내의 미래는 봐준다 — 저장과 읽기 사이의 시계 흔들림은 정상이다', () => {
    seedWithAge(-60_000)
    expect(readTodaySnapshot(now)).not.toBeNull()
  })

  it('60초를 1ms 넘긴 미래는 버린다', () => {
    seedWithAge(-60_001)
    expect(readTodaySnapshot(now)).toBeNull()
  })
})

/* ==========================================================================
 * 5. 손상된 값 / 옛 스키마 — 저장소의 내용을 믿지 않는다
 * ======================================================================== */

describe('readTodaySnapshot — 손상된 값은 전부 null', () => {
  const now = localTime(2026, 8, 31, 12, 0)
  const today = deviceLocalDate(now)

  /** 오늘·정상 나이의 스냅샷에서 한 곳만 망가뜨립니다. */
  function seed(overrides: Record<string, unknown>): void {
    writeRaw(
      JSON.stringify({
        v: SNAPSHOT_VERSION,
        date: today,
        savedAt: now.getTime(),
        groupName: '',
        tasks: [task('a', '산책')],
        ...overrides,
      })
    )
  }

  it('JSON 이 아니면 null (던지지 않는다)', () => {
    writeRaw('{ 이건 JSON 이 아닙니다')
    expect(() => readTodaySnapshot(now)).not.toThrow()
    expect(readTodaySnapshot(now)).toBeNull()
  })

  it('빈 문자열은 null', () => {
    writeRaw('')
    expect(readTodaySnapshot(now)).toBeNull()
  })

  it('JSON 이지만 객체가 아니면 null (null / 배열 / 숫자 / 문자열)', () => {
    for (const raw of ['null', '[]', '42', '"어제 목록"', 'true']) {
      writeRaw(raw)
      expect(readTodaySnapshot(now), `raw=${raw}`).toBeNull()
    }
  })

  it('★ 버전이 다르면 null — 옛 형식을 새 화면이 그리려 들면 안 된다 ★', () => {
    seed({ v: 0 })
    expect(readTodaySnapshot(now)).toBeNull()

    seed({ v: SNAPSHOT_VERSION + 1 })
    expect(readTodaySnapshot(now)).toBeNull()

    seed({ v: String(SNAPSHOT_VERSION) }) // "1" — 느슨한 비교였다면 통과했을 값
    expect(readTodaySnapshot(now)).toBeNull()
  })

  it('date 가 없거나 형식이 다르면 null', () => {
    for (const date of [undefined, null, 20260831, '2026-8-31', '2026/08/31', 'today']) {
      seed({ date })
      expect(readTodaySnapshot(now), `date=${String(date)}`).toBeNull()
    }
  })

  it('savedAt 이 숫자가 아니거나 유한하지 않으면 null', () => {
    for (const savedAt of [undefined, null, '1756600000000', Number.NaN]) {
      seed({ savedAt })
      expect(readTodaySnapshot(now), `savedAt=${String(savedAt)}`).toBeNull()
    }
    // Infinity 는 JSON.stringify 가 null 로 접기 때문에 따로 문자열로 심습니다.
    writeRaw(`{"v":${SNAPSHOT_VERSION},"date":"${today}","savedAt":1e999,"groupName":"","tasks":[]}`)
    expect(readTodaySnapshot(now)).toBeNull()
  })

  it('groupName 이 문자열이 아니면 null', () => {
    seed({ groupName: 42 })
    expect(readTodaySnapshot(now)).toBeNull()
  })

  it('tasks 가 배열이 아니면 null', () => {
    for (const tasks of [undefined, null, {}, '산책']) {
      seed({ tasks })
      expect(readTodaySnapshot(now), `tasks=${String(tasks)}`).toBeNull()
    }
  })

  it('할 일 한 줄이라도 모양이 다르면 통째로 null — 반쪽짜리 목록을 그리지 않는다', () => {
    seed({ tasks: [task('a', '산책'), { id: 'b', title: '물 마시기' }] }) // done 없음
    expect(readTodaySnapshot(now)).toBeNull()

    seed({ tasks: [{ id: 1, title: '산책', done: false }] }) // id 가 숫자
    expect(readTodaySnapshot(now)).toBeNull()

    seed({ tasks: [{ id: 'a', title: '산책', done: 'true' }] }) // done 이 문자열
    expect(readTodaySnapshot(now)).toBeNull()

    seed({ tasks: [null] })
    expect(readTodaySnapshot(now)).toBeNull()

    seed({ tasks: ['산책'] })
    expect(readTodaySnapshot(now)).toBeNull()
  })

  it('모르는 필드가 더 붙어 있는 것은 통과한다 — 앞으로 필드를 더해도 깨지지 않는다', () => {
    seed({ note: '나중에 추가된 필드' })
    expect(readTodaySnapshot(now)).not.toBeNull()
  })
})

/* ==========================================================================
 * 6. 저장 시 정규화 — 저장소 예산과 DB 제약을 함께 지킨다
 * ======================================================================== */

describe('saveTodaySnapshot — 정규화와 상한', () => {
  const now = localTime(2026, 8, 31, 9, 0)

  it(`할 일이 ${SNAPSHOT_MAX_TASKS}개를 넘으면 잘라서 저장한다`, () => {
    const many = Array.from({ length: SNAPSHOT_MAX_TASKS + 50 }, (_, i) =>
      task(`id-${i}`, `할 일 ${i}`)
    )
    expect(saveTodaySnapshot({ tasks: many, now })).toBe(true)

    const snapshot = readTodaySnapshot(now)
    expect(snapshot?.tasks).toHaveLength(SNAPSHOT_MAX_TASKS)
    // 앞에서부터 자릅니다 — 목록의 위쪽이 사용자가 실제로 보는 부분입니다.
    expect(snapshot?.tasks[0].id).toBe('id-0')
    expect(snapshot?.tasks[SNAPSHOT_MAX_TASKS - 1].id).toBe(`id-${SNAPSHOT_MAX_TASKS - 1}`)
  })

  it(`상한과 같은 개수(${SNAPSHOT_MAX_TASKS})는 그대로 저장된다`, () => {
    const exact = Array.from({ length: SNAPSHOT_MAX_TASKS }, (_, i) => task(`id-${i}`, `할 일 ${i}`))
    saveTodaySnapshot({ tasks: exact, now })
    expect(readTodaySnapshot(now)?.tasks).toHaveLength(SNAPSHOT_MAX_TASKS)
  })

  it('★ 제목은 코드 포인트 기준으로 자른다 — 이모지가 반쪽으로 잘리면 깨진 글자가 된다 ★', () => {
    // JS 의 .slice() 는 UTF-16 코드 유닛 단위라 서로게이트 페어를 쪼갭니다.
    const title = '😀'.repeat(250)
    saveTodaySnapshot({ tasks: [task('a', title)], now })

    const stored = readTodaySnapshot(now)?.tasks[0].title ?? ''
    expect(Array.from(stored)).toHaveLength(TASK_TITLE_MAX)
    expect(stored).toBe('😀'.repeat(TASK_TITLE_MAX))
    expect(stored).not.toContain('�')
  })

  it('상한(200자) 이하의 제목은 손대지 않는다 — DB 의 tasks_title_len_chk 와 같은 값', () => {
    expect(TASK_TITLE_MAX).toBe(200)
    const title = '할'.repeat(TASK_TITLE_MAX)
    saveTodaySnapshot({ tasks: [task('a', title)], now })
    expect(readTodaySnapshot(now)?.tasks[0].title).toBe(title)
  })

  it('groupName 도 같은 상한으로 잘린다', () => {
    saveTodaySnapshot({ tasks: [], groupName: '가'.repeat(500), now })
    const stored = readTodaySnapshot(now)?.groupName ?? ''
    expect(Array.from(stored)).toHaveLength(TASK_TITLE_MAX)
  })

  it('done 은 정확히 true 일 때만 true — 느슨한 truthy 는 "다 했다"는 거짓말이 된다', () => {
    const dirty = [
      { id: 'a', title: '느슨한 참', done: 1 },
      { id: 'b', title: '문자열', done: 'yes' },
      { id: 'c', title: '진짜', done: true },
    ] as unknown as OfflineTask[]

    saveTodaySnapshot({ tasks: dirty, now })

    expect(readTodaySnapshot(now)?.tasks.map((row) => row.done)).toEqual([false, false, true])
  })

  it('id 는 문자열로 강제된다 — 숫자 id 가 섞여 들어와도 읽기가 통째로 실패하지 않는다', () => {
    const dirty = [{ id: 7, title: '산책', done: false }] as unknown as OfflineTask[]
    saveTodaySnapshot({ tasks: dirty, now })
    expect(readTodaySnapshot(now)?.tasks[0].id).toBe('7')
  })

  it('groupName 이 문자열이 아니면 빈 문자열로 접는다', () => {
    const dirty = { tasks: [], groupName: 123, now } as unknown as Parameters<
      typeof saveTodaySnapshot
    >[0]
    saveTodaySnapshot(dirty)
    expect(readTodaySnapshot(now)?.groupName).toBe('')
  })

  it('입력 배열을 변형하지 않는다 (호출부의 React state 를 건드리면 안 된다)', () => {
    const tasks = [task('a', '산책')]
    const before = structuredClone(tasks)
    saveTodaySnapshot({ tasks, now })
    expect(tasks).toEqual(before)
  })
})

/* ==========================================================================
 * 7. 저장소가 고장난 환경 — 앱이 죽지 않고 빈 값으로 흘러간다
 * ======================================================================== */

describe('저장소 접근이 막혀도 앱은 흘러간다', () => {
  const now = localTime(2026, 8, 31, 9, 0)

  it('★ localStorage 접근 자체가 던져도 save 는 false, read 는 null ★', () => {
    stubThrowingStorageGetter()

    expect(() => saveTodaySnapshot({ tasks: [task('a', '산책')], now })).not.toThrow()
    expect(saveTodaySnapshot({ tasks: [task('a', '산책')], now })).toBe(false)

    expect(() => readTodaySnapshot(now)).not.toThrow()
    expect(readTodaySnapshot(now)).toBeNull()

    expect(() => clearTodaySnapshot()).not.toThrow()
  })

  it('localStorage 가 아예 없어도(서비스워커 등) 같은 결과', () => {
    stubMissingStorage()

    expect(saveTodaySnapshot({ tasks: [task('a', '산책')], now })).toBe(false)
    expect(readTodaySnapshot(now)).toBeNull()
    expect(() => clearTodaySnapshot()).not.toThrow()
  })

  it('getItem 이 던져도 read 는 null', () => {
    stubStorageWhere({
      getItem: () => {
        throw new Error('SecurityError')
      },
    })
    expect(readTodaySnapshot(now)).toBeNull()
  })

  it('용량 초과(setItem 이 던짐)면 false 를 돌려주고 예외를 삼킨다', () => {
    stubStorageWhere({
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    })
    expect(saveTodaySnapshot({ tasks: [task('a', '산책')], now })).toBe(false)
  })

  it('★ 용량 초과로 저장에 실패하면 옛 스냅샷을 지운다 — 낡은 목록이 남아 오늘 것처럼 보이면 안 된다 ★', () => {
    // 먼저 진짜 저장소에 어제치 값을 정상적으로 넣습니다.
    saveTodaySnapshot({ tasks: [task('old', '먼저 저장된 목록')], now })
    expect(readRaw()).not.toBeNull()

    // 그다음 setItem 만 던지게 만들고 다시 저장을 시도합니다.
    const real = globalThis.localStorage
    stubStorage({
      value: {
        ...real,
        getItem: (key: string) => real.getItem(key),
        removeItem: (key: string) => real.removeItem(key),
        setItem: () => {
          throw new Error('QuotaExceededError')
        },
      },
      writable: true,
    })

    expect(saveTodaySnapshot({ tasks: [task('new', '새 목록')], now })).toBe(false)

    restoreStorage()
    expect(readRaw()).toBeNull()
    expect(readTodaySnapshot(now)).toBeNull()
  })

  it('setItem 도 removeItem 도 던지면 그래도 false 만 돌려준다 (여기서 포기한다)', () => {
    stubStorageWhere({
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: () => {
        throw new Error('SecurityError')
      },
    })
    expect(() => saveTodaySnapshot({ tasks: [task('a', '산책')], now })).not.toThrow()
    expect(saveTodaySnapshot({ tasks: [task('a', '산책')], now })).toBe(false)
  })

  it('removeItem 이 던져도 clearTodaySnapshot 은 던지지 않는다', () => {
    stubStorageWhere({
      removeItem: () => {
        throw new Error('SecurityError')
      },
    })
    expect(() => clearTodaySnapshot()).not.toThrow()
  })
})

/* ==========================================================================
 * 8. 서비스워커와의 계약
 *
 * app/sw.ts 는 OFFLINE_SNAPSHOT_KEY 를 import 하지만, 오프라인 문서 안의
 * 인라인 스크립트는 읽기 규칙(v === 1, 날짜, 36시간, -60초)을 손으로 복제하고
 * 있습니다. 그 스크립트는 서비스워커 번들 안의 문자열이라 여기서 직접 실행할
 * 수 없으므로, 대신 스크립트가 하드코딩한 상수들이 이 모듈의 값과 같은지를
 * 못 박습니다. 여기가 어긋나면 오프라인 화면만 조용히 비어 버립니다.
 * ======================================================================== */

describe('스냅샷 키 / 버전 계약', () => {
  it('키에 버전이 박혀 있다 — 형식을 바꾸면 키도 올려서 옛 값이 그냥 무시되게 한다', () => {
    expect(OFFLINE_SNAPSHOT_KEY).toBe('daily-todo:today-snapshot:v1')
    expect(OFFLINE_SNAPSHOT_KEY.endsWith(`:v${SNAPSHOT_VERSION}`)).toBe(true)
  })

  it('SNAPSHOT_VERSION 은 1 — app/sw.ts 의 인라인 스크립트가 `snap.v !== 1` 로 복제하고 있다', () => {
    expect(SNAPSHOT_VERSION).toBe(1)
  })

  it('실제로 저장되는 JSON 이 sw.ts 가 기대하는 필드를 전부 갖는다', () => {
    const now = localTime(2026, 8, 31, 9, 0)
    saveTodaySnapshot({ tasks: [task('a', '산책', true)], groupName: '아침조', now })

    const parsed = JSON.parse(readRaw() ?? '{}') as Record<string, unknown>
    // sw.ts 가 읽는 것: v, date, savedAt, tasks[].title, tasks[].done
    expect(Object.keys(parsed).sort()).toEqual(['date', 'groupName', 'savedAt', 'tasks', 'v'])
    expect(parsed.v).toBe(1)
    expect(parsed.date).toBe('2026-08-31')
    expect(typeof parsed.savedAt).toBe('number')
  })
})

/* ==========================================================================
 * 9. probeNetwork — navigator.onLine 을 믿지 않는 연결 확인
 * ======================================================================== */

/** fetch 응답의 최소 모양. probeNetwork 는 ok 와 redirected 만 봅니다. */
function fakeResponse(init: { ok: boolean; redirected: boolean }): Response {
  return init as unknown as Response
}

/** navigator.onLine 을 바꿉니다. jsdom 기본값은 true 입니다. */
function stubOnLine(value: boolean): void {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => value })
}

describe('probeNetwork', () => {
  afterEach(() => {
    delete (navigator as { onLine?: unknown }).onLine
  })

  it('navigator.onLine === false 면 요청도 하지 않고 false', async () => {
    // false 는 "인터페이스가 내려갔다"는 뜻이라 믿을 만합니다. 요청 한 번을 아낍니다.
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    stubOnLine(false)

    await expect(probeNetwork()).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('200 이고 리다이렉트되지 않았으면 true', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeResponse({ ok: true, redirected: false }))
    )
    await expect(probeNetwork()).resolves.toBe(true)
  })

  it('★ 리다이렉트됐으면 false — 카페 와이파이의 캡티브 포털이 200 을 돌려준다 ★', async () => {
    // 응답이 200 이어도 우리 서버가 아닙니다. ok 만 보면 "온라인"이라고 착각하고
    // 화면이 저장을 열어 주는데, 그 저장은 전부 실패합니다.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeResponse({ ok: true, redirected: true }))
    )
    await expect(probeNetwork()).resolves.toBe(false)
  })

  it('2xx 가 아니면 false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeResponse({ ok: false, redirected: false }))
    )
    await expect(probeNetwork()).resolves.toBe(false)
  })

  it('fetch 가 던지면 false (예외가 밖으로 새지 않는다)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      })
    )
    await expect(probeNetwork()).resolves.toBe(false)
  })

  it('fetch 가 아예 없는 환경에서도 false', async () => {
    vi.stubGlobal('fetch', undefined)
    await expect(probeNetwork()).resolves.toBe(false)
  })

  it('★ 응답이 오지 않으면 시간 안에 포기한다 — 확인이 매달리면 화면도 매달린다 ★', async () => {
    const fetchMock = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('AbortError')))
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(probeNetwork(5)).resolves.toBe(false)
  })

  it('HEAD · no-store · credentials omit 으로 보낸다', async () => {
    let seenUrl: unknown
    let seenInit: RequestInit | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        seenUrl = url
        seenInit = init
        return fakeResponse({ ok: true, redirected: false })
      })
    )

    await probeNetwork()

    expect(seenUrl).toBe(NETWORK_PROBE_URL)
    // GET 이면 Serwist 라우터의 런타임 캐시가 대신 대답해서 오프라인인데도
    // "온라인"이 됩니다. HEAD 는 구조적으로 캐시를 타지 않습니다.
    expect(seenInit?.method).toBe('HEAD')
    expect(seenInit?.cache).toBe('no-store')
    expect(seenInit?.credentials).toBe('omit')
    // redirect: 'follow' 여야 캡티브 포털의 302 가 redirected=true 로 드러납니다.
    expect(seenInit?.redirect).toBe('follow')
    expect(seenInit?.signal).toBeDefined()
  })
})

describe('NETWORK_PROBE_URL — proxy.ts 와의 계약', () => {
  it('/serwist/sw.js 다', () => {
    expect(NETWORK_PROBE_URL).toBe('/serwist/sw.js')
  })

  it('★ proxy.ts 의 matcher 제외 패턴에 걸린다 — 아니면 세션 없는 확인이 로그인 리다이렉트를 맞는다 ★', () => {
    // proxy.ts 의 matcher 에서 그대로 옮긴 조각입니다. 여기에 걸리지 않는 URL 을
    // 고르면 미들웨어가 /login 으로 302 를 보내고, probeNetwork 는 redirected 를
    // 보고 언제나 false 를 돌려줍니다 — 즉 앱이 영원히 "오프라인"이 됩니다.
    const proxyExcluded = /.*\.(?:js|mjs|map|css|json|txt|xml|svg|png|jpg|jpeg|gif|webp|avif|ico|woff|woff2|ttf|otf)$/
    expect(proxyExcluded.test(NETWORK_PROBE_URL)).toBe(true)
  })

  it('부수효과가 없는 같은 출처 경로다 (절대 URL 이 아니다)', () => {
    expect(NETWORK_PROBE_URL.startsWith('/')).toBe(true)
    expect(NETWORK_PROBE_URL).not.toMatch(/^https?:/)
  })
})
