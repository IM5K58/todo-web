import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import {
  PushConfigurationError,
  sendPushToUser,
  type PushFanoutResult,
} from "@/lib/push/send";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * POST /api/cron/auto-nudge — 자동 리마인더 발송기.
 *
 * WHO CALLS THIS
 * --------------
 * Supabase `pg_cron` fires every 5 minutes (UTC) and calls a SECURITY DEFINER
 * dispatcher that POSTs here through `pg_net` with
 *
 *     Authorization: Bearer <CRON_SECRET>
 *
 * Vercel Cron is NOT used: on the Hobby plan a cron expression that runs more
 * than once a day fails deployment outright, and the one daily run it does
 * allow has ±59 minutes of jitter. "21시에 알려줘" cannot be built on that.
 *
 * WHAT IT DOES
 * ------------
 * All of the decision-making lives in `public.run_auto_nudges()`:
 *   - which users are due right now IN THEIR OWN TIMEZONE,
 *   - the one-reminder-per-local-day guard (`profiles.auto_nudge_last_on`),
 *   - the advisory lock that makes two overlapping scheduler runs safe,
 *   - and the `nudges` row itself (`source='auto'`, `from_user_id=null`).
 *
 * This route does exactly two things the database cannot: it authenticates the
 * caller, and it runs the Web Push fan-out. It deliberately reads NOTHING from
 * the request body — there is no user-supplied target anywhere in this file, so
 * even a leaked secret cannot be used to notify a chosen victim. The worst a
 * leaked secret buys an attacker is making today's already-due reminders fire a
 * few minutes early, once.
 *
 * DELIVERY SEMANTICS: at-most-once, on purpose.
 * `run_auto_nudges()` commits the claim (the nudges row + `auto_nudge_last_on`)
 * before this process sends anything. If the fan-out dies in between, that
 * user loses today's reminder rather than getting it twice tomorrow morning.
 * For a reminder that is the right trade — but it means "the scheduler retries"
 * is true only for a request that never reached the RPC at all.
 *
 * ⚠️ THREE PLACES MUST AGREE — 0003's commented setup block uses older names.
 * `supabase/migrations/0003_auto_nudge.sql` §12 is written against a draft that
 * called this route `/api/cron/reminders` and its secret `REMINDER_CRON_SECRET`,
 * and told the route to answer 404. The shipped route is:
 *
 *   path   /api/cron/auto-nudge     (not /api/cron/reminders)
 *   env    CRON_SECRET              (not REMINDER_CRON_SECRET)
 *   fail   401                      (not 404)
 *
 * So the Vault secret in 0003 §12 [2단계] must hold the full URL
 * `https://<앱주소>/api/cron/auto-nudge`, and the value in Vercel must be
 * `CRON_SECRET`. Getting this wrong is a silent outage: pg_net fires every five
 * minutes, gets a 401 or a 404, and records it in a table that is purged after
 * six hours. Nothing in the app ever tells you.
 *
 * ⚠️ proxy.ts MUST EXEMPT THIS PATH.
 * `proxy.ts` matches `/api/*` on purpose and answers 401 for any API request
 * with no session cookie (proxy.ts:129-135). A machine-to-machine POST has no
 * cookie, so without an exemption every single tick is rejected before this
 * handler ever runs. The matcher's negative lookahead needs `api/cron/` added:
 *   '/((?!api/cron/|_next/static|_next/image|…).*)'
 * That file is owned elsewhere; if reminders never arrive, check that first.
 */

// node:crypto (timingSafeEqual) and web-push both require the Node runtime.
export const runtime = "nodejs";
// Never statically optimized, never cached: this must execute on every call.
export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Shape of one row from `public.run_auto_nudges()`. */
interface AutoNudgeRow {
  out_to_user_id: string;
  out_group_id: string;
  out_pending_count: number;
}

