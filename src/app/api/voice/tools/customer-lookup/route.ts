/**
 * `customer_lookup_by_phone` voice tool (Phase 5).
 *
 * Lets the on-call agent probe customer_memories for the current
 * caller (or another phone the caller mentions, e.g. "look up my
 * husband, his number is …"). Returns a compact summary the model
 * can speak aloud or condition its next response on. Never returns
 * pinned_md verbatim — that's owner-private context the agent uses
 * for steering, not for read-back.
 *
 * Auth: ROWBOAT_GATEWAY_TOKEN bearer (same as every other
 * /api/voice/tools/* adapter; the bridge forwards on the VPS).
 *
 * Failure modes:
 *   - phone not in E.164 format → invalid_args
 *   - customer not found        → ok:true, data.found:false
 *   - DB error                  → ok:false, detail:"internal_error"
 */

import { z } from "zod";
import {
  agentToolDisabledResponse,
  gatewayGuard,
  parseVoiceToolRequest,
  voiceToolResponse,
  voiceToolValidationError
} from "@/lib/voice-tools/common";
import { getCustomerMemory } from "@/lib/customer-memory/db";
import { logger } from "@/lib/logger";

const argsSchema = z.object({
  /** E.164 phone to look up. When omitted the bridge defaults to envelope.callerE164. */
  phone: z.string().regex(/^\+[1-9]\d{6,15}$/).optional()
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

  const disabled = await agentToolDisabledResponse(
    envelope.businessId,
    "voice",
    "customer_lookup_by_phone"
  );
  if (disabled) return disabled;

  const parsed = argsSchema.safeParse(envelope.args);
  if (!parsed.success) {
    return voiceToolValidationError(parsed.error.issues[0]?.message ?? "invalid args");
  }
  const phone = parsed.data.phone ?? envelope.callerE164;
  if (!phone) {
    return voiceToolValidationError("missing phone (and no callerE164 in envelope)");
  }
  // Even when callerE164 came from the envelope, validate the shape
  // — Telnyx has been observed to deliver "anonymous" / "" / "unknown"
  // there in spotty CNAM cases.
  if (!/^\+[1-9]\d{6,15}$/.test(phone)) {
    return voiceToolResponse({ ok: true, data: { found: false } });
  }

  try {
    const memory = await getCustomerMemory(envelope.businessId, phone);
    if (!memory) {
      return voiceToolResponse({ ok: true, data: { found: false } });
    }
    return voiceToolResponse({
      ok: true,
      data: {
        found: true,
        customer: {
          displayName: memory.display_name,
          customerE164: memory.customer_e164,
          // Voice-safe summary only — owner notes (pinned_md) stay
          // server-side; the agent uses them for steering but doesn't
          // read them back to the customer on a phone call.
          summary: memory.summary_md,
          lastChannel: memory.last_channel,
          lastInteractionAt: memory.last_interaction_at,
          totalInteractionCount: memory.total_interaction_count
        }
      }
    });
  } catch (err) {
    logger.warn("voice-tools/customer-lookup failed", {
      businessId: envelope.businessId,
      phone,
      error: err instanceof Error ? err.message : String(err)
    });
    return voiceToolResponse({ ok: false, detail: "internal_error" }, 500);
  }
}
