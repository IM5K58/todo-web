'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { loadNudgeMessage } from '@/app/settings/nudge-message-actions'
import {
  EMPTY_FANOUT,
  PushConfigurationError,
  sendPushToUser,
  type PushFanoutResult,
} from '@/lib/push/send'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import type { NudgeFailureReason } from '@/lib/supabase/types'

/**
 * Server Action for /status — 콕 찌르기.
 *
 * WHAT THIS FILE DOES NOT DO
 * --------------------------
 * It does not check membership and it does not count nudges. Both live inside
 * `public.send_nudge` (0001 §17, redefined in 0003 §8), a SECURITY DEFINER
 * function that takes `pg_advisory_xact_lock` on the (from, to) pair, counts,
 * and inserts in ONE transaction. Re-checking here would be a check-then-act:
 * two taps in the same millisecond both read "0 nudges this hour" and both
 * insert. The client also has no INSERT grant and no INSERT policy on `nudges`
 * (0002), so there is no path around the RPC even if someone wanted one.
 *
 * The RPC runs on the USER's client, so `auth.uid()` is the caller and is the
 * only possible source of `from_user_id`. The service role appears only after
 * `ok = true`, and only to deliver the push.
 *
 * WHY A SERVER ACTION AND NOT fetch('/api/nudge')
 * ----------------------------------------------
 * /status is a Server Component with no client state (the same choice
 * app/groups/manage-actions.ts documents), so a plain `<form action={...}>`
 * gets an honest pending state from <Button>'s useFormStatus() for free and
 * still works with JS disabled. app/api/nudge/route.ts remains the client-side
 * entry point and is untouched; both call the same RPC with the same rate
 * limit. The push fan-out below is the same three calls the route makes, using
 * the same `lib/push/send` helpers — nothing about the limit is reimplemented.
 *
 * WHY THE DELIVERY OUTCOME MATTERS TO THE USER
 * -------------------------------------------
 * push_subscriptions is readable only by its owner (policy
 * `push_subscriptions_all_own`, `user_id = auth.uid()`), so the /status page
 * CANNOT tell in advance whether a friend has notifications turned on. The
 * fan-out result is the only honest signal available, and it arrives after the
 * fact — hence the separate `sent_pushoff` / `sent_undelivered` notices below.
 */

// ---------------------------------------------------------------------------
// Notice codes
// ---------------------------------------------------------------------------

/**
 * Travel in `?ok=` / `?err=`. Kept as unions so app/status/page.tsx stops
 * type-checking the moment a code here has no Korean copy over there.
 */
export type StatusOkCode =
  /** Recorded and at least one device accepted the push. */
  | 'sent'
  /** Recorded, but the target has no push subscription at all. */
  | 'sent_pushoff'
  /** Recorded; devices exist but nothing could be delivered right now. */
  | 'sent_undelivered'

export type StatusErrCode =
  /** No verified session reached Postgres. */
  | 'auth'
  /** The form did not carry usable uuids. A bug here, not user error. */
  | 'badrequest'
  /** send_nudge said `not_member`. */
  | 'notmember'
  /** send_nudge said `self_nudge` (the page should never offer the button). */
  | 'self'
  /** send_nudge said `rate_limited_hour`. */
  | 'ratehour'
  /** send_nudge said `rate_limited_day`. */
  | 'rateday'
  /** PGRST202 — send_nudge is missing from PostgREST's schema cache. */
  | 'notdeployed'
  /** Anything else. */
  | 'fail'

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * What the push says when the sender has not written a message of their own.
 * Same string app/api/nudge/route.ts falls back to, so both nudge paths read
 * identically on the lock screen.
 */
const DEFAULT_NUDGE_BODY = '오늘 할 일 적었어요?'

function uuidField(formData: FormData, name: string): string | null {
  const raw = formData.get(name)
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  // A non-uuid would come back as 22P02 "invalid input syntax", which is a
  // worse message than the one we can write ourselves.
  return UUID_RE.test(value) ? value : null
}

/**
 * `redirect()` throws NEXT_REDIRECT, so it must never sit inside a `try`.
 * Every exit below is the last statement on its path.
 */
function backTo(groupId: string | null, query: string): never {
  const prefix = groupId ? `/status?group=${encodeURIComponent(groupId)}&` : '/status?'
  redirect(`${prefix}${query}`)
}

function fail(code: StatusErrCode, groupId: string | null): never {
  backTo(groupId, `err=${code}`)
}

/** send_nudge's `reason` -> our notice code. */
const REASON_TO_CODE: Record<NudgeFailureReason, StatusErrCode> = {
  not_member: 'notmember',
  self_nudge: 'self',
  rate_limited_hour: 'ratehour',
  rate_limited_day: 'rateday',
}

interface SendNudgeRow {
  ok: boolean
  reason: string | null
  nudge_id: string | null
}

/**
 * `returns table (...)` is a row set. Depending on how the Database types model
 * it, supabase-js hands back either the array or a single object — normalise
 * both rather than betting on one. (app/api/nudge/route.ts does the same.)
 */
