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
  countUpcomingByAssignee,
  stampAssigneeIfUnset,
  getBookingPageForBusiness,
  stampAttendeeContact,
  getEnabledBookingPageBySlug,
  getEnabledBookingPageByToken,
  listBookingStartsBetween,
  recordPlatformBooking,
  stampManageToken
} from "@/lib/booking-page/db";
import type { BookingPageRow } from "@/lib/booking-page/db";
import {
  mintBookingManageToken,
  parseBookingPageRef,
  parseBookingPageSlug
} from "@/lib/booking-page/keys";
import { chooseAssignee, eligibleMembers, parseAssignmentMode } from "@/lib/booking-page/assignment";
import {
  effectiveTypeSettings,
  listMeetingTypes,
  type BookingMeetingTypeRow,
  type EffectiveBookingSettings
} from "@/lib/booking-page/meeting-types";
import { notifyAssigneeOfBooking } from "@/lib/booking-page/assignee-notify";
import {
  activeIntakeQuestions,
  formatIntakeAnswers,
  parseIntakeQuestions,
  validateIntakeAnswers
} from "@/lib/booking-page/intake";
import { sendBookingConfirmationEmail } from "@/lib/booking-page/confirmation-email";
import { computePublicSlots } from "@/lib/booking-page/slots";
import type { BusyBlock, PublicSlot } from "@/lib/booking-page/slots";
import { readBusyCache, saveBusyCache } from "@/lib/booking-page/busy-cache";
import { resolveCalendarConnection } from "@/lib/voice-tools/connections";
import {
  bookCalendarAppointment,
  formatBookingStartLocal,
  getWorkspaceBusyBlocks
} from "@/lib/calendar-tools/handlers";
import { getCaldavBusyBlocks } from "@/lib/calendar-tools/caldav";
import { getBusiness } from "@/lib/db/businesses";
import { listTeamMembers, listTimeOff, markMemberOffered } from "@/lib/db/employees";
import { getActiveZoomConnectionId } from "@/lib/db/zoom-connections";
import { parseBusinessHours } from "@/lib/business-profile/profile";
import { normalizeContactNumber } from "@/lib/telnyx/format";
import { getSmsOptOutKind } from "@/lib/sms/opt-outs";
import { ensureCapturedContact } from "@/lib/customer-memory/capture-contact";
import {
  bookingAttendeeKey,
  claimBookingDedupe,
  releaseBookingDedupe
} from "@/lib/calendar-tools/booking-dedupe";
import {
  getWaitlistSettings,
  upsertLiveWaitlistEntry
} from "@/lib/db/booking-waitlist";
import { resolveWaitlistAfterBooking } from "@/lib/calendar-tools/waitlist-resolve";
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
  /**
   * Every meeting type the business has defined (any visibility). The
   * public page filters to the visible ones for its picker; the
   * single-type route resolves its own by slug.
   */
  meetingTypes: BookingMeetingTypeRow[];
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
    | "booking_failed"
    /** A required intake question went unanswered (form problem, retryable). */
    | "missing_answers"
    /**
     * The page requires payment and collection has not shipped: refusing
     * is the only answer that does not give paid work away free.
     */
    | "payment_required";
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

  const [zoomId, meetingTypes] = await Promise.all([
    getActiveZoomConnectionId(page.business_id),
    listMeetingTypes(page.business_id)
  ]);

  return {
    ok: true,
    context: {
      businessId: page.business_id,
      businessName: business.name,
      timezone: business.timezone?.trim() || "UTC",
      description: page.description,
      allowedDurations: page.allowed_durations,
      videoCall: zoomId !== null,
      mode: conn ? "provider" : "platform",
      page,
      meetingTypes
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
  nowOverride?: Date,
  /**
   * The meeting the visitor is booking (/book/<page>/<typeSlug>). Its
   * duration REPLACES the requested one, so a stale tab cannot ask for a
   * length this meeting does not offer.
   */
  meetingTypeSlug?: string | null
): Promise<ListPublicSlotsResult> {
  const resolved = await getBookingPageContext(rawToken);
  if (!resolved.ok) return resolved;
  const typed = resolveMeetingType(resolved.context, meetingTypeSlug);
  if (!typed.ok) return typed;
  return listSlotsForContext(
    resolved.context,
    typed.type ? typed.type.duration_minutes : durationMinutes,
    nowOverride,
    { meetingType: typed.type }
  );
}

/**
 * The requested meeting type, or null for the typeless flow. An unknown or
 * disabled slug is refused rather than silently falling back to the page:
 * a direct link that no longer works must say so, never quietly book
 * something else.
 */
function resolveMeetingType(
  context: BookingPageContext,
  slug?: string | null
): { ok: true; type: BookingMeetingTypeRow | null } | BookingPageFailure {
  if (!slug) return { ok: true, type: null };
  const parsed = parseBookingPageSlug(slug);
  const type = parsed
    ? context.meetingTypes.find((t) => t.slug === parsed && t.enabled)
    : undefined;
  if (!type) return { ok: false, detail: "not_found" };
  return { ok: true, type };
}

/**
 * The same availability, addressed by BUSINESS rather than by page ref.
 * The invitee manage page (/book/manage/<token>) holds a booking, not a
 * page link, and must offer exactly the slots the public page would: same
 * policy knobs, same busy sources, same degradation.
 */
export async function listSlotsForBusiness(
  businessId: string,
  durationMinutes: number,
  opts: {
    nowOverride?: Date;
    /**
     * A booking to ignore while computing availability: the invitee's OWN
     * appointment, when they are moving it. Without this their existing
     * slot blocks itself and, worse, counts against the day's booking cap,
     * so a same-day move can find no times at all even though the move adds
     * no appointment.
     */
    excludeStartIso?: string;
  } = {}
): Promise<ListPublicSlotsResult> {
  const page = await getBookingPageForBusiness(businessId);
  if (!page || !page.enabled) return { ok: false, detail: "not_found" };
  const resolved = await getBookingPageContext(page.token);
  if (!resolved.ok) return resolved;
  return listSlotsForContext(resolved.context, durationMinutes, opts.nowOverride, {
    ...(opts.excludeStartIso ? { excludeStartIso: opts.excludeStartIso } : {})
  });
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
  nowOverride?: Date,
  opts: { excludeStartIso?: string; meetingType?: BookingMeetingTypeRow | null } = {}
): Promise<ListPublicSlotsResult> {
  const page = context.page;

  // A meeting type OWNS its duration, so the page's picker list does not
  // apply to it (a 45 minute meeting is legal even though the picker only
  // offers 15/30/60).
  if (!opts.meetingType && !page.allowed_durations.includes(durationMinutes)) {
    return { ok: false, detail: "invalid_duration" };
  }

  try {
    const now = nowOverride ?? new Date();
    const windowEnd = new Date(now.getTime() + (page.max_advance_days + 2) * DAY_MS);

    // Ledger starts serve the daily cap in both modes, the busy blocks in
    // platform mode, and the DEGRADED busy baseline in provider mode, so
    // they are always fetched.
    const allStarts = await listBookingStartsBetween(
      context.businessId,
      now.toISOString(),
      windowEnd.toISOString()
    );
    // An invitee moving their own appointment must not be blocked by it, or
    // counted against the day's cap for it (see excludeStartIso).
    const excludeMs = opts.excludeStartIso ? Date.parse(opts.excludeStartIso) : NaN;
    const existingStarts = Number.isFinite(excludeMs)
      ? allStarts.filter((s) => s.getTime() !== excludeMs)
      : allStarts;
    // The ledger stores starts only; block a conservative hour per booking
    // so no offered duration can overlap a prior one.
    const ledgerBusy: BusyBlock[] = existingStarts.map((start) => ({
      start,
      end: new Date(start.getTime() + PLATFORM_BUSY_BLOCK_MS)
    }));

    let busy: BusyBlock[];
    if (context.mode === "platform") {
      busy = ledgerBusy;
    } else {
      const conn = await resolveCalendarConnection(context.businessId);
      /* c8 ignore next 3 -- context resolution above already vetted the connection */
      if (!conn || conn.provider === "vagaro" || conn.provider === "calendly") {
        return { ok: false, detail: "calendar_not_connected" };
      }
      // A connected provider is ADDITIVE availability signal: when its
      // busy data is unreadable (outage, scope-starved consent), the page
      // degrades instead of going down. Degradation prefers the
      // LAST-KNOWN-GOOD snapshot (stale-while-error, bounded staleness) so
      // a time the provider reported busy stays blocked through the
      // outage; with no fresh snapshot it falls back to the platform
      // baseline (business hours minus the booking ledger). The owner
      // sees the "cannot read availability" warning on the Bookings
      // dashboard either way; only events created DURING the outage can
      // be double-booked.
      let fetched: BusyBlock[] | null = null;
      try {
        fetched = await fetchBusyBlocks(context.businessId, conn.provider, conn, now, windowEnd);
      } catch (err) {
        logger.warn("booking-page: provider busy fetch threw; degrading", {
          businessId: context.businessId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
      if (fetched === null) {
        const cached = await readBusyCache(context.businessId);
        logger.warn("booking-page: provider busy unreadable; degrading", {
          businessId: context.businessId,
          cachedSnapshot: cached !== null
        });
        // The ledger union covers bookings the outage kept off the
        // snapshot; overlapping spans are harmless to the slot walk.
        busy = cached ? [...ledgerBusy, ...cached] : ledgerBusy;
      } else {
        busy = fetched;
        // Write-through (best-effort inside): the snapshot future outages
        // will serve.
        await saveBusyCache(context.businessId, now, windowEnd, fetched);
      }
    }

    const business = await getBusiness(context.businessId);
    const businessHours = parseBusinessHours(business?.business_hours ?? null);

    // An assigned page's availability IS its people's availability: a
    // visitor must not be offered a time nobody who could take it is
    // working. So those modes read the roster regardless of the
    // require-staff toggle, and narrow it to the members the page can book.
    const effective = effectiveTypeSettings(page, opts.meetingType ?? null, durationMinutes);
    const mode = parseAssignmentMode(effective.assignmentMode);
    const assigned = mode !== "any";
    const needsRoster = page.require_staff_on_shift || assigned;
    const allMembers = needsRoster ? await listTeamMembers(context.businessId) : [];
    const roster = assigned
      ? eligibleMembers(mode, effective.employeeId, allMembers)
      : allMembers.filter((m) => m.active);
    const timeOff = needsRoster ? await listTimeOff(context.businessId) : [];

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
        requireStaffOnShift: page.require_staff_on_shift || assigned
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
  /** Answers to the page's intake questions, keyed by question id. */
  intakeAnswers?: unknown;
  /** "Text me if an earlier time opens up" opt-in (cancellation waitlist). */
  notifyEarlier?: boolean;
  /**
   * Visitor IANA zone from the browser, so the confirmation email can show
   * THEIR clock next to the business's. Absent is fine (business zone only).
   */
  visitorTimeZone?: string | null;
  /** Locale of the page they booked on, so the email is in their language. */
  locale?: string | null;
  /** The meeting being booked (/book/<page>/<typeSlug>); null = the page itself. */
  meetingTypeSlug?: string | null;
};

/**
 * Has the target's business-local day already hit `max_daily_bookings`?
 *
 * Run AFTER winning the slot claim: concurrent writes for DIFFERENT slots
 * on the same day could each pass their availability read while the ledger
 * count still sat below the cap. This narrows that window to the ledger
 * write itself; the cap is a courtesy limit, and exact enforcement would
 * need a DB-side atomic reserve. Shared so a self-serve RESCHEDULE onto a
 * day cannot bypass what a new booking onto it respects.
 *
 * `excludeStartIso` drops the booking being moved from the count, so a
 * same-day move does not count itself.
 */
export async function dailyCapReached(
  businessId: string,
  page: Pick<BookingPageRow, "max_daily_bookings">,
  timezone: string,
  start: Date,
  excludeStartIso?: string
): Promise<boolean> {
  const cap = page.max_daily_bookings;
  if (cap === null) return false;
  const DAY_WINDOW_MS = 26 * 60 * 60 * 1000;
  const nearby = await listBookingStartsBetween(
    businessId,
    new Date(start.getTime() - DAY_WINDOW_MS).toISOString(),
    new Date(start.getTime() + DAY_WINDOW_MS).toISOString()
  );
  const excludeMs = excludeStartIso ? Date.parse(excludeStartIso) : NaN;
  const slotDay = localClock(start, timezone).isoDate;
  const sameDay = nearby.filter(
    (d) =>
      d.getTime() !== excludeMs && localClock(d, timezone).isoDate === slotDay
  ).length;
  return sameDay >= cap;
}

/**
 * Who this booking belongs to, or null when the page is unassigned (mode
 * `any`) or nobody eligible is working that slot. Reads the roster fresh so
 * a member deactivated between listing and booking is not handed work.
 */
async function resolveAssignee(
  context: BookingPageContext,
  start: Date,
  effective: Pick<EffectiveBookingSettings, "assignmentMode" | "employeeId">
): Promise<string | null> {
  const mode = parseAssignmentMode(effective.assignmentMode);
  if (mode === "any") return null;
  const [roster, timeOff, upcomingCounts] = await Promise.all([
    listTeamMembers(context.businessId),
    listTimeOff(context.businessId),
    countUpcomingByAssignee(context.businessId)
  ]);
  const choice = chooseAssignee({
    mode,
    employeeId: effective.employeeId,
    roster,
    timeOff,
    startIso: start.toISOString(),
    timezone: context.timezone,
    upcomingCounts
  });
  if (choice.memberId === null) {
    logger.warn("booking-page: booking left unassigned", {
      businessId: context.businessId,
      reason: choice.reason
    });
  }
  return choice.memberId;
}

export type SubmitPublicBookingResult =
  | {
      ok: true;
      startIso: string;
      endIso: string;
      /** Human-readable local start from the booking core (business zone). */
      startLocal: string | null;
      zoomJoinUrl: string | null;
      /**
       * Self-serve reschedule/cancel path for THIS booking
       * (`/book/manage/<token>`), or null when the token could not be
       * attached. Relative: the caller renders it against its own origin.
       */
      manageLink: string | null;
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

  // The meeting being booked. An unknown or disabled slug is refused here,
  // never silently downgraded to the page: a dead link must say so rather
  // than book something the visitor did not choose.
  const typed = resolveMeetingType(context, input.meetingTypeSlug);
  if (!typed.ok) return typed;
  const meetingType = typed.type;
  const effective = effectiveTypeSettings(context.page, meetingType, input.durationMinutes);
  // The type owns its length, so a stale tab cannot book a 30 when the
  // owner has since made this meeting 60.
  const durationMinutes = effective.durationMinutes;

  const name = input.name.trim();
  const email = input.email.trim();
  const note = input.note?.trim() ?? "";
  // Named once, before the idempotent-resubmit branch can need it: a
  // meeting type puts its own name on the event, so "Liz + New Coworker:
  // Discovery call" beats a bare duration.
  const summary = meetingType
    ? `${name} + ${context.businessName}: ${meetingType.name}`
    : `${name} + ${context.businessName} (${durationMinutes} min)`;

  // The page's intake questions, answered. Validated here but only REFUSED
  // after the idempotent resubmit check below: a visitor whose first submit
  // already booked must get their idempotent success even if the owner has
  // since added a required question. What DID validate is kept either way
  // (the lenient pass treats every question as optional) so a resubmit can
  // still stamp whatever answers it carried.
  const intakeQuestions = activeIntakeQuestions(effective.questions);
  const intake = validateIntakeAnswers(intakeQuestions, input.intakeAnswers);
  const lenient = intake.ok
    ? intake
    : validateIntakeAnswers(
        intakeQuestions.map((q) => ({ ...q, required: false })),
        input.intakeAnswers
      );
  // With every question optional the lenient pass cannot report missing,
  // so the fallback object is unreachable and exists only for the narrow.
  /* c8 ignore next */
  const intakeAnswers = lenient.ok ? lenient.answers : {};
  const intakeLines = formatIntakeAnswers(intakeQuestions, intakeAnswers);
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

  // Owner-declared spam blocks booking (flag_contact_spam, PR #884: a spam
  // declaration must never start MORE automation; a booking would fire
  // goals and page the owner via the unassigned-booking alert). A
  // customer's own "stop" row does NOT block: they opted out of TEXTS, not
  // of appointments they choose to make. The refusal is deliberately the
  // generic booking_failed shape so the page never reveals a block.
  if ((await getSmsOptOutKind(context.businessId, phone)) === "owner_spam") {
    logger.warn("booking-page: refused owner_spam number", {
      businessId: context.businessId
    });
    return { ok: false, detail: "booking_failed" };
  }

  const endIso = new Date(start.getTime() + durationMinutes * 60_000).toISOString();

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
    // The first submit may have landed the booking and then died before
    // stamping (a client timeout mid-flight), which would leave the visitor
    // unreachable for reminders and the booking unassigned (which also
    // skews the round-robin load counts). The stamp is idempotent, so redo
    // it here, assignee included. The confirmation email deliberately is
    // NOT re-sent: it either went out already or the visitor is holding an
    // appointment they can see, and a duplicate is worse than a missing one.
    const retryAssignee = await resolveAssignee(context, start, effective).catch(() => null);
    if (retryAssignee) {
      // Only fills a genuine gap: the original assignment is the right
      // answer, and re-resolving can name someone else as loads move, so
      // overwriting would reassign work already on somebody's calendar.
      // The tiebreak advances only when the gap was ACTUALLY filled: a
      // harmless resubmit must not skew who wins the next tie.
      const filled = await stampAssigneeIfUnset(
        context.businessId,
        bookingAttendeeKey(phone, email, name),
        start.toISOString(),
        retryAssignee
      ).catch(() => false);
      if (filled) {
        await markMemberOffered(retryAssignee).catch(() => {});
        // The gap-fill is the first time this booking had an owner, so the
        // owner has never heard about it either.
        if (context.page.notify_assignee) {
          await notifyAssigneeOfBooking(context.businessId, retryAssignee, {
            visitorName: name,
            visitorPhone: phone,
            startLocal: formatBookingStartLocal(start.toISOString(), context.timezone),
            durationMinutes,
            summary
          });
        }
      }
    }
    await stampAttendeeContact(
      context.businessId,
      bookingAttendeeKey(phone, email, name),
      start.toISOString(),
      // Answers included: the first request may have booked and died before
      // its final stamp, and the retry is the last chance for them to land.
      {
        email,
        name,
        intakeAnswers: intakeLines.length > 0 ? intakeAnswers : null,
        meetingTypeId: meetingType?.id ?? null
      }
    ).catch((err: unknown) => {
      logger.warn("booking-page: attendee contact re-stamp failed", {
        businessId: context.businessId,
        error: err instanceof Error ? err.message : String(err)
      });
    });
    return {
      ok: true,
      startIso: start.toISOString(),
      endIso,
      startLocal: formatBookingStartLocal(start.toISOString(), context.timezone),
      // The join link was shown on the original confirmation; a retry
      // cannot reconstruct it from the ledger's meeting id alone.
      zoomJoinUrl: null,
      // Same reason: the first confirmation carried the manage link, and
      // minting a second token here would orphan the one already sent.
      manageLink: null
    };
  }
  const nowMs = Date.now();
  if (existing.some((b) => Date.parse(b.startIso) > nowMs)) {
    return { ok: false, detail: "already_booked" };
  }

  // Only a FRESH booking is refused by the gates below, after the
  // idempotent path above and before any claim: a visitor who already
  // holds this appointment gets their idempotent success even if the page
  // has since gained required questions or turned on payment.

  // Payment gate, schema-hooks phase: a page marked as requiring payment
  // must not hand out free appointments before collection exists.
  if (effective.paymentRequired) {
    logger.warn("booking-page: booking refused, page requires payment (not yet supported)", {
      businessId: context.businessId
    });
    return { ok: false, detail: "payment_required" };
  }

  if (!intake.ok) return { ok: false, detail: "missing_answers" };

  // Re-verify the requested start is still an offered slot against live
  // free/busy (a booking made anywhere since page load withdraws the slot).
  // Deliberately the SAME context snapshot as the write below, so the mode
  // cannot change between the availability check and the booking path.
  const listed = await listSlotsForContext(context, durationMinutes, undefined, {
    meetingType
  });
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
  if (await dailyCapReached(context.businessId, context.page, context.timezone, start)) {
    await releaseSlotClaim();
    return { ok: false, detail: "slot_taken" };
  }

  let startLocal: string | null = null;
  let zoomJoinUrl: string | null = null;
  // Minted before either write so both modes stamp the SAME token, and the
  // confirmation can hand the visitor a link that manages this booking.
  const manageToken = mintBookingManageToken();
  let manageLink: string | null = `/book/manage/${manageToken}`;

  if (context.mode === "platform") {
    // PLATFORM MODE: the booking ledger is the calendar of record (the
    // per-person policy already ran above, shared with provider mode).
    // The agenda is where a Zoom-hosted call shows what the visitor said:
    // their note plus the intake answers, same content the provider path
    // puts in the event notes.
    const agendaLines = [...(note ? [note] : []), ...intakeLines];
    const zoomMeeting = await createZoomMeetingForBooking(context.businessId, {
      topic: summary,
      startIso: start.toISOString(),
      endIso,
      agenda: agendaLines.length > 0 ? agendaLines.join("\n") : undefined
    });

    // Re-run the per-person guard AFTER winning the slot claim: two
    // overlapping submits from the same attendee for DIFFERENT slots could
    // both pass the early check (the provider core runs its own late guard;
    // this is the platform-mode equivalent).
    const recheck = await findUpcomingBookingsForAttendee(
      context.businessId,
      { phones: [phone], email: email.toLowerCase(), name },
      {},
      { mode: "detail" }
    );
    const recheckNowMs = Date.now();
    if (recheck.some((b) => Date.parse(b.startIso) > recheckNowMs)) {
      if (zoomMeeting) {
        await deleteZoomMeetingForBooking(context.businessId, zoomMeeting.meetingId);
      }
      await releaseSlotClaim();
      return { ok: false, detail: "already_booked" };
    }

    const record = await recordPlatformBooking(
      context.businessId,
      bookingAttendeeKey(phone, email, name),
      start.toISOString(),
      `platform:${randomUUID()}`,
      zoomMeeting?.meetingId ?? null,
      undefined,
      { token: manageToken, durationMinutes }
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
    // booking may fast-forward parked AiFlow runs, the visitor's live
    // waitlist entries resolve against what they now hold (the provider
    // path gets this inside bookCalendarAppointment), and a booking for a
    // lead nobody owns pages the owner.
    await fireGoalEvent(context.businessId, phone, { kind: "appointment_booked" });
    await resolveWaitlistAfterBooking(
      context.businessId,
      { phones: [phone], email: email.toLowerCase() },
      start.toISOString()
    );
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
      ...(note ? [`Note: ${note}`] : []),
      // The answers travel with the event, so the person taking the call
      // reads them where they will actually look.
      ...intakeLines
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

    // The booking core owns the ledger write in this mode and knows nothing
    // about manage links, so the token is stamped onto the row it just
    // created. Best-effort: the appointment is real either way, and a
    // visitor who cannot self-serve still has the business's number.
    try {
      const stamped = await stampManageToken(
        context.businessId,
        bookingAttendeeKey(phone, email, name),
        start.toISOString(),
        manageToken,
        durationMinutes
      );
      if (!stamped) manageLink = null;
    } catch (err) {
      manageLink = null;
      logger.warn("booking-page: manage token stamp failed", {
        businessId: context.businessId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
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

  // Cancellation-waitlist opt-in ("text me if an earlier time opens up"):
  // one live entry linked to the booking just made, so a freed EARLIER
  // slot texts them an offer (waitlist-fill core). Best-effort (the
  // booking is already durable) and gated on the owner's waitlist toggle.
  if (input.notifyEarlier === true) {
    const waitlist = await getWaitlistSettings(context.businessId);
    if (waitlist.enabled) {
      await upsertLiveWaitlistEntry(context.businessId, {
        phone,
        email,
        name,
        durationMinutes,
        latestAtIso: start.toISOString(),
        currentBookingStartAtIso: start.toISOString()
      });
    }
  }

  // Reminder addressing + the confirmation email. Best-effort: the booking
  // is already durable, and a visitor who gets no email still holds the
  // appointment (and, in provider mode, the provider's own invitation).
  const assignee = await resolveAssignee(context, start, effective).catch((err: unknown) => {
    // An unassigned booking is a bookkeeping loss, never a lost
    // appointment: the visitor already holds the time.
    logger.warn("booking-page: assignee resolution failed", {
      businessId: context.businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  });
  if (assignee) {
    // Advance the round-robin tiebreak, or two members carrying the same
    // load would forever resolve to the same person. Best-effort: a stale
    // timestamp only costs fairness on the next tie, never the booking.
    await markMemberOffered(assignee).catch((err: unknown) => {
      logger.warn("booking-page: could not advance the assignment tiebreak", {
        businessId: context.businessId,
        error: err instanceof Error ? err.message : String(err)
      });
    });
  }

  const contactStamped = await stampAttendeeContact(
    context.businessId,
    bookingAttendeeKey(phone, email, name),
    start.toISOString(),
    {
      email,
      name,
      assigneeMemberId: assignee,
      intakeAnswers: intakeLines.length > 0 ? intake.answers : null,
      meetingTypeId: meetingType?.id ?? null
    }
  )
    .then((stamped) => {
      if (!stamped) {
        // Reminders address the visitor from this row, so a miss means they
        // will hear nothing before the appointment.
        logger.warn("booking-page: attendee contact not stamped (no matching row)", {
          businessId: context.businessId
        });
      }
      return stamped;
    })
    .catch((err: unknown) => {
      logger.warn("booking-page: attendee contact stamp failed", {
        businessId: context.businessId,
        error: err instanceof Error ? err.message : String(err)
      });
      return false;
    });

  // The person who must show up hears about it where they look: their
  // texts. Sent only AFTER their ownership is durably on the row: a text
  // before a failed stamp would double when the resubmit's gap-fill
  // (rightly) treats itself as the first ownership moment.
  if (assignee && contactStamped && context.page.notify_assignee) {
    await notifyAssigneeOfBooking(context.businessId, assignee, {
      visitorName: name,
      visitorPhone: phone,
      startLocal: startLocal ?? formatBookingStartLocal(start.toISOString(), context.timezone),
      durationMinutes,
      summary
    });
  }

  if (context.page.send_confirmation_email) {
    await sendBookingConfirmationEmail({
      businessId: context.businessId,
      businessName: context.businessName,
      businessTimeZone: context.timezone,
      startIso: start.toISOString(),
      durationMinutes,
      attendeeEmail: email,
      joinUrl: zoomJoinUrl,
      manageLink,
      visitorTimeZone: input.visitorTimeZone ?? null,
      locale: input.locale ?? null
    }).catch((err: unknown) => {
      logger.warn("booking-page: confirmation email failed", {
        businessId: context.businessId,
        error: err instanceof Error ? err.message : String(err)
      });
    });
  }

  return {
    ok: true,
    startIso: start.toISOString(),
    endIso,
    startLocal,
    zoomJoinUrl,
    manageLink
  };
}

/**
 * Daily-cap helper exposed for the dashboard page ("N bookings today").
 * Bounds are UTC instants of the business-local day, computed by callers.
 */
export { countBookingsBetween };
