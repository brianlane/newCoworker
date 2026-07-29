/**
 * Invitee self-serve: view, reschedule, or cancel ONE booking made on the
 * public page, addressed by its own `ncbm_` manage token.
 *
 * Before this, a visitor who needed a different time had to text the
 * business and wait for a person (or the AI on another channel) to move
 * it. The link rides the confirmation, so the change is theirs to make.
 *
 * Two calendars of record, one contract:
 *   - provider mode: the reschedule/cancel CORES own the change, so the
 *     provider event moves or disappears and the invitee gets the
 *     provider's own updated/cancelled invitation.
 *   - platform mode: the ledger row IS the appointment, so it is moved or
 *     deleted here, and the freed slot is offered to the waitlist exactly
 *     like a provider-side cancellation.
 *
 * The manage token survives a reschedule: the invitee's link keeps working
 * for the appointment they still hold.
 */

import { getBusiness } from "@/lib/db/businesses";
import {
  cancelCalendarAppointment,
  rescheduleCalendarAppointment
} from "@/lib/calendar-tools/reschedule";
import {
  deleteZoomMeetingForBooking,
  getZoomJoinUrl,
  updateZoomMeetingForBooking
} from "@/lib/zoom/meetings";
import { offerFreedSlot } from "@/lib/calendar-tools/waitlist-fill";
import {
  cancelWaitlistForAttendee,
  resolveWaitlistAfterBooking
} from "@/lib/calendar-tools/waitlist-resolve";
import {
  claimBookingDedupe,
  findUpcomingBookingClaim,
  releaseBookingDedupe,
  releaseParkedSlotClaims
} from "@/lib/calendar-tools/booking-dedupe";
import {
  PUBLIC_SLOT_CLAIM_KEY,
  dailyCapReached,
  listSlotsForBusiness
} from "@/lib/booking-page/service";
import { getBookingPageForBusiness } from "@/lib/booking-page/db";
import type { BookingPageRow } from "@/lib/booking-page/db";
import {
  deleteManagedBooking,
  getBookingByManageToken,
  moveManagedBooking,
  type ManagedBookingRow
} from "@/lib/booking-page/db";
import { parseBookingManageToken } from "@/lib/booking-page/keys";
import { logger } from "@/lib/logger";

/** Platform-mode bookings carry a synthetic event id (no provider event). */
export const PLATFORM_EVENT_PREFIX = "platform:";

export type ManageFailure = {
  ok: false;
  detail:
    | "not_found"
    | "too_late"
    | "slot_taken"
    | "invalid_request"
    | "change_failed"
    /** The appointment already happened: nothing to change. */
    | "already_past"
    /**
     * The shared cores resolve by attendee identity, so they would act on
     * this person's SOONEST upcoming booking. When that is a different
     * appointment than the one this link addresses, self-serve stops: a
     * person has to sort it out. Moving the wrong event silently is the
     * failure worth refusing for.
     */
    | "needs_human";
};

export type ManagedBookingView = {
  businessName: string;
  timezone: string;
  startIso: string;
  durationMinutes: number;
  /** Join link for the video call, when the booking has one. */
  zoomJoinUrl: string | null;
  /** False inside the page's minimum-notice window: view only. */
  changeable: boolean;
  /**
   * The appointment already happened. Distinct from `!changeable`, which
   * also covers the notice window: someone opening an old link should be
   * told it is past, not that it is "too soon to change".
   */
  past: boolean;
  /** Minutes of notice the business requires, for the explain-why copy. */
  minNoticeMinutes: number;
  /**
   * Absolute public booking-page URL (vanity slug preferred), or null when
   * the page is missing or disabled. Captured before cancel deletes the
   * ledger row so the canceled confirmation can still offer a rebook link.
   */
  bookingPageUrl: string | null;
};

/** Duration to assume for bookings made before the column existed. */
const DEFAULT_DURATION_MINUTES = 30;

