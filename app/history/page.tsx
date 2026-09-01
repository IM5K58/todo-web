import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { Screen } from '@/components/screen'
import { Card, ErrorText, Hint, LinkButton, PageHeader } from '@/components/ui'
import {
  STREAK_WINDOW_DAYS,
  WEEKDAY_LABELS,
  getHistoryPageData,
  heatLevel,
  type HistoryDay,
  type HistoryMonth,
  type HistoryTask,
} from '@/lib/history'

/**
 * /history — 내 할 일 기록.
 *
 * Server Component. 모든 조회는 lib/history.ts 를 거칩니다. 그 파일이
 * "오늘"을 DB 에 물어보고(rpc('current_user_local_date') — tasks.task_date 의
 * DEFAULT 와 같은 함수), 180일치 (task_date, done_at) 을 한 번에 긁어와
 * JS 로 집계합니다. 이 파일에는 쿼리가 한 줄도 없습니다.
 *
 * ---------------------------------------------------------------------------
 * 이 화면이 보여 주는 것과 보여 주지 않는 것
 * ---------------------------------------------------------------------------
 * 내 기록만입니다. 0002 의 tasks_select_group_members 정책은 같은 그룹 멤버의
 * 할 일도 읽게 해 주지만, "친구가 지난 반년 동안 며칠 빠졌는지"를 달력으로
 * 펼쳐 보여 주는 것은 이 앱이 하려는 일이 아닙니다. 오늘의 상호 압력은
 * /status 가 담당하고, 여기는 혼자 보는 화면입니다.
 *
 * ---------------------------------------------------------------------------
 * 히트맵이 반드시 구분해야 하는 세 가지
 * ---------------------------------------------------------------------------
 *   빈 칸        : 조회 범위(180일) 밖이거나 아직 오지 않은 날 — 아무것도 그리지 않음
 *   안 적은 날    : 그날 할 일이 0개 — accent 를 아예 쓰지 않고 점선 테두리
 *   못 끝낸 날    : 적었는데 남긴 날 — accent 투명도 단계(1~3)
 *   다 끝낸 날    : accent 원색
 *
 * "안 적은 날"과 "0개 완료한 날"을 옅은 색 두 단계로만 나누면 야외 화면이나
 * 색각 이상에서는 같은 칸이 됩니다. 그래서 그 둘의 차이는 농도가 아니라
 * "accent 가 있는가 없는가 + 테두리가 점선인가"입니다.
 *
 * 색은 전부 globals.css 의 @theme inline 이 만드는 9개 토큰 안에서 해결합니다
 * (bg / surface / surface-2 / fg / muted / line / accent / accent-fg / danger).
 * 새 색 토큰은 만들지 않았습니다.
 */

export const metadata: Metadata = {
  title: '기록',
}

// ---------------------------------------------------------------------------
// 표시 유틸
// ---------------------------------------------------------------------------

/**
 * '2026-08-30' -> '2026년 8월 30일 토요일'.
 *
 * timeZone: 'UTC' 로 고정하고 UTC 자정 Date 를 넘깁니다. 시간대 가정이 아니라
 * 그 반대입니다 — 입력은 이미 사용자 시간대로 계산된 순수 달력 날짜라서,
 * 어떤 존으로든 다시 투영하면 하루가 밀립니다. (app/page.tsx 와 같은 방식)
 */
function formatKoreanDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number)
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return isoDate
  }
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(new Date(Date.UTC(year, month - 1, day)))
}

function firstParam(raw: string | string[] | undefined): string | undefined {
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) return raw[0]
  return undefined
}

/**
 * 농도 0~4 -> 실제 클래스.
 *
 * 0 만 accent 를 쓰지 않고 점선입니다. 1~3 은 accent 투명도 단계이고 4 는
 * 원색 + accent-fg 글자입니다(옅은 칸 위의 글자는 fg 그대로가 제일 잘 읽힙니다).
 */
const LEVEL_CLASS: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: 'border-line bg-surface-2 text-muted border border-dashed',
  1: 'border-accent/40 bg-accent/15 text-fg border',
  2: 'border-accent/50 bg-accent/35 text-fg border',
  3: 'border-accent/60 bg-accent/60 text-fg border',
  4: 'border-accent bg-accent text-accent-fg border',
}

