import { NextResponse, type NextRequest } from 'next/server'

import { createClient } from '@/lib/supabase/server'

/** This route sets a session cookie. It must never be cached or prerendered. */
export const dynamic = 'force-dynamic'

/**
 * Only same-origin, path-only redirect targets.
 *
 * Without this, `/auth/callback?next=https://evil.example` turns our own
 * login flow into an open redirect that phishes from our own trusted domain.
 * `//host` and `/\host` are protocol-relative URLs the browser resolves to a
 * remote origin, so a bare `startsWith('/')` check is not enough.
 */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/')) return '/'
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/'
  return raw
}

/**
 * The origin every redirect out of this handler is built against.
 *
 * `x-forwarded-host` is fully attacker-controlled on any deployment where a
 * proxy does not overwrite it (plain nginx without `proxy_set_header`, a
 * container behind a dumb LB, `next start` fronted by anything). Honour it
 * only when it matches a host we configured ourselves; otherwise fall back to
 * NEXT_PUBLIC_SITE_URL, and only then to the request's own origin.
 */
function resolveBaseUrl(request: NextRequest, origin: string): string {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL
  const isLocalEnv = process.env.NODE_ENV === 'development'

  if (isLocalEnv) return origin

  const allowedHosts = new Set(
    [siteUrl, process.env.VERCEL_PROJECT_PRODUCTION_URL]
      .filter((value): value is string => Boolean(value))
      .map((value) => new URL(value.startsWith('http') ? value : `https://${value}`).host)
  )

  const forwardedHost = request.headers.get('x-forwarded-host')
  if (forwardedHost && allowedHosts.has(forwardedHost)) {
    return `https://${forwardedHost}`
  }

  return siteUrl ?? origin
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const baseUrl = resolveBaseUrl(request, origin)
  const next = safeNext(searchParams.get('next'))

  /** Bounce back to /login with a machine-readable reason the page can localise. */
  function failWith(reason: string): NextResponse {
    const failure = new URL('/login', baseUrl)
    failure.searchParams.set('error', reason)
    if (next !== '/') failure.searchParams.set('next', next)
    const response = NextResponse.redirect(failure)
    response.headers.set('Cache-Control', 'private, no-store, max-age=0')
    return response
  }

  // Google/GoTrue report failures on the redirect itself (user pressed 취소,
  // provider disabled, temporary Google outage). Check before anything else,
  // or the real reason is thrown away and the user sees a blank form.
  const providerError =
    searchParams.get('error_code') ?? searchParams.get('error')
  if (providerError) {
    return failWith(providerError)
  }

  // Google OAuth is PKCE, exactly like the magic link used to be: the flow
  // always comes back as ?code=... There is no token_hash branch any more.
  const code = searchParams.get('code')
  if (!code) return failWith('missing_code')

  // A route handler CAN write cookies, so the session lands in this response.
  const supabase = await createClient()

  // Single-use, ~5 minute lifetime. The PKCE verifier lives in a cookie on the
  // browser that STARTED the flow, so the round trip must finish in the same
  // browser instance -- on iOS the installed app and Safari are two different
  // cookie jars, which is why /login pushes people to install first.
  const { error } = await supabase.auth.exchangeCodeForSession(code)
  if (error) return failWith(error.code ?? 'exchange_failed')

  const response = NextResponse.redirect(new URL(next, baseUrl))
  response.headers.set('Cache-Control', 'private, no-store, max-age=0')
  return response
}
