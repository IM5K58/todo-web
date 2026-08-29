import "server-only";

import webpush from "web-push";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Web Push fan-out.
 *
 * Server-only: this module reads VAPID_PRIVATE_KEY and (through
 * createAdminClient) SUPABASE_SERVICE_ROLE_KEY. The `server-only` import makes
 * any accidental client import a build error rather than a leaked secret.
 *
 * Schema of record: push_subscriptions(
 *   id, user_id, endpoint, p256dh, auth, expiration_time,
 *   user_agent, created_at, updated_at, last_used_at
 * )
 */

export interface PushMessage {
  title: string;
  body: string;
  /** Path the service worker opens on notificationclick. Defaults to "/". */
  url?: string;
  /** Coalescing tag so repeat nudges replace rather than stack. */
  tag?: string;
  icon?: string;
  badge?: string;
}

export interface PushFanoutResult {
  /** Rows found for the user before sending. */
  subscriptions: number;
  /** Endpoints the push service accepted. */
  sent: number;
  /** Endpoints that failed for any reason (including the pruned ones). */
  failed: number;
  /** Rows deleted because the push service reported 404/410. */
  removed: number;
}

export const EMPTY_FANOUT: PushFanoutResult = {
  subscriptions: 0,
  sent: 0,
  failed: 0,
  removed: 0,
};

/**
 * Thrown when VAPID env vars are missing/invalid. This is a total, permanent
 * outage — distinct from a per-device delivery failure — so callers can report
 * it instead of silently pretending the notification went out.
 */
export class PushConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushConfigurationError";
  }
}

interface DeliverableSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

let vapidConfigured = false;

export function isPushConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim() &&
      process.env.VAPID_PRIVATE_KEY?.trim() &&
      process.env.VAPID_SUBJECT?.trim(),
  );
}