const CELL_BASE =
  'flex aspect-square items-center justify-center rounded-md text-[11px] tabular-nums'

// ---------------------------------------------------------------------------
// 레이아웃 조각
// ---------------------------------------------------------------------------

/**
 * 조회가 실패했습니다. 빈 달력으로 삼키지 않습니다 — "기록이 없어요"와
 * "기록을 못 불러왔어요"는 완전히 다른 사실이고, 둘 중 하나만 다시 시도로
 * 고쳐집니다.
 *
 * 다시 시도는 <Link> 가 아니라 평범한 <a> 입니다. 지금 있는 라우트로의
 * 클라이언트 내비게이션은 라우터 캐시에서 그대로 나올 수 있어서, 정작 필요한
 * 순간에 아무 일도 하지 않는 버튼이 됩니다.
 */
function LoadFailure({ message }: { message: string }) {
  return (
    <Screen>
      <PageHeader title="내 기록" backHref="/" backLabel="오늘로 돌아가기" />
      <Card>
        <ErrorText>{message}</ErrorText>
        <a
          href="/history"
          className="border-line bg-surface text-fg inline-flex h-12 w-full shrink-0 items-center justify-center rounded-xl border px-4 text-base font-medium transition active:scale-[0.99]"
        >
          다시 불러오기
        </a>
      </Card>
    </Screen>
  )
}

function Stat({
  label,
  value,
  note,
}: {
  label: string
  value: string
  note?: string
}) {
  return (
    <div className="border-line bg-surface-2 flex flex-col gap-0.5 rounded-xl border p-3">
      <p className="text-muted text-xs">{label}</p>
      <p className="text-fg text-xl font-semibold tabular-nums">{value}</p>
      {note && <p className="text-muted text-xs [word-break:keep-all]">{note}</p>}
    </div>
  )
}

/** 범례 견본 한 칸. 달력 칸과 같은 클래스를 써서 색이 어긋나지 않게 합니다. */
function Swatch({ level }: { level: 0 | 1 | 2 | 3 | 4 }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block size-3.5 shrink-0 rounded-sm ${LEVEL_CLASS[level]}`}
    />
  )
}

// ---------------------------------------------------------------------------
// 달력
// ---------------------------------------------------------------------------

/**
 * 달력 한 칸.
 *
 * 할 일을 적은 날만 링크입니다. 안 적은 날을 눌러도 보여 줄 것이 없는데
 * 탭 영역만 만들어 두면 "눌리는데 아무 일도 안 나는 칸"이 됩니다.
 *
 * 링크는 ?d=YYYY-MM-DD 로 이 화면을 다시 부릅니다. 클라이언트 상태도, 미리
 * 받아 둔 제목 목록도 없습니다 — 반년치 할 일 제목을 전부 내려받아 두는 것은
 * 첫 화면을 무겁게 만들고, 대부분의 사용자는 한 칸도 누르지 않습니다.
 */
function DayCell({
  day,
  selectedDate,
}: {
  day: HistoryDay | null
  selectedDate: string | null
}) {
  // 그 달에 속하지 않는 칸(요일 정렬 여백), 창 밖, 미래 — 자리만 잡습니다.
  if (day === null || day.outOfRange) {
    return <div aria-hidden="true" className="aspect-square rounded-md" />
  }

  const level = heatLevel(day)
  const month = Number(day.date.slice(5, 7))
  const selected = selectedDate === day.date

  // 오늘과 선택한 날은 색이 아니라 테두리 링으로 표시합니다. 농도 단계를
  // 하나 더 쓰면 히트맵이 읽히지 않습니다.
  const ring = selected
    ? 'ring-2 ring-fg ring-offset-1 ring-offset-surface'
    : day.isToday
      ? 'ring-1 ring-fg'
      : ''

  const className = `${CELL_BASE} ${LEVEL_CLASS[level]} ${ring}`

  const label =
    day.total === 0
      ? `${month}월 ${day.dayOfMonth}일, 적은 할 일 없음`
      : `${month}월 ${day.dayOfMonth}일, ${day.total}개 중 ${day.done}개 완료`

  if (day.total === 0) {
    return (
      <div role="img" aria-label={label} className={className}>
        {day.dayOfMonth}
      </div>
    )
  }

  return (
    <Link
      href={`/history?d=${day.date}#day`}
      aria-label={label}
      aria-current={selected ? 'true' : undefined}
      className={`${className} transition active:scale-[0.95]`}
    >
      {day.dayOfMonth}
    </Link>
  )
}

