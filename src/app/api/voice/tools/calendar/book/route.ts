import { z } from "zod";
import {
  agentToolDisabledResponse,
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
  // offset:true — matches the tool contract ("ISO 8601 with timezone
  // offset"); the bare .datetime() rejected offset-carrying instants and
  // failed every booking the model formatted per its own instructions.
  startIso: z.string().datetime({ offset: true }),
  endIso: z.string().datetime({ offset: true }),
  summary: z.string().min(1).max(200),
  attendeeName: z.string().min(1).max(200),
  attendeeEmail: z.string().email().optional(),
  attendeePhone: z.string().max(32).optional(),
  notes: z.string().max(2000).optional(),
  timezone: z.string().optional(),
  // Vagaro connections only: explicit service to book.
  serviceId: z.string().max(120).optional()
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