type Resolved = {
  row: ManagedBookingRow;
  durationMinutes: number;
  platform: boolean;
  minNoticeMinutes: number;
  /**
   * Cap knob for the post-claim recount plus the fields needed to build the
   * public rebook URL. Null page reads as uncapped / no rebook link.
   */
  page: Pick<BookingPageRow, "max_daily_bookings" | "enabled" | "slug" | "token"> | null;
  timezone: string;
};

/** Absolute /book/<slug|token> URL when the page is enabled; else null. */
function publicUrlForPage(
  page: Pick<BookingPageRow, "enabled" | "slug" | "token"> | null
): string | null {
  if (!page?.enabled) return null;
  const site = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return `${site}/book/${page.slug ?? page.token}`;
}

async function resolve(rawToken: string): Promise<Resolved | null> {
  const token = parseBookingManageToken(rawToken);
  if (!token) return null;
  const row = await getBookingByManageToken(token);
  if (!row) return null;
  const [page, business] = await Promise.all([
    getBookingPageForBusiness(row.business_id),
    getBusiness(row.business_id)
  ]);
  return {
    row,
    durationMinutes: row.duration_minutes ?? DEFAULT_DURATION_MINUTES,
    platform: (row.event_id ?? "").startsWith(PLATFORM_EVENT_PREFIX),
    minNoticeMinutes: page?.min_notice_minutes ?? 0,
    page: page
      ? {
          max_daily_bookings: page.max_daily_bookings,
          enabled: page.enabled,
          slug: page.slug,
          token: page.token
        }
      : null,
    timezone: business?.timezone || "UTC"
  };
}

/** True when the appointment is still far enough out to be changed. */
function withinNotice(startIso: string, minNoticeMinutes: number, now = Date.now()): boolean {
  return new Date(startIso).getTime() - now >= minNoticeMinutes * 60_000;
}

/**
 * Why a change is refused, told apart: a stale tab still showing buttons on
 * a past appointment should hear "already passed", not "too soon".
 */
function refusalFor(startIso: string, minNoticeMinutes: number): "already_past" | "too_late" {
  return Date.parse(startIso) <= Date.now() ? "already_past" : "too_late";
}

export async function getManagedBooking(
  rawToken: string
): Promise<{ ok: true; view: ManagedBookingView } | ManageFailure> {
  const resolved = await resolve(rawToken);
  if (!resolved) return { ok: false, detail: "not_found" };
  const business = await getBusiness(resolved.row.business_id);
  if (!business) return { ok: false, detail: "not_found" };

  return {
    ok: true,
    view: {
      businessName: business.name,
      timezone: resolved.timezone,
      startIso: resolved.row.start_at,
      durationMinutes: resolved.durationMinutes,
      // Read back from Zoom rather than rebuilt from the id: a
      // password-protected meeting needs the pwd parameter, and a link
      // without it opens a page the invitee cannot get past.
      zoomJoinUrl: resolved.row.zoom_meeting_id
        ? await getZoomJoinUrl(resolved.row.business_id, resolved.row.zoom_meeting_id)
        : null,
      changeable: withinNotice(resolved.row.start_at, resolved.minNoticeMinutes),
      past: Date.parse(resolved.row.start_at) <= Date.now(),
      minNoticeMinutes: resolved.minNoticeMinutes,
      bookingPageUrl: publicUrlForPage(resolved.page)
    }
  };
}

/** Attendee identity for the cores, recovered from the ledger's key. */
function attendeeArgs(attendeeKey: string): {
  attendeePhone?: string;
  attendeeEmail?: string;
} {
  if (attendeeKey.startsWith("phone:")) {
    return { attendeePhone: attendeeKey.slice("phone:".length) };
  }
  if (attendeeKey.startsWith("email:")) {
    return { attendeeEmail: attendeeKey.slice("email:".length) };
  }
  return {};
}

/**
 * True when the shared cores would act on the very booking this manage
 * token addresses. They resolve the attendee's soonest upcoming claim, so
 * a visitor holding two upcoming appointments could otherwise see one time
 * on this page while a different event is moved or cancelled.
 */
