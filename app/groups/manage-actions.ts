'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { createClient } from '@/lib/supabase/server'

/**
 * Server Actions for /groups — 코드 재발급 / 내보내기 / 나가기.
 *
 * WHY PLAIN <form action={...}> AND NOT A CLIENT COMPONENT
 * -------------------------------------------------------
 * Every mutation here is a single owner-gated RPC. Nothing on this screen needs
 * local state, optimistic UI, or a controlled input, so the whole page stays a
 * Server Component and confirmation is a native <details> disclosure. The one
 * consequence is that an action cannot hand a value back through
 * `useActionState`, so each action ends in a redirect back to /groups carrying
 * a short notice code, which the page renders as Korean copy. The result is a
 * real URL you can reload and share, and no error is ever swallowed.
 *
 * WHAT THE DATABASE ACTUALLY ENFORCES (0001/0002 — read, not remembered)
 * ---------------------------------------------------------------------
 * These actions are a thin shell. The rules live in Postgres:
 *
 *   rotate_invite_code(p_group_id)      SECURITY DEFINER. Re-checks
 *     `group_members.role = 'owner'` INSIDE the function because it runs with
 *     RLS bypassed. Raises 42501 otherwise. Returns the NEW code as text.
 *
 *   remove_member(p_group_id, p_user_id) SECURITY DEFINER, and the reason this
 *     RPC exists at all. In ONE transaction it (1) refuses `p_user_id =
 *     auth.uid()` with 22023, (2) re-checks owner, (3) returns silently if the
 *     target is already gone — WITHOUT rotating, (4) deletes the membership
 *     row, (5) calls `private.rotate_invite_code_unchecked(p_group_id)`.
 *     Step 5 is the whole point: deleting the row through the RLS DELETE policy
 *     instead would leave the code untouched and the removed member would walk
 *     back in with the code they memorised.
 *
 *   Leaving is NOT an RPC. Policy `group_members_delete_self_or_owner` allows
 *     `user_id = auth.uid()`, so a direct DELETE is the correct path — and it
 *     deliberately does NOT rotate the code, because nobody was expelled.
 *
 *   private.ensure_group_has_owner() is a DEFERRABLE INITIALLY DEFERRED
 *     constraint trigger on group_members. When the last owner's row
 *     disappears, at COMMIT it locks the groups row FOR UPDATE and promotes the
 *     longest-standing remaining member (`order by joined_at asc, user_id asc`)
 *     to 'owner'. It never raises, and if zero members remain the group is left
 *     empty rather than deleted. So an owner CAN leave; someone else inherits.
 */

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

/**
 * Notice codes travel in `?ok=` / `?err=`. Kept as a union so the page and the
 * actions cannot drift apart — page.tsx imports these types.
 *
 * Deliberately opaque short codes rather than the raw Postgres message: the
 * RPCs raise Korean text, but echoing a database string into the URL is how
 * you end up rendering a leaked identifier or an injected message.
 */
export type GroupsOkCode = 'rotated' | 'removed' | 'left'

export type GroupsErrCode =
  /** No verified session reached Postgres. */
  | 'auth'
  /** 42501 from an owner-gated RPC while we DO have a session. */
  | 'notowner'
  /** 22023 — remove_member refusing `p_user_id = auth.uid()`. */
  | 'self'
  /** PGRST202 — the RPC is not in PostgREST's schema cache (migration missing). */
  | 'notdeployed'
  /** The form did not carry a usable uuid. Means a bug here, not user error. */
  | 'badrequest'
  /** DELETE matched zero rows: already left, or already removed. */
  | 'notmember'
  /** Anything else. */
  | 'fail'

/**
 * The Korean copy for each code lives in page.tsx, not here: a `'use server'`
 * module may only export async functions, so a lookup table would have to be
 * dressed up as a server action to live in this file. Exporting the two unions
 * above (type-only, erased at build) is what keeps the two files in step — add
 * a code here and page.tsx stops type-checking until it has a message.
 */

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function uuidField(formData: FormData, name: string): string | null {
  const raw = formData.get(name)
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  // Sending a non-uuid would come back as 22P02 "invalid input syntax", which
  // is a worse message than the one we can write ourselves.
  return UUID_RE.test(value) ? value : null
}

/**
 * `redirect()` throws a NEXT_REDIRECT control-flow error, so it must never sit
 * inside a `try`. Every action below calls this as its last statement and none
 * of them wraps a redirect in a catch.
 */
function back(query: string): never {
  redirect(`/groups?${query}`)
}

