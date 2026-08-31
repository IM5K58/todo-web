/**
 * lib/offline.ts — "마지막으로 본 오늘 목록" 스냅샷 저장소 + 연결 확인
 *
 * ★ 범위: 읽기 전용 오프라인입니다. ★
 * 여기에는 쓰기 큐도, 재접속 동기화도, 충돌 해결도 없습니다. 오프라인에서
 * 저장을 시도하면 화면이 정직하게 "지금은 저장할 수 없어요"를 말하고 끝입니다.
 * (되는 척하다가 조용히 잃는 것이 최악이고, iOS Safari 는 Background Sync 도
 *  지원하지 않아서 "나중에 자동으로 보낼게요"는 지킬 수 없는 약속입니다.)
 *
 * ---------------------------------------------------------------------------
 * 이 모듈은 세 곳에서 import 됩니다 — 그래서 모듈 최상위가 순수해야 합니다
 * ---------------------------------------------------------------------------
 *   1. app/today-tasks.tsx  (브라우저, 'use client')
 *   2. app/sw.ts            (서비스워커 — esbuild 가 번들합니다)
 *   3. 테스트 (jsdom)
 *
 * 서비스워커에는 window 도 localStorage 도 없습니다. 그래서 최상위에서는
 * 어떤 전역도 건드리지 않고, 모든 저장소 접근을 함수 안 try/catch 에 가둡니다.
 * sw.ts 는 실제로 상수 하나(OFFLINE_SNAPSHOT_KEY)만 가져가고 나머지는
 * esbuild 의 treeShaking 이 떨어냅니다 — 최상위 부수효과가 있으면 그 트리
 * 셰이킹이 막히므로, 여기에 부수효과를 추가하지 마세요.
 *
 * sw.ts 가 키를 복제하지 않고 import 하는 이유: 문자열이 어긋나면 오프라인
 * 화면이 조용히 빈 채로 뜹니다. 그건 사용자가 알아챌 수 없는 종류의 고장입니다.
 * (app/sw.ts 의 urlBase64ToUint8Array 는 반대로 복제돼 있는데, 그건 원본이
 *  'use client' + window 참조라 워커에 넣을 수 없었기 때문입니다. 이 파일은
 *  일부러 그 제약이 없게 썼습니다.)
 */

/* ==========================================================================
 * 저장 형식
 * ======================================================================== */

/**
 * localStorage 키. app/sw.ts 의 오프라인 문서가 같은 키를 읽습니다.
 *
 * 끝의 ':v1' 은 아래 SNAPSHOT_VERSION 과 짝입니다. 형식을 바꿀 때는 키를
 * 올리세요 — 그러면 옛 형식이 남아 있어도 그냥 무시되고, 파싱 실패 경로를
 * 탈 일이 없습니다.
 */
export const OFFLINE_SNAPSHOT_KEY = 'daily-todo:today-snapshot:v1'

/** 스냅샷 본문의 버전. 읽을 때 정확히 이 값이 아니면 버립니다. */
export const SNAPSHOT_VERSION = 1 as const

/**
 * 저장할 최대 줄 수. 3~6명이 쓰는 앱의 하루치는 보통 3~7줄이고, 여기 걸릴
 * 일은 사실상 없습니다. 상한이 있는 이유는 localStorage 가 원점(origin) 단위로
 * 5MB 안팎을 공유하기 때문입니다 — 스냅샷 하나가 그 예산을 다 먹어서 다른
 * 기능(Supabase 의 세션 저장 등)의 쓰기를 QuotaExceededError 로 밀어내면
 * 그게 훨씬 큰 고장입니다.
 */
export const SNAPSHOT_MAX_TASKS = 100

/** 제목 상한. tasks_title_len_chk 와 같은 200자(코드 포인트)입니다. */
const SNAPSHOT_MAX_TITLE = 200

/**
 * 날짜가 같아도 이만큼 지난 스냅샷은 버립니다.
 *
 * 날짜 문자열 비교만으로 충분해 보이지만, 기기 시계나 시간대를 바꾸면
 * "어제 23:50 에 저장한 것"이 오늘 날짜와 같아질 수 있습니다. 36시간이면
 * 정상 사용(하루 안)은 절대 걸리지 않고 시계 장난만 걸러냅니다.
 */
