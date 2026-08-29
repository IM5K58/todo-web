import "server-only";

import { NextResponse } from "next/server";

import {
  EMPTY_FANOUT,
  PushConfigurationError,
  sendPushToUser,
  type PushFanoutResult,
} from "@/lib/push/send";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/nudge — 콕 찌르기.
 *
 * Authorization (same group) and rate limiting (1/hour, 3/day per target) are
 * NOT implemented here. They live in public.send_nudge, a SECURITY DEFINER
 * function that takes an advisory lock, counts, and inserts inside a single
 * transaction. Re-checking in TypeScript would be a non-atomic check-then-act:
 * two concurrent requests both read "0 nudges this hour" and both insert.
 *
 * The RPC runs on the USER's client so auth.uid() is the caller — it is the
 * source of from_user_id. Only after it returns ok=true do we escalate to the
 * service role, and only to read the target's push subscriptions.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// nudges_message_len_chk allows 1..200 characters. Cap at the same number so
// the route never sends something the CHECK would reject, and never truncates
// at a different point than the RPC's own left(btrim(...), 200).
const MAX_MESSAGE_LENGTH = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reason codes returned by public.send_nudge when ok = false. */
const REASON_MESSAGES: Record<string, string> = {
  not_member: "같은 그룹이 아니에요",
  self_nudge: "자기 자신은 찌를 수 없어요",
  rate_limited_hour: "방금 찔렀어요. 한 시간 뒤에 다시 시도해주세요",
  rate_limited_day: "오늘은 이미 세 번 찔렀어요",
};

const REASON_STATUS: Record<string, number> = {
  not_member: 403,
  self_nudge: 400,
  rate_limited_hour: 429,
  rate_limited_day: 429,
};

interface SendNudgeRow {
  ok: boolean;
  reason: string | null;
  nudge_id: string | null;
}

interface NudgeBody {
  toUserId?: unknown;
  targetUserId?: unknown;
  to_user_id?: unknown;
  groupId?: unknown;
  group_id?: unknown;
  taskId?: unknown;
  task_id?: unknown;
  message?: unknown;
}

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * Cheap CSRF backstop; see the identical note in app/api/push/subscribe/route.ts.
 * Hosts are compared (not full origins) and the expected host comes from the
 * forwarded/Host header, because behind a proxy request.url carries the
 * internal origin and would reject every real request.
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

function readUuid(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (UUID_RE.test(trimmed)) return trimmed;
  }
  return null;
}

/**
 * `returns table (...)` comes back as a row set. Depending on how the generated
 * Database types model it, supabase-js hands us either the array or a single
 * object — normalise both rather than betting on one.
 */
function firstRow(data: unknown): SendNudgeRow | null {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") return null;
  const candidate = row as Partial<SendNudgeRow>;
  if (typeof candidate.ok !== "boolean") return null;
  return {
    ok: candidate.ok,
    reason: typeof candidate.reason === "string" ? candidate.reason : null,
    nudge_id: typeof candidate.nudge_id === "string" ? candidate.nudge_id : null,
  };
}

export async function POST(request: Request) {
  if (crossOrigin(request)) {
    return NextResponse.json({ error: "잘못된 요청입니다." }, { status: 403 });
  }

  const supabase = await createClient();
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  const callerId = claimsData?.claims.sub;

  if (claimsError || !claimsData || typeof callerId !== "string" || !callerId) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  let body: NudgeBody;
  try {
    body = (await request.json()) as NudgeBody;
  } catch {
    return badRequest("잘못된 요청 형식입니다.");
  }
  if (!body || typeof body !== "object") {
    return badRequest("잘못된 요청 형식입니다.");
  }

  const toUserId = readUuid(body.toUserId, body.targetUserId, body.to_user_id);
  if (!toUserId) return badRequest("대상이 올바르지 않습니다.");

  const groupId = readUuid(body.groupId, body.group_id);
  if (!groupId) return badRequest("그룹이 올바르지 않습니다.");

  // Optional: which task the nudge is about. Absent is fine.
  const taskId = readUuid(body.taskId, body.task_id);

  const message =
    typeof body.message === "string"
      ? body.message.trim().slice(0, MAX_MESSAGE_LENGTH)
      : "";

  // Build the args incrementally: the generated Args type may declare the
  // defaulted parameters as optional-and-not-nullable, so omit rather than
  // pass null.
  const args: {
    p_to_user_id: string;
    p_group_id: string;
    p_task_id?: string;
    p_message?: string;
  } = { p_to_user_id: toUserId, p_group_id: groupId };
  if (taskId) args.p_task_id = taskId;
  if (message) args.p_message = message;

  const { data, error } = await supabase.rpc("send_nudge", args);

  if (error) {
    // send_nudge raises 42501 when auth.uid() is null — i.e. the JWT did not
    // reach Postgres even though the cookie parsed. That is an auth problem,
    // not a server fault, so it must not read as a 500.
    if (error.code === "42501") {
      return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    }
    console.error("[nudge] send_nudge rpc failed", { code: error.code, message: error.message });
    return NextResponse.json({ error: "처리 중 오류가 발생했습니다." }, { status: 500 });
  }

  const result = firstRow(data);
  if (!result) {
    console.error("[nudge] send_nudge returned an unexpected shape");
    return NextResponse.json({ error: "처리 중 오류가 발생했습니다." }, { status: 500 });
  }

  if (!result.ok) {
    const reason = result.reason ?? "unknown";
    const status = REASON_STATUS[reason] ?? 400;
    const headers =
      status === 429 ? { "Retry-After": "3600" } : undefined;
    return NextResponse.json(
      {
        ok: false,
        reason,
        error: REASON_MESSAGES[reason] ?? "지금은 찌를 수 없어요",
      },
      { status, ...(headers ? { headers } : {}) },
    );
  }

  // ---- The nudge is recorded. Everything below is best-effort delivery. ----

  const admin = createAdminClient();

  let senderName = "친구";
  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("display_name")
    .eq("id", callerId)
    .maybeSingle();

  if (profileError) {
    console.error("[nudge] sender profile lookup failed", profileError.message);
  } else if (profile?.display_name && profile.display_name.trim()) {
    senderName = profile.display_name.trim();
  }

  let delivery: PushFanoutResult = { ...EMPTY_FANOUT };
  let deliveryError: "config" | "failed" | null = null;

  try {
    delivery = await sendPushToUser(toUserId, {
      title: `${senderName}님이 콕 찔렀어요`,
      body: message || "오늘 할 일 적었어요?",
      url: "/",
      // Collapse repeat nudges from the same sender into one notification.
      tag: `nudge-${callerId}`,
    });
  } catch (cause) {
    // The nudge row already exists and the rate limit is already spent, so a
    // delivery failure must not 500 the caller. But a configuration failure is
    // a total outage, not a hiccup — surface which one it was.
    deliveryError = cause instanceof PushConfigurationError ? "config" : "failed";
    console.error("[nudge] push fan-out failed", {
      kind: deliveryError,
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }

  return NextResponse.json({
    ok: true,
    nudgeId: result.nudge_id,
    delivered: delivery.sent > 0,
    delivery: {
      subscriptions: delivery.subscriptions,
      sent: delivery.sent,
      failed: delivery.failed,
      removed: delivery.removed,
    },
    deliveryError,
  });
}
