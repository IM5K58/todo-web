'use client'

import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'

import { Button, LinkButton } from '@/components/ui'
import { isIos, isStandalone } from '@/lib/push/subscribe'

/**
 * 화면 맨 위에 뜨는 PWA 설치 안내 배너.
 *
 * 두 가지 얼굴이 있습니다. 같은 문구를 두 곳에 쓰면 한쪽은 반드시 거짓말이
 * 되기 때문입니다.
 *
 *   prompt : 안드로이드/데스크톱 크롬 계열. beforeinstallprompt 를 잡아두었다가
 *            버튼 탭에 prompt() 를 부릅니다. 진짜 설치 버튼입니다.
 *   guide  : 아이폰. 사파리에는 beforeinstallprompt 자체가 없어서 우리가
 *            설치를 시작할 방법이 없습니다. 공유 → 홈 화면에 추가 절차를 적어
 *            둔 /install 로 보냅니다.
 *
 * 그 밖(이벤트도 없고 iOS 도 아닌 경우)에는 아무것도 그리지 않습니다. 이벤트가
 * 없다는 것은 이미 설치했거나 브라우저가 설치를 지원하지 않는다는 뜻이고,
 * 그런 사람에게 띄우는 "설치하세요"는 누를 데가 없는 소음입니다.
 */

// ---------------------------------------------------------------------------
// beforeinstallprompt 붙잡아 두기
// ---------------------------------------------------------------------------

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

/**
 * 리스너를 useEffect 가 아니라 모듈 최상위에 답니다.
 *
 * 크롬은 이 이벤트를 페이지 로드 직후 한 번만 쏘고, 놓치면 다시 주지 않습니다.
 * 컴포넌트가 하이드레이션되어 이펙트가 도는 시점보다 이 모듈이 평가되는 시점이
 * 언제나 빠르므로, 여기가 우리가 닿을 수 있는 가장 이른 지점입니다.
 *
 * 'use client' 모듈은 서버 렌더 때도 평가되므로 window 가드가 필요합니다.
 */
let deferredPrompt: BeforeInstallPromptEvent | null = null
const subscribers = new Set<() => void>()

function emit(): void {
  for (const notify of subscribers) notify()
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    // preventDefault 를 해야 크롬이 자기 미니 인포바를 띄우지 않고, 이벤트를
    // 나중에 쓸 수 있게 살려 둡니다.
    event.preventDefault()
    deferredPrompt = event as BeforeInstallPromptEvent
    emit()
  })

  // 설치가 끝나면(배너 밖의 주소창 설치 버튼으로 했더라도) 즉시 접습니다.
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null
    emit()
  })
}

function subscribe(listener: () => void): () => void {
  subscribers.add(listener)
  return () => {
    subscribers.delete(listener)
  }
}

/** 이벤트는 일회용입니다. 꺼내는 순간 저장소에서 비웁니다. */
function takeDeferredPrompt(): BeforeInstallPromptEvent | null {
  const event = deferredPrompt
  deferredPrompt = null
  if (event) emit()
  return event
}

// ---------------------------------------------------------------------------
// "닫음" 기억하기
// ---------------------------------------------------------------------------

const DISMISS_KEY = 'install-banner-dismissed-at'

/**
 * 2주.
 *
 * 영원히 숨기면 "나중에"를 누른 사람은 설치 경로를 영영 잃습니다. 반대로 매번
 * 띄우면 배너가 아니라 방해물입니다. 이 앱은 하루 한 번 여는 습관 앱이라
 * 2주면 14번쯤 쓴 뒤 다시 묻는 셈이고, 그 정도면 "이제 설치할 만한가?"를
 * 되묻기에 충분히 뜸합니다. 진짜로 설치한 사람은 애초에 standalone 검사에서
 * 걸러지므로 이 주기와 무관합니다.
 */
const DISMISS_MS = 14 * 24 * 60 * 60 * 1000

/**
 * 저장소 핸들. 없거나 접근 자체가 던지면 null.
 *
 * getter 접근이 던지는 환경이 실재합니다 — 쿠키/사이트 데이터를 막은 브라우저,
 * 일부 인앱 웹뷰, iOS 의 옛 프라이빗 모드가 SecurityError 를 냅니다. 그래서
 * `'localStorage' in window` 로는 부족하고 try/catch 여야 합니다. 저장소가
 * 아예 없어도 앱은 평소대로 돌아야 하고, 잃는 것은 "닫음"의 기억뿐입니다.
 */
function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function isDismissedRecently(now = Date.now()): boolean {
  const store = storage()
  if (!store) return false

  let raw: string | null
  try {
    raw = store.getItem(DISMISS_KEY)
  } catch {
    return false
  }
  if (!raw) return false

  const savedAt = Number(raw)
  // 값은 사용자도 옛 버전의 우리도 고칠 수 있습니다. 숫자가 아니면 버립니다.
  if (!Number.isFinite(savedAt)) {
    forget()
    return false
  }
  // 기기 시계가 미래로 갔다 돌아온 경우. 그대로 두면 now - savedAt 이 음수라
  // 영원히 "방금 닫음"이 됩니다.
  if (savedAt > now) {
    forget()
    return false
  }
  return now - savedAt < DISMISS_MS
}

