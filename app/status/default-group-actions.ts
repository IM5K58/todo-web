'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import type { PostgrestError } from '@supabase/supabase-js'

import { createClient } from '@/lib/supabase/server'

import type { DefaultGroupCode } from './page'

/**
 * Server Action for /status — "이 그룹을 현황 탭의 기본으로 고정".
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES NOT DO
 * ---------------------------------------------------------------------------
 * It does not check that the caller is a member of `p_group_id`. 0007's
 * `public.set_default_group` is SECURITY DEFINER and does that itself, and its
 * contract is deliberately "silently ignore a group I am not in" rather than
 * "raise". Re-checking here would be a check-then-act against a membership row
 * that `remove_member()` can delete in the same instant, and it would cost a
 * round trip to arrive at a *worse* answer than the function's own.
 *
 * It also does not write `profiles.default_group_id` directly. It cannot: 0003
 * narrowed the profiles UPDATE grant to (display_name, avatar_emoji, timezone)
 * and 0007 does not widen it, so the RPC is the structurally only write path —
 * the same shape `set_auto_nudge` already established.
 *
 * The RPC runs on the USER's client, so `auth.uid()` is the caller and is the
 * only possible source of the row that gets written. There is no service-role
 * client anywhere in this file, on purpose.
 *
 * ---------------------------------------------------------------------------
 * WHY A SERVER ACTION AND NOT A CLIENT TOGGLE
 * ---------------------------------------------------------------------------
 * /status is a Server Component with no client state (./actions.ts documents
 * the same choice for 콕 찌르기). A plain `<form action={…}>` gets an honest
 * pending state from <Button>'s useFormStatus() for free, works without JS, and
 * — the part that actually matters here — makes the *result* a URL you can
 * reload. An optimistic client toggle would happily show 고정됨 for a write the
 * database quietly ignored, which is exactly the failure mode "조용히 무시" on
 * the RPC side makes possible.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CALL IS CAST INSTEAD OF TYPED
 * ---------------------------------------------------------------------------
 * `lib/supabase/types.ts` is not this feature's file to edit, so at the time of
 * writing `set_default_group` may or may not be in `Database['public']
 * ['Functions']`. A typed `supabase.rpc('set_default_group', …)` would then be
 * a compile error for a function that exists in the database, which is a build
 * break over a bookkeeping gap. The cast below is deliberately narrow — it
 * names the one function, the one argument, and reads back nothing but `error`
 * (the function `returns void`, so there is no row to mistype) — and the
 * `PGRST202` branch is what turns "not in the schema cache yet" into Korean
 * copy instead of a stack trace.
 *
 * When types.ts does grow the entry, delete the cast and call
 * `supabase.rpc('set_default_group', { p_group_id })` directly. Nothing else in
 * this file changes.
 */

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function uuidField(formData: FormData, name: string): string | null {
  const raw = formData.get(name)
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  // A non-uuid would come back from Postgres as 22P02 "invalid input syntax",
  // which is a worse message than the one we can write ourselves.
  return UUID_RE.test(value) ? value : null
}

/**
 * `redirect()` throws NEXT_REDIRECT, so it must never sit inside a `try`.
 * Every exit below is the last statement on its path.
 *
 * The group id is carried back in `?group=` so the screen returns to the board
 * the user was actually looking at — including when they just *un*pinned it,
 * where jumping to some other group would read as the button having done
 * something it did not do.
 */
function backTo(groupId: string | null, code: DefaultGroupCode): never {
  const prefix = groupId ? `/status?group=${encodeURIComponent(groupId)}&` : '/status?'
  redirect(`${prefix}dg=${code}`)
}

/**
 * The one call this file makes, typed by hand. See the header for why.
 * `returns void`, so only `error` is read.
 */
type SetDefaultGroupRpc = (
  fn: 'set_default_group',
  args: { p_group_id: string | null },
) => PromiseLike<{ error: PostgrestError | null }>

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

/**
 * 기본 그룹 고정 / 해제. Expects two hidden fields:
 *
 *   groupId  the group being looked at right now (uuid, always present)
 *   pin      '1' to pin it, anything else to clear the pin
 *
 * `pin` is a separate field rather than "send an empty groupId to unpin"
 * because the redirect needs the group id in BOTH directions. Folding the two
 * meanings into one field is how you end up bouncing the user to a different
 * group every time they release a pin.
 *
 * Always ends in a redirect back to /status for the SAME group, carrying one
 * notice code, so no failure can be swallowed into a silently unchanged screen.
 */
export async function setDefaultGroupAction(formData: FormData): Promise<void> {
  const groupId = uuidField(formData, 'groupId')
  if (!groupId) backTo(null, 'e_badrequest')

  const pin = formData.get('pin') === '1'

  const supabase = await createClient()

  // getClaims() verifies the JWT signature; getSession() would just echo the
  // cookie back, which is not an authorization check.
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims()
  const callerId = claimsData?.claims.sub
  if (claimsError || typeof callerId !== 'string' || !callerId) {
    backTo(groupId, 'e_auth')
  }

  const rpc = supabase.rpc as unknown as SetDefaultGroupRpc
  const { error } = await rpc('set_default_group', {
    // null clears the pin. 0007 treats it as "고정 해제", not as an error.
    p_group_id: pin ? groupId : null,
  })

  if (error) {
    // set_default_group raises 42501 only when auth.uid() is null — the cookie
    // parsed but the JWT never reached Postgres. That is an auth problem.
    if (error.code === '42501') backTo(groupId, 'e_auth')
    // PGRST202: the function is not in PostgREST's schema cache (0007 not
    // deployed yet). 42883/42703: the function or the column does not exist on
    // this database at all. All three mean the same thing to the user.
    if (error.code === 'PGRST202' || error.code === '42883' || error.code === '42703') {
      backTo(groupId, 'e_notdeployed')
    }
    // P0002: the UPDATE matched 0 rows — there is no profiles row for this
    // user. 0007 raises instead of reporting a 0-row write as success (the
    // project rule), and it is not something waiting will fix, so it gets its
    // own message rather than "잠시 후 다시 시도해 주세요".
    if (error.code === 'P0002') backTo(groupId, 'e_noprofile')
    console.error('[status/default-group] set_default_group rpc failed', {
      code: error.code,
      message: error.message,
    })
    backTo(groupId, 'e_fail')
  }

  // ★ The RPC succeeding does NOT mean the pin was set. ★
  // Its contract is to ignore a group the caller is not in, silently and
  // without raising, so "no error" covers both "pinned" and "you are not in
  // that group any more". /status re-reads profiles.default_group_id on the
  // very next render and draws the toggle from THAT value, never from this
  // outcome — so a quietly-ignored write shows up as a toggle that stayed off
  // rather than as a lie. The notice below is worded as an outcome the reader
  // can check against the toggle right under it.

  // The Router Cache lives on the client, so a soft nav back would show the
  // pre-toggle state. '/' reads the same profiles row for its group dropdown.
  revalidatePath('/status')
  revalidatePath('/')

  backTo(groupId, pin ? 'pinned' : 'unpinned')
}
