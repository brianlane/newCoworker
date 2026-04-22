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
 * `calendar_find_slots` — given a window and a slot size, returns up to 3
 * free time ranges for the first connected calendar. Gemini Live sends
 * natural-ish args (`purpose`, `earliest`, `latest`) because those are what
 * the model can fill from a conversation; we translate them into the strict
 * window used by the FreeBusy / Graph APIs here.
 *
 * The voice bridge expects a synchronous, low-latency answer. We keep the
 * proxy call timeboxed and only inspect the primary calendar's free/busy.
 * If no calendar is connected, we return `calendar_not_connected` so Gemini
 * Live can gracefully offer "I'll have the owner call you back" instead.
 */

const DEFAULT_SEARCH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const argsSchema = z.object({
  purpose: z.string().max(200).optional(),
  earliest: z.string().optional(),
  latest: z.string().optional(),
  durationMinutes: z.number().int().min(5).max(480).default(30),
  timezone: z.string().optional()
});

type Slot = { startIso: string; endIso: string };

type FreeBusyBody = {
  calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }>;
};

function parseOptionalDate(value: string | undefined, fallback: Date): Date {
  if (!value) return fallback;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return fallback;
  return d;
}

function computeFreeSlots(
  windowStart: Date,
  windowEnd: Date,
  busy: Array<{ start: Date; end: Date }>,
  durationMs: number,
  maxSlots = 3
): Slot[] {
  const sorted = [...busy].sort((a, b) => a.start.getTime() - b.start.getTime());
  const slots: Slot[] = [];
  let cursor = windowStart;
  for (const block of sorted) {
    if (block.start.getTime() >= windowEnd.getTime()) break;
    if (block.end.getTime() <= cursor.getTime()) continue;
    if (block.start.getTime() - cursor.getTime() >= durationMs) {
      slots.push({
        startIso: cursor.toISOString(),
        endIso: new Date(cursor.getTime() + durationMs).toISOString()
      });
      if (slots.length >= maxSlots) return slots;
    }
    if (block.end.getTime() > cursor.getTime()) {
      cursor = block.end;
    }
  }
  if (windowEnd.getTime() - cursor.getTime() >= durationMs && slots.length < maxSlots) {
    slots.push({
      startIso: cursor.toISOString(),
      endIso: new Date(cursor.getTime() + durationMs).toISOString()
    });
  }
  return slots;
}

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
  const now = new Date();
  const windowStart = parseOptionalDate(args.earliest, now);
  const windowEnd = parseOptionalDate(
    args.latest,
    new Date(windowStart.getTime() + DEFAULT_SEARCH_WINDOW_MS)
  );
  const durationMs = args.durationMinutes * 60_000;

  if (windowEnd.getTime() <= windowStart.getTime()) {
    return voiceToolResponse({ ok: false, detail: "invalid_window" });
  }

  try {
    const conn = await resolveCalendarConnection(envelope.businessId);
    if (!conn) {
      return voiceToolResponse({ ok: false, detail: "calendar_not_connected" });
    }

    let busy: Array<{ start: Date; end: Date }> = [];

    if (conn.provider === "google") {
      const res = await nangoProxyForBusiness(
        envelope.businessId,
        { connectionId: conn.connectionId, providerConfigKey: conn.providerConfigKey },
        {
          endpoint: "/calendar/v3/freeBusy",
          method: "POST",
          data: {
            timeMin: windowStart.toISOString(),
            timeMax: windowEnd.toISOString(),
            items: [{ id: "primary" }]
          }
        }
      );
      if (!res) return voiceToolResponse({ ok: false, detail: "calendar_not_connected" });
      const data = res.data as FreeBusyBody;
      const blocks = data?.calendars?.primary?.busy ?? [];
      busy = blocks.map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
    } else {
      // Microsoft Graph getSchedule: POST /me/calendar/getSchedule.
      const res = await nangoProxyForBusiness(
        envelope.businessId,
        { connectionId: conn.connectionId, providerConfigKey: conn.providerConfigKey },
        {
          endpoint: "/v1.0/me/calendar/getSchedule",
          method: "POST",
          data: {
            startTime: { dateTime: windowStart.toISOString(), timeZone: "UTC" },
            endTime: { dateTime: windowEnd.toISOString(), timeZone: "UTC" },
            availabilityViewInterval: args.durationMinutes,
            schedules: ["me"]
          }
        }
      );
      if (!res) return voiceToolResponse({ ok: false, detail: "calendar_not_connected" });
      type GraphBusy = {
        value?: Array<{
          scheduleItems?: Array<{ start?: { dateTime: string }; end?: { dateTime: string } }>;
        }>;
      };
      const data = res.data as GraphBusy;
      const items = data?.value?.[0]?.scheduleItems ?? [];
      busy = items
        .filter((i) => i.start?.dateTime && i.end?.dateTime)
        .map((i) => ({ start: new Date(i.start!.dateTime), end: new Date(i.end!.dateTime) }));
    }

    const slots = computeFreeSlots(windowStart, windowEnd, busy, durationMs);
    return voiceToolResponse({
      ok: true,
      data: {
        slots,
        timezone: args.timezone ?? null,
        purpose: args.purpose ?? null,
        durationMinutes: args.durationMinutes
      }
    });
  } catch (err) {
    logger.warn("voice-tools/calendar.find-slots failed", {
      businessId: envelope.businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return voiceToolResponse({ ok: false, detail: "calendar_lookup_failed" }, 500);
  }
}
