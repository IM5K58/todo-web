'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { createClient } from '@/lib/supabase/server'
import type { GroupsRow } from '@/lib/supabase/types'

/**
 * Server Actions shared by /groups/new and /groups/join.
 *
 * WHY THE ERROR CHANNEL IS A QUERY PARAM
 * --------------------------------------
 * Both pages are Server Components with a plain `<form action={...}>`: no
 * client bundle, no hydration, and they still work while the JS chunk is
 * downloading on a phone. That rules out `useActionState`, so a failure is
 * reported by redirecting back to the same route with `?e=<code>`, which the
 * page maps onto Korean copy. Codes are opaque tokens, never raw SQLSTATEs or
 * database strings — nothing from Postgres is echoed into the URL.
 *
 * WHAT THE SQL ACTUALLY RETURNS (checked against 0001_init.sql, not memory)
 * ------------------------------------------------------------------------
 *   create_group(p_name text)                     returns public.groups
 *   join_group_by_invite_code(p_invite_code text) returns public.groups
 *
 * Both are `RETURNS <composite>`, NOT `RETURNS TABLE`, so PostgREST hands back
 * a single JSON OBJECT — `data.id`, not `data[0].id`. (`send_nudge` is the
 * RETURNS TABLE one, and that is why the nudge route reads `data[0]`.) The row
 * carries `invite_code`, because a function result is not subject to the
 * column-level GRANT on the `groups` table; it is deliberately never read
 * here, never logged, and never put in a URL.
 */

/** Longest name `groups_name_len_chk` will accept (60 chars, after btrim). */
const MAX_GROUP_NAME = 60

/**
 * `groups_invite_code_shape_chk` and the guard inside
 * `join_group_by_invite_code` both use `^[A-Z0-9]{6,16}$`.
 * `private.generate_invite_code()` currently mints exactly 12 characters from
 * 'ABCDEFGHJKMNPQRSTVWXYZ23456789' (I, L, O, U, 0, 1 removed so a code read off
 * a photo is unambiguous), so 12 is what a real code looks like — but accept
 * the whole 6..16 window the database accepts rather than inventing a stricter
 * client rule that would reject a code the server would have honoured.
 */
const CODE_MIN = 6
const CODE_MAX = 16

/**
 * Unwrap a PostgREST RPC payload defensively.
 *
 * The type says object (composite return), and that is what the current SQL
 * produces. Should someone ever rewrite the function as `RETURNS TABLE`, this
 * degrades to reading the first row instead of crashing on `undefined.id`.
 */
function firstRow<T>(data: T | T[] | null): T | null {
  if (data === null || data === undefined) return null
  return Array.isArray(data) ? (data[0] ?? null) : data
}

function backTo(path: string, params: Record<string, string>): never {
  const query = new URLSearchParams(params).toString()
  redirect(query ? `${path}?${query}` : path)
}

// ---------------------------------------------------------------------------
// 그룹 만들기
// ---------------------------------------------------------------------------

/**
 * `rpc('create_group', { p_name })`.
 *
 * Two guards that exist because this action creates something permanent:
 *
 *  1. CONFIRMATION. If the caller is already in at least one group, a bare
 *     submit is refused (`e=confirm`). The page only renders the confirmation
 *     checkbox in that case, so the normal first-group flow is unaffected —
 *     but a stray tap on a stale form cannot silently mint a second group.
 *  2. IDEMPOTENCY. A double tap on a form with no pending state would
 *     otherwise create two identical groups. Before calling the RPC we look
 *     for a group this user created with this exact name in the last minute
 *     and treat it as the same submission. `.select()` names its columns:
 *     `select('*')` on public.groups is "permission denied for column
 *     invite_code" (0002 grants only id, name, created_by, created_at).
 */
