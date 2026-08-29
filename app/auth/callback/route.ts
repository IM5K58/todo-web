import { NextResponse, type NextRequest } from 'next/server'
import type { EmailOtpType } from '@supabase/supabase-js'

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

const OTP_TYPES: ReadonlySet<string> = new Set<EmailOtpType>([
  'magiclink',
  'signup',
  'invite',
  'recovery',
  'email_change',
  'email',
])

/** Never hand an unvalidated string to `verifyOtp`. */
function parseOtpType(raw: string | null): EmailOtpType | null {
  return raw && OTP_TYPES.has(raw) ? (raw as EmailOtpType) : null
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

  // Supabase reports link failures on the redirect itself (expired link,
  // already-used link, access_denied). Check before anything else, or the
  // real reason is thrown away and the user sees a blank form.
  const providerError =
    searchParams.get('error_code') ?? searchParams.get('error')
  if (providerError) {
    return failWith(providerError)
  }

  const code = searchParams.get('code')
  const tokenHash = searchParams.get('token_hash')
  const type = parseOtpType(searchParams.get('type'))

  // A route handler CAN write cookies, so the session lands in this response.
  const supabase = await createClient()

  if (code) {
    // PKCE flow: the magic link came back with ?code=...
    // Single-use, ~5 minute lifetime, and the code verifier lives in the
    // browser that requested it -- the link must be opened on the same device.
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (error) return failWith(error.code ?? 'exchange_failed')
  } else if (tokenHash && type) {
    // Token-hash flow, for the email template that sends
    //   {{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=magiclink
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash })
    if (error) return failWith(error.code ?? 'verify_failed')
  } else {
    return failWith('missing_code')
  }

  const response = NextResponse.redirect(new URL(next, baseUrl))
  response.headers.set('Cache-Control', 'private, no-store, max-age=0')
  return response
}
