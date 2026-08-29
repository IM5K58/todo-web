import Link from 'next/link'

export default function NotFound() {
  return (
    <main className="screen-safe px-safe flex flex-col items-center justify-center gap-4 text-center">
      <p className="text-muted text-5xl font-semibold tabular-nums">404</p>
      <h1 className="text-fg text-lg font-semibold">페이지를 찾을 수 없어요</h1>
      <p className="text-muted max-w-xs text-sm leading-relaxed">
        주소가 바뀌었거나 사라진 페이지예요.
      </p>
      <Link
        href="/"
        className="bg-accent text-accent-fg mt-2 rounded-xl px-5 py-3 text-sm font-medium"
      >
        오늘 화면으로 가기
      </Link>
    </main>
  )
}
