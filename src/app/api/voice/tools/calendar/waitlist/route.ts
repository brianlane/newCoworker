import { z } from "zod";
import {
  agentToolDisabledResponse,
  gatewayBusinessGuard,
  parseVoiceToolRequest,
  voiceToolResponse,
  voiceToolValidationError
} from "@/lib/voice-tools/common";
import { joinCalendarWaitlist } from "@/lib/calendar-tools/waitlist-join";

/**
 * `calendar_join_waitlist`, voice-bridge adapter. Puts the caller on the
 * cancellation waitlist via the shared core in
 * src/lib/calendar-tools/waitlist-join.ts (also used by the Rowboat tool
 * webhook for the dashboard + texting surfaces). The caller's number
 * backfills `attendeePhone` when the model omits it, the earlier-slot
 * offer arrives by text on that number.
 */

const argsSchema = z.object({
  attendeeName: z.string().max(200).optional(),
  attendeeEmail: z.string().email().optional(),
  attendeePhone: z.string().max(32).optional(),
  durationMinutes: z.number().int().min(5).max(480).optional(),
  latestIso: z.string().optional(),
  timezone: z.string().optional()
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
    "calendar_join_waitlist"
  );
  if (disabled) return disabled;

  const parsed = argsSchema.safeParse(envelope.args);
  if (!parsed.success) {
    return voiceToolValidationError(parsed.error.issues[0]?.message ?? "invalid args");
  }

  // The core carries its own model-facing guidance on every failure detail.
  const result = await joinCalendarWaitlist(
    envelope.businessId,
    parsed.data,
    envelope.callerE164
  );
  return voiceToolResponse(result);
}