const SNAPSHOT_MAX_AGE_MS = 36 * 60 * 60 * 1000

/** 스냅샷에 담기는 할 일 한 줄. app/today-tasks.tsx 의 TodayTaskView 와 같은 모양입니다. */
export type OfflineTask = {
  id: string
  title: string
  done: boolean
}

/** localStorage 에 JSON 으로 들어가는 값. */
export type TodaySnapshot = {
  v: typeof SNAPSHOT_VERSION
  /** 저장 시점의 **기기** 로컬 날짜 'YYYY-MM-DD'. 아래 deviceLocalDate() 주석 참고. */
  date: string
  /** Date.now(). 시계가 바뀐 경우를 걸러내는 용도. */
  savedAt: number
  /** 활성 그룹 이름. 없으면 빈 문자열. */
  groupName: string
  tasks: OfflineTask[]
}

/* ==========================================================================
 * 날짜
 * ======================================================================== */

/**
 * 기기 시간대 기준 오늘 ('YYYY-MM-DD'). en-CA 로케일이 정확히 이 형식입니다.
 *
 * ★ 이것은 DB 의 current_user_local_date() 가 아닙니다 ★
 * ---------------------------------------------------------------------------
 * 이 프로젝트의 "오늘"은 profiles.timezone 기준이고 DB 가 정합니다. 그 값은
 * 서버 왕복 없이는 알 수 없는데, 오프라인은 정의상 서버 왕복이 불가능합니다.
 * 그래서 여기서는 기기 시간대를 씁니다.
 *
 * 이게 안전한 이유는 이 값이 **쓰기에 쓰이지 않기 때문**입니다. tasks.task_date
 * 는 여전히 컬럼 DEFAULT 가 정하고, 이 문자열은 어디에도 전송되지 않습니다.
 * 하는 일은 오직 하나 — "저장할 때와 읽을 때가 같은 날인가"를 판정하는 것.
 * 저장과 읽기가 같은 기기·같은 방식이라 둘은 언제나 서로 일관됩니다.
 *
 * profiles.timezone 과 기기 시간대가 다르면(해외 여행 등) 스냅샷의 유효기간이
 * DB 의 하루 경계보다 이르거나 늦게 끝날 수 있습니다. 그 결과는 "스냅샷을
 * 버리고 빈 오프라인 화면을 보여줌"입니다 — 즉 실패 방향이 안전한 쪽입니다.
 * 반대(어제 목록을 오늘 것처럼 보여줌)는 최대 몇 시간 창에서만 가능한데,
 * 화면에 언제 저장된 목록인지 시각이 함께 뜨고 배너가 최신이 아님을 말합니다.
 */
export function deviceLocalDate(now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now)
  } catch {
    // Intl 이 없거나 로케일이 막힌 환경. 같은 결과를 손으로 만듭니다.
    const year = now.getFullYear()
    const month = `${now.getMonth() + 1}`.padStart(2, '0')
    const day = `${now.getDate()}`.padStart(2, '0')
    return `${year}-${month}-${day}`
  }
}

/* ==========================================================================
 * 저장소
 *
 * localStorage 를 씁니다. IndexedDB 가 아닙니다.
 * ---------------------------------------------------------------------------
 *  · 양: 하루치 3~7줄 × 제목 200자 상한 = 수 KB. localStorage 예산 안입니다.
 *  · 동기: 서비스워커가 만들어 주는 오프라인 문서는 첫 페인트에 목록을 그려야
 *    합니다. IndexedDB 는 비동기라 "빈 화면 → 목록" 깜빡임이 생깁니다.
 *  · 단순함: 스키마도 마이그레이션도 없고, 실패해도 그냥 null 입니다.
 * 나중에 오프라인 쓰기 큐가 생긴다면 그건 IndexedDB 가 맞습니다. 지금은 아닙니다.
 * ======================================================================== */

