import { z } from "zod";
import {
  gatewayGuard,
  parseVoiceToolRequest,
  voiceToolResponse,
  voiceToolValidationError
} from "@/lib/voice-tools/common";
import { getTelnyxMessagingForBusiness, sendTelnyxSms } from "@/lib/telnyx/messaging";
import { logger } from "@/lib/logger";

/**
 * `send_follow_up_sms` — sends an SMS to the caller (or another number the
 * model collected). Goes through the same metered helper as the SMS-inbound
 * worker, so monthly caps and per-second throttles apply. The adapter is
 * also our only path for "email not connected -> fall back to SMS".
 *
 * The bridge declares args as `{ toE164?, body }`; when the caller's own
 * ANI should be used, the model omits `toE164` and we fall back to
 * `envelope.callerE164`.
 */

const argsSchema = z.object({
  toE164: z.string().min(5).max(32).optional(),
  body: z.string().min(1).max(1600)
});

export async function POST(request: Request) {
  const guard = gatewayGuard(request);
  if (guard) return guard;

  let envelope;
  try {
    envelope = await parseVoiceToolRequest(request);
  } catch (err) {
    return voiceToolValidationError(
      err instanceof z.ZodError ? err.issues[0]?.message ?? "invalid envelope" : "invalid body"
    );
  }

  const parsed = argsSchema.safeParse(envelope.args);
  if (!parsed.success) {
    return voiceToolValidationError(parsed.error.issues[0]?.message ?? "invalid args");
  }
  const args = parsed.data;
  const toPhone = args.toE164 ?? envelope.callerE164 ?? "";
  if (!toPhone) {
    return voiceToolResponse({ ok: false, detail: "no_destination" });
  }

  try {
    const config = await getTelnyxMessagingForBusiness(envelope.businessId);
    try {
      const messageId = await sendTelnyxSms(config, toPhone, args.body, {
        meterBusinessId: envelope.businessId
      });
      return voiceToolResponse({ ok: true, data: { messageId, toE164: toPhone } });
    } catch (err) {
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
