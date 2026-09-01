/**
 * '2026-08-30' -> '8월 30일 토요일'.
 *
 * Formats the DATE STRING the query actually used, never `new Date()`, so the
 * header cannot disagree with the rows under it. Rendered as a UTC instant on
 * purpose: the string is already a calendar date in the user's own timezone, so
 * re-projecting it through any zone would shift it by a day.
 */
function formatBoardDate(isoDate: string): string {
  const [rawYear, rawMonth, rawDay] = isoDate.split('-')
  const year = Number(rawYear)
  const month = Number(rawMonth)
  const day = Number(rawDay)

  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return isoDate
  }

  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(new Date(Date.UTC(year, month - 1, day)))
}

/**
 * 지금 보고 있는 그룹 이름과, 그 보드가 실제로 조회한 날짜.
 *
 * `today` 는 반드시 board.today — 즉 `rpc('current_user_local_date')` 가 준
 * 값 — 이어야 합니다. 화면에서 날짜를 새로 만들면 새벽 1시 30분에 헤더와 그
 * 아래 줄이 서로 다른 날을 말하게 됩니다.
 */
export function BoardHeader({ groupName, today }: { groupName: string; today: string }) {
  return (
    <header className="flex flex-col gap-1">
      <p className="text-fg truncate text-base font-semibold">{groupName}</p>
      <p className="text-muted text-sm tabular-nums">{formatBoardDate(today)}</p>
    </header>
  )
}
