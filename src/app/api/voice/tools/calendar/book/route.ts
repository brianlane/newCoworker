import { z } from "zod";
import {
  agentToolDisabledResponse,
  gatewayGuard,
  gatewayBusinessGuard,
  parseVoiceToolRequest,
  voiceToolResponse,
  voiceToolValidationError
} from "@/lib/voice-tools/common";
import { bookCalendarAppointment } from "@/lib/calendar-tools/handlers";

/**
 * `calendar_book_appointment` — voice-bridge adapter. Creates an event on
 * the first connected calendar via the shared core in
 * src/lib/calendar-tools/handlers.ts (also used by the Rowboat tool webhook
 * for the dashboard + texting surfaces). The caller's number backfills
 * `attendeePhone` when the model omits it.
 */

const argsSchema = z.object({
  startIso: z.string().datetime(),
  endIso: z.string().datetime(),
  summary: z.string().min(1).max(200),
  attendeeName: z.string().min(1).max(200),
  attendeeEmail: z.string().email().optional(),
  attendeePhone: z.string().max(32).optional(),
  notes: z.string().max(2000).optional(),
  timezone: z.string().optional()
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

  const bindGuard = await gatewayBusinessGuard(request, envelope.businessId);
  if (bindGuard) return bindGuard;

  const disabled = await agentToolDisabledResponse(
    envelope.businessId,
    "voice",
    "calendar_book_appointment"
  );
  if (disabled) return disabled;

  const parsed = argsSchema.safeParse(envelope.args);
  if (!parsed.success) {
    return voiceToolValidationError(parsed.error.issues[0]?.message ?? "invalid args");
  }

  const result = await bookCalendarAppointment(
    envelope.businessId,
    parsed.data,
    envelope.callerE164
  );
  return voiceToolResponse(result, result.detail === "calendar_book_failed" ? 500 : 200);
}
