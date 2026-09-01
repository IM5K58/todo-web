import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'

import { Screen } from '@/components/screen'
import { Card, EmptyState, ErrorText, Hint, LinkButton, PageHeader } from '@/components/ui'
import { avatarAltText } from '@/lib/avatar'
import {
  STREAK_WINDOW_DAYS,
  WEEKDAY_LABELS,
  heatLevel,
  type HistoryDay,
  type HistoryMonth,
  type HistoryTask,
} from '@/lib/history'
import { getMemberDetail, type MemberDetail } from '@/lib/member-detail'

/**
 * /members/[userId] — 그룹원 한 명의 오늘과 기록.
 *
 * 현황 화면(/status)의 이름을 누르면 여기로 옵니다. 보여 주는 것은 셋입니다:
 * 누구인지(이름·아바타·함께 있는 그룹), 오늘 무엇을 적었고 어디까지 했는지,
 * 그리고 최근 180일의 달력.
 *
 * Server Component 입니다. 쿼리는 한 줄도 여기 없습니다 — 전부
 * lib/member-detail.ts 를 거칩니다. 그 파일 머리말에 "왜 이 화면이 가능한가"
 * (0002 의 tasks_select_group_members 정책)와 "왜 함께 있는 그룹으로 좁히는가"
 * 가 SQL 인용과 함께 적혀 있습니다.
 *
 * ---------------------------------------------------------------------------
 * 세 갈래 분기
 * ---------------------------------------------------------------------------
 *   self       내 id → /history. 같은 사람의 숫자가 화면마다 갈라지지 않게
 *              하기 위해서입니다(근거는 lib/member-detail.ts 머리말).
 *   not-found  없는 사람이든 남남이든 **똑같이** notFound(). 문구를 다르게
 *              하면 uuid 를 넣어 보는 것만으로 계정 존재 여부를 알 수 있게
 *              됩니다. 그래서 여기서는 이유를 받지도 않습니다.
 *   error      조회 실패. 빈 달력으로 삼키지 않습니다 — "기록이 없어요" 와
 *              "못 불러왔어요" 는 다른 사실이고 둘 중 하나만 재시도로 고쳐집니다.
 *
 * ---------------------------------------------------------------------------
 * /history 와 무엇이 다른가 (일부러 다르게 둔 것들)
 * ---------------------------------------------------------------------------
 * · 달력 칸이 링크가 아닙니다. 남의 지난 하루를 제목까지 펼쳐 보는 것은 이
 *   화면이 하려는 일이 아니고(오늘의 상호 압력이 이 앱의 목적입니다),
 *   ?d= 를 받으면 날짜마다 왕복이 하나씩 더 붙습니다. 칸은 role="img" +
 *   aria-label 로 "며칠, 몇 개 중 몇 개" 를 그대로 읽어 줍니다.
 * · 오늘 목록에 TaskCheckbox 를 쓰지 않습니다. 그건 Server Action 폼의 submit
 *   버튼이라 "눌러서 고칠 수 있다" 는 약속이 되는데, 남의 할 일은 0002 의
 *   tasks_update_own 이 막습니다. 지킬 수 없는 약속은 그리지 않습니다.
 *
 * 색은 globals.css 가 만드는 9개 토큰 안에서만 씁니다
 * (bg / surface / surface-2 / fg / muted / line / accent / accent-fg / danger).
 */

export const metadata: Metadata = {
  title: '그룹원',
}

// ---------------------------------------------------------------------------
// 표시 유틸
// ---------------------------------------------------------------------------

/**
 * '2026-08-30' -> '2026년 8월 30일'.
 *
 * timeZone: 'UTC' 로 고정하고 UTC 자정 Date 를 넘깁니다. 시간대 가정이 아니라
 * 그 반대입니다 — 입력은 이미 사용자 시간대로 계산된 순수 달력 날짜라서,
 * 어떤 존으로든 다시 투영하면 하루가 밀립니다. (app/history/page.tsx 와 동일)
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
  }).format(new Date(Date.UTC(year, month - 1, day)))
}

/**
 * 농도 0~4 -> 클래스. app/history/page.tsx 의 LEVEL_CLASS 와 같은 값입니다 —
 * 두 화면의 같은 색이 다른 뜻이 되면 히트맵을 읽을 수 없습니다.
 *
 * 0 만 accent 를 아예 쓰지 않고 점선입니다. "안 적은 날" 과 "적고 하나도 못
 * 끝낸 날" 을 옅은 색 두 단계로 나누면 야외 화면이나 색각 이상에서 같은 칸이
 * 됩니다.
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
// 조각
// ---------------------------------------------------------------------------

/**
 * 조회 실패 화면.
 *
 * 다시 시도는 <Link> 가 아니라 평범한 <a> 입니다. 지금 있는 라우트로의
 * 클라이언트 내비게이션은 라우터 캐시에서 그대로 나올 수 있어서, 정작 필요한
 * 순간에 아무 일도 하지 않는 버튼이 됩니다. (app/history/page.tsx 와 같은 이유)
 */