/**
 * 저장소 핸들. 없거나 접근 자체가 던지면 null.
 *
 * getter 접근이 던지는 환경이 실재합니다 — 쿠키/사이트 데이터를 막은 브라우저,
 * 일부 인앱 웹뷰, iOS 의 옛 프라이빗 모드가 SecurityError 를 냅니다. 그래서
 * `'localStorage' in window` 같은 검사로는 부족하고 try/catch 여야 합니다.
 */
function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** 제목을 코드 포인트 기준으로 자릅니다. 이모지가 반쪽으로 잘리지 않게. */
function clampTitle(title: string): string {
  const points = Array.from(title)
  return points.length <= SNAPSHOT_MAX_TITLE
    ? title
    : points.slice(0, SNAPSHOT_MAX_TITLE).join('')
}

/**
 * 오늘 목록을 저장합니다. 성공하면 true.
 *
 * 실패(저장소 없음 / 용량 초과 / 프라이빗 모드)는 값으로 돌려주고 던지지
 * 않습니다. 저장소가 아예 없어도 앱은 평소대로 동작해야 합니다 — 잃는 것은
 * 오프라인 화면 하나뿐입니다.
 */
export function saveTodaySnapshot(input: {
  tasks: readonly OfflineTask[]
  groupName?: string
  now?: Date
}): boolean {
  const store = storage()
  if (!store) return false

  const now = input.now ?? new Date()

  const snapshot: TodaySnapshot = {
    v: SNAPSHOT_VERSION,
    date: deviceLocalDate(now),
    savedAt: now.getTime(),
    groupName: typeof input.groupName === 'string' ? clampTitle(input.groupName) : '',
    tasks: input.tasks.slice(0, SNAPSHOT_MAX_TASKS).map((task) => ({
      id: String(task.id),
      title: clampTitle(String(task.title)),
      done: task.done === true,
    })),
  }

  try {
    store.setItem(OFFLINE_SNAPSHOT_KEY, JSON.stringify(snapshot))
    return true
  } catch {
    // 대개 QuotaExceededError. 우리 키를 비워 자리를 돌려주고 포기합니다 —
    // 여기서 재시도를 반복하면 다른 기능의 쓰기까지 같이 실패시킵니다.
    try {
      store.removeItem(OFFLINE_SNAPSHOT_KEY)
    } catch {
      /* 지우는 것마저 안 되면 할 수 있는 게 없습니다 */
    }
    return false
  }
}

/** 저장된 값이 우리가 쓴 모양인지 확인합니다. localStorage 는 누구나 고칠 수 있습니다. */
function isSnapshot(value: unknown): value is TodaySnapshot {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>

  if (candidate.v !== SNAPSHOT_VERSION) return false
  if (typeof candidate.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(candidate.date)) {
    return false
  }
  if (typeof candidate.savedAt !== 'number' || !Number.isFinite(candidate.savedAt)) {
    return false
  }
  if (typeof candidate.groupName !== 'string') return false
  if (!Array.isArray(candidate.tasks)) return false

  return candidate.tasks.every((task: unknown) => {
    if (typeof task !== 'object' || task === null) return false
    const row = task as Record<string, unknown>
    return (
      typeof row.id === 'string' &&
      typeof row.title === 'string' &&
      typeof row.done === 'boolean'
    )
  })
}

/**
 * 저장된 오늘 목록. **오늘 것이 아니면 null 입니다.**
 *
 * 어제 목록을 오늘 것처럼 보여주는 건 이 기능이 할 수 있는 가장 나쁜 거짓말
 * 입니다("어제 다 했는데 왜 미완료지?" → 실제로는 오늘 아침 목록이 아님).
 * 그래서 날짜가 다르면 조용히 버리고, 화면은 "저장된 목록이 없어요"를 냅니다.
 */
export function readTodaySnapshot(now: Date = new Date()): TodaySnapshot | null {
  const store = storage()
  if (!store) return null

  let raw: string | null
  try {
    raw = store.getItem(OFFLINE_SNAPSHOT_KEY)
  } catch {
    return null
  }
  if (!raw) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (!isSnapshot(parsed)) return null

  // 규칙 1: 오늘이 아니면 버린다.
  if (parsed.date !== deviceLocalDate(now)) return null

  // 규칙 2: 시계가 바뀌었을 수 있으니 나이도 본다. 미래 시각도 거부합니다.
  const age = now.getTime() - parsed.savedAt
  if (age < -60_000 || age > SNAPSHOT_MAX_AGE_MS) return null

  return parsed
}