function MonthGrid({
  month,
  selectedDate,
}: {
  month: HistoryMonth
  selectedDate: string | null
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-fg text-sm font-semibold tabular-nums">{month.label}</h3>
      {/* 요일 헤더를 같은 grid 안에 넣어야 7열이 절대 어긋나지 않습니다. */}
      <div className="grid grid-cols-7 gap-1">
        {WEEKDAY_LABELS.map((weekday) => (
          <div key={weekday} className="text-muted pb-0.5 text-center text-[11px]">
            {weekday}
          </div>
        ))}
        {month.weeks.map((week, weekIndex) =>
          week.map((day, dayIndex) => (
            <DayCell
              key={day?.date ?? `${month.key}-blank-${weekIndex}-${dayIndex}`}
              day={day}
              selectedDate={selectedDate}
            />
          )),
        )}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// 하루 펼쳐 보기
// ---------------------------------------------------------------------------

/**
 * 읽기 전용 목록입니다. TaskCheckbox 를 쓰지 않은 이유가 있습니다 — 그건
 * Server Action 폼 안의 submit 버튼이라, 과거 날짜에 놓으면 "눌러서 지난 날을
 * 고칠 수 있다"는 약속이 됩니다. 이 화면은 그 약속을 지킬 수 없습니다.
 */
function DayDetail({
  date,
  tasks,
  error,
}: {
  date: string
  tasks: HistoryTask[]
  error: string | null
}) {
  const done = tasks.filter((task) => task.done).length

  return (
    <div id="day" className="scroll-mt-4">
      <Card title={formatKoreanDate(date)}>
        {error ? (
          <ErrorText>{error}</ErrorText>
        ) : tasks.length === 0 ? (
          <Hint>그날은 할 일을 적지 않았어요.</Hint>
        ) : (
          <>
            <p className="text-muted text-xs tabular-nums">
              {tasks.length}개 중 {done}개 완료
            </p>
            <ul className="flex flex-col">
              {tasks.map((task) => (
                <li
                  key={task.id}
                  className="border-line flex min-h-11 items-center gap-3 border-b py-2 last:border-b-0"
                >
                  <span
                    aria-hidden="true"
                    className={`grid size-5 shrink-0 place-items-center rounded-md border text-[11px] ${
                      task.done
                        ? 'border-accent bg-accent text-accent-fg'
                        : 'border-line bg-surface-2'
                    }`}
                  >
                    {task.done ? '✓' : ''}
                  </span>
                  <span
                    className={`min-w-0 flex-1 text-sm leading-snug [word-break:keep-all] ${
                      task.done ? 'text-muted line-through' : 'text-fg'
                    }`}
                  >
                    {task.title}
                  </span>
                  <span className="sr-only">{task.done ? '완료' : '미완료'}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        <Link
          href="/history"
          className="text-muted inline-flex h-11 items-center text-sm underline-offset-4 hover:underline"
        >
          접기
        </Link>
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const params = await searchParams
  // 검증은 lib/history.ts 가 합니다(존재하지 않는 '2026-02-31' 같은 값 포함).
  const data = await getHistoryPageData(firstParam(params.d))

  if (!data.userId) {
    redirect('/login')
  }
  if (data.error) {
    return <LoadFailure message={data.error} />
  }

  const { summary } = data

  // 창 상한에 걸린 스트릭은 "120일"이 아니라 "120일+"입니다. 홈 화면의 🔥
  // 배지와 같은 표기를 씁니다.
  const currentStreakText =
    summary.currentStreak >= STREAK_WINDOW_DAYS
      ? `${summary.currentStreak}일+`
      : `${summary.currentStreak}일`

  // 기록이 없거나 오늘 하루뿐인 신규 사용자.
  // ★ "아직 기록이 없어요"로 화면을 덮지 않습니다 ★ — 달력은 그대로 두고
  // 오늘 칸을 보여 준 다음, 한 줄로 사실만 덧붙입니다.
  const isBrandNew = summary.recordedDays <= 1

  return (
    <Screen>
      <PageHeader title="내 기록" backHref="/" backLabel="오늘로 돌아가기" />

      {/* ---- 요약 -------------------------------------------------------- */}
      <Card>
        <div className="grid grid-cols-2 gap-3">
          <Stat
            label="총 완료"
            value={`${summary.totalDone}개`}
            note={`적은 할 일 ${summary.totalTasks}개 중`}
          />
          <Stat
            label="완주한 날"
            value={`${summary.perfectDays}일`}
            note={`할 일을 적은 ${summary.recordedDays}일 중`}
          />
          <Stat label="현재 연속" value={currentStreakText} note="오늘은 아직 세지 않아요" />
          <Stat
            label="최장 연속"
            value={`${summary.longestStreak}일`}
            note={`최근 ${data.windowDays}일 안에서`}
          />
        </div>

        {isBrandNew && (
          <Hint>
            {summary.recordedDays === 0
              ? '아직 여기에 쌓인 게 없어요. 오늘 할 일을 적으면 오늘 칸부터 채워집니다.'
              : '이제 막 시작했어요. 하루씩 쌓이면 아래 달력이 채워집니다.'}
          </Hint>
        )}

        {summary.recordedDays === 0 && <LinkButton href="/">오늘 할 일 적으러 가기</LinkButton>}
      </Card>

      {/* ---- 펼쳐 본 하루 ------------------------------------------------ */}
      {data.selectedDate && (
        <DayDetail
          date={data.selectedDate}
          tasks={data.selectedTasks}
          error={data.selectedError}
        />
      )}

      {/* ---- 달력 -------------------------------------------------------- */}
      <Card title="달력">
        <div className="flex flex-col gap-5">
          {data.months.map((month) => (
            <MonthGrid key={month.key} month={month} selectedDate={data.selectedDate} />
          ))}
        </div>

        {/* ---- 범례 ------------------------------------------------------ */}
        <div className="border-line flex flex-col gap-2 border-t pt-3">
          <div className="text-muted flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
            <span className="inline-flex items-center gap-1.5">
              <Swatch level={0} />
              안 적은 날
            </span>
            <span className="inline-flex items-center gap-1.5">
              적고 남긴 날
              <Swatch level={1} />
              <Swatch level={2} />
              <Swatch level={3} />
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Swatch level={4} />
              다 끝낸 날
            </span>
          </div>
          <Hint>
            아무것도 없는 칸은 조회 범위 밖이거나 아직 오지 않은 날이에요. 테두리가 굵은
            칸이 오늘이고, 할 일을 적은 날을 누르면 그날 목록이 열려요.
          </Hint>
        </div>
      </Card>

      {/* ---- 범위 고지 --------------------------------------------------- */}
      <div className="flex flex-col gap-1">
        <p className="text-muted text-xs [word-break:keep-all]">
          최근 {data.windowDays}일({formatKoreanDate(data.from)}부터)까지만 모아서 보여줘요.
          그 이전 기록도 지워지지 않고 그대로 남아 있어요.
        </p>
        {data.truncated && (
          <p className="text-muted text-xs [word-break:keep-all]">
            적어 둔 할 일이 아주 많아서 그보다 이전은 이 화면에서 생략했어요. 그래서 위
            숫자들은 {formatKoreanDate(data.from)} 이후만 센 값이에요.
          </p>
        )}
        <p className="text-muted text-xs [word-break:keep-all]">
          여기 보이는 건 내 기록뿐이에요. 친구들의 오늘은 현황 화면에서 볼 수 있어요.
        </p>
      </div>

      <LinkButton href="/status" variant="secondary">
        친구들 현황 보기
      </LinkButton>
    </Screen>
  )
}
