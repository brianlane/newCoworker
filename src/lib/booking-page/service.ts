/**
 * Public booking page orchestration: token → page context, slot listing,
 * and booking submission. The pure math lives in slots.ts.
 *
 * Two modes, resolved per business:
 *   - PROVIDER (Google / Microsoft workspace free/busy, CalDAV): writes
 *     ride the shared calendar core (`bookCalendarAppointment`), so Zoom
 *     decoration, the dedupe ledger, appointment_booked goals, and the
 *     unassigned-booking owner alert all behave exactly like AI-made
 *     bookings.
 *   - PLATFORM (no calendar integration at all): the feature stands on
 *     its own. Availability is business hours minus the platform's own
 *     booking ledger, and a booking IS a confirmed ledger row (synthetic
 *     `platform:` event id) with the same Zoom decoration, goal fan-out,
 *     owner alert, and contact filing. The dashboard's upcoming list is
 *     the calendar of record; connecting a real calendar later simply
 *     upgrades the mode.
 *
 * Vagaro and Calendly resolve elsewhere on purpose, Vagaro merchants
 * have their own booking site, and link-mode Calendly cannot book on the
 * invitee's behalf; the dashboard card explains both.
 */

import { randomUUID } from "crypto";
import {
  countBookingsBetween,
  getEnabledBookingPageBySlug,
  getEnabledBookingPageByToken,
  listBookingStartsBetween,
  recordPlatformBooking
} from "@/lib/booking-page/db";
import type { BookingPageRow } from "@/lib/booking-page/db";
import { parseBookingPageRef } from "@/lib/booking-page/keys";
import { computePublicSlots } from "@/lib/booking-page/slots";
import type { BusyBlock, PublicSlot } from "@/lib/booking-page/slots";
import { resolveCalendarConnection } from "@/lib/voice-tools/connections";
import {
  bookCalendarAppointment,
  formatBookingStartLocal,
  getWorkspaceBusyBlocks
} from "@/lib/calendar-tools/handlers";
import { getCaldavBusyBlocks } from "@/lib/calendar-tools/caldav";
import { getBusiness } from "@/lib/db/businesses";
import { listTeamMembers, listTimeOff } from "@/lib/db/employees";
import { getActiveZoomConnectionId } from "@/lib/db/zoom-connections";
import { parseBusinessHours } from "@/lib/business-profile/profile";
import { normalizeContactNumber } from "@/lib/telnyx/format";
import { ensureCapturedContact } from "@/lib/customer-memory/capture-contact";
import {
  bookingAttendeeKey,
  claimBookingDedupe,
  releaseBookingDedupe
} from "@/lib/calendar-tools/booking-dedupe";
import { findUpcomingBookingsForAttendee } from "@/lib/calendar-tools/attendee-bookings";
import { maybeAlertUnassignedBooking } from "@/lib/calendar-tools/unassigned-booking-alert";
import {
  createZoomMeetingForBooking,
  deleteZoomMeetingForBooking
} from "@/lib/zoom/meetings";
import { fireGoalEvent } from "@/lib/ai-flows/goal-hooks";
import { localClock } from "../../../supabase/functions/_shared/ai_flows/engine";
import { logger } from "@/lib/logger";

export const BOOKING_PAGE_SOURCE_TAG = "Booking Page";

/**
 * Synthetic attendee key for the slot-scoped submission claim: uniqueness
 * rides the ledger's (business, attendee_key, start_at), so one key
 * serializes all public-page submissions for the same slot without ever
 * colliding with a real attendee's claim.
 */
export const PUBLIC_SLOT_CLAIM_KEY = "slot:public-booking-page";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Platform-mode busy padding: the ledger stores booking STARTS only, so
 * each one blocks a conservative hour (the longest offered duration).
 */
const PLATFORM_BUSY_BLOCK_MS = 60 * 60 * 1000;

export type BookingPageMode = "provider" | "platform";

