'use client'

import { useEffect, useState, type FormEvent } from 'react'

import { createClient } from '@/lib/supabase/client'

type Status = 'idle' | 'sending' | 'sent' | 'error'

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

/** Maps the `?error=` reason the callback route forwards into Korean copy. */
function messageForCallbackError(reason: string): string {
  switch (reason) {
    case 'otp_expired':
      return '로그인 링크가 만료됐어요. 아래에서 새 링크를 받아주세요.'
    case 'access_denied':
      return '이미 사용한 링크예요. 새 링크를 받아주세요.'
    case 'missing_code':
      return '링크 정보가 빠져 있어요. 메일 속 링크를 그대로 눌러주세요.'
    case 'flow_state_not_found':
    case 'flow_state_expired':
      return '링크를 요청한 기기와 다른 기기에서 열었어요. 같은 브라우저에서 열어주세요.'
    default:
      return '로그인에 실패했어요. 다시 시도해 주세요.'
  }
}

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [errorText, setErrorText] = useState('')
  const [sentTo, setSentTo] = useState('')

  // Read `?error=` after mount, not in a useState initialiser: the server
  // renders with no window, so initialising from the URL would produce a
  // hydration mismatch on the very first paint.
  useEffect(() => {
    const reason = new URLSearchParams(window.location.search).get('error')
    if (!reason) return
    setErrorText(messageForCallbackError(reason))
    setStatus('error')
  }, [])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const address = email.trim()
    if (!address) return

    setStatus('sending')
    setErrorText('')

    const supabase = createClient()

    // Only append `next` when it is not the default. GoTrue glob-matches
    // `redirect_to` against the Redirect URLs allowlist as a whole string, so
    // an always-present `?next=%2F` would need a wildcard entry to match. The
    // allowlist should contain both `/auth/callback` and `/auth/callback?**`.
    const callback = new URL('/auth/callback', window.location.origin)
    const next = readNext()
    if (next !== '/') callback.searchParams.set('next', next)

    const { error } = await supabase.auth.signInWithOtp({
      email: address,
      options: { emailRedirectTo: callback.toString() },
    })

    if (error) {
      setStatus('error')
      if (error.status === 429) {
        setErrorText('메일을 너무 자주 요청했어요. 60초 뒤에 다시 시도해 주세요.')
      } else if (error.code === 'validation_failed') {
        setErrorText('이메일 주소 형식을 다시 확인해 주세요.')
      } else {
        setErrorText('메일을 보내지 못했어요. 잠시 후 다시 시도해 주세요.')
      }
      return
    }

    setSentTo(address)
    setStatus('sent')
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
            비밀번호는 없어요. 이메일로 받은 링크만 누르면 바로 시작할 수 있어요.
          </p>
        </header>

        {status === 'sent' ? (
          <section
            aria-live="polite"
            className="rounded-2xl border border-line bg-surface p-5"
          >
            <h2 className="text-base font-semibold text-fg">메일함을 확인해 주세요</h2>
            <p className="mt-2 break-all text-sm leading-relaxed text-fg">
              <span className="font-medium">{sentTo}</span> 주소로 로그인 링크를 보냈어요.
            </p>
            <p className="mt-3 text-xs leading-relaxed text-muted">
              링크는 1시간 동안만 쓸 수 있고, 한 번만 열 수 있어요. 링크를 요청한 것과
              같은 기기·브라우저에서 열어야 해요. 메일이 안 보이면 스팸함도 확인해 주세요.
            </p>
            <button
              type="button"
              onClick={() => {
                setStatus('idle')
                setErrorText('')
              }}
              className="mt-5 h-12 w-full rounded-xl border border-line bg-surface-2 text-base font-medium text-fg transition active:scale-[0.99]"
            >
              다른 이메일로 다시 보내기
            </button>
          </section>
        ) : (
          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            <div>
              <label htmlFor="email" className="mb-2 block text-sm font-medium text-fg">
                이메일 주소
              </label>
              <input
                id="email"
                name="email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                autoComplete="email"
                inputMode="email"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="send"
                placeholder="you@example.com"
                aria-invalid={status === 'error'}
                aria-describedby={status === 'error' ? 'login-error' : undefined}
                disabled={status === 'sending'}
                /* globals.css already pins inputs to 16px so iOS Safari does
                   not zoom the viewport on focus -- do not shrink this. */
                className="h-12 w-full rounded-xl border border-line bg-surface px-4 text-base text-fg outline-none transition placeholder:text-muted focus:border-accent disabled:opacity-60"
              />
            </div>

            {status === 'error' && (
              <p
                id="login-error"
                role="alert"
                className="text-sm leading-relaxed text-danger"
              >
                {errorText}
              </p>
            )}

            <button
              type="submit"
              disabled={status === 'sending' || email.trim().length === 0}
              className="h-12 w-full rounded-xl bg-accent text-base font-semibold text-accent-fg transition active:scale-[0.99] disabled:opacity-40"
            >
              {status === 'sending' ? '보내는 중…' : '로그인 링크 받기'}
            </button>

            <p className="pt-1 text-center text-xs leading-relaxed text-muted">
              처음이라면 자동으로 가입돼요. 메일은 60초에 한 번만 보낼 수 있어요.
            </p>
          </form>
        )}
      </div>
    </main>
  )
}
