/**
 * Scheduled outbound SMS (Standard/Enterprise perk).
 *
 * GET  /api/dashboard/messages/schedule?businessId=…  → { scheduled: [...] }
 *   Upcoming (pending) sends plus the most recent dispatched ones.
 * POST /api/dashboard/messages/schedule
 *   body: { businessId: uuid, toE164: string, text: string, sendAt: ISO }
 *   → { scheduled } (queued row). Dispatch happens in the scheduled-sms-sweep
 *   Edge cron (every minute); sends are metered against the monthly SMS cap
 *   at dispatch time, exactly like an immediate send.
 *
 * Auth: getAuthUser + requireBusinessRole(businessId, "operate_messages"). Admins may target any
 * business (messages-send convention).
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { normalizeContactNumber } from "@/lib/telnyx/format";
import {
  SCHEDULED_SMS_MAX_DAYS_AHEAD,
  SMS_TOOLS_UPGRADE_MESSAGE,
  smsToolsAllowedForBusiness
} from "@/lib/plans/sms-tools";

export const dynamic = "force-dynamic";

// Queuing is cheap but each queued row becomes a metered send; keep a human
// pace and stop a runaway script from stuffing the queue.
const SCHEDULE_RATE = { interval: 60 * 1000, maxRequests: 20 };

const createSchema = z.object({
  businessId: z.string().uuid(),
  toE164: z.string().transform((val, ctx) => {
    const result = normalizeContactNumber(val);
    if (!result.ok) {
      ctx.addIssue({ code: "custom", message: result.reason });
      return z.NEVER;
    }
    return result.value;
  }),
  // Persisted UNTRIMMED to match the immediate-send route: bodies are labeled
  // "sent verbatim" in the composer, so scheduling must not alter whitespace
  // that an immediate send of the same content would keep.
  text: z
    .string()
    .max(1600)
    .refine((v) => v.trim().length > 0, "Message can't be empty"),
  sendAt: z.string().transform((val, ctx) => {
    const ms = Date.parse(val);
    if (!Number.isFinite(ms)) {
      ctx.addIssue({ code: "custom", message: "sendAt must be a valid date-time" });
      return z.NEVER;
    }
    return new Date(ms);
  })
});

export async function GET(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const businessId = new URL(request.url).searchParams.get("businessId") ?? "";
    if (!z.string().uuid().safeParse(businessId).success) {
      return errorResponse("VALIDATION_ERROR", "businessId must be a UUID");
    }
    if (!user.isAdmin) await requireBusinessRole(businessId, "operate_messages");

    const db = await createSupabaseServiceClient();
    // Pending soonest-first so a deep queue never hides what dispatches next
    // (a descending-only cap would drop the soonest rows), plus a short tail
    // of recent dispatched/canceled rows for context.
    const [pendingRes, historyRes] = await Promise.all([
      db
        .from("scheduled_sms")
        .select("id, to_e164, body, send_at, status, error, created_at, sent_at")
        .eq("business_id", businessId)
        .eq("status", "pending")
        .order("send_at", { ascending: true })
        .limit(50),
      db
        .from("scheduled_sms")
        .select("id, to_e164, body, send_at, status, error, created_at, sent_at")
        .eq("business_id", businessId)
        .neq("status", "pending")
        .order("send_at", { ascending: false })
        .limit(10)
    ]);
    if (pendingRes.error) return errorResponse("DB_ERROR", pendingRes.error.message);
    if (historyRes.error) return errorResponse("DB_ERROR", historyRes.error.message);

    return successResponse({
      scheduled: [...(pendingRes.data ?? []), ...(historyRes.data ?? [])]
    });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const json = (await request.json().catch(() => null)) as unknown;
    const { businessId, toE164, text, sendAt } = createSchema.parse(json);

    if (!user.isAdmin) await requireBusinessRole(businessId, "operate_messages");

    const limiter = rateLimit(`dashboard-sms-schedule:${businessId}:${user.userId}`, SCHEDULE_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many scheduled sends, please slow down.", 429);
    }

    // At least a minute out (that's the sweep cadence — "now" belongs on the
    // immediate-send path) and no more than SCHEDULED_SMS_MAX_DAYS_AHEAD.
    const now = Date.now();
    if (sendAt.getTime() < now + 60 * 1000) {
      return errorResponse(
        "VALIDATION_ERROR",
        "Send time must be at least a minute from now; use Send for immediate messages."
      );
    }
    if (sendAt.getTime() > now + SCHEDULED_SMS_MAX_DAYS_AHEAD * 24 * 60 * 60 * 1000) {
      return errorResponse(
        "VALIDATION_ERROR",
        `Send time can't be more than ${SCHEDULED_SMS_MAX_DAYS_AHEAD} days out.`
      );
    }

    const db = await createSupabaseServiceClient();
    if (!(await smsToolsAllowedForBusiness(businessId, db))) {
      return errorResponse("FORBIDDEN", SMS_TOOLS_UPGRADE_MESSAGE);
    }

    const { data, error } = await db
      .from("scheduled_sms")
      .insert({
        business_id: businessId,
        to_e164: toE164,
        body: text,
        send_at: sendAt.toISOString()
      })
      .select("id, to_e164, body, send_at, status, created_at")
      .single();
    if (error) return errorResponse("DB_ERROR", error.message);

    return successResponse({ scheduled: data }, 201);
  } catch (err) {
    return handleRouteError(err);
  }
}
