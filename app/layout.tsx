import type { Metadata, Viewport } from 'next'

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
      <body className="bg-bg text-fg min-h-dvh">{children}</body>
    </html>
  )
}
