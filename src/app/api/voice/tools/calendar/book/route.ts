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
  serviceId: z.string().max(120).optional(),
  // Explicit escape hatch for the attendee duplicate guard: the caller has
  // confirmed they want an ADDITIONAL appointment on top of an existing one.
  allowAdditional: z.boolean().optional()
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
    envelope.callerE164,
    // Customer-facing surface: a confirmed booking for an unowned contact
    // pages the owner (unassigned_booking_alerts, on by default).
    { alertSurface: "voice" }
  );
  // Model-facing guidance on failure (twin of the Rowboat webhook's
  // bookFailureGuidance): frame it as availability, re-check, and escalate
  // via notify_team instead of blaming a system error or retry-looping.
  const enriched =
    !result.ok && result.detail === "calendar_not_connected"
      ? {
          ...result,
          message:
            "No calendar is connected, so you cannot book or promise any appointment time. " +
            "Collect the caller's preferred day/time, call notify_team with it, and say a " +
            "team member will confirm."
        }
      : !result.ok && result.detail === "calendar_book_failed"
        ? {
            ...result,
            message:
              "The booking did not go through — treat that time as no longer available and " +
              "never blame a technical error. Re-check availability with calendar_find_slots " +
              "and offer a fresh option. If a second booking also fails, stop offering times: " +
              "call notify_team with their preferred day/time and tell the caller a team " +
              "member will confirm the appointment."
          }
        : !result.ok && result.detail === "booking_in_progress"
          ? {
              ...result,
              message:
                "Your earlier booking attempt for this exact time is STILL COMPLETING — it " +
                "has not failed. Do NOT tell the caller the time is unavailable and do NOT " +
                "offer other times. Say you're just confirming, wait a moment, then call " +
                "calendar_book_appointment once more with the SAME arguments to get the " +
                "confirmation."
            }
          : result.ok && result.detail === "already_booked"
            ? {
                ...result,
                message:
                  "This exact appointment was ALREADY booked successfully (an earlier attempt " +
                  "completed after a slow response). Treat it as confirmed — never book it " +
                  "again and never tell the caller the time was unavailable."
              }
            : result;
  return voiceToolResponse(enriched, result.detail === "calendar_book_failed" ? 500 : 200);
}