function fail(code: GroupsErrCode): never {
  back(`err=${code}`)
}

/** Router Cache lives on the client, so a soft nav back would show stale rows. */
function refresh(): void {
  revalidatePath('/groups')
  revalidatePath('/')
}

/**
 * Resolve the signed-in user before touching an owner-gated RPC.
 *
 * Both "no session" and "not the owner" surface as 42501 from these functions
 * (they `raise ... using errcode = '42501'` for either), so the only way to
 * report the right thing is to rule out the session case up front.
 */
async function requireUserId(): Promise<string> {
  const supabase = await createClient()
  // getClaims() verifies the JWT signature. getSession() would echo the cookie.
  const { data, error } = await supabase.auth.getClaims()
  const userId = data?.claims.sub
  if (error || typeof userId !== 'string' || !userId) fail('auth')
  return userId
}

/** Map a PostgREST/Postgres error onto a notice, assuming the session is fine. */
function classify(code: string | undefined): GroupsErrCode {
  switch (code) {
    case '42501':
      return 'notowner'
    case '22023':
      return 'self'
    case 'PGRST202':
      return 'notdeployed'
    default:
      return 'fail'
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * 코드 재발급 — owner only.
 *
 * Returns the new code, which we intentionally do NOT put in the URL: the page
 * re-reads it through `get_invite_code` on the very next render, and a code in
 * a shareable URL is a code in somebody's browser history.
 */
export async function rotateInviteCodeAction(formData: FormData): Promise<void> {
  const groupId = uuidField(formData, 'groupId')
  if (!groupId) fail('badrequest')

  await requireUserId()

  const supabase = await createClient()
  const { error } = await supabase.rpc('rotate_invite_code', {
    p_group_id: groupId,
  })

  if (error) fail(classify(error.code))

  refresh()
  back('ok=rotated')
}

/**
 * 내보내기 — owner only.
 *
 * VERIFIED against 0001 section 16: this RPC deletes the membership row AND
 * calls `private.rotate_invite_code_unchecked()` in the SAME transaction. Every
 * other member's saved code stops working. The confirmation copy in page.tsx
 * says so before the button is pressed, because there is no undo.
 *
 * Self-removal is refused by the function itself with 22023 — the trigger-based
 * owner succession only applies to LEAVING, not to this path.
 */
export async function removeMemberAction(formData: FormData): Promise<void> {
  const groupId = uuidField(formData, 'groupId')
  const targetUserId = uuidField(formData, 'userId')
  if (!groupId || !targetUserId) fail('badrequest')

  const userId = await requireUserId()

  // The RPC raises 22023 for this, but catching it here keeps the round trip
  // (and a pointless code rotation risk) off the table entirely.
  if (targetUserId === userId) fail('self')

  const supabase = await createClient()
  const { error } = await supabase.rpc('remove_member', {
    p_group_id: groupId,
    p_user_id: targetUserId,
  })

  if (error) fail(classify(error.code))

  refresh()
  back('ok=removed')
}

/**
 * 그룹 나가기 — any member, including the owner.
 *
 * A direct DELETE, not an RPC: policy `group_members_delete_self_or_owner`
 * allows `user_id = (select auth.uid())`, and the `delete` grant on
 * group_members is unrestricted. The `.eq('user_id', userId)` is therefore
 * belt-and-braces — the policy already makes it impossible to delete anyone
 * else's row this way — but it keeps the intent readable at the call site.
 *
 * No rotation here, deliberately: nobody was expelled, so invalidating the
 * code every time someone leaves would just churn the group's shared code.
 *
 * If the leaver was the only owner, the DEFERRED constraint trigger
 * `group_members_ensure_owner` promotes the longest-standing remaining member
 * at commit. Nothing to do from here, and nothing to wait for.
 */
export async function leaveGroupAction(formData: FormData): Promise<void> {
  const groupId = uuidField(formData, 'groupId')
  if (!groupId) fail('badrequest')

  const userId = await requireUserId()

  const supabase = await createClient()
  const { error, count } = await supabase
    .from('group_members')
    .delete({ count: 'exact' })
    .eq('group_id', groupId)
    .eq('user_id', userId)

  if (error) {
    // 42501 here really is "no grant / no session" — the policy filters rows
    // rather than raising, so a non-member gets count 0, not an error.
    fail(error.code === '42501' ? 'auth' : 'fail')
  }

  if (count === 0) fail('notmember')

  refresh()
  // If that was the user's last group, /groups redirects on to /groups/new.
  back('ok=left')
}