function firstRow(data: unknown): SendNudgeRow | null {
  const row = Array.isArray(data) ? data[0] : data
  if (!row || typeof row !== 'object') return null
  const candidate = row as Partial<SendNudgeRow>
  if (typeof candidate.ok !== 'boolean') return null
  return {
    ok: candidate.ok,
    reason: typeof candidate.reason === 'string' ? candidate.reason : null,
    nudge_id: typeof candidate.nudge_id === 'string' ? candidate.nudge_id : null,
  }
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

/**
 * 콕 찌르기. Expects `groupId` and `userId` hidden fields.
 *
 * Always ends in a redirect back to /status for the SAME group, carrying one
 * notice code. That makes the outcome a URL you can reload, and means no
 * failure is ever swallowed into a silently unchanged screen.
 */
export async function nudgeAction(formData: FormData): Promise<void> {
  const groupId = uuidField(formData, 'groupId')
  const targetUserId = uuidField(formData, 'userId')
  if (!groupId || !targetUserId) fail('badrequest', groupId)

  const supabase = await createClient()

  // getClaims() verifies the JWT signature; getSession() would just echo the
  // cookie back, which is not an authorization check.
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims()
  const callerId = claimsData?.claims.sub
  if (claimsError || typeof callerId !== 'string' || !callerId) fail('auth', groupId)

  // send_nudge returns `self_nudge` for this too (0001 §17 / 0003 §8, and the
  // `nudges_no_self_nudge_chk` CHECK behind it). Catching it here saves a round
  // trip; the page never renders the button on your own row in the first place.
  if (callerId === targetUserId) fail('self', groupId)

  // 설정 › 콕 찌르기 메시지. Strictly additive: the nudge is the point, the
  // message is decoration, so a failed read must degrade to the default copy
  // rather than abort. `loadNudgeMessage()` reads auth.uid()'s own row only —
  // it never reaches another member's profile.
  let myMessage: string | null = null
  try {
    const loaded = await loadNudgeMessage()
    if (loaded.ok) myMessage = loaded.message
    else console.error('[status/nudge] nudge message lookup failed', loaded.code)
  } catch (cause) {
    console.error('[status/nudge] nudge message lookup threw', {
      message: cause instanceof Error ? cause.message : String(cause),
    })
  }

  // Built incrementally rather than passing `p_message: null`: the generated
  // Args type declares the defaulted parameters as optional, and omitting one
  // is what makes Postgres apply its own DEFAULT.
  const args: {
    p_to_user_id: string
    p_group_id: string
    p_message?: string
  } = { p_to_user_id: targetUserId, p_group_id: groupId }
  if (myMessage) args.p_message = myMessage

  const { data, error } = await supabase.rpc('send_nudge', args)

  if (error) {
    // send_nudge raises 42501 only when auth.uid() is null — the cookie parsed
    // but the JWT never reached Postgres. That is an auth problem, not a fault.
    if (error.code === '42501') fail('auth', groupId)
    if (error.code === 'PGRST202') fail('notdeployed', groupId)
    console.error('[status/nudge] send_nudge rpc failed', {
      code: error.code,
      message: error.message,
    })
    fail('fail', groupId)
  }

  const result = firstRow(data)
  if (!result) {
    console.error('[status/nudge] send_nudge returned an unexpected shape')
    fail('fail', groupId)
  }

  if (!result.ok) {
    const reason = result.reason
    const code =
      reason && Object.prototype.hasOwnProperty.call(REASON_TO_CODE, reason)
        ? REASON_TO_CODE[reason as NudgeFailureReason]
        : 'fail'
    fail(code, groupId)
  }

  // ---- The nudge row exists and the quota is already spent. -----------------
  // Everything below is best-effort delivery: it must never turn a recorded
  // nudge into an error, only into a more honest success message.

  let delivery: PushFanoutResult = { ...EMPTY_FANOUT }
  let deliveryFailed = false

  try {
    // Reading someone else's push_subscriptions needs the service role — the
    // RLS policy scopes that table to its owner. createAdminClient() throws
    // when SUPABASE_SERVICE_ROLE_KEY is missing, which is why it is inside the
    // try: a misconfigured deployment must still report "찔렀어요".
    const admin = createAdminClient()

    let senderName = '친구'
    const { data: profile, error: profileError } = await admin
      .from('profiles')
      .select('display_name')
      .eq('id', callerId)
      .maybeSingle()

    if (profileError) {
      console.error('[status/nudge] sender profile lookup failed', profileError.message)
    } else if (profile?.display_name.trim()) {
      senderName = profile.display_name.trim()
    }

    delivery = await sendPushToUser(targetUserId, {
      title: `${senderName}님이 콕 찔렀어요`,
      // The sender's own sentence, or the generic default. A push notification
      // lands on a lock screen, a paired watch, a mirrored car display — the
      // RECIPIENT's task titles and the group name still have no business being
      // there (0003 §13(i)), and nothing below reads them. A message the sender
      // wrote for this exact purpose is a different thing, and it is the same
      // substitution app/api/nudge/route.ts already makes.
      body: myMessage ?? DEFAULT_NUDGE_BODY,
      url: '/',
      // Collapse repeat nudges from the same sender into one notification.
      tag: `nudge-${callerId}`,
    })
  } catch (cause) {
    deliveryFailed = true
    console.error('[status/nudge] push fan-out failed', {
      kind: cause instanceof PushConfigurationError ? 'config' : 'failed',
      message: cause instanceof Error ? cause.message : String(cause),
    })
  }

  const ok: StatusOkCode = deliveryFailed
    ? 'sent_undelivered'
    : delivery.subscriptions === 0
      ? 'sent_pushoff'
      : delivery.sent === 0
        ? 'sent_undelivered'
        : 'sent'

  // The Router Cache lives on the client, so a soft nav back would show the
  // pre-nudge board. '/' shares the same task rows.
  revalidatePath('/status')
  revalidatePath('/')

  backTo(groupId, `ok=${ok}`)
}