/**
 * Lock-screen copy.
 *
 * A manual 콕 찌르기 shows text the *sender* chose to disclose. An automatic
 * reminder is generated from the recipient's own private task list, and push
 * notifications render on a locked screen, on a paired watch, and while
 * mirroring to a TV or a car display.
 *
 * So: a bare count and nothing else. NEVER a `tasks.title`, never a group
 * name, never another member's display_name, and never a URL carrying a task
 * or group UUID (notification data survives in the service worker and in OS
 * logs). In particular, do not "make the body nicer" by re-querying `tasks`
 * here — that is exactly how task titles end up on a stranger's screen.
 */
const NOTIFICATION_TITLE = "오늘 할 일이 남았어요";
const NOTIFICATION_URL = "/";
/**
 * A CONSTANT tag, not `auto-nudge-${uuid}`. app/sw.ts sets `renotify: true`,
 * which requires a tag; a constant one makes a repeat reminder replace the
 * previous entry instead of stacking up on the lock screen.
 */
const NOTIFICATION_TAG = "auto-nudge";

function notificationBody(pendingCount: number): string {
  if (!Number.isFinite(pendingCount) || pendingCount <= 0) {
    return "아직 못 끝낸 할 일이 있어요.";
  }
  return `아직 ${pendingCount}개 남았어요.`;
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/**
 * The shared secret, or null when it is missing/blank.
 *
 * Read at request time, not at module scope: a module-level read is captured
 * during the build, and an env var added in the dashboard afterwards would
 * never take effect.
 */
function expectedSecret(): string | null {
  const raw = process.env.CRON_SECRET;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Header only. NEVER a query string: URLs land in access logs, Referer
 * headers, and browser history, and rotating a secret that has been logged is
 * a lot harder than never logging it.
 */
function presentedSecret(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match?.[1]) return match[1].trim();
  }
  // Fallback for schedulers that cannot set Authorization.
  const direct = request.headers.get("x-cron-secret");
  if (direct && direct.trim()) return direct.trim();
  return null;
}

/**
 * Constant-time comparison.
 *
 * `timingSafeEqual` THROWS on a length mismatch, so comparing the raw strings
 * would both crash on a wrong-length guess and leak the correct length through
 * the difference between a 500 and a 401. Hashing first makes both sides
 * exactly 32 bytes, so length never enters into it.
 */
