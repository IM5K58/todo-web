import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

import type { Database } from '@/lib/supabase/types'

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

/**
 * Supabase client for Server Components, Server Actions and Route Handlers.
 *
 * `cookies()` is async in Next 15+, which is why this factory is async and
 * every call site must write `const supabase = await createClient()`.
 *
 * Create a NEW client per request. Never hoist the result into a module-level
 * constant: it closes over one specific request's cookie store, so a shared
 * instance would leak one user's session into another user's request.
 *
 * For anything that gates access, call `getClaims()` (or `getUser()`), never
 * `getSession()` -- `getSession()` returns whatever is in the cookie without
 * verifying it.
 */
export async function createClient() {
  const cookieStore = await cookies()
  const { url, key } = publicEnv()

  return createServerClient<Database>(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      /**
       * `SetAllCookies` in @supabase/ssr 0.12 takes TWO arguments:
       *   1. the cookies to write
       *   2. `headers` -- the no-store Cache-Control / Expires / Pragma trio
       *      that must ride along on any response carrying a session cookie,
       *      so a CDN cannot cache one user's Set-Cookie and hand it to
       *      somebody else.
       *
       * There is no response object reachable from `cookies()`, so the second
       * argument cannot be honoured here. proxy.ts is the layer that actually
       * applies them, and it refreshes the session on every matched request,
       * so in practice this branch writes cookies only for the auth callback
       * route (which sets its own no-store headers).
       */
      setAll(cookiesToSet, _headers) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          )
        } catch {
          // Called from a Server Component, which cannot write cookies.
          // Safe to swallow: proxy.ts refreshes the session instead.
        }
      },
    },
  })
}
