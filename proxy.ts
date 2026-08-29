import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

import type { Database } from '@/lib/supabase/types'

/**
 * Next 16 renamed the root middleware convention to `proxy.ts`. `middleware.ts`
 * is deprecated and having BOTH files in the repo is a hard build error, so
 * this is the only root request hook -- and the session-refresh helper is
 * folded in here rather than living in `lib/supabase/middleware.ts`.
 *
 * Next accepts either a default export or a named `proxy` export. The default
 * export below satisfies both. Note that route segment config (`export const
 * runtime = ...`) is rejected in this file: proxy always runs on Node.js.
 *
 * SCOPE: this layer is for session refresh and UX redirects. It is NOT the
 * authorization boundary. Next middleware has a documented bypass class
 * (CVE-2025-29927), so every protected layout and every /api route handler
 * must independently call `supabase.auth.getUser()` and reject on failure.
 * RLS is the real backstop.
 */

/** Path prefixes reachable without a session. */
const PUBLIC_PREFIXES = ['/login', '/auth'] as const

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  )
}

/** See lib/supabase/client.ts for why this is `||` and why the reads are literal. */
function publicEnv(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!url) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set.')
  }
  if (!key) {
    throw new Error(
      'Set NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (or NEXT_PUBLIC_SUPABASE_ANON_KEY).'
    )
  }

  return { url, key }
}

export default async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  /**
   * The no-store headers @supabase/ssr hands us when it writes auth cookies.
   * Kept outside `setAll` so the early-return responses below can carry them
   * too -- a 302 or a 401 that also sets a refreshed session cookie must be
   * just as uncacheable as the 200 would have been.
   */
  let cacheHeaders: Record<string, string> = {}

  const { url, key } = publicEnv()

  // Never hoist this client to module scope: it closes over one request.
  const supabase = createServerClient<Database>(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      /**
       * TWO arguments. `SetAllCookies` in @supabase/ssr 0.12.5 is
       *   (cookies: {name,value,options}[], headers: Record<string,string>)
       * and the `headers` argument is real -- it carries
       *   Cache-Control: private, no-cache, no-store, must-revalidate, max-age=0
       *   Expires: 0
       *   Pragma: no-cache
       * Applying it is what stops a CDN or reverse proxy from caching a
       * response that carries a refreshed session cookie and replaying it to a
       * different user.
       */
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
        // Rebuilding the response resets its headers, so this must come first
        // and the header writes must come after.
        supabaseResponse = NextResponse.next({ request })
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options)
        )
        cacheHeaders = headers ?? {}
        Object.entries(cacheHeaders).forEach(([headerName, headerValue]) =>
          supabaseResponse.headers.set(headerName, headerValue)
        )
      },
    },
  })

  // Do NOT put code between createServerClient and getClaims(). Anything that
  // awaits in between can let the response commit before a refresh lands,
  // which is the classic "users randomly logged out" bug.
  //
  // getClaims() verifies the JWT signature against the project JWKS (falling
  // back to a network round-trip on legacy HS256 secrets). getSession() does
  // not verify anything and must not be used for a trust decision.
  const { data } = await supabase.auth.getClaims()
  const claims = data?.claims

  /** Copy the refreshed cookies and the no-store headers onto another response. */
  function handOff(response: NextResponse): NextResponse {
    supabaseResponse.cookies.getAll().forEach((cookie) => response.cookies.set(cookie))
    // Baseline first, then let the library's own headers win if it supplied any.
    response.headers.set(
      'Cache-Control',
      'private, no-cache, no-store, must-revalidate, max-age=0'
    )
    Object.entries(cacheHeaders).forEach(([headerName, headerValue]) =>
      response.headers.set(headerName, headerValue)
    )
    return response
  }

  /** Same-origin, path-only redirect targets only. See app/auth/callback/route.ts. */
  function safeNext(raw: string | null): string {
    if (!raw || !raw.startsWith('/')) return '/'
    // `//host` and `/\host` are protocol-relative URLs, not local paths.
    if (raw.startsWith('//') || raw.startsWith('/\\')) return '/'
    return raw
  }

  if (!claims && !isPublicPath(request.nextUrl.pathname)) {
    // An API call deserves a status code, not an HTML login page.
    if (request.nextUrl.pathname.startsWith('/api/')) {
      return handOff(
        NextResponse.json({ error: 'unauthorized' }, { status: 401 })
      )
    }

    const loginUrl = request.nextUrl.clone()
    loginUrl.pathname = '/login'
    loginUrl.search = ''
    // Send them back where they were headed once they sign in.
    const intended = `${request.nextUrl.pathname}${request.nextUrl.search}`
    if (intended !== '/') {
      loginUrl.searchParams.set('next', intended)
    }
    return handOff(NextResponse.redirect(loginUrl))
  }

  // Signed in and sitting on /login? Bounce them into the app.
  if (claims && request.nextUrl.pathname === '/login') {
    const target = safeNext(request.nextUrl.searchParams.get('next'))
    return handOff(NextResponse.redirect(new URL(target, request.nextUrl.origin)))
  }

  // Return `supabaseResponse` as-is. If you ever need to build a different
  // response here, copy the cookies over first (that is what handOff does) or
  // the browser and server sessions drift apart and the user is logged out.
  return supabaseResponse
}

export const config = {
  /**
   * Everything EXCEPT:
   *
   *  - `_next/static`, `_next/image` -- framework assets.
   *  - `favicon.ico`, `robots.txt`, `sitemap.xml` -- metadata files.
   *  - `sw.js` and the Serwist route that serves it. @serwist/turbopack serves
   *    the service worker and its bundled chunks from a root catch-all route
   *    handler, with `Service-Worker-Allowed: /`. A 3xx on a service-worker
   *    script is a registration failure per the Service Workers spec, and a
   *    failed registration means push subscriptions can never be created --
   *    the app silently loses notifications forever. The blanket
   *    `.*\.(?:js|mjs|map)$` arm covers `sw.js`, `swe-worker-*.js` and any
   *    other emitted worker chunk whose hashed name we cannot predict here.
   *  - `manifest.json` / `manifest.webmanifest` -- the web app manifest is
   *    fetched with `credentials: omit` by some browsers, so a login redirect
   *    would break installability.
   *  - `~offline` -- Serwist's offline fallback page. It must render when
   *    there is no network, which is exactly when a session check cannot run.
   *  - static asset extensions.
   *
   * `/api` is deliberately NOT excluded, so route handlers still receive a
   * freshly refreshed session cookie (and a 401 when there is no session).
   *
   * EXCEPTION: `/api/cron/` IS excluded. It is machine-to-machine (pg_net has no
   * cookie), so the session check here would 401 it before the handler ever runs.
   * The route authenticates itself with CRON_SECRET via timingSafeEqual. Excluding
   * it in the matcher rather than in isPublicPath also skips a pointless getClaims()
   * JWKS round-trip on all 288 ticks a day.
   */
  matcher: [
    '/((?!_next/static|_next/image|_next/webpack-hmr|api/cron/|favicon\\.ico|robots\\.txt|sitemap\\.xml|sw\\.js|~offline|manifest\\.json|manifest\\.webmanifest|icons/|.*\\.(?:js|mjs|map|css|json|txt|xml|svg|png|jpg|jpeg|gif|webp|avif|ico|woff|woff2|ttf|otf)$).*)',
  ],
}