function secretMatches(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

function unauthorized() {
  return NextResponse.json(
    { ok: false, error: "unauthorized" },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}

// ---------------------------------------------------------------------------
// RPC result normalisation
// ---------------------------------------------------------------------------

/**
 * `returns table (...)` comes back as a row set, but depending on how the
 * client models it we may get the array or a lone object. Normalise both, and
 * drop anything that does not carry the two ids we need — a malformed row must
 * skip that user, not throw and abandon everyone else in the batch.
 */
function normalizeRows(data: unknown): AutoNudgeRow[] {
  const raw = Array.isArray(data) ? data : data ? [data] : [];
  const rows: AutoNudgeRow[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Partial<AutoNudgeRow>;
    if (typeof candidate.out_to_user_id !== "string" || !candidate.out_to_user_id) {
      continue;
    }
    rows.push({
      out_to_user_id: candidate.out_to_user_id,
      out_group_id:
        typeof candidate.out_group_id === "string" ? candidate.out_group_id : "",
      out_pending_count:
        typeof candidate.out_pending_count === "number"
          ? candidate.out_pending_count
          : 0,
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  const startedAt = Date.now();

  // Fail CLOSED. An unset or blank CRON_SECRET rejects every request; it must
  // never fall back to "no secret configured, so let everyone in".
  const secret = expectedSecret();
  if (!secret) {
    console.error(
      "[auto-nudge] CRON_SECRET is not set — every scheduler call is being rejected.",
    );
    return unauthorized();
  }

  const presented = presentedSecret(request);
  if (!presented || !secretMatches(presented, secret)) {
    return unauthorized();
  }

  // ---- authenticated ------------------------------------------------------

  let rows: AutoNudgeRow[];
  try {
    const admin = createAdminClient();
    // No arguments, by design: the function derives every recipient from
    // auth-free server state. There is nothing here for a caller to steer.
    const { data, error } = await admin.rpc("run_auto_nudges");

    if (error) {
      console.error("[auto-nudge] run_auto_nudges rpc failed", {
        code: error.code,
        message: error.message,
      });
      return NextResponse.json(
        { ok: false, error: "rpc_failed" },
        { status: 500, headers: { "Cache-Control": "no-store" } },
      );
    }

    rows = normalizeRows(data);
  } catch (cause) {
    // createAdminClient() throws when SUPABASE_SERVICE_ROLE_KEY is missing.
    console.error("[auto-nudge] could not reach the database", {
      message: cause instanceof Error ? cause.message : String(cause),
    });
    return NextResponse.json(
      { ok: false, error: "database_unavailable" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }

  // ~284 of the 288 daily ticks land here. The dispatcher in Postgres already
  // short-circuits before making the HTTP call when nobody is due, so this is
  // the second line of defence, not the first.
  if (rows.length === 0) {
    return NextResponse.json(
      {
        ok: true,
        claimed: 0,
        reminded: 0,
        delivered: 0,
        failed: 0,
        removed: 0,
        durationMs: Date.now() - startedAt,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  let delivered = 0;
  let failedUsers = 0;
  let sentEndpoints = 0;
  let failedEndpoints = 0;
  let removedEndpoints = 0;
  /** Set once VAPID is found to be misconfigured — a total outage, not a hiccup. */
  let configError = false;

  // Sequential, not Promise.all: a 3-6 person group makes concurrency
  // pointless, and serial sends keep this well inside any request timeout
  // while making the logs readable when one user's delivery misbehaves.
  for (const row of rows) {
    if (configError) {
      // Every subsequent send would throw the same PushConfigurationError.
      failedUsers += 1;
      continue;
    }

    try {
      const result: PushFanoutResult = await sendPushToUser(row.out_to_user_id, {
        title: NOTIFICATION_TITLE,
        body: notificationBody(row.out_pending_count),
        url: NOTIFICATION_URL,
        tag: NOTIFICATION_TAG,
      });

      sentEndpoints += result.sent;
      failedEndpoints += result.failed;
      removedEndpoints += result.removed;
      if (result.sent > 0) {
        delivered += 1;
      } else {
        // The reminder was claimed in the database but reached no device —
        // usually because the user enabled reminders without ever granting
        // push permission (very common on iOS outside a Home Screen app).
        failedUsers += 1;
      }
    } catch (cause) {
      // One user's failure must never fail the batch or the response.
      failedUsers += 1;
      if (cause instanceof PushConfigurationError) {
        configError = true;
        console.error("[auto-nudge] VAPID configuration is broken", cause.message);
      } else {
        console.error("[auto-nudge] fan-out failed for one user", {
          // Never log the whole uuid alongside anything else identifying.
          userId: row.out_to_user_id.slice(0, 8),
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
  }

  // 200 even when some users failed: the rows are already claimed, the
  // scheduler has nothing useful to do with a 500, and pg_net would only
  // record the status in a table that is purged after six hours anyway.
  return NextResponse.json(
    {
      ok: true,
      /** Users the database handed us this tick. */
      claimed: rows.length,
      /** Users whose reminder reached at least one device. */
      reminded: delivered,
      /** Users we could not deliver to at all. */
      unreachable: failedUsers,
      /** Endpoint-level totals from the push fan-out. */
      delivered: sentEndpoints,
      failed: failedEndpoints,
      removed: removedEndpoints,
      configError,
      durationMs: Date.now() - startedAt,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Only POST is exported on purpose. A GET endpoint that sends notifications is
 * one link preview, one prefetch, or one crawler away from firing by accident;
 * anything else on this path answers 405.
 */