function configureWebPush(): void {
  if (vapidConfigured) return;

  // Trim: a key pasted with a trailing newline produces a signature the push
  // service rejects with an opaque 400 on every send.
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.VAPID_SUBJECT?.trim();

  if (!publicKey || !privateKey || !subject) {
    throw new PushConfigurationError(
      "VAPID 설정이 없습니다. NEXT_PUBLIC_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT를 확인하세요.",
    );
  }
  if (!subject.startsWith("mailto:") && !subject.startsWith("https://")) {
    throw new PushConfigurationError(
      "VAPID_SUBJECT는 mailto: 또는 https:// 로 시작해야 합니다.",
    );
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
  vapidConfigured = true;
}

/**
 * web-push rejects with a WebPushError carrying `statusCode`. Duck-type it
 * rather than importing the class as a value: the error may also come from a
 * wrapped/proxied module instance, where `instanceof` silently fails.
 */
function statusCodeOf(error: unknown): number | undefined {
  if (error && typeof error === "object" && "statusCode" in error) {
    const code = (error as { statusCode?: unknown }).statusCode;
    if (typeof code === "number") return code;
  }
  return undefined;
}

/**
 * 404 Not Found - the endpoint never existed or was garbage collected.
 * 410 Gone      - the user unsubscribed, cleared site data, or removed the PWA.
 * Both are permanent; every future fan-out to this row is a guaranteed failure.
 * Any other status (400, 413, 429, 5xx) is transient or a payload problem —
 * log it, keep the row.
 */
function isGone(status: number | undefined): boolean {
  return status === 404 || status === 410;
}

function buildPayload(message: PushMessage): string {
  return JSON.stringify({
    title: message.title,
    body: message.body,
    url: message.url ?? "/",
    tag: message.tag,
    icon: message.icon,
    badge: message.badge,
  });
}

/**
 * Fan a notification out to every device the user has registered.
 *
 * Never throws for a delivery failure — a single dead endpoint must not fail
 * the caller's request. Throws only for configuration problems
 * (PushConfigurationError) or when the subscription lookup itself fails.
 */
export async function sendPushToUser(
  userId: string,
  message: PushMessage,
): Promise<PushFanoutResult> {
  configureWebPush();

  const admin = createAdminClient();

  const { data, error } = await admin
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .eq("user_id", userId);

  if (error) {
    throw new Error(`푸시 구독 조회 실패: ${error.message}`);
  }

  // Defensive narrowing: a row missing either key cannot be encrypted, and
  // web-push would throw synchronously inside the map.
  const rows: DeliverableSubscription[] = (data ?? []).filter(
    (row): row is DeliverableSubscription =>
      typeof row.endpoint === "string" &&
      row.endpoint.length > 0 &&
      typeof row.p256dh === "string" &&
      row.p256dh.length > 0 &&
      typeof row.auth === "string" &&
      row.auth.length > 0,
  );

  if (rows.length === 0) {
    return { ...EMPTY_FANOUT, subscriptions: (data ?? []).length };
  }

  const payload = buildPayload(message);

  const outcomes = await Promise.all(
    rows.map(async (row) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: row.endpoint,
            keys: { p256dh: row.p256dh, auth: row.auth },
          },
          payload,
          {
            // A nudge is worthless a day later; TTL 0 would drop it whenever
            // the phone is briefly offline, so cap at 24h instead.
            TTL: 60 * 60 * 24,
            // "high" asks the push service to wake the device promptly, which
            // iOS in particular needs for the notification to appear at all.
            urgency: "high",
            // Socket timeout: without it a hung push service holds the route
            // handler open until the platform's own request timeout.
            timeout: 10_000,
          },
        );
        return { endpoint: row.endpoint, ok: true, gone: false };
      } catch (cause) {
        const status = statusCodeOf(cause);
        if (isGone(status)) {
          return { endpoint: row.endpoint, ok: false, gone: true };
        }
        console.error("[push] delivery failed", {
          endpoint: row.endpoint.slice(0, 64),
          status,
          message: cause instanceof Error ? cause.message : String(cause),
        });
        return { endpoint: row.endpoint, ok: false, gone: false };
      }
    }),
  );

  const staleEndpoints = outcomes.filter((o) => o.gone).map((o) => o.endpoint);
  const liveEndpoints = outcomes.filter((o) => o.ok).map((o) => o.endpoint);

  let removed = 0;
  if (staleEndpoints.length > 0) {
    // Scope the delete by user_id as well: `endpoint` is globally unique, but
    // an id from a verified session is the only thing that should ever select
    // rows under the service role.
    const { error: deleteError, count } = await admin
      .from("push_subscriptions")
      .delete({ count: "exact" })
      .eq("user_id", userId)
      .in("endpoint", staleEndpoints);

    if (deleteError) {
      console.error("[push] pruning stale subscriptions failed", deleteError.message);
    } else {
      removed = count ?? staleEndpoints.length;
    }
  }

  if (liveEndpoints.length > 0) {
    const { error: touchError } = await admin
      .from("push_subscriptions")
      .update({ last_used_at: new Date().toISOString() })
      .eq("user_id", userId)
      .in("endpoint", liveEndpoints);

    // Bookkeeping only — a failure here must not affect the caller's result.
    if (touchError) {
      console.error("[push] last_used_at touch failed", touchError.message);
    }
  }

  return {
    subscriptions: rows.length,
    sent: liveEndpoints.length,
    failed: outcomes.filter((o) => !o.ok).length,
    removed,
  };
}

/**
 * Fan out to several users at once. Per-user failures are absorbed the same way
 * per-device failures are; the aggregate counts still add up.
 */
export async function sendPushToUsers(
  userIds: string[],
  message: PushMessage,
): Promise<PushFanoutResult> {
  const unique = Array.from(new Set(userIds));
  const results = await Promise.all(
    unique.map(async (id) => {
      try {
        return await sendPushToUser(id, message);
      } catch (cause) {
        console.error("[push] fan-out failed for user", {
          userId: id,
          message: cause instanceof Error ? cause.message : String(cause),
        });
        return EMPTY_FANOUT;
      }
    }),
  );

  return results.reduce<PushFanoutResult>(
    (acc, r) => ({
      subscriptions: acc.subscriptions + r.subscriptions,
      sent: acc.sent + r.sent,
      failed: acc.failed + r.failed,
      removed: acc.removed + r.removed,
    }),
    { ...EMPTY_FANOUT },
  );
}
