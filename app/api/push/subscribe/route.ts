import "server-only";

import { NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/push/subscribe  - store (or refresh) the caller's PushSubscription
 * DELETE /api/push/subscribe - forget one of the caller's endpoints
 *
 * The service worker inspects the HTTP status of the POST, so this route must
 * never answer 200 for an unauthenticated caller: a 401 is the signal the
 * client uses to know it has to re-sync after the session is restored.
 */

// web-push, the service-role client and node:crypto all need the Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Push endpoints are long; anything past this is not a real FCM/APNs/Mozilla URL. */
const MAX_ENDPOINT_LENGTH = 2048;
const MAX_KEY_LENGTH = 256;
const MAX_USER_AGENT_LENGTH = 512;

/**
 * The worker may post either `{ subscription: <PushSubscriptionJSON> }` or the
 * PushSubscriptionJSON itself (that is what `subscription.toJSON()` yields).
 * Accept both so a pushsubscriptionchange handler cannot silently mis-shape it.
 */
interface SubscriptionJson {
  endpoint?: unknown;
  expirationTime?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown } | null;
}

interface SubscribeBody extends SubscriptionJson {
  subscription?: SubscriptionJson | null;
  /** Endpoint being replaced (pushsubscriptionchange), deleted in the same request. */
  oldEndpoint?: unknown;
}

function unauthorized() {
  return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
}

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * Cheap CSRF backstop. Same-origin fetches either omit Origin or send our own
 * origin; a cross-site POST always carries a foreign one. We do not rely on
 * this alone — Supabase cookies are SameSite=Lax — but an implicit control is
 * not a control.
 *
 * Compare HOSTS, not full origins, and take the host from the forwarded/Host
 * header rather than request.url: behind a proxy request.url can carry the
 * internal origin (http://localhost:3000), which would reject every legitimate
 * request in production. Scheme is not compared for the same reason — the
 * proxy terminates TLS.
 */
function crossOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  const expected =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    (() => {
      try {
        return new URL(request.url).host;
      } catch {
        return null;
      }
    })();

  if (!expected) return true;

  try {
    return new URL(origin).host !== expected;
  } catch {
    return true;
  }
}

function asNonEmptyString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) return null;
  return trimmed;
}

/**
 * expirationTime is a DOMHighResTimeStamp: epoch MILLISECONDS, or null.
 *
 * The column is `expiration_time bigint` — it stores that number verbatim (see
 * 0001_init.sql: "PushSubscription.expirationTime (epoch ms)"). Do NOT convert
 * it to an ISO timestamp: bigint would reject the string at runtime, and with
 * a typed client it will not even compile.
 *
 * Anything that is not a finite positive number becomes null.
 */
function toExpirationTime(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  // Guard the bigint range; a bogus huge value would overflow the column.
  if (!Number.isSafeInteger(Math.trunc(value))) return null;
  return Math.trunc(value);
}

/** Returns the authenticated user's id, or null. */
async function currentUserId(): Promise<string | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data) return null;
  const sub = data.claims.sub;
  if (typeof sub !== "string" || sub.length === 0) return null;
  if (data.claims.role !== "authenticated") return null;
  return sub;
}