async function coreWouldActOnThisBooking(row: ManagedBookingRow): Promise<boolean> {
  const claim = await findUpcomingBookingClaim(row.business_id, row.attendee_key);
  // No claim at all: the core does its own provider-side resolution (older
  // bookings that predate the ledger), which this guard cannot second-guess.
  if (!claim) return true;
  return Date.parse(claim.startAt) === Date.parse(row.start_at);
}

/** The same identity in the shape the waitlist helpers take. */
function waitlistAttendee(attendeeKey: string): { phones: string[]; email: string | null } {
  const args = attendeeArgs(attendeeKey);
  return {
    phones: args.attendeePhone ? [args.attendeePhone] : [],
    email: args.attendeeEmail?.toLowerCase() ?? null
  };
}

export async function cancelManagedBooking(
  rawToken: string
): Promise<{ ok: true } | ManageFailure> {
  const resolved = await resolve(rawToken);
  if (!resolved) return { ok: false, detail: "not_found" };
  if (!withinNotice(resolved.row.start_at, resolved.minNoticeMinutes)) {
    return {
      ok: false,
      detail: refusalFor(resolved.row.start_at, resolved.minNoticeMinutes)
    };
  }

  try {
    if (resolved.platform) {
      // The ledger is the calendar here: dropping the row IS the
      // cancellation. Everything after it mirrors what the provider-mode
      // core does, in the same order: Zoom cleanup, drop the canceler's own
      // live waitlist entries (they are no longer waiting on anything), and
      // only then offer the freed time to whoever is.
      await deleteManagedBooking(resolved.row.id);
      if (resolved.row.zoom_meeting_id) {
        await deleteZoomMeetingForBooking(resolved.row.business_id, resolved.row.zoom_meeting_id);
      }
      await cancelWaitlistForAttendee(
        resolved.row.business_id,
        waitlistAttendee(resolved.row.attendee_key)
      );
      // The original booking's slot claim is still parked on this start
      // until its lease lapses; without dropping it the freed time turns
      // the next booker away.
      await releaseParkedSlotClaims(
        resolved.row.business_id,
        PUBLIC_SLOT_CLAIM_KEY,
        resolved.row.start_at
      );
      await offerFreedSlot(resolved.row.business_id, resolved.row.start_at);
      return { ok: true };
    }

    if (!(await coreWouldActOnThisBooking(resolved.row))) {
      return { ok: false, detail: "needs_human" };
    }
    const result = await cancelCalendarAppointment(
      resolved.row.business_id,
      attendeeArgs(resolved.row.attendee_key),
      null
    );
    if (!result.ok) {
      logger.warn("booking-manage: provider cancel refused", {
        businessId: resolved.row.business_id,
        detail: result.detail
      });
      return { ok: false, detail: "change_failed" };
    }
    // Same parked-claim cleanup as platform mode: the core clears the
    // CONFIRMED row, but the public page's slot claim sits on that start
    // until its lease lapses and would turn the next booker away.
    await releaseParkedSlotClaims(
      resolved.row.business_id,
      PUBLIC_SLOT_CLAIM_KEY,
      resolved.row.start_at
    );
    return { ok: true };
  } catch (err) {
    logger.warn("booking-manage: cancel failed", {
      businessId: resolved.row.business_id,
      error: err instanceof Error ? err.message : String(err)
    });
    return { ok: false, detail: "change_failed" };
  }
}

