'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

/**
 * Fixed bottom navigation: 홈 / 현황 / 내기록 / 마이페이지.
 *
 * Mounted from app/layout.tsx after {children}, so the DOM order matches the
 * reading order. The bar is 56px tall plus the iOS home-indicator inset; every
 * page clears it with a spacer element at the end of its <main> (NOT `pb-28` —
 * `screen-safe` sets min-height:100dvh and its own padding-bottom, and which of
 * the two wins the cascade is not something to leave to chance).
 *
 * Deliberately hidden on /login, /install, /onboarding and /auth: pre-membership
 * screens where the tabs would either bounce the user to a redirect or dead-end
 * on an empty group list.
 *
 * Four tabs at max-w-md is 96px each — still well over the 44px touch minimum,
 * so the labels stay rather than being traded for icon-only tabs. That ceiling
 * is also why there is no fifth tab: at 375px five tabs would be 75px each and
 * '마이페이지' would not fit on one line.
 *
 * ---------------------------------------------------------------------------
 * ROUTES THAT ARE NOT TABS  (개편 후)
 * ---------------------------------------------------------------------------
 * 그룹 관리(/groups)와 알림 설정(/settings)은 탭에서 빠졌지만 라우트는 그대로
 * 살아 있습니다. 진입 경로만 바뀌었습니다:
 *   /groups   ← 현황 화면의 "내 그룹 상세 보기"
 *   /settings ← 마이페이지의 "알림 설정"
 *
 * 그래서 그 경로에 서 있을 때 아무 탭도 활성이 아니면 "내가 어디서 왔는지"가
 * 화면에서 사라집니다. TAB_ALIASES 가 그 경로들을 자기를 부른 탭에 되돌려
 * 붙입니다 — 활성 탭은 "지금 이 URL"이 아니라 "지금 이 화면이 속한 구역"을
 * 가리켜야 하기 때문입니다.
 *
 *   /groups   → 현황     : 그룹 관리로 들어가는 유일한 입구가 현황 화면입니다.
 *                          (그룹을 고르는 일 자체가 현황의 관심사입니다.)
 *   /settings → 마이페이지 : 알림 설정은 마이페이지에서만 들어갑니다.
 *   /templates → 홈       : 반복 할 일은 "오늘을 채우는" 도구이고, 그 입구가
 *                          홈의 빠르게 채우기 카드와 이동 블록입니다.
 */

const TABS = [
  { href: '/', label: '홈', icon: HomeIcon },
  { href: '/status', label: '현황', icon: ChartIcon },
  { href: '/history', label: '내기록', icon: HistoryIcon },
  { href: '/me', label: '마이페이지', icon: PersonIcon },
] as const

/**
 * 탭이 아닌 경로 → 그 경로가 속한 탭. 접두사로 비교하므로 하위 경로
 * (/groups/new, /groups/join, /groups/<id>)까지 함께 잡힙니다.
 */
const TAB_ALIASES: ReadonlyArray<readonly [prefix: string, tabHref: string]> = [
  ['/groups', '/status'],
  // /members/[userId] 는 현황의 멤버 행에서만 들어갑니다.
  ['/members', '/status'],
  ['/settings', '/me'],
  ['/templates', '/'],
]

/** Screens where a nav bar would offer routes the user cannot use yet. */
const HIDDEN_PREFIXES = ['/login', '/install', '/onboarding', '/auth']

/** `/x` 와 `/x/...` 는 맞고 `/xyz` 는 아닙니다. */
function underPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

export default function BottomNav() {
  const pathname = usePathname()

  if (HIDDEN_PREFIXES.some((prefix) => underPrefix(pathname, prefix))) {
    return null
  }

  // 별칭이 먼저입니다. /templates 는 '/' 로 접두사 비교하면 모든 경로를
  // 삼키는 문제와 무관하게, 아래 규칙만으로는 어떤 탭에도 걸리지 않습니다.
  const aliasTab = TAB_ALIASES.find(([prefix]) => underPrefix(pathname, prefix))?.[1] ?? null

  return (
    <nav
      aria-label="주요 메뉴"
      className="border-line bg-surface px-safe pb-safe fixed inset-x-0 bottom-0 z-40 border-t"
    >
      <ul className="mx-auto flex w-full max-w-md items-stretch">
        {TABS.map(({ href, label, icon: Icon }) => {
          // '/' would prefix-match everything, so it only matches exactly.
          const active = aliasTab
            ? aliasTab === href
            : href === '/'
              ? pathname === '/'
              : underPrefix(pathname, href)

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

/**
 * 내기록 — a clock with a counter-clockwise arrow: "지난 날들".
 *
 * 달력이 아니라 시계인 이유: /status 의 막대그래프와 실루엣이 겹치지 않고,
 * 격자 무늬는 22px 에서 뭉개집니다.
 */
function HistoryIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
      <path d="M3.2 4.6v3.9h3.9" />
      <path d="M12 7.5V12l3 1.8" />
    </svg>
  )
}

/** 마이페이지 — head and shoulders. GroupIcon 과 달리 사람이 하나입니다. */
function PersonIcon() {
  return (
    <svg {...ICON_PROPS}>
      <circle cx="12" cy="8" r="3.4" />
      <path d="M4.8 20c0-3.4 3.2-5.4 7.2-5.4s7.2 2 7.2 5.4" />
    </svg>
  )
}
