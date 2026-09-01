'use server'

import { createClient } from '@/lib/supabase/server'

/**
 * Server Actions for the "콕 찌르기 메시지" section of /settings.
 *
 * WHY A SERVER ACTION AND NOT THE BROWSER CLIENT
 * ----------------------------------------------
 * `public.set_nudge_message(text)` (0009 ④-c) is `returns void`. A void RPC
 * cannot tell the caller what it stored, and it does NOT reject a long input —
 * it truncates with exactly the expression `send_nudge` uses:
 *
 *     v_msg := nullif(left(btrim(coalesce(p_message, '')), 200), '');
 *
 * So 201 characters save "successfully" as 200, and blank-only input saves as
 * NULL. Rendering the textarea from what the user typed would therefore show a
 * value the database does not hold. Every write below is followed by a read of
 * `profiles.nudge_message`, and the UI renders THAT — one round trip instead of
 * two from the browser, and the write/read pair cannot drift apart because it
 * lives in one function.
 *
 * WHY THE CASTS
 * -------------
 * `lib/supabase/types.ts` has not been regenerated since migration 0009, so it
 * knows neither `set_nudge_message` nor `profiles.nudge_message`. That file is
 * shared with other work in flight, so instead of widening it here this module
 * reaches the two new surfaces through a narrow structural view. The view names
 * the exact function, table and column it uses, so a rename shows up as a
 * compile error in this file rather than as a runtime 42703.
 *
 * ▶ When types.ts is regenerated, delete `NudgeMessageGateway` and the two
 *   `as unknown as` casts. Nothing else here has to change.
 */

/**
 * `public.profiles_nudge_message_len_chk` allows 1..200 characters, and
 * `set_nudge_message` / `send_nudge` both truncate at 200. Migration 0009's
 * self-check compares all three, so this number is not free to drift.
 *
 * Duplicated in app/settings/page.tsx: a `'use server'` module may only export
 * async functions, so this constant cannot be shared from here.
 */
const MAX_NUDGE_MESSAGE_LENGTH = 200

/** The part of a PostgREST error this module actually branches on. */
interface QueryError {
  code?: string
  message: string
}

/**
 * The 0009 surfaces, spelled out. Deliberately not generic: `set_nudge_message`
 * and `nudge_message` are string literals here, so a typo cannot compile.
 */