export type BookingPageContext = {
  businessId: string;
  businessName: string;
  timezone: string;
  description: string | null;
  /** Owner-set public event title; null = localized default. */
  title: string | null;
  allowedDurations: number[];
  /** True when bookings will carry a Zoom join link. */
  videoCall: boolean;
  /**
   * provider = a real calendar backs availability and receives the event
   * (invite email possible); platform = no integration, the booking ledger
   * is the calendar of record (no invite email).
   */
  mode: BookingPageMode;
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
    | "already_booked"
    | "booking_failed";
};

/**
 * Resolve the public page context for rendering. The ref is either the
 * capability token or the owner's vanity slug (shapes are disjoint).
 * `not_found` covers every fail-closed case (bad ref shape, unknown ref,
 * disabled page); the page 404s rather than explaining which.
 */
export async function getBookingPageContext(
  rawRef: string
): Promise<{ ok: true; context: BookingPageContext } | BookingPageFailure> {
  const ref = parseBookingPageRef(rawRef);
  if (!ref) return { ok: false, detail: "not_found" };

  const page = await (ref.kind === "token"
    ? getEnabledBookingPageByToken(ref.value)
    : getEnabledBookingPageBySlug(ref.value));
  if (!page) return { ok: false, detail: "not_found" };

  const business = await getBusiness(page.business_id);
  if (!business) return { ok: false, detail: "not_found" };

  const conn = await resolveCalendarConnection(page.business_id);
  // Vagaro merchants and link-mode Calendly keep their own booking pages;
  // ledger-only bookings behind their backs would desynchronize the real
  // book. NO connection at all is fully supported: platform mode.
  if (conn && (conn.provider === "vagaro" || conn.provider === "calendly")) {
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
      title: page.title?.trim() || null,
      allowedDurations: page.allowed_durations,
      videoCall: zoomId !== null,
      mode: conn ? "provider" : "platform",
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

export type CalendarAvailabilityProbe = "ok" | "unreadable" | "unsupported" | "platform";

/**
 * Owner-facing health probe for the Bookings dashboard: can the connected
 * calendar actually serve availability reads? A connection that can write
 * events but not read free/busy (a consent missing the Calendar scope, the
 * Jul 2026 HQ case) renders the public page unable to offer slots; the
 * page fails safe for visitors, and THIS is how the owner finds out why.
 * No connection at all is a healthy state: platform mode.
 */
export async function probeCalendarAvailability(
  businessId: string
): Promise<CalendarAvailabilityProbe> {
  try {
    const conn = await resolveCalendarConnection(businessId);
    if (!conn) return "platform";
    if (conn.provider === "vagaro" || conn.provider === "calendly") return "unsupported";
    const now = new Date();
    const busy = await fetchBusyBlocks(
      businessId,
      conn.provider,
      conn,
      now,
      new Date(now.getTime() + DAY_MS)
    );
    return busy === null ? "unreadable" : "ok";
  } catch {
    return "unreadable";
  }
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
  return listSlotsForContext(resolved.context, durationMinutes, nowOverride);
}

/**
 * Slot listing against a PRE-RESOLVED context. Submission re-verifies with
 * ITS OWN snapshot through this function, so a calendar connecting mid
 * request can never split the mode between the availability check and the
 * write; the fresh connection simply governs the next request.
 */
async function listSlotsForContext(
  context: BookingPageContext,
  durationMinutes: number,
  nowOverride?: Date
): Promise<ListPublicSlotsResult> {
  const page = context.page;

  if (!page.allowed_durations.includes(durationMinutes)) {
    return { ok: false, detail: "invalid_duration" };
  }

  try {
    const now = nowOverride ?? new Date();
    const windowEnd = new Date(now.getTime() + (page.max_advance_days + 2) * DAY_MS);

    // Ledger starts serve the daily cap in both modes, and in platform
    // mode they are ALSO the busy blocks (the ledger is the calendar).
    const existingStarts =
      context.mode === "platform" || page.max_daily_bookings !== null
        ? await listBookingStartsBetween(
            context.businessId,
            now.toISOString(),
            windowEnd.toISOString()
          )
        : [];

    let busy: BusyBlock[];
    if (context.mode === "platform") {
      // The ledger stores starts only; block a conservative hour per
      // booking so no offered duration can overlap a prior one.
      busy = existingStarts.map((start) => ({
        start,
        end: new Date(start.getTime() + PLATFORM_BUSY_BLOCK_MS)
      }));
    } else {
      const conn = await resolveCalendarConnection(context.businessId);
      /* c8 ignore next 3 -- context resolution above already vetted the connection */
      if (!conn || conn.provider === "vagaro" || conn.provider === "calendly") {
        return { ok: false, detail: "calendar_not_connected" };
      }
      const fetched = await fetchBusyBlocks(
        context.businessId,
        conn.provider,
        conn,
        now,
        windowEnd
      );
      if (fetched === null) return { ok: false, detail: "calendar_not_connected" };
      busy = fetched;
    }

    const business = await getBusiness(context.businessId);
    const businessHours = parseBusinessHours(business?.business_hours ?? null);

    const roster = page.require_staff_on_shift
      ? (await listTeamMembers(context.businessId)).filter((m) => m.active)
      : [];
    const timeOff = page.require_staff_on_shift ? await listTimeOff(context.businessId) : [];

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

  const endIso = new Date(start.getTime() + input.durationMinutes * 60_000).toISOString();

  // One-upcoming-appointment-per-person policy, BOTH modes, checked before
  // the re-verify (which would otherwise answer a double submit with a
  // confusing slot_taken): a repeat request for the attendee's EXISTING
  // start is idempotent success; a different upcoming booking is refused
  // honestly. The shared lookup reads the ledger plus provider adapters.
  const existing = await findUpcomingBookingsForAttendee(
    context.businessId,
    { phones: [phone], email: email.toLowerCase(), name },
    {},
    { mode: "detail" }
  );
  const requestedStartMs = start.getTime();
  if (existing.some((b) => Date.parse(b.startIso) === requestedStartMs)) {
    return {
      ok: true,
      startIso: start.toISOString(),
      endIso,
      startLocal: formatBookingStartLocal(start.toISOString(), context.timezone),
      // The join link was shown on the original confirmation; a retry
      // cannot reconstruct it from the ledger's meeting id alone.
      zoomJoinUrl: null
    };
  }
  const nowMs = Date.now();
  if (existing.some((b) => Date.parse(b.startIso) > nowMs)) {
    return { ok: false, detail: "already_booked" };
  }

  // Re-verify the requested start is still an offered slot against live
  // free/busy (a booking made anywhere since page load withdraws the slot).
  // Deliberately the SAME context snapshot as the write below, so the mode
  // cannot change between the availability check and the booking path.
  const listed = await listSlotsForContext(context, input.durationMinutes);
  if (!listed.ok) return listed;
  const stillOpen = listed.slots.some(
    (s) => new Date(s.startIso).getTime() === start.getTime()
  );
  if (!stillOpen) return { ok: false, detail: "slot_taken" };

  // Two DIFFERENT visitors can both pass the re-verify while provider
  // free/busy is stale (the booking core's own dedupe only guards the SAME
  // attendee), so take a slot-scoped ledger claim under a synthetic
  // attendee key before the write: the first caller proceeds, a racer gets
  // in_flight/duplicate and is told to re-pick. Refusal paths RELEASE the
  // claim immediately (the slot must not stay parked); after a successful
  // booking the unconfirmed claim simply lapses with its lease while
  // provider free/busy takes over withdrawing the slot. Fail-open on a
  // ledger hiccup, matching the booking core's own claim contract.
  const slotClaim = await claimBookingDedupe(
    context.businessId,
    PUBLIC_SLOT_CLAIM_KEY,
    start.toISOString()
  );
  if (slotClaim && slotClaim.kind !== "claimed") {
    return { ok: false, detail: "slot_taken" };
  }
  const releaseSlotClaim = async () => {
    if (slotClaim?.kind === "claimed") await releaseBookingDedupe(slotClaim.id);
  };

  // Daily-cap recount AFTER winning the slot claim: concurrent submissions
  // for DIFFERENT slots on the same business-local day could each pass the
  // re-verify while the ledger count sat below the cap. Recounting here
  // narrows that window to the ledger write itself; the cap is a courtesy
  // limit, and exact enforcement would need a DB-side atomic reserve.
  const cap = context.page.max_daily_bookings;
  if (cap !== null) {
    const DAY_WINDOW_MS = 26 * 60 * 60 * 1000;
    const nearby = await listBookingStartsBetween(
      context.businessId,
      new Date(start.getTime() - DAY_WINDOW_MS).toISOString(),
      new Date(start.getTime() + DAY_WINDOW_MS).toISOString()
    );
    const slotDay = localClock(start, context.timezone).isoDate;
    const sameDay = nearby.filter(
      (d) => localClock(d, context.timezone).isoDate === slotDay
    ).length;
    if (sameDay >= cap) {
      await releaseSlotClaim();
      return { ok: false, detail: "slot_taken" };
    }
  }

  const summary = `${name} + ${context.businessName} (${input.durationMinutes} min)`;

  let startLocal: string | null = null;
  let zoomJoinUrl: string | null = null;

  if (context.mode === "platform") {
    // PLATFORM MODE: the booking ledger is the calendar of record (the
    // per-person policy already ran above, shared with provider mode).
    const zoomMeeting = await createZoomMeetingForBooking(context.businessId, {
      topic: summary,
      startIso: start.toISOString(),
      endIso,
      agenda: note || undefined
    });

    const record = await recordPlatformBooking(
      context.businessId,
      bookingAttendeeKey(phone, email, name),
      start.toISOString(),
      `platform:${randomUUID()}`,
      zoomMeeting?.meetingId ?? null
    );
    if (!record.ok) {
      if (zoomMeeting) await deleteZoomMeetingForBooking(context.businessId, zoomMeeting.meetingId);
      await releaseSlotClaim();
      if (record.reason === "duplicate") return { ok: false, detail: "already_booked" };
      logger.warn("booking-page: platform booking write failed", {
        businessId: context.businessId
      });
      return { ok: false, detail: "booking_failed" };
    }

    startLocal = formatBookingStartLocal(start.toISOString(), context.timezone);
    zoomJoinUrl = zoomMeeting?.joinUrl ?? null;

    // Same post-booking fan-out the provider core runs: a confirmed
    // booking may fast-forward parked AiFlow runs, and a booking for a
    // lead nobody owns pages the owner.
    await fireGoalEvent(context.businessId, phone, { kind: "appointment_booked" });
    await maybeAlertUnassignedBooking(context.businessId, {
      attendeeName: name,
      attendeePhone: phone,
      attendeeEmail: email,
      startIso: start.toISOString(),
      startLocal,
      summary,
      eventId: "platform",
      surface: "webchat"
    });
  } else {
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
        summary,
        attendeeName: name,
        attendeeEmail: email,
        attendeePhone: phone,
        notes: noteLines.join("\n")
      },
      phone,
      // Customer-initiated surface: a booking for a lead nobody owns should
      // page the owner exactly like an AI-made webchat booking would. The
      // visitor typed their own name seconds ago, so it wins over any stale
      // stored display name (trustProvidedName).
      { alertSurface: "webchat", trustProvidedName: true }
    );

    if (!booked.ok) {
      // Every refusal releases the slot claim so the time is immediately
      // bookable by someone else.
      await releaseSlotClaim();
      // The attendee duplicate guard is a deliberate policy on this public
      // surface (one upcoming appointment per person keeps a single phone
      // number from strip-mining the calendar), surface it honestly instead
      // of a generic failure so the visitor knows what happened.
      if (booked.detail === "attendee_already_booked") {
        return { ok: false, detail: "already_booked" };
      }
      logger.warn("booking-page: booking failed", {
        businessId: context.businessId,
        detail: booked.detail ?? null
      });
      return { ok: false, detail: "booking_failed" };
    }

    const data = (booked.data ?? {}) as Record<string, unknown>;
    startLocal = typeof data.startLocal === "string" ? data.startLocal : null;
    zoomJoinUrl = typeof data.zoomJoinUrl === "string" ? data.zoomJoinUrl : null;
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

  return {
    ok: true,
    startIso: start.toISOString(),
    endIso,
    startLocal,
    zoomJoinUrl
  };
}

/**
 * Daily-cap helper exposed for the dashboard page ("N bookings today").
 * Bounds are UTC instants of the business-local day, computed by callers.
 */
export { countBookingsBetween };
