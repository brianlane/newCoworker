/**
 * Public booking page orchestration: token → page context, slot listing,
 * and booking submission. The pure math lives in slots.ts; the provider
 * writes ride the shared calendar core (`bookCalendarAppointment`), so
 * Zoom decoration, the dedupe ledger, appointment_booked goals, and the
 * unassigned-booking owner alert all behave exactly like AI-made bookings.
 *
 * Providers: Google / Microsoft (workspace free/busy) and CalDAV. Vagaro
 * and Calendly resolve elsewhere on purpose — Vagaro merchants have their
 * own booking site, and link-mode Calendly cannot book on the invitee's
 * behalf; the dashboard card explains both.
 */

import { getEnabledBookingPageByToken, countBookingsBetween } from "@/lib/booking-page/db";
import type { BookingPageRow } from "@/lib/booking-page/db";
import { parseBookingPageToken } from "@/lib/booking-page/keys";
import { computePublicSlots } from "@/lib/booking-page/slots";
import type { BusyBlock, PublicSlot } from "@/lib/booking-page/slots";
import { resolveCalendarConnection } from "@/lib/voice-tools/connections";
import {
  bookCalendarAppointment,
  getWorkspaceBusyBlocks
} from "@/lib/calendar-tools/handlers";
import { getCaldavBusyBlocks } from "@/lib/calendar-tools/caldav";
import { getBusiness } from "@/lib/db/businesses";
import { listTeamMembers, listTimeOff } from "@/lib/db/employees";
import { getActiveZoomConnectionId } from "@/lib/db/zoom-connections";
import { parseBusinessHours } from "@/lib/business-profile/profile";
import { normalizeContactNumber } from "@/lib/telnyx/format";
import { ensureCapturedContact } from "@/lib/customer-memory/capture-contact";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

export const BOOKING_PAGE_SOURCE_TAG = "Booking Page";

const DAY_MS = 24 * 60 * 60 * 1000;

export type BookingPageContext = {
  businessId: string;
  businessName: string;
  timezone: string;
  description: string | null;
  allowedDurations: number[];
  /** True when bookings will carry a Zoom join link. */
  videoCall: boolean;
  page: BookingPageRow;
};

export type BookingPageFailure = {
  ok: false;
  detail:
    | "not_found"
    | "calendar_not_connected"
    | "invalid_duration"
    | "invalid_request"
    | "slot_taken"
    | "booking_failed";
};

/**
 * Resolve the public page context for rendering. `not_found` covers every
 * fail-closed case (bad token shape, unknown token, disabled page); the
 * page 404s rather than explaining which.
 */
export async function getBookingPageContext(
  rawToken: string
): Promise<{ ok: true; context: BookingPageContext } | BookingPageFailure> {
  const token = parseBookingPageToken(rawToken);
  if (!token) return { ok: false, detail: "not_found" };

  const page = await getEnabledBookingPageByToken(token);
  if (!page) return { ok: false, detail: "not_found" };

  const business = await getBusiness(page.business_id);
  if (!business) return { ok: false, detail: "not_found" };

  const conn = await resolveCalendarConnection(page.business_id);
  if (!conn || conn.provider === "vagaro" || conn.provider === "calendly") {
    return { ok: false, detail: "calendar_not_connected" };
  }

  const zoomId = await getActiveZoomConnectionId(page.business_id);

  return {
    ok: true,
    context: {
      businessId: page.business_id,
      businessName: business.name,
      timezone: business.timezone?.trim() || "UTC",
      description: page.description,
      allowedDurations: page.allowed_durations,
      videoCall: zoomId !== null,
      page
    }
  };
}

/** Provider busy blocks for the page's whole bookable window. */
async function fetchBusyBlocks(
  businessId: string,
  provider: "google" | "microsoft" | "caldav",
  conn: { provider: string; connectionId: string; providerConfigKey: string },
  windowStart: Date,
  windowEnd: Date
): Promise<BusyBlock[] | null> {
  if (provider === "caldav") {
    const res = await getCaldavBusyBlocks(businessId, windowStart, windowEnd);
    return res.ok ? res.busy : null;
  }
  return getWorkspaceBusyBlocks(businessId, conn, windowStart, windowEnd);
}

export type ListPublicSlotsResult =
  | { ok: true; timezone: string; durationMinutes: number; slots: PublicSlot[] }
  | BookingPageFailure;