interface NudgeMessageGateway {
  rpc(
    fn: 'set_nudge_message',
    args: { p_message: string | null },
  ): PromiseLike<{ error: QueryError | null }>
  from(table: 'profiles'): {
    select(columns: 'nudge_message'): {
      eq(
        column: 'id',
        value: string,
      ): {
        maybeSingle(): PromiseLike<{
          data: { nudge_message: unknown } | null
          error: QueryError | null
        }>
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** Mapped to Korean copy in app/settings/page.tsx. */
export type NudgeMessageErrorCode =
  /** No verified session reached Postgres (42501, or no `sub` claim). */
  | 'auth'
  /** P0002 — the profile row is missing. `set_nudge_message` refuses to report
   *  a 0-row UPDATE as success, so this is a real failure, not a no-op. */
  | 'noprofile'
  /** PGRST202 — migration 0009 is not in PostgREST's schema cache. */
  | 'notdeployed'
  /** Anything else. */
  | 'fail'

export type LoadNudgeMessageResult =
  | { ok: true; message: string | null }
  | { ok: false; code: NudgeMessageErrorCode }

export type SaveNudgeMessageResult =
  | {
      ok: true
      /** What `profiles.nudge_message` actually holds now. NULL = 해제됨. */
      message: string | null
      /** The server cut the input down to 200 characters. */
      truncated: boolean
      /**
       * False when the write succeeded but the read-back did not, so `message`
       * is this module's best guess rather than an observed value. The UI says
       * so instead of pretending to have confirmed it.
       */
      verified: boolean
    }
  | { ok: false; code: NudgeMessageErrorCode }

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function classify(error: QueryError): NudgeMessageErrorCode {
  if (error.code === '42501') return 'auth'
  if (error.code === 'P0002') return 'noprofile'
  if (error.code === 'PGRST202' || error.code === '42883') return 'notdeployed'
  // 42703 = the column is missing, i.e. 0009 was not applied to this database.
  if (error.code === '42703') return 'notdeployed'
  return 'fail'
}

/** Postgres `char_length` counts code points, and so does this. */
function codePointLength(value: string): number {
  return Array.from(value).length
}

/** The exact expression `set_nudge_message` and `send_nudge` share. */
function normalize(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const points = Array.from(trimmed)
  const cut = points.length > MAX_NUDGE_MESSAGE_LENGTH
  return cut ? points.slice(0, MAX_NUDGE_MESSAGE_LENGTH).join('') : trimmed
}

/**
 * Read `auth.uid()`'s own message.
 *
 * Column-scoped SELECT on `nudge_message` was granted to `authenticated` in
 * 0009 ④-b, and the `profiles` SELECT policy already limits the rows, so the
 * user's own client is enough — no service role anywhere in this file.
 *
 * NOTE: `select('*')` is forbidden on profiles (column-scoped grants make it a
 * 42501). One named column only.
 */
async function readOwn(
  client: unknown,
  userId: string,
): Promise<LoadNudgeMessageResult> {
  const db = client as NudgeMessageGateway
  const { data, error } = await db
    .from('profiles')
    .select('nudge_message')
    .eq('id', userId)
    .maybeSingle()

  if (error) {
    console.error('[settings/nudge-message] read failed', {
      code: error.code,
      message: error.message,
    })
    return { ok: false, code: classify(error) }
  }

  const raw = data?.nudge_message
  return { ok: true, message: typeof raw === 'string' && raw.trim() ? raw : null }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Current value of my default nudge message. NULL = 설정 안 함. */
export async function loadNudgeMessage(): Promise<LoadNudgeMessageResult> {
  try {
    const supabase = await createClient()
    // getClaims() verifies the JWT signature; getSession() would just echo the
    // cookie back, which is not an authorization check.
    const { data: claims } = await supabase.auth.getClaims()
    const userId = claims?.claims.sub
    if (typeof userId !== 'string' || !userId) return { ok: false, code: 'auth' }
    return await readOwn(supabase, userId)
  } catch (cause) {
    console.error('[settings/nudge-message] load threw', {
      message: cause instanceof Error ? cause.message : String(cause),
    })
    return { ok: false, code: 'fail' }
  }
}

/**
 * Save (or clear) my default nudge message, then report what the database
 * actually holds.
 *
 * Blank or whitespace-only input clears it — that is `nullif(..., '')` in the
 * RPC, not a special case invented here.
 */
export async function saveNudgeMessage(input: string): Promise<SaveNudgeMessageResult> {
  const raw = typeof input === 'string' ? input : ''
  const expected = normalize(raw)
  const wasCut = codePointLength(raw.trim()) > MAX_NUDGE_MESSAGE_LENGTH

  try {
    const supabase = await createClient()
    const { data: claims } = await supabase.auth.getClaims()
    const userId = claims?.claims.sub
    if (typeof userId !== 'string' || !userId) return { ok: false, code: 'auth' }

    // Send the text as typed. The server owns the truncation rule; doing it
    // here as well would only create a second place for the number 200 to be
    // wrong, and the read-back below is what the screen renders anyway.
    const { error } = await (supabase as unknown as NudgeMessageGateway).rpc(
      'set_nudge_message',
      { p_message: raw.trim() === '' ? null : raw },
    )

    if (error) {
      console.error('[settings/nudge-message] set_nudge_message failed', {
        code: error.code,
        message: error.message,
      })
      return { ok: false, code: classify(error) }
    }

    // `returns void` told us nothing. Ask the table.
    const after = await readOwn(supabase, userId)
    if (!after.ok) {
      return { ok: true, message: expected, truncated: wasCut, verified: false }
    }

    const stored = after.message
    return {
      ok: true,
      message: stored,
      // Trust the observed value over the local prediction: `truncated` is true
      // only when what came back is genuinely shorter than what was sent.
      truncated:
        stored !== null && codePointLength(raw.trim()) > codePointLength(stored),
      verified: true,
    }
  } catch (cause) {
    console.error('[settings/nudge-message] save threw', {
      message: cause instanceof Error ? cause.message : String(cause),
    })
    return { ok: false, code: 'fail' }
  }
}