function remember(now = Date.now()): void {
  const store = storage()
  if (!store) return
  try {
    store.setItem(DISMISS_KEY, String(now))
  } catch {
    /* 용량 초과/쓰기 금지. 다음 방문에 한 번 더 뜨는 것이 전부입니다. */
  }
}

function forget(): void {
  const store = storage()
  if (!store) return
  try {
    store.removeItem(DISMISS_KEY)
  } catch {
    /* 지우는 것마저 안 되면 할 수 있는 게 없습니다 */
  }
}

// ---------------------------------------------------------------------------
// 배너
// ---------------------------------------------------------------------------

/**
 * 배너를 띄우지 않을 화면. app/(nav)/BottomNav.tsx 의 HIDDEN_PREFIXES 와 같은
 * 목록이지만 일부러 복사해 왔습니다 — 저 파일은 탭 이야기를 하고 여기는 설치
 * 이야기를 합니다. 이유가 겹칠 뿐 규칙이 하나인 것은 아닙니다.
 *
 *   /install  : 설치 안내 페이지 위에 설치 안내 배너는 그냥 소음입니다.
 *   /login,
 *   /auth,
 *   /onboarding : 로그인·가입 도중에 끼어들면 정작 할 일을 가립니다.
 */
const HIDDEN_PREFIXES = ['/login', '/install', '/onboarding', '/auth']

/** `/x` 와 `/x/...` 는 맞고 `/xyz` 는 아닙니다. */
function underPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

type Mode = 'hidden' | 'prompt' | 'guide'

export default function InstallBanner() {
  const pathname = usePathname()

  // 서버에서는 언제나 'hidden'. matchMedia 도 navigator.standalone 도 서버에는
  // 없고, 어느 쪽으로든 찍으면 하이드레이션 불일치가 납니다.
  const [mode, setMode] = useState<Mode>('hidden')
  const [dismissed, setDismissed] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    // 이미 앱으로 열었으면 여기서 끝. 아래 구독조차 걸지 않습니다.
    if (isStandalone()) return
    if (isDismissedRecently()) {
      setDismissed(true)
      return
    }

    const resolve = () => {
      if (isStandalone()) return setMode('hidden')
      if (deferredPrompt) return setMode('prompt')
      if (isIos()) return setMode('guide')
      // 아직 이벤트가 오지 않았을 수도 있습니다. 오면 구독이 깨웁니다.
      return setMode('hidden')
    }
    resolve()

    const unsubscribe = subscribe(resolve)
    // iOS 는 홈 화면 아이콘으로 다시 열릴 때 새로고침 없이 standalone 으로
    // 넘어갑니다. 그 순간 배너가 남아 있으면 안 됩니다.
    const mql = window.matchMedia('(display-mode: standalone)')
    mql.addEventListener('change', resolve)

    return () => {
      unsubscribe()
      mql.removeEventListener('change', resolve)
    }
  }, [])

  const onHiddenRoute = HIDDEN_PREFIXES.some((prefix) => underPrefix(pathname, prefix))
  if (dismissed || onHiddenRoute || mode === 'hidden') return null

  function close() {
    remember()
    setDismissed(true)
  }

  async function install() {
    const event = takeDeferredPrompt()
    if (!event) {
      setDismissed(true)
      return
    }

    setBusy(true)
    try {
      await event.prompt()
      await event.userChoice
    } catch {
      /* 이미 소비된 이벤트 등. 배너를 접는 것 말고 할 일이 없습니다. */
    } finally {
      // 수락했든 네이티브 창을 닫았든 이 이벤트는 재사용할 수 없습니다.
      // 수락했다면 다음 실행은 standalone 이라 어차피 안 뜨고, 닫았다면
      // 방금 "지금은 아니오"라고 답한 셈이니 2주는 조용히 있습니다.
      remember()
      setBusy(false)
      setDismissed(true)
    }
  }

  return (
    <aside
      aria-label="앱 설치 안내"
      className="border-line bg-surface px-safe pt-safe fixed inset-x-0 top-0 z-50 border-b pb-3 shadow-sm"
    >
      <div className="mx-auto flex w-full max-w-md items-start gap-3">
        <span
          aria-hidden="true"
          className="bg-surface-2 mt-0.5 grid size-10 shrink-0 place-items-center rounded-full text-lg"
        >
          📲
        </span>

        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div>
            <p className="text-fg text-sm font-semibold">앱으로 설치하기</p>
            <p className="text-muted mt-0.5 text-xs leading-relaxed [word-break:keep-all]">
              {mode === 'prompt'
                ? '홈 화면에 추가하면 아이콘으로 바로 열리고, 주소창 없이 전체 화면으로 쓸 수 있어요.'
                : '아이폰은 홈 화면에 추가한 뒤 그 아이콘으로 열어야 알림을 받을 수 있어요.'}
            </p>
          </div>

          <div className="flex">
            {mode === 'prompt' ? (
              <Button
                type="button"
                size="sm"
                onClick={install}
                pending={busy}
                pendingLabel="설치 중…"
              >
                설치하기
              </Button>
            ) : (
              <LinkButton href="/install" size="sm">
                추가 방법 보기
              </LinkButton>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={close}
          aria-label="설치 안내 닫기"
          className="text-muted -mr-2 -mt-2 grid size-11 shrink-0 place-items-center rounded-xl transition active:scale-[0.99]"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
    </aside>
  )
}