export async function listPublicSlots(
  rawToken: string,
  durationMinutes: number,
  nowOverride?: Date
): Promise<ListPublicSlotsResult> {
  const resolved = await getBookingPageContext(rawToken);
  if (!resolved.ok) return resolved;
  const { context } = resolved;
  const page = context.page;

  if (!page.allowed_durations.includes(durationMinutes)) {
    return { ok: false, detail: "invalid_duration" };
  }

  try {
    const conn = await resolveCalendarConnection(context.businessId);
    /* c8 ignore next 3 -- context resolution above already vetted the connection */
    if (!conn || conn.provider === "vagaro" || conn.provider === "calendly") {
      return { ok: false, detail: "calendar_not_connected" };
    }

    const now = nowOverride ?? new Date();
    const windowEnd = new Date(now.getTime() + (page.max_advance_days + 2) * DAY_MS);
    const busy = await fetchBusyBlocks(
      context.businessId,
      conn.provider,
      conn,
      now,
      windowEnd
    );
    if (busy === null) return { ok: false, detail: "calendar_not_connected" };

    const business = await getBusiness(context.businessId);
    const businessHours = parseBusinessHours(business?.business_hours ?? null);

    const roster = page.require_staff_on_shift
      ? (await listTeamMembers(context.businessId)).filter((m) => m.active)
      : [];
    const timeOff = page.require_staff_on_shift ? await listTimeOff(context.businessId) : [];

    const db = await createSupabaseServiceClient();
    const existingStarts: Date[] = [];
    if (page.max_daily_bookings !== null) {
      const { data, error } = await db
        .from("calendar_booking_dedupe")
        .select("start_at")
        .eq("business_id", context.businessId)
        .gte("start_at", now.toISOString())
        .lt("start_at", windowEnd.toISOString());
      if (error) throw new Error(`booking starts read: ${error.message}`);
      for (const row of (data ?? []) as Array<{ start_at: string }>) {
        existingStarts.push(new Date(row.start_at));
      }
    }

    const slots = computePublicSlots({
      now,
      timezone: context.timezone,
      durationMinutes,
      busy,
      businessHours,
      policy: {
        minNoticeMinutes: page.min_notice_minutes,
        maxAdvanceDays: page.max_advance_days,
        bufferMinutes: page.buffer_minutes,
        maxDailyBookings: page.max_daily_bookings,
        requireStaffOnShift: page.require_staff_on_shift
      },
      roster,
      timeOff,
      existingBookingStarts: existingStarts
    });

    return { ok: true, timezone: context.timezone, durationMinutes, slots };
  } catch (err) {
    logger.warn("booking-page: slot listing failed", {
      businessId: context.businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return { ok: false, detail: "booking_failed" };
  }
}

export type SubmitPublicBookingInput = {
  startIso: string;
  durationMinutes: number;
  name: string;
  phone: string;
  email: string;
  note?: string;
};

export type SubmitPublicBookingResult =
  | {
      ok: true;
      startIso: string;
      endIso: string;
      /** Human-readable local start from the booking core (business zone). */
      startLocal: string | null;
      zoomJoinUrl: string | null;
    }
  | BookingPageFailure;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function submitPublicBooking(
  rawToken: string,
  input: SubmitPublicBookingInput
): Promise<SubmitPublicBookingResult> {
  const resolved = await getBookingPageContext(rawToken);
  if (!resolved.ok) return resolved;
  const { context } = resolved;

  const name = input.name.trim();
  const email = input.email.trim();
  const note = input.note?.trim() ?? "";
  const phoneResult = normalizeContactNumber(input.phone);
  const start = new Date(input.startIso);
  if (
    name.length === 0 ||
    name.length > 200 ||
    !EMAIL_RE.test(email) ||
    email.length > 320 ||
    note.length > 1000 ||
    !phoneResult.ok ||
    // Full E.164 only: normalizeContactNumber also passes 3-8 digit short
    // codes, which are not reachable customer numbers.
    !/^\+[1-9]\d{7,14}$/.test(phoneResult.value) ||
    Number.isNaN(start.getTime())
  ) {
    return { ok: false, detail: "invalid_request" };
  }
  const phone = phoneResult.value;

  // Re-verify the requested start is still an offered slot: closes most of
  // the visitor-vs-visitor race window (the dedupe ledger and attendee
  // guard inside the booking core make the write itself idempotent).
  const listed = await listPublicSlots(rawToken, input.durationMinutes);
  if (!listed.ok) return listed;
  const stillOpen = listed.slots.some(
    (s) => new Date(s.startIso).getTime() === start.getTime()
  );
  if (!stillOpen) return { ok: false, detail: "slot_taken" };

  const endIso = new Date(start.getTime() + input.durationMinutes * 60_000).toISOString();
  const noteLines = [
    `Booked via the public booking page.`,
    `Phone: ${phone}`,
    `Email: ${email}`,
    ...(note ? [`Note: ${note}`] : [])
  ];

  const booked = await bookCalendarAppointment(
    context.businessId,
    {
      startIso: start.toISOString(),
      endIso,
      summary: `${name} + ${context.businessName} (${input.durationMinutes} min)`,
      attendeeName: name,
      attendeeEmail: email,
      attendeePhone: phone,
      notes: noteLines.join("\n")
    },
    phone,
    // Customer-initiated surface: a booking for a lead nobody owns should
    // page the owner exactly like an AI-made webchat booking would.
    { alertSurface: "webchat" }
  );

  if (!booked.ok) {
    logger.warn("booking-page: booking failed", {
      businessId: context.businessId,
      detail: booked.detail ?? null
    });
    return { ok: false, detail: "booking_failed" };
  }

  // File the visitor as a contact (fires contact_created for new leads, so
  // round-robin assignment and follow-up flows pick them up). Best-effort
  // by design: the booking above is already durable.
  await ensureCapturedContact(context.businessId, {
    e164: phone,
    name,
    email,
    channel: "webchat",
    sourceTag: BOOKING_PAGE_SOURCE_TAG
  });

  const data = (booked.data ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    startIso: start.toISOString(),
    endIso,
    startLocal: typeof data.startLocal === "string" ? data.startLocal : null,
    zoomJoinUrl: typeof data.zoomJoinUrl === "string" ? data.zoomJoinUrl : null
  };
}

/**
 * Daily-cap helper exposed for the dashboard page ("N bookings today").
 * Bounds are UTC instants of the business-local day, computed by callers.
 */
export { countBookingsBetween };
