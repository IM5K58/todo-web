'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

/**
 * Fixed bottom navigation: 홈 / 현황 / 그룹 / 설정.
 *
 * NOT wired into app/layout.tsx from here — the "home" agent owns that file.
 * To mount it, render <BottomNav /> after {children} inside <body>, and give
 * every page enough bottom padding to clear it (the bar is 56px tall plus the
 * iOS home-indicator inset, so `pb-28` on the page <main> is the safe amount).
 *
 * Deliberately hidden on /login, /install, and /onboarding: those are all
 * pre-membership screens where the tabs would either bounce the user to a
 * redirect or dead-end on an empty group list.
 *
 * Four tabs at max-w-md is 96px each — still well over the 44px touch minimum,
 * so the labels stay rather than being traded for icon-only tabs.
 */

const TABS = [
  { href: '/', label: '홈', icon: HomeIcon },
  { href: '/status', label: '현황', icon: ChartIcon },
  { href: '/groups', label: '그룹', icon: GroupIcon },
  { href: '/settings', label: '설정', icon: BellIcon },
] as const

/** Screens where a nav bar would offer routes the user cannot use yet. */
const HIDDEN_PREFIXES = ['/login', '/install', '/onboarding', '/auth']

export default function BottomNav() {
  const pathname = usePathname()

  if (HIDDEN_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return null
  }

  return (
    <nav
      aria-label="주요 메뉴"
      className="border-line bg-surface px-safe pb-safe fixed inset-x-0 bottom-0 z-40 border-t"
    >
      <ul className="mx-auto flex w-full max-w-md items-stretch">
        {TABS.map(({ href, label, icon: Icon }) => {
          // '/' would prefix-match everything, so it only matches exactly.
          const active =
            href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`)

          return (
            <li key={href} className="flex-1">
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className={`flex h-14 flex-col items-center justify-center gap-0.5 text-xs font-medium transition ${
                  active ? 'text-accent' : 'text-muted'
                }`}
              >
                <Icon />
                {label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

// ---------------------------------------------------------------------------
// Icons — inline so nothing has to be installed, and so they inherit
// currentColor from the active/inactive tab classes above.
// ---------------------------------------------------------------------------

const ICON_PROPS = {
  width: 22,
  height: 22,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const

function HomeIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5.5 9.5V20h13V9.5" />
    </svg>
  )
}

/** 현황 — three bars of different heights, i.e. everyone's progress. */
function ChartIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M6 20v-6.5" />
      <path d="M12 20V7" />
      <path d="M18 20v-9.5" />
      <path d="M3.5 20h17" />
    </svg>
  )
}

function GroupIcon() {
  return (
    <svg {...ICON_PROPS}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 19.5c0-3.1 2.7-5 6-5s6 1.9 6 5" />
      <path d="M16 5.5a3 3 0 0 1 0 5.6" />
      <path d="M17.5 14.8c2.1.5 3.5 1.9 3.5 4.2" />
    </svg>
  )
}

function BellIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M6.5 9.5a5.5 5.5 0 0 1 11 0c0 4 1.5 5.5 1.5 5.5H5s1.5-1.5 1.5-5.5Z" />
      <path d="M10 18.5a2 2 0 0 0 4 0" />
    </svg>
  )
}
