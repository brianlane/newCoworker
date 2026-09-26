/**
 * Cal.com cores for the calendar tools.
 *
 * Cal.com is the owner's real booking page. `calendar_find_slots` reads
 * open times on an event type, and `calendar_book_appointment` creates the
 * booking. A missing email becomes a non-deliverable example.com address,
 * the same approach Acuity uses for phone callers who never gave one.
 */
import type { CalendarToolResult } from "@/lib/calendar-tools/handlers";
import {
  CalApiError,
  cancelCalBooking,
  createCalBooking,
  listCalEventTypes,
  listCalSlotStarts,
  rescheduleCalBooking,
  selectCalEventType
} from "@/lib/cal/client";
import { getCalConnectionByBusiness } from "@/lib/db/cal-connections";

const MAX_SLOTS = 3;

export function calBookingEmail(
  attendeeEmail: string | null | undefined,
  phone: string | null | undefined
): string {
  const given = attendeeEmail?.trim();
  if (given) return given;
  const digits = (phone ?? "").replace(/\D/g, "");
  return `no-reply+${digits || "unknown"}@example.com`;
}

function knownFailure(err: unknown): CalendarToolResult | null {
  if (err instanceof CalApiError && err.code === "needs_reauth") {
    return { ok: false, detail: "cal_auth_failed" };
  }
  return null;
}

export async function findCalSlots(
  businessId: string,
  args: {
    windowStart: Date;
    windowEnd: Date;
    durationMinutes: number;
    purpose?: string;
    serviceId?: string;
    timezone: string;
  }
): Promise<CalendarToolResult> {
  const conn = await getCalConnectionByBusiness(businessId);
  if (!conn) return { ok: false, detail: "calendar_not_connected" };
  try {
    const startMs = Math.max(args.windowStart.getTime(), Date.now());
    const endMs = args.windowEnd.getTime();
    if (endMs <= startMs) return { ok: false, detail: "invalid_window" };
    const types = await listCalEventTypes(conn);
    const type = selectCalEventType(types, args.serviceId ?? conn.default_event_type_id, args.durationMinutes);
    if (type === "no_types") return { ok: false, detail: "cal_no_event_types" };
    const starts = await listCalSlotStarts(conn, {
      eventTypeId: type.id,
      startIso: new Date(startMs).toISOString(),
      endIso: new Date(endMs).toISOString(),
      timeZone: args.timezone
    });
    const slots: Array<{ startIso: string; endIso: string }> = [];
    for (const startIso of starts) {
      if (slots.length >= MAX_SLOTS) break;
      const ms = Date.parse(startIso);
      if (!Number.isFinite(ms) || ms < startMs || ms >= endMs) continue;
      slots.push({
        startIso: new Date(ms).toISOString(),
        endIso: new Date(ms + type.lengthMinutes * 60_000).toISOString()
      });
    }
    return {
      ok: true,
      data: {
        slots,
        timezone: args.timezone,
        purpose: args.purpose ?? null,
        durationMinutes: type.lengthMinutes,
        provider: "cal",
        serviceId: type.id,
        serviceName: type.title
      }
    };
  } catch (err) {
    const known = knownFailure(err);
    if (known) return known;
    throw err;
  }
}

export async function bookCalAppointment(
  businessId: string,
  args: {
    startIso: string;
    endIso: string;
    attendeeName: string;
    attendeeEmail?: string | null;
    attendeePhone?: string | null;
    summary: string;
    notes?: string | null;
    serviceId?: string;
    timezone?: string;
  },
  fallbackPhone?: string | null
): Promise<CalendarToolResult> {
  const conn = await getCalConnectionByBusiness(businessId);
  if (!conn) return { ok: false, detail: "calendar_not_connected" };
  try {
    const requestedMinutes = Math.max(
      1,
      Math.round((Date.parse(args.endIso) - Date.parse(args.startIso)) / 60_000)
    );
    const types = await listCalEventTypes(conn);
    const type = selectCalEventType(types, args.serviceId ?? conn.default_event_type_id, requestedMinutes);
    if (type === "no_types") return { ok: false, detail: "cal_no_event_types" };
    const timezone = args.timezone ?? conn.time_zone ?? "UTC";
    const phone = args.attendeePhone ?? fallbackPhone ?? null;
    const notes = [args.summary, args.notes ?? ""].map((line) => line.trim()).filter(Boolean).join("\n");
    const eventId = await createCalBooking(conn, {
      eventTypeId: type.id,
      startIso: args.startIso,
      name: args.attendeeName.trim() || "Customer",
      email: calBookingEmail(args.attendeeEmail, phone),
      timeZone: timezone,
      phone,
      notes: notes || null
    });
    if (!eventId) return { ok: false, detail: "cal_book_failed" };
    return {
      ok: true,
      data: {
        eventId,
        htmlLink: null,
        provider: "cal",
        calendar: "cal",
        serviceId: type.id,
        serviceName: type.title,
        inviteEmail: args.attendeeEmail?.trim() || null
      }
    };
  } catch (err) {
    const known = knownFailure(err);
    if (known) return known;
    throw err;
  }
}

export async function cancelCalAppointment(
  businessId: string,
  bookingUid: string
): Promise<CalendarToolResult> {
  const conn = await getCalConnectionByBusiness(businessId);
  if (!conn) return { ok: false, detail: "calendar_not_connected" };
  try {
    await cancelCalBooking(conn, bookingUid);
    return { ok: true, data: { eventId: bookingUid, provider: "cal", canceled: true } };
  } catch (err) {
    const known = knownFailure(err);
    if (known) return known;
    throw err;
  }
}

export async function rescheduleCalAppointment(
  businessId: string,
  bookingUid: string,
  newStartIso: string
): Promise<CalendarToolResult> {
  const conn = await getCalConnectionByBusiness(businessId);
  if (!conn) return { ok: false, detail: "calendar_not_connected" };
  try {
    const eventId = await rescheduleCalBooking(conn, bookingUid, newStartIso);
    return { ok: true, data: { eventId, provider: "cal", rescheduled: true } };
  } catch (err) {
    const known = knownFailure(err);
    if (known) return known;
    throw err;
  }
}