export async function createGroupAction(formData: FormData): Promise<void> {
  const supabase = await createClient()

  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims()
  const userId = claimsData?.claims.sub
  if (claimsError || typeof userId !== 'string' || !userId) {
    redirect('/login?next=%2Fgroups%2Fnew')
  }

  const rawName = formData.get('name')
  const name = typeof rawName === 'string' ? rawName.trim().replace(/\s+/g, ' ') : ''

  if (!name) backTo('/groups/new', { e: 'empty' })
  if (name.length > MAX_GROUP_NAME) backTo('/groups/new', { e: 'too_long' })

  const confirmed = formData.get('confirm') === 'on'

  // Authoritative membership check — the page's copy of this is only UI.
  const { data: memberships, error: membershipError } = await supabase
    .from('group_members')
    .select('group_id')
    .eq('user_id', userId)

  if (membershipError) backTo('/groups/new', { e: 'unknown' })
  if ((memberships?.length ?? 0) > 0 && !confirmed) {
    backTo('/groups/new', { e: 'confirm' })
  }

  const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString()
  const { data: recent } = await supabase
    .from('groups')
    .select('id, name, created_by, created_at')
    .eq('created_by', userId)
    .eq('name', name)
    .gte('created_at', oneMinuteAgo)
    .limit(1)

  if (recent && recent.length > 0) {
    // Same name, same person, seconds ago: this is the second half of a double
    // tap, not a second group. Land them on /groups as if it had just worked.
    revalidatePath('/groups')
    revalidatePath('/')
    redirect('/groups')
  }

  const { data, error } = await supabase.rpc('create_group', { p_name: name })

  if (error) {
    // 42501 is raised by the function when auth.uid() is null — the session
    // died between the page render and the submit.
    if (error.code === '42501') redirect('/login?next=%2Fgroups%2Fnew')
    // 22023: the function's own '그룹 이름을 입력해 주세요.' guard.
    if (error.code === '22023') backTo('/groups/new', { e: 'empty' })
    // PGRST202: the RPC is missing from PostgREST's schema cache, i.e. the
    // migration has not been applied on this project yet.
    if (error.code === 'PGRST202') backTo('/groups/new', { e: 'schema' })
    backTo('/groups/new', { e: 'unknown' })
  }

  const group = firstRow<GroupsRow>(data)
  if (!group) backTo('/groups/new', { e: 'unknown' })

  revalidatePath('/groups')
  revalidatePath('/')
  redirect('/groups')
}

// ---------------------------------------------------------------------------
// 초대 코드로 참여
// ---------------------------------------------------------------------------

/**
 * `rpc('join_group_by_invite_code', { p_invite_code })`.
 *
 * HOW THE THREE OUTCOMES ARE ACTUALLY TOLD APART
 * ----------------------------------------------
 * Read the function: it does `insert ... on conflict (group_id, user_id) do
 * nothing` and returns the groups row either way. So "이미 그 그룹의 멤버"
 * is NOT an error — it is an indistinguishable success. The only honest way to
 * separate it is to look at the caller's memberships BEFORE the call and check
 * whether the returned group id was already among them.
 *
 *   틀린 코드   -> SQLSTATE P0002 ('초대 코드가 올바르지 않습니다.', not found)
 *   형식 오류   -> SQLSTATE 22023 (fails `^[A-Z0-9]{6,16}$` inside the function)
 *   이미 멤버   -> no error at all; detected by the before/after comparison
 *   그 밖       -> anything else, surfaced as its own message
 *
 * Note the two different SQLSTATEs for what reads as the same Korean sentence
 * in the SQL: 22023 means the string was never code-shaped, P0002 means it was
 * well-formed but matched no group. Both get user-facing copy here, but
 * distinct copy, because "오타" and "만료된 코드" call for different next steps.
 */
export async function joinGroupAction(formData: FormData): Promise<void> {
  const supabase = await createClient()

  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims()
  const userId = claimsData?.claims.sub
  if (claimsError || typeof userId !== 'string' || !userId) {
    redirect('/login?next=%2Fgroups%2Fjoin')
  }

  // Uppercase and strip everything that is not [A-Z0-9]: people paste codes
  // with spaces, hyphens or a trailing newline, and the function's regex has
  // no tolerance for any of it. (It upper/btrims too, but not de-hyphenates.)
  const rawCode = formData.get('code')
  const code =
    typeof rawCode === 'string' ? rawCode.toUpperCase().replace(/[^A-Z0-9]/g, '') : ''

  if (!code) backTo('/groups/join', { e: 'empty' })
  if (code.length < CODE_MIN || code.length > CODE_MAX) {
    backTo('/groups/join', { e: 'shape' })
  }

  // Snapshot BEFORE the RPC. This is the only way to recognise a re-join,
  // because the function swallows the conflict and returns the group anyway.
  const { data: before, error: beforeError } = await supabase
    .from('group_members')
    .select('group_id')
    .eq('user_id', userId)

  if (beforeError) backTo('/groups/join', { e: 'unknown' })
  const alreadyIn = new Set((before ?? []).map((row) => row.group_id))

  const { data, error } = await supabase.rpc('join_group_by_invite_code', {
    p_invite_code: code,
  })

  if (error) {
    if (error.code === '42501') redirect('/login?next=%2Fgroups%2Fjoin')
    if (error.code === '22023') backTo('/groups/join', { e: 'shape' })
    if (error.code === 'P0002') backTo('/groups/join', { e: 'not_found' })
    if (error.code === 'PGRST202') backTo('/groups/join', { e: 'schema' })
    backTo('/groups/join', { e: 'unknown' })
  }

  const group = firstRow<GroupsRow>(data)
  if (!group) backTo('/groups/join', { e: 'unknown' })

  if (alreadyIn.has(group.id)) {
    // Not a failure, so it is not reported as `e=`. The page reads `g` to name
    // the group it already belongs to. A group id in the URL is fine; the
    // invite code on `group` never leaves this function.
    backTo('/groups/join', { already: '1', g: group.id })
  }

  revalidatePath('/groups')
  revalidatePath('/')
  redirect('/groups')
}