/** 스냅샷을 지웁니다. 로그아웃처럼 "이 기기에 남기면 안 되는" 시점에 부르세요. */
export function clearTodaySnapshot(): void {
  const store = storage()
  if (!store) return
  try {
    store.removeItem(OFFLINE_SNAPSHOT_KEY)
  } catch {
    /* 지울 수 없으면 그대로 둡니다 — 어차피 날짜가 바뀌면 무시됩니다 */
  }
}

/* ==========================================================================
 * 연결 확인
 * ======================================================================== */

/**
 * 연결 확인용 URL.
 *
 * 왜 하필 서비스워커 스크립트인가:
 *  · **캐시될 수 없습니다.** 프리캐시 매니페스트는 `.next/static/**` 와
 *    `public/**` 만 담습니다(@serwist/turbopack 의 generateGlobPatterns).
 *    /serwist/sw.js 는 Route Handler 라 둘 중 어디에도 없고, next.config.ts 가
 *    `max-age=0, must-revalidate` 를 붙여 HTTP 캐시도 막습니다.
 *  · **HEAD 는 어떤 런타임 캐시 규칙도 타지 않습니다.** Serwist 라우터는 GET
 *    만 처리하므로 HEAD 는 언제나 진짜 네트워크로 나갑니다. 즉 캐시가 대신
 *    대답해서 "온라인"이라고 착각할 여지가 구조적으로 없습니다.
 *  · proxy.ts 의 matcher 가 `.*\.(?:js|mjs|map)$` 로 제외하므로 세션이 없어도
 *    로그인 리다이렉트를 맞지 않습니다.
 *  · 부수효과가 없고 본문도 오지 않습니다.
 */
export const NETWORK_PROBE_URL = '/serwist/sw.js'

/** 확인 요청 제한 시간. 이보다 오래 걸리면 "연결 안 됨"으로 봅니다. */
const PROBE_TIMEOUT_MS = 4000

/**
 * 진짜로 서버에 닿는지 확인합니다.
 *
 * ★ navigator.onLine 은 거짓말을 합니다 ★
 * true 는 "네트워크 인터페이스가 올라와 있다"는 뜻일 뿐입니다. 카페 와이파이에
 * 붙었지만 로그인 페이지를 통과하지 않았거나, 지하철에서 신호만 잡힌 상태도
 * 전부 true 입니다. false 는 비교적 믿을 만하지만(인터페이스가 내려간 것),
 * 그것도 일부 데스크톱 환경에서는 항상 true 로 고정돼 있습니다.
 *
 * 그래서 "온라인으로 돌아왔다"는 판정은 반드시 이 함수로 합니다.
 * 'online' 이벤트는 확인을 시작하라는 **신호**일 뿐 결론이 아닙니다.
 *
 * 캡티브 포털은 요청을 가로채 자기 페이지로 302 를 보냅니다. 그래서 200 만으로는
 * 부족하고 `redirected` 도 봅니다 — 리다이렉트됐다면 우리 서버가 아닙니다.
 */
export async function probeNetwork(timeoutMs: number = PROBE_TIMEOUT_MS): Promise<boolean> {
  // false 는 믿습니다. 그러면 요청 한 번을 아낍니다.
  try {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return false
  } catch {
    /* navigator 가 없는 환경 — 그냥 요청해 봅니다 */
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const controller = new AbortController()
    timer = setTimeout(() => controller.abort(), timeoutMs)

    const response = await fetch(NETWORK_PROBE_URL, {
      method: 'HEAD',
      cache: 'no-store',
      // 세션 쿠키를 붙일 이유가 없습니다. 확인만 하면 됩니다.
      credentials: 'omit',
      redirect: 'follow',
      signal: controller.signal,
    })

    return response.ok && !response.redirected
  } catch {
    // 네트워크 실패, 시간 초과, 그리고 fetch 자체가 없는 환경(테스트 등).
    return false
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
