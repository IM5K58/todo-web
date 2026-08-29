'use client'

import { useEffect, useState } from 'react'

import { createClient } from '@/lib/supabase/client'

type Status = 'idle' | 'redirecting' | 'error'

/**
 * Read `next` from `window.location` rather than `useSearchParams()`, so this
 * page does not have to be wrapped in <Suspense> and does not opt the whole
 * route into dynamic rendering.
 *
 * Same rules as `safeNext()` in app/auth/callback/route.ts: same-origin,
 * path-only. `//host` and `/\host` are protocol-relative URLs.
 */
function readNext(): string {
  if (typeof window === 'undefined') return '/'
  const raw = new URLSearchParams(window.location.search).get('next')
  if (!raw || !raw.startsWith('/')) return '/'
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/'
  return raw
}

/**
 * Maps the `?error=` reason the callback route forwards, plus the `error.code`
 * `signInWithOAuth` can return locally, into Korean copy.
 */
function messageForCallbackError(reason: string): string {
  switch (reason) {
    case 'access_denied':
      return '구글 로그인을 취소했어요. 다시 시도해 주세요.'
    case 'flow_state_expired':
    case 'flow_state_not_found':
      return '로그인 시간이 초과됐어요. 다시 시도해 주세요.'
    case 'bad_code_verifier':
    case 'bad_oauth_state':
    case 'bad_oauth_callback':
      // PKCE verifier lives in a cookie on the browser that STARTED the flow.
      // On iOS the installed app and Safari do not share cookies at all, so
      // "started in Safari, finished in the app" lands exactly here.
      return '로그인을 시작한 창과 끝낸 창이 달라요. 홈 화면 앱 안에서 다시 시도해 주세요.'
    case 'provider_disabled':
      return '구글 로그인이 아직 켜져 있지 않아요. 관리자에게 알려주세요.'
    case 'provider_email_needs_verification':
      return '구글 계정 이메일 인증이 필요해요. 메일함을 확인해 주세요.'
    case 'server_error':
    case 'temporarily_unavailable':
      return '구글 쪽에 문제가 생겼어요. 잠시 후 다시 시도해 주세요.'
    case 'missing_code':
      return '로그인 정보가 빠졌어요. 다시 시도해 주세요.'
    case 'validation_failed':
      return '로그인 주소 설정이 잘못됐어요. 관리자에게 알려주세요.'
    default:
      return '로그인에 실패했어요. 다시 시도해 주세요.'
  }
}

/** Google's own mark. Inline SVG on purpose: an external image would be a
 *  blank box offline and on the very first paint of the installed app. */
function GoogleMark() {
  return (
    <svg
      viewBox="0 0 48 48"
      width="20"
      height="20"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <path
        fill="#4285F4"
        d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"
      />
      <path
        fill="#34A853"
        d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"
      />
      <path
        fill="#FBBC05"
        d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"
      />
      <path
        fill="#EA4335"
        d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"
      />
    </svg>
  )
}

/**
 * True only for an iPhone/iPad that is browsing in Safari rather than running
 * the installed Home Screen app.
 *
 * Why this matters enough to branch the UI on it: on iOS, Web Push works ONLY
 * inside an installed PWA (16.4+), and Safari and the installed app share no
 * cookies or storage at all. Signing in here does NOT sign you in there -- the
 * user would have to do the whole Google flow twice and would still get no
 * notifications until they install. So we tell them to install first.
 */
function isIosBrowserTab(): boolean {
  if (typeof window === 'undefined') return false
  const ua = window.navigator.userAgent
  const isIos =
    /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13+ reports itself as a Mac; the touch points give it away.
    (ua.includes('Macintosh') && window.navigator.maxTouchPoints > 1)
  if (!isIos) return false

  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    // Non-standard, iOS-only, and still the only signal older iOS versions give.
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true

  return !standalone
}