function LoadFailure({ userId, message }: { userId: string; message: string }) {
  return (
    <Screen>
      <PageHeader title="그룹원" backHref="/status" backLabel="현황으로 돌아가기" />
      <Card>
        <ErrorText>{message}</ErrorText>
        <a
          href={`/members/${userId}`}
          className="border-line bg-surface text-fg inline-flex h-12 w-full shrink-0 items-center justify-center rounded-xl border px-4 text-base font-medium transition active:scale-[0.99]"
        >
          다시 불러오기
        </a>
      </Card>
    </Screen>
  )
}

/**
 * 이름표. 사진이 있으면 <img>, 없으면 이모지.
 *
 * next/image 가 아니라 평범한 <img> 입니다: next.config.ts 의
 * images.remotePatterns 에는 `*.supabase.co` 만 있어서 avatar_url 에 저장된
 * 구글 사진(lh3…)은 최적화 경로에서 400 이 납니다. onError 폴백은 없습니다 —
 * Server Component 이고, 사진이 깨지면 뒤의 둥근 자리가 그대로 남아 이모지
 * 경우와 같은 모양이 됩니다. (app/groups/page.tsx 와 같은 처방)
 */
function MemberHeading({ detail }: { detail: MemberDetail }) {
  const groupNames = detail.sharedGroups.map((group) => group.name).join(', ')

  return (
    <Card>
      <div className="flex items-center gap-3">
        <div className="bg-surface-2 grid size-14 shrink-0 place-items-center overflow-hidden rounded-full text-2xl">
          {detail.avatar.kind === 'image' && detail.avatar.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={detail.avatar.imageUrl}
              // 이름이 바로 옆에 글자로 있으므로 alt 는 일부러 빈 문자열입니다.
              alt={avatarAltText(detail.displayName)}
              className="size-14 object-cover"
              referrerPolicy="no-referrer"
              loading="lazy"
              decoding="async"
            />
          ) : (
            <span aria-hidden="true">{detail.avatar.emoji}</span>
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="text-fg truncate text-lg font-semibold">{detail.displayName}</h2>
          <p className="text-muted truncate text-xs">
            {groupNames ? `${groupNames} 에서 함께해요` : '함께하는 그룹'}
          </p>
        </div>
      </div>
    </Card>
  )
}

/**
 * 오늘의 할 일과 완료 여부. 읽기 전용입니다(머리말의 TaskCheckbox 주석 참고).
 */
function TodayCard({
  name,
  today,
  tasks,
  error,
}: {
  name: string
  today: string
  tasks: HistoryTask[]
  error: string | null
}) {
  const done = tasks.filter((task) => task.done).length

  return (
    <Card title={`오늘 (${formatKoreanDate(today)})`}>
      {error ? (
        // 오늘 목록만 실패한 경우입니다. 아래 달력과 요약은 그대로 살아 있습니다.
        <ErrorText>{error}</ErrorText>
      ) : tasks.length === 0 ? (
        <EmptyState
          title={`${name}님은 아직 오늘 할 일을 적지 않았어요`}
          description="현황 화면에서 콕 찔러 깨울 수 있어요."
          action={
            <LinkButton href="/status" variant="secondary">
              현황으로 가기
            </LinkButton>
          }
        />
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
    </Card>
  )
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
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

/**
 * 달력 한 칸. 링크가 아닙니다 — 머리말 "/history 와 무엇이 다른가" 참고.
 * 눌리지 않으므로 탭 영역을 만들지 않고, 대신 aria-label 로 사실을 그대로
 * 읽어 줍니다.
 */
function DayCell({ day }: { day: HistoryDay | null }) {
  if (day === null || day.outOfRange) {
    return <div aria-hidden="true" className="aspect-square rounded-md" />
  }

  const level = heatLevel(day)
  const month = Number(day.date.slice(5, 7))
  // 오늘은 색이 아니라 테두리 링으로 표시합니다. 농도 단계를 하나 더 쓰면
  // 히트맵이 읽히지 않습니다.
  const ring = day.isToday ? 'ring-1 ring-fg' : ''

  const label =
    day.total === 0
      ? `${month}월 ${day.dayOfMonth}일, 적은 할 일 없음`
      : `${month}월 ${day.dayOfMonth}일, ${day.total}개 중 ${day.done}개 완료`

  return (
    <div
      role="img"
      aria-label={label}
      className={`${CELL_BASE} ${LEVEL_CLASS[level]} ${ring}`}
    >
      {day.dayOfMonth}
    </div>
  )
}

function MonthGrid({ month }: { month: HistoryMonth }) {
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
            />
          )),
        )}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function MemberDetailPage({
  params,
}: {
  params: Promise<{ userId: string }>
}) {
  // Next 가 이미 디코딩해서 넘겨 줍니다. 여기서 다시 decodeURIComponent 를
  // 부르면 이름에 '%' 가 든 값에서 URIError 로 500 이 납니다.
  const { userId } = await params

  // uuid 검증도, 같은 그룹인지 판정도 전부 로더 안에 있습니다.
  const result = await getMemberDetail(userId)

  if (result.kind === 'unauthenticated') {
    redirect('/login')
  }
  if (result.kind === 'self') {
    // 내 기록의 정본은 /history 입니다. 근거는 lib/member-detail.ts 머리말.
    redirect('/history')
  }
  if (result.kind === 'not-found') {
    // ★ 이유를 말하지 않습니다 ★ 없는 사람과 남남인 사람이 같은 404 입니다.
    notFound()
  }
  if (result.kind === 'error') {
    return <LoadFailure userId={userId} message={result.message} />
  }

  const detail = result.detail
  const { summary } = detail

  // 창 상한에 걸린 스트릭은 "120일" 이 아니라 "120일+" 입니다. 홈 화면의 🔥
  // 배지, /history 와 같은 표기입니다.
  const currentStreakText =
    summary.currentStreak >= STREAK_WINDOW_DAYS
      ? `${summary.currentStreak}일+`
      : `${summary.currentStreak}일`

  return (
    <Screen>
      <PageHeader
        title={`${detail.displayName}님`}
        backHref="/status"
        backLabel="현황으로 돌아가기"
      />

      <MemberHeading detail={detail} />

      <TodayCard
        name={detail.displayName}
        today={detail.today}
        tasks={detail.todayTasks}
        error={detail.todayError}
      />

      {/* ---- 요약 -------------------------------------------------------- */}
      <Card title="기록 요약">
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
            note={`최근 ${detail.windowDays}일 안에서`}
          />
        </div>

        {summary.recordedDays === 0 && (
          <Hint>
            최근 {detail.windowDays}일 동안 이 그룹에 적어 둔 할 일이 아직 없어요.
          </Hint>
        )}
      </Card>

      {/* ---- 달력 -------------------------------------------------------- */}
      <Card title="달력">
        <div className="flex flex-col gap-5">
          {detail.months.map((month) => (
            <MonthGrid key={month.key} month={month} />
          ))}
        </div>

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
            칸이 오늘이고, 내 기록과 달리 여기서는 하루를 눌러 펼칠 수 없어요.
          </Hint>
        </div>
      </Card>

      {/* ---- 조회 범위 고지 ----------------------------------------------- */}
      <div className="flex flex-col gap-1">
        <p className="text-muted text-xs [word-break:keep-all]">
          최근 {detail.windowDays}일({formatKoreanDate(detail.from)}부터)까지, 그리고{' '}
          {detail.sharedGroups.length === 1
            ? `${detail.sharedGroups[0].name} 그룹에 적은 것만`
            : `함께 있는 그룹 ${detail.sharedGroups.length}곳에 적은 것만`}{' '}
          모아서 보여줘요.
        </p>
        <p className="text-muted text-xs [word-break:keep-all]">
          우리가 함께 있지 않은 그룹의 기록은 원래 보이지 않아요. 그래서 위 숫자는 이
          범위 안에서만 센 값이에요.
        </p>
        {detail.truncated && (
          <p className="text-muted text-xs [word-break:keep-all]">
            적어 둔 할 일이 아주 많아서 {formatKoreanDate(detail.from)} 이전은 이 화면에서
            생략했어요.
          </p>
        )}
      </div>

      <LinkButton href="/status" variant="secondary">
        현황으로 돌아가기
      </LinkButton>
    </Screen>
  )
}