export async function POST(request: Request) {
  if (crossOrigin(request)) {
    return NextResponse.json({ error: "잘못된 요청입니다." }, { status: 403 });
  }

  const userId = await currentUserId();
  if (!userId) return unauthorized();

  let body: SubscribeBody;
  try {
    body = (await request.json()) as SubscribeBody;
  } catch {
    return badRequest("잘못된 요청 형식입니다.");
  }
  if (!body || typeof body !== "object") {
    return badRequest("잘못된 요청 형식입니다.");
  }

  const subscription: SubscriptionJson = body.subscription ?? body;

  const endpoint = asNonEmptyString(subscription.endpoint, MAX_ENDPOINT_LENGTH);
  const p256dh = asNonEmptyString(subscription.keys?.p256dh, MAX_KEY_LENGTH);
  const auth = asNonEmptyString(subscription.keys?.auth, MAX_KEY_LENGTH);

  if (!endpoint || !p256dh || !auth) {
    return badRequest("구독 정보가 올바르지 않습니다.");
  }
  // Mirror push_subscriptions_endpoint_shape_chk exactly (^https:// and 12..2048
  // characters), so a malformed endpoint is a 400 here instead of a CHECK
  // violation surfacing as a 500 from the upsert.
  if (!endpoint.startsWith("https://") || endpoint.length < 12) {
    return badRequest("허용되지 않는 엔드포인트입니다.");
  }

  // Service role rather than the user client: `endpoint` is globally unique, so
  // a shared device can leave behind a row owned by a different account. Under
  // RLS the ON CONFLICT would fail instead of reassigning the row. user_id
  // always comes from the verified session and never from the request body.
  const admin = createAdminClient();

  const { error } = await admin.from("push_subscriptions").upsert(
    {
      user_id: userId,
      endpoint,
      p256dh,
      auth,
      expiration_time: toExpirationTime(subscription.expirationTime),
      user_agent:
        request.headers.get("user-agent")?.slice(0, MAX_USER_AGENT_LENGTH) ?? null,
      // Set explicitly rather than leaning on push_subscriptions_set_updated_at:
      // that trigger is guarded by `when (old.* is distinct from new.*)`, so a
      // device re-subscribing with byte-identical keys would not refresh it.
      // last_used_at is deliberately NOT touched here — it means "last time a
      // push was actually delivered", and lib/push/send.ts owns it.
      updated_at: new Date().toISOString(),
    },
    // Requires push_subscriptions_endpoint_key (UNIQUE on endpoint alone).
    // Because user_id is in the payload, a conflicting row is RE-OWNED rather
    // than duplicated — that is the intended behaviour for a shared device.
    { onConflict: "endpoint" },
  );

  if (error) {
    console.error("[push/subscribe] upsert failed", error.message);
    return NextResponse.json({ error: "구독 저장에 실패했습니다." }, { status: 500 });
  }

  // pushsubscriptionchange hands us the endpoint that was replaced. Drop it now
  // instead of waiting for the next fan-out to earn a 410.
  const oldEndpoint = asNonEmptyString(body.oldEndpoint, MAX_ENDPOINT_LENGTH);
  let replacedRemoved = false;
  if (oldEndpoint && oldEndpoint !== endpoint) {
    const { error: deleteError } = await admin
      .from("push_subscriptions")
      .delete()
      .eq("user_id", userId)
      .eq("endpoint", oldEndpoint);
    if (deleteError) {
      // Not fatal: the new subscription is already stored, and the stale row
      // will be pruned on its next 404/410.
      console.error("[push/subscribe] stale endpoint delete failed", deleteError.message);
    } else {
      replacedRemoved = true;
    }
  }

  return NextResponse.json({ ok: true, replacedRemoved });
}

export async function DELETE(request: Request) {
  if (crossOrigin(request)) {
    return NextResponse.json({ error: "잘못된 요청입니다." }, { status: 403 });
  }

  const userId = await currentUserId();
  if (!userId) return unauthorized();

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return badRequest("잘못된 요청 형식입니다.");
  }

  const endpoint = asNonEmptyString(
    (raw as { endpoint?: unknown } | null)?.endpoint,
    MAX_ENDPOINT_LENGTH,
  );
  if (!endpoint) return badRequest("endpoint가 필요합니다.");

  const admin = createAdminClient();
  // The user_id filter is the ownership proof: a body-supplied endpoint alone
  // must never be able to delete another account's subscription.
  const { error, count } = await admin
    .from("push_subscriptions")
    .delete({ count: "exact" })
    .eq("user_id", userId)
    .eq("endpoint", endpoint);

  if (error) {
    console.error("[push/subscribe] delete failed", error.message);
    return NextResponse.json({ error: "구독 삭제에 실패했습니다." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, removed: count ?? 0 });
}