export default function LoginPage() {
  const [status, setStatus] = useState<Status>('idle')
  const [errorText, setErrorText] = useState('')
  const [showIosInstallHint, setShowIosInstallHint] = useState(false)

  // Read `?error=` and sniff the platform after mount, not in a useState
  // initialiser: the server renders with no window, so initialising from the
  // URL or the user agent would produce a hydration mismatch on first paint.
  useEffect(() => {
    setShowIosInstallHint(isIosBrowserTab())

    const reason = new URLSearchParams(window.location.search).get('error')
    if (!reason) return
    setErrorText(messageForCallbackError(reason))
    setStatus('error')
  }, [])

  async function signIn() {
    setStatus('redirecting')
    setErrorText('')

    const supabase = createClient()

    // Build the return URL from `window.location.origin`, NEVER from
    // NEXT_PUBLIC_SITE_URL.
    //
    // On iOS, a Home Screen web app that navigates outside its manifest
    // `scope` ("/" -- see public/manifest.json, do not remove it) opens an
    // in-app browser sheet INSIDE the app rather than kicking out to
    // Safari.app. The sheet closes and hands control back to the standalone
    // window only when the final URL of the redirect chain lands back in
    // scope, i.e. on the exact origin the app was installed from. If we sent
    // Google to a different origin here (apex vs www, a preview deployment,
    // a custom domain vs *.vercel.app) the chain would end out of scope, the
    // sheet would never close, and the user would be stranded in a browser
    // sheet with a session the installed app cannot see -- which means no
    // push notifications, i.e. the whole product.
    const callback = new URL('/auth/callback', window.location.origin)

    // Only append `next` when it is not the default. GoTrue glob-matches
    // `redirect_to` against the Redirect URLs allowlist as a whole string, so
    // an always-present `?next=%2F` would need a wildcard entry to match. The
    // allowlist should contain both `/auth/callback` and `/auth/callback?**`.
    const next = readNext()
    if (next !== '/') callback.searchParams.set('next', next)

    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: callback.toString(),
        // Deliberately NOT set, both for the same iOS reason:
        //
        //  - `skipBrowserRedirect`: the default is a same-window `location`
        //    assignment, and that is the only thing that works in an iOS
        //    standalone PWA. Taking the URL and opening it ourselves via
        //    window.open() / target="_blank" is silently blocked there.
        //
        //  - `queryParams: { access_type: 'offline', prompt: 'consent' }`:
        //    those exist only to obtain a `provider_refresh_token` so you can
        //    keep calling Google APIs as the user. We call no Google APIs, and
        //    the Supabase session refreshes on its own token regardless.
        //    `prompt: 'consent'` would force the consent screen on every
        //    single sign-in for no benefit.
      },
    })

    if (error) {
      setStatus('error')
      setErrorText(messageForCallbackError(error.code ?? ''))
      return
    }
    // On success the browser is already navigating away; leave the button
    // in its disabled 'redirecting' state.
  }

  return (
    <main className="flex min-h-[100dvh] flex-col justify-center bg-bg px-5 py-10 px-safe">
      <div className="mx-auto w-full max-w-sm">
        <header className="mb-8">
          <p className="text-3xl" aria-hidden="true">
            📝
          </p>
          <h1 className="mt-3 text-2xl font-bold tracking-tight text-fg">
            매일 할거 적기
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            비밀번호는 없어요. 구글 계정으로 바로 시작할 수 있어요.
          </p>
        </header>

        {status === 'error' && (
          <p
            id="login-error"
            role="alert"
            className="mb-4 rounded-xl border border-danger/40 bg-surface p-3 text-sm leading-relaxed text-danger"
          >
            {errorText}
          </p>
        )}

        <button
          type="button"
          onClick={signIn}
          disabled={status === 'redirecting'}
          aria-describedby={status === 'error' ? 'login-error' : undefined}
          className="flex h-12 w-full items-center justify-center gap-3 rounded-xl border border-line bg-surface text-base font-semibold text-fg transition active:scale-[0.99] disabled:opacity-40"
        >
          <GoogleMark />
          <span>{status === 'redirecting' ? '구글로 이동 중…' : '구글로 로그인'}</span>
        </button>

        <p className="pt-4 text-center text-xs leading-relaxed text-muted">
          처음이라면 자동으로 가입돼요.
        </p>

        {showIosInstallHint && (
          <section className="mt-8 rounded-2xl border border-line bg-surface-2 p-5">
            <h2 className="text-sm font-semibold text-fg">
              아이폰이라면 먼저 홈 화면에 추가해 주세요
            </h2>
            <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-xs leading-relaxed text-muted">
              <li>
                아래 <span className="text-fg">공유 버튼</span>
                <span aria-hidden="true"> (□↑) </span>탭
              </li>
              <li>
                <span className="text-fg">홈 화면에 추가</span> 탭
              </li>
              <li>
                <span className="text-fg">홈 화면 아이콘</span>으로 앱을 연 다음, 그
                안에서 구글 로그인
              </li>
            </ol>
            <p className="mt-3 text-xs leading-relaxed text-muted">
              알림은 홈 화면에 추가한 앱에서만 와요. 여기 사파리에서 먼저 로그인해도
              앱 안에서는 로그아웃 상태예요 — 로그인 정보를 서로 공유하지 않거든요.
            </p>
          </section>
        )}
      </div>
    </main>
  )
}