export async function rescheduleManagedBooking(
  rawToken: string,
  startIso: string
): Promise<{ ok: true; startIso: string } | ManageFailure> {
  const resolved = await resolve(rawToken);
  if (!resolved) return { ok: false, detail: "not_found" };
  const startMs = new Date(startIso).getTime();
  if (!Number.isFinite(startMs)) return { ok: false, detail: "invalid_request" };
  if (!withinNotice(resolved.row.start_at, resolved.minNoticeMinutes)) {
    return {
      ok: false,
      detail: refusalFor(resolved.row.start_at, resolved.minNoticeMinutes)
    };
  }

  try {
    // The new time must be a slot the page is actually offering right now:
    // this is the same re-verify the public submit does, and it is what
    // stops a stale tab from booking over someone else.
    const slots = await listSlotsForBusiness(resolved.row.business_id, resolved.durationMinutes, {
      // Their own appointment must not block the move, or count against the
      // day's cap for it.
      excludeStartIso: resolved.row.start_at
    });
    if (!slots.ok) return { ok: false, detail: "change_failed" };
    const offered = slots.slots.some((s) => new Date(s.startIso).getTime() === startMs);
    if (!offered) return { ok: false, detail: "slot_taken" };

    const endIso = new Date(startMs + resolved.durationMinutes * 60_000).toISOString();
    const newStartIso = new Date(startMs).toISOString();
    if (resolved.platform) {
      // Slot-scoped claim before the write, exactly like the public submit:
      // the availability read above can be stale, and without this two
      // people can land on the same start.
      const claim = await claimBookingDedupe(
        resolved.row.business_id,
        PUBLIC_SLOT_CLAIM_KEY,
        newStartIso
      );
      if (claim && claim.kind !== "claimed") return { ok: false, detail: "slot_taken" };
      const releaseClaim = async () => {
        if (claim?.kind === "claimed") await releaseBookingDedupe(claim.id);
      };
      // Same post-claim cap recount a new booking runs, or concurrent moves
      // onto one day could push it past max_daily_bookings. The booking
      // being moved is excluded so a same-day move never counts itself.
      if (
        await dailyCapReached(
          resolved.row.business_id,
          { max_daily_bookings: resolved.page?.max_daily_bookings ?? null },
          resolved.timezone,
          new Date(startMs),
          resolved.row.start_at
        )
      ) {
        await releaseClaim();
        return { ok: false, detail: "slot_taken" };
      }
      try {
        await moveManagedBooking(resolved.row.id, newStartIso);
      } catch (err) {
        await releaseClaim();
        throw err;
      }
      // The meeting itself has to move too, or the invitee joins a call
      // still scheduled at the old time.
      if (resolved.row.zoom_meeting_id) {
        await updateZoomMeetingForBooking(
          resolved.row.business_id,
          resolved.row.zoom_meeting_id,
          { startIso: newStartIso, endIso }
        );
      }
      // Same waitlist bookkeeping as a provider reschedule: their own live
      // entries re-point at what they now hold, then the old time is
      // offered to whoever is waiting.
      await resolveWaitlistAfterBooking(
        resolved.row.business_id,
        waitlistAttendee(resolved.row.attendee_key),
        newStartIso
      );
      // Same for the time just vacated (see the cancel path).
      await releaseParkedSlotClaims(
        resolved.row.business_id,
        PUBLIC_SLOT_CLAIM_KEY,
        resolved.row.start_at
      );
      await offerFreedSlot(resolved.row.business_id, resolved.row.start_at);
      return { ok: true, startIso: newStartIso };
    }

    if (!(await coreWouldActOnThisBooking(resolved.row))) {
      return { ok: false, detail: "needs_human" };
    }
    const result = await rescheduleCalendarAppointment(
      resolved.row.business_id,
      {
        newStartIso: newStartIso,
        newEndIso: endIso,
        ...attendeeArgs(resolved.row.attendee_key)
      },
      null
    );
    if (!result.ok) {
      logger.warn("booking-manage: provider reschedule refused", {
        businessId: resolved.row.business_id,
        detail: result.detail
      });
      return { ok: false, detail: "change_failed" };
    }
    // Calendly answers with a link for the invitee to finish the move
    // themselves: the appointment has NOT moved, so say so rather than
    // showing a new time that does not exist yet.
    if (result.detail === "reschedule_link_created") {
      return { ok: false, detail: "change_failed" };
    }
    // The vacated start keeps its parked claim otherwise (see cancel).
    await releaseParkedSlotClaims(
      resolved.row.business_id,
      PUBLIC_SLOT_CLAIM_KEY,
      resolved.row.start_at
    );
    return { ok: true, startIso: newStartIso };
  } catch (err) {
    logger.warn("booking-manage: reschedule failed", {
      businessId: resolved.row.business_id,
      error: err instanceof Error ? err.message : String(err)
    });
    return { ok: false, detail: "change_failed" };
  }
}
