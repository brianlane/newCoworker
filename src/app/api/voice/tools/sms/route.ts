import { z } from "zod";
import {
  agentToolDisabledResponse,
  gatewayBusinessGuard,
  parseVoiceToolRequest,
  voiceToolResponse,
  voiceToolValidationError
} from "@/lib/voice-tools/common";
import { getTelnyxMessagingForBusiness, sendTelnyxSms } from "@/lib/telnyx/messaging";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { checkSmsOptOut } from "@/lib/sms/opt-outs";
import { normalizeContactNumber } from "@/lib/telnyx/format";
import { logger } from "@/lib/logger";
import {
  deleteShortLinks,
  shortenSmsBodyUrls
} from "../../../../../../supabase/functions/_shared/sms_short_links";

/**
 * `send_follow_up_sms` — sends an SMS to the caller (or another number the
 * model collected). Goes through the same metered helper as the SMS-inbound
 * worker, so monthly caps and per-second throttles apply. The adapter is
 * also our only path for "email not connected -> fall back to SMS".
 *
 * The bridge declares args as `{ toE164?, body }`; when the caller's own
 * ANI should be used, the model omits `toE164` and we fall back to
 * `envelope.callerE164`.
 *
 * Every successful send is logged to `sms_outbound_log` (source
 * 'voice_follow_up') so it renders in the dashboard Text history like every
 * other outbound path — these used to be invisible platform-side (the only
 * record lived in Telnyx).
 */

const argsSchema = z.object({
  toE164: z.string().min(5).max(32).optional(),
  body: z.string().min(1).max(1600)
});

export async function POST(request: Request) {
  let envelope;
  try {
    envelope = await parseVoiceToolRequest(request);
  } catch (err) {
    return voiceToolValidationError(
      err instanceof z.ZodError ? err.issues[0]?.message ?? "invalid envelope" : "invalid body"
    );
  }

  const bindGuard = await gatewayBusinessGuard(request, envelope.businessId);
  if (bindGuard) return bindGuard;

  const disabled = await agentToolDisabledResponse(
    envelope.businessId,
    "voice",
    "send_follow_up_sms"
  );
  if (disabled) return disabled;

  const parsed = argsSchema.safeParse(envelope.args);
  if (!parsed.success) {
    return voiceToolValidationError(parsed.error.issues[0]?.message ?? "invalid args");
  }
  const args = parsed.data;
  const toPhoneRaw = args.toE164 ?? envelope.callerE164 ?? "";
  if (!toPhoneRaw) {
    return voiceToolResponse({ ok: false, detail: "no_destination" });
  }
  // Canonicalize BEFORE the opt-out check and the send: STOP rows are stored
  // as canonical E.164 by the inbound keyword handler, so a model-supplied
  // "602 555 0147" must not slip past the exact-match RPC just because of
  // formatting. An unnormalizable destination is refused rather than sent
  // unchecked.
  const normalized = normalizeContactNumber(toPhoneRaw);
  if (!normalized.ok) {
    return voiceToolResponse({ ok: false, detail: "invalid_destination" });
  }
  const toPhone = normalized.value;

  try {
    // STOP-list gate (fail closed, matching the Edge send paths): a caller
    // who previously texted STOP must not receive agent follow-ups either.
    const optOut = await checkSmsOptOut(envelope.businessId, toPhone);
    if (!optOut.ok) {
      logger.error("voice-tools/sms: opt-out check failed; refusing (fail closed)", {
        businessId: envelope.businessId,
        error: optOut.error
      });
      return voiceToolResponse({ ok: false, detail: "opt_out_check_failed" });
    }
    if (optOut.optedOut) {
      return voiceToolResponse({ ok: false, detail: "recipient_opted_out" });
    }

    // Customer-facing follow-up: eligible tenants send RCS-first w/ SMS fallback.
    const config = await getTelnyxMessagingForBusiness(envelope.businessId, undefined, {
      resolveRcs: true
    });

    // Tracked short links: rewrite long URLs to /s/<code> redirects so link
    // clicks are measurable (sms_links table). Fail-safe — any error leaves
    // the original URL in place and the send proceeds — and a failed send
    // below deletes the minted rows so no live redirect survives for a text
    // nobody received.
    const linksDb = await createSupabaseServiceClient();
    const shortened = await shortenSmsBodyUrls(linksDb, {
      businessId: envelope.businessId,
      text: args.body,
      source: "voice_follow_up",
      baseUrl: process.env.NEXT_PUBLIC_APP_URL,
      toE164: toPhone
    });
    const smsBody = shortened.text;

    try {
      const { id: messageId, channel } = await sendTelnyxSms(config, toPhone, smsBody, {
        meterBusinessId: envelope.businessId
      });
      // Best-effort durable log so the text renders in the dashboard thread.
      // A failed insert must not fail the tool call — the SMS already went out.
      try {
        const db = await createSupabaseServiceClient();
        const { error: logErr } = await db.from("sms_outbound_log").insert({
          business_id: envelope.businessId,
          to_e164: toPhone,
          from_e164: config.fromE164 ?? null,
          // Log the body as sent (post-shortening) so Text history matches
          // what the customer received.
          body: smsBody,
          source: "voice_follow_up",
          run_id: null,
          flow_id: null,
          telnyx_message_id: messageId,
          channel
        });
        if (logErr) throw new Error(logErr.message);
      } catch (logErr) {
        logger.error("voice-tools/sms: outbound log insert failed", {
          businessId: envelope.businessId,
          error: logErr instanceof Error ? logErr.message : String(logErr)
        });
      }
      return voiceToolResponse({ ok: true, data: { messageId, toE164: toPhone } });
    } catch (err) {
      // The text never went out — remove its tracked links (best-effort).
      await deleteShortLinks(linksDb, shortened.links);
      const message = err instanceof Error ? err.message : String(err);
      const isQuota = /Monthly SMS limit|SMS quota blocked|throttled/i.test(message);
      logger.warn("voice-tools/sms: send failed", {
        businessId: envelope.businessId,
        error: message
      });
      return voiceToolResponse({
        ok: false,
        detail: isQuota ? "sms_quota_blocked" : "sms_send_failed"
      });
    }
  } catch (err) {
    logger.warn("voice-tools/sms: unexpected error", {
      error: err instanceof Error ? err.message : String(err)
    });
    return voiceToolResponse({ ok: false, detail: "internal_error" }, 500);
  }
}
