import { z } from "zod";
import {
  gatewayGuard,
  parseVoiceToolRequest,
  voiceToolResponse,
  voiceToolValidationError
} from "@/lib/voice-tools/common";
import { resolveCalendarConnection } from "@/lib/voice-tools/connections";
import { nangoProxyForBusiness } from "@/lib/nango/workspace";
import { logger } from "@/lib/logger";

/**
 * `calendar_book_appointment` — creates an event on the first connected
 * calendar. Matches the bridge's function-declaration contract: the model
 * passes `attendee*` fields, which we translate into the provider payloads.
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

  const parsed = argsSchema.safeParse(envelope.args);
  if (!parsed.success) {
    return voiceToolValidationError(parsed.error.issues[0]?.message ?? "invalid args");
  }
  const args = parsed.data;

  if (new Date(args.endIso).getTime() <= new Date(args.startIso).getTime()) {
    return voiceToolResponse({ ok: false, detail: "invalid_window" });
  }

  try {
    const conn = await resolveCalendarConnection(envelope.businessId);
    if (!conn) {
      return voiceToolResponse({ ok: false, detail: "calendar_not_connected" });
    }

    const phoneFallback = args.attendeePhone ?? envelope.callerE164 ?? "";
    const descriptionLines = [
      args.notes ?? "",
      `Attendee: ${args.attendeeName}`,
      phoneFallback ? `Phone: ${phoneFallback}` : "",
      args.attendeeEmail ? `Email: ${args.attendeeEmail}` : ""
    ].filter((line) => line && line.trim().length > 0);
    const description = descriptionLines.join("\n");

    let eventId: string | null = null;
    let htmlLink: string | null = null;

    if (conn.provider === "google") {
      const res = await nangoProxyForBusiness(
        envelope.businessId,
        { connectionId: conn.connectionId, providerConfigKey: conn.providerConfigKey },
        {
          endpoint: "/calendar/v3/calendars/primary/events",
          method: "POST",
          data: {
            summary: args.summary,
            description: description || undefined,
            start: { dateTime: args.startIso, timeZone: args.timezone ?? "UTC" },
            end: { dateTime: args.endIso, timeZone: args.timezone ?? "UTC" },
            attendees: args.attendeeEmail
              ? [{ email: args.attendeeEmail, displayName: args.attendeeName }]
              : undefined
          }
        }
      );
      if (!res) return voiceToolResponse({ ok: false, detail: "calendar_not_connected" });
      const data = res.data as { id?: string; htmlLink?: string };
      eventId = data?.id ?? null;
      htmlLink = data?.htmlLink ?? null;
    } else {
      const res = await nangoProxyForBusiness(
        envelope.businessId,
        { connectionId: conn.connectionId, providerConfigKey: conn.providerConfigKey },
        {
          endpoint: "/v1.0/me/events",
          method: "POST",
          data: {
            subject: args.summary,
            body: { contentType: "Text", content: description || args.summary },
            start: { dateTime: args.startIso, timeZone: args.timezone ?? "UTC" },
            end: { dateTime: args.endIso, timeZone: args.timezone ?? "UTC" },
            attendees: args.attendeeEmail
              ? [
                  {
                    emailAddress: { address: args.attendeeEmail, name: args.attendeeName },
                    type: "required"
                  }
                ]
              : undefined
          }
        }
      );
      if (!res) return voiceToolResponse({ ok: false, detail: "calendar_not_connected" });
      const data = res.data as { id?: string; webLink?: string };
      eventId = data?.id ?? null;
      htmlLink = data?.webLink ?? null;
    }

    return voiceToolResponse({
      ok: true,
      data: { eventId, htmlLink, provider: conn.provider }
    });
  } catch (err) {
    logger.warn("voice-tools/calendar.book failed", {
      businessId: envelope.businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return voiceToolResponse({ ok: false, detail: "calendar_book_failed" }, 500);
  }
}
