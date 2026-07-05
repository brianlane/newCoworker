/**
 * POST /api/public/v1/messages — send an SMS through the tenant's number.
 *
 * The Zapier "Send SMS" action (and any other API client) lands here.
 * Reuses the exact metered send path as the dashboard compose box
 * (sendTelnyxSms with meterBusinessId), so monthly caps and per-second
 * throttles apply identically, and logs to sms_outbound_log with
 * source 'api' so the message renders in the owner's thread view.
 *
 * Auth: `Authorization: Bearer nck_…` (public API key). No session, no CSRF.
 */

import { z } from "zod";
import { authenticatePublicApiRequest } from "@/lib/public-api/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getTelnyxMessagingForBusiness, sendTelnyxSms } from "@/lib/telnyx/messaging";
import { normalizeContactNumber } from "@/lib/telnyx/format";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

// Zaps can loop (trigger → send → trigger …); a per-business ceiling above
// the dashboard's human rate but below anything that could drain a monthly
// SMS pool in one runaway hour.
const API_SMS_SEND_RATE = { interval: 60 * 1000, maxRequests: 60 };

const bodySchema = z.object({
  to: z.string().transform((val, ctx) => {
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
    const auth = await authenticatePublicApiRequest(request);
    if (!auth) return errorResponse("UNAUTHORIZED", "Invalid or missing API key");
    const { businessId } = auth;

    const json = (await request.json().catch(() => null)) as unknown;
    const { to, text } = bodySchema.parse(json);

    const limiter = rateLimit(`public-api-sms:${businessId}`, API_SMS_SEND_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Rate limit exceeded, retry shortly.", 429);
    }

    const db = await createSupabaseServiceClient();
    // resolveRcs: API sends are customer-facing, same as dashboard compose.
    const config = await getTelnyxMessagingForBusiness(businessId, db, { resolveRcs: true });

    let telnyxMessageId: string;
    let channel: "sms" | "rcs";
    try {
      ({ id: telnyxMessageId, channel } = await sendTelnyxSms(config, to, text, {
        meterBusinessId: businessId
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isQuota = /Monthly SMS limit|SMS quota blocked|throttled/i.test(message);
      logger.warn("public-api sms send failed", { businessId, error: message });
      if (isQuota) return errorResponse("CONFLICT", message, 409);
      return errorResponse(
        "INTERNAL_SERVER_ERROR",
        `Could not send: ${message}`.slice(0, 300),
        502
      );
    }

    // Best-effort log — the SMS already went out; a failed insert only means
    // the thread view misses the row (same policy as dashboard compose).
    const { data: logRow, error: logErr } = await db
      .from("sms_outbound_log")
      .insert({
        business_id: businessId,
        to_e164: to,
        from_e164: config.fromE164 ?? null,
        body: text,
        source: "api",
        run_id: null,
        flow_id: null,
        telnyx_message_id: telnyxMessageId,
        channel
      })
      .select("id")
      .single();
    if (logErr) {
      logger.error("public-api sms: outbound log insert failed", {
        businessId,
        error: logErr.message
      });
    }

    return successResponse({
      message_id: telnyxMessageId,
      log_id: logRow?.id ?? null,
      channel
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
