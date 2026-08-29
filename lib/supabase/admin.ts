// 이 모듈이 클라이언트 번들에 섞이면 service_role 키가 브라우저로 나갑니다.
// server-only 는 그런 import 를 런타임이 아니라 빌드 시점에 실패시킵니다.
import 'server-only'

import { createClient as createSupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/lib/supabase/types'

/**
 * Service-role Supabase client. **Server only.**
 *
 * This key bypasses every RLS policy in the database, so it must never reach
 * a browser bundle. Only import this from Route Handlers, Server Actions or
 * cron jobs -- never from a file that carries `'use client'`, and never from a
 * module that a Client Component imports transitively.
 *
 * Legitimate uses in this app:
 *   - the push fan-out job, which must read other members' push_subscriptions
 *   - pruning subscriptions after web-push returns 404/410 Gone
 *   - the auto-nudge cron, which acts on behalf of no signed-in user
 *
 * Anything a signed-in user does on their own behalf should go through
 * lib/supabase/server.ts so RLS still applies.
 *
 * Like server.ts, do not hoist the result to module scope. It is cheap to
 * construct and a shared instance is an easy way to leak state between
 * concurrent requests.
 */
export function createAdminClient() {
  if (typeof window !== 'undefined') {
    throw new Error(
      'createAdminClient() was called in the browser. The service-role key must never be shipped to a client bundle.'
    )
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  // `||` not `??`: a blank env var must fall through to the error, not be used.
  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY

  if (!url) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set.')
  }
  if (!serviceRoleKey) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set.')
  }

  return createSupabaseClient<Database>(url, serviceRoleKey, {
    auth: {
      // No user session is involved: never read, write or refresh one.
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { 'X-Client-Info': 'daily-todo-pwa/admin' },
    },
  })
}
