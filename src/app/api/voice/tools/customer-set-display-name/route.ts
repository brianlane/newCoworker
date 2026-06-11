/**
 * `customer_set_display_name` voice tool (Phase 5).
 *
 * The agent calls this when the caller volunteers their name on a
 * call ("Hi, this is Joe Plumber"). We persist it on the
 * customer_memories row so future channels (SMS, dashboard) recognize
 * the caller by name instead of just E.164. Idempotent — calling
 * with the same name on every call is cheap and safe.
 *
 * Boundaries:
 *   - Never overwrites a name the OWNER set via the customers UI.
 *     The PATCH /api/dashboard/customers/[customerE164] endpoint
 *     sets owner-curated names; this tool is for *agent-discovered*
 *     names only and only writes when display_name is currently
 *     null/empty. The owner's edit beats the agent's transcription
 *     every time.
 *   - Hard caps the name at 200 chars (mirrors the schema constraint
 *     in customer_memories — see migration 20260507000000).
 */

import { z } from "zod";
import {
  agentToolDisabledResponse,
  gatewayGuard,
  parseVoiceToolRequest,
  voiceToolResponse,
  voiceToolValidationError
} from "@/lib/voice-tools/common";
import { setCustomerDisplayName } from "@/lib/customer-tools/handlers";
import { logger } from "@/lib/logger";

const argsSchema = z.object({
  /**
   * Display name as the agent heard it. Accept ASCII letters / spaces /
   * common punctuation only — Gemini Live transcription occasionally
   * emits leading/trailing whitespace and punctuation, normalize here.
   */
  displayName: z.string().min(1).max(200),
  /** Optional override; defaults to envelope.callerE164. */
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
    "customer_set_display_name"
  );
  if (disabled) return disabled;

  const parsed = argsSchema.safeParse(envelope.args);
  if (!parsed.success) {
    return voiceToolValidationError(parsed.error.issues[0]?.message ?? "invalid args");
  }
  const phone = parsed.data.phone ?? envelope.callerE164;
  if (!phone || !/^\+[1-9]\d{6,15}$/.test(phone)) {
    return voiceToolValidationError("missing or invalid phone");
  }
  const displayName = parsed.data.displayName.trim();
  if (!displayName) {
    return voiceToolValidationError("displayName cannot be empty after trim");
  }

  try {
    // Shared core: force-creates the row when missing and never clobbers
    // an owner-curated name (see src/lib/customer-tools/handlers.ts).
    return voiceToolResponse(
      await setCustomerDisplayName(envelope.businessId, phone, displayName, "voice")
    );
  } catch (err) {
    logger.warn("voice-tools/customer-set-display-name failed", {
      businessId: envelope.businessId,
      phone,
      error: err instanceof Error ? err.message : String(err)
    });
    return voiceToolResponse({ ok: false, detail: "internal_error" }, 500);
  }
}
