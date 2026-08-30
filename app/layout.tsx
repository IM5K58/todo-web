import type { Metadata, Viewport } from 'next'

import { SerwistProvider } from '@serwist/turbopack/react'

import BottomNav from '@/app/(nav)/BottomNav'

import './globals.css'

/**
 * Root layout. Next.js App Router requires this file, and under Next 16 +
 * Turbopack it is never generated for you -- the bundler only tells you it is
 * missing. It is also the single place that can:
 *   1. import ./globals.css (nothing else imports it, so without this file
 *      Tailwind never loads at all), and
 *   2. emit <link rel="manifest"> via the `manifest` metadata field, without
 *      which public/manifest.json is dead weight and the PWA is not
 *      installable.
 */

export const metadata: Metadata = {
  title: {
    default: '매일 할거 적기',
    template: '%s · 매일 할거 적기',
  },
  description: '오늘 할 일을 적고, 친구들끼리 서로 콕 찔러주는 작은 할 일 앱.',
  applicationName: '매일 할거 적기',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    // 'default' keeps the iOS status bar legible against both palettes in
    // app/globals.css. 'black-translucent' would draw the page under the
    // status bar, which the safe-area utilities are not laid out for.
    statusBarStyle: 'default',
    title: '할거적기',
  },
  // Korean date/time strings such as "2026. 8. 30." get auto-linked as phone
  // numbers by iOS Safari otherwise.
  formatDetection: {
    telephone: false,
    date: false,
    address: false,
    email: false,
  },
  // Not a public app -- one private friend group.
  robots: { index: false, follow: false },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Required for env(safe-area-inset-*) to report anything but 0, which the
  // pt-safe / pb-safe / px-safe / screen-safe utilities in app/globals.css
  // depend on.
  viewportFit: 'cover',
  // iOS input zoom is already prevented the correct way -- app/globals.css
  // forces `font-size: 16px` on input/select/textarea, which is the actual
  // trigger. So this cap stays well above 1: pinning maximumScale to 1 (or
  // userScalable: false) would buy nothing here and would take pinch-zoom
  // away from anyone who needs it.
  maximumScale: 5,
  userScalable: true,
  themeColor: [
    // Both values track --app-bg in app/globals.css.
    { media: '(prefers-color-scheme: light)', color: '#f9fafb' },
    { media: '(prefers-color-scheme: dark)', color: '#191b1f' },
  ],
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="ko">
      <body className="bg-bg text-fg min-h-dvh">
        {/*
         * 서비스워커 등록. 이게 없으면 워커가 영영 등록되지 않고,
         * 그 결과 (a) 크롬/안드로이드 설치 배너가 뜨지 않으며
         * (b) lib/push/subscribe.ts 의 navigator.serviceWorker.ready 가
         * 영원히 대기해서 푸시 알림이 통째로 죽는다.
         *
         * @serwist/next(webpack) 는 등록 스크립트를 자동 주입해주지만
         * 우리가 쓰는 @serwist/turbopack 은 하지 않는다. 대신 이 프로바이더를
         * 제공한다. 내부에서 window.serwist.register() 를 호출한다.
         *
         * swUrl 이 루트가 아니라 /serwist/ 아래인 이유는 Turbopack 에
         * 플러그인 API 가 없어 워커를 Route Handler 로 서빙하기 때문이다.
         * 그 핸들러가 Service-Worker-Allowed: / 를 붙여주므로 scope 를
         * '/' 로 명시해야 워커가 사이트 전체를 제어한다. 생략하면 스코프가
         * /serwist/ 로 좁아져 아무 페이지도 제어하지 못한다.
         */}
        <SerwistProvider swUrl="/serwist/sw.js" options={{ scope: '/' }}>
        {children}
        {/*
         * Fixed bottom tab bar (홈 / 그룹 / 설정), mounted here because the root
         * layout is the only node that survives every navigation -- putting it
         * inside a page would remount and re-animate it on each route change.
         *
         * It renders AFTER {children} so the DOM order matches the reading
         * order: page content first, then the navigation landmark.
         *
         * BottomNav returns null on /login, /install, /onboarding and /auth --
         * pre-membership screens where two of its three tabs would dead-end --
         * so it is safe to mount unconditionally from here.
         *
         * The bar is `fixed`, so it does not reserve space. Each page has to
         * clear it itself; app/page.tsx does that with a spacer at the end of
         * its <main>. No padding is added to <body> on purpose: it would also
         * apply on the screens where the bar is hidden, and combined with the
         * `screen-safe` (min-height:100dvh) wrapper those pages use it would
         * push every one of them into a pointless 7rem scroll.
         */}
          <BottomNav />
        </SerwistProvider>
      </body>
    </html>
  )
}
