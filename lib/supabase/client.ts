import { createBrowserClient } from '@supabase/ssr'

import type { Database } from '@/lib/supabase/types'

/**
 * Reads the public Supabase env vars.
 *
 * Two deliberate details:
 *
 * 1. Each `process.env.NEXT_PUBLIC_*` is written as a literal member
 *    expression. That is the only form Next inlines at build time; a dynamic
 *    lookup like `process.env[name]` would be `undefined` in the browser.
 * 2. `||` and not `??`. An env var declared in a dashboard but left blank is
 *    an empty string, not `undefined`, and `'' ?? key` evaluates to `''`.
 *    `createBrowserClient(url, '')` then throws `supabaseKey is required`
 *    from inside supabase-js at render time -- a white screen from a build
 *    that succeeded. An empty key is never valid, so fall through.
 */
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
 * Supabase client for code that runs in the browser (Client Components).
 *
 * `createBrowserClient` memoises internally, so calling this many times does
 * not create many clients or many auth listeners.
 *
 * Do NOT pass a `cookies` option here. In a browser runtime @supabase/ssr
 * falls back to `document.cookie`, which is exactly what we want: the session
 * cookie has to be readable by proxy.ts and by Server Components too.
 */
export function createClient() {
  const { url, key } = publicEnv()
  return createBrowserClient<Database>(url, key)
}
