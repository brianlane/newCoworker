import { z } from "zod";
import {
  agentToolDisabledResponse,
  gatewayBusinessGuard,
  parseVoiceToolRequest,
  voiceToolResponse,
  voiceToolValidationError
} from "@/lib/voice-tools/common";
import { findCalendarSlots } from "@/lib/calendar-tools/handlers";

/**
 * `calendar_find_slots` — voice-bridge adapter. Gemini Live sends
 * natural-ish args (`purpose`, `earliest`, `latest`); the shared core in
 * src/lib/calendar-tools/handlers.ts (also used by the Rowboat tool
 * webhook for the dashboard + texting surfaces) translates them into the
 * strict FreeBusy / Graph window and returns up to 3 free ranges.
 *
 * If no calendar is connected the core returns `calendar_not_connected` so
 * Gemini Live can gracefully offer "I'll have the owner call you back".
 */

const argsSchema = z.object({
  purpose: z.string().max(200).optional(),
  earliest: z.string().optional(),
  latest: z.string().optional(),
  durationMinutes: z.number().int().min(5).max(480).default(30),
  timezone: z.string().optional(),
  // Vagaro connections only: explicit service to search.
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
    "calendar_find_slots"
  );
  if (disabled) return disabled;

  const parsed = argsSchema.safeParse(envelope.args);
  if (!parsed.success) {
    return voiceToolValidationError(parsed.error.issues[0]?.message ?? "invalid args");
  }

  const result = await findCalendarSlots(envelope.businessId, parsed.data);
  return voiceToolResponse(result, result.detail === "calendar_lookup_failed" ? 500 : 200);
}
