/**
 * Owner-initiated outbound SMS (dashboard).
 *
 * POST /api/dashboard/messages/send
 *   body: { businessId: uuid, toE164: string, text: string }
 *   → { telnyxMessageId, logId } on success.
 *
 * Powers two UI affordances on the Text history pages:
 *   1. Replying verbatim into an existing thread (e.g. typing "CONFIRM" to a
 *      lead-source short code).
 *   2. Composing a brand-new message to any number.
 *
 * The body is sent EXACTLY as typed (no templating) — owners expect "CONFIRM"
 * to arrive as "CONFIRM". Sends go through the same metered helper as the
 * AiFlow worker / voice tools, so monthly caps and per-second throttles apply,
 * and we log the send to sms_outbound_log (source 'owner_manual') so it renders
 * inline with the rest of the conversation.
 *
 * Auth: getAuthUser + requireOwner(businessId). Admins may target any business
 * (matches the dashboard-chat / thread-read convention).
 */

import { z } from "zod";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getTelnyxMessagingForBusiness, sendTelnyxSms } from "@/lib/telnyx/messaging";
import { normalizeContactNumber } from "@/lib/telnyx/format";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

// A handful of manual sends a minute is plenty for a human at a keyboard and
// keeps an over-eager script (or double-click loop) from burning the SMS pool.
const SMS_SEND_RATE = { interval: 60 * 1000, maxRequests: 20 };

const bodySchema = z.object({
  businessId: z.string().uuid(),
  // Coerce whatever the owner typed into a canonical E.164 number or short
  // code (US assumed when no country code). Short codes are kept because lead
  // sources (ReferralExchange, realtor.com) text from them and owners reply
  // "CONFIRM" to them. Telnyx rejects unsupported destinations; we surface that.
  toE164: z
    .string()
    .transform((val, ctx) => {
      const result = normalizeContactNumber(val);
      if (!result.ok) {
        ctx.addIssue({ code: "custom", message: result.reason });
        return z.NEVER;
      }
      return result.value;
    }),
  text: z.string().min(1, "Message can't be empty").max(1600)
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const json = (await request.json().catch(() => null)) as unknown;
    const { businessId, toE164, text } = bodySchema.parse(json);

    if (!user.isAdmin) await requireOwner(businessId);

    const limiter = rateLimit(`dashboard-sms-send:${businessId}:${user.userId}`, SMS_SEND_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many sends, please slow down.", 429);
    }

    const db = await createSupabaseServiceClient();
    // resolveRcs: owner-composed messages are customer-facing, so RCS-eligible
    // tenants (Standard+, agent approved) send RCS-first with SMS fallback.
    const config = await getTelnyxMessagingForBusiness(businessId, db, { resolveRcs: true });

    let telnyxMessageId: string;
    let channel: "sms" | "rcs";
    try {
      ({ id: telnyxMessageId, channel } = await sendTelnyxSms(config, toE164, text, {
        meterBusinessId: businessId
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isQuota = /Monthly SMS limit|SMS quota blocked|throttled/i.test(message);
      logger.warn("dashboard-sms-send: send failed", { businessId, error: message });
      if (isQuota) {
        return errorResponse("CONFLICT", message, 409);
      }
      // Surface the underlying Telnyx failure (e.g. a rejected short code or
      // invalid destination) so the owner knows WHY it didn't send, rather than
      // a generic message. Trimmed to stay readable; the owner is trusted.
      return errorResponse(
        "INTERNAL_SERVER_ERROR",
        `Could not send: ${message}`.slice(0, 300),
        502
      );
    }

    // Best-effort durable log so the message renders in the thread. A failed
    // insert must not imply the SMS didn't go out (it did) — log and continue.
    const { data: logRow, error: logErr } = await db
      .from("sms_outbound_log")
      .insert({
        business_id: businessId,
        to_e164: toE164,
        from_e164: config.fromE164 ?? null,
        body: text,
        source: "owner_manual",
        run_id: null,
        flow_id: null,
        telnyx_message_id: telnyxMessageId,
        channel
      })
      .select("id")
      .single();
    if (logErr) {
      logger.error("dashboard-sms-send: outbound log insert failed", {
        businessId,
        error: logErr.message
      });
    }

    // `logged` tells the client whether the message will actually appear in the
    // thread. The SMS already went out and was billed, so we still return ok —
    // but when logging failed (e.g. the owner_manual migration isn't applied
    // yet) the UI must NOT navigate to a thread that would 404 on an empty
    // history, and should tell the owner it sent without being saved.
    return successResponse({ telnyxMessageId, logId: logRow?.id ?? null, logged: !logErr });
  } catch (err) {
    return handleRouteError(err);
  }
}
