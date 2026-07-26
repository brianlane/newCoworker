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
import { deleteZoomMeetingForBooking } from "@/lib/zoom/meetings";
import { offerFreedSlot } from "@/lib/calendar-tools/waitlist-fill";
import { getBookingPageForBusiness } from "@/lib/booking-page/db";
import {
  deleteManagedBooking,
  getBookingByManageToken,
  moveManagedBooking,
  type ManagedBookingRow
} from "@/lib/booking-page/db";
import { parseBookingManageToken } from "@/lib/booking-page/keys";
import { listSlotsForBusiness } from "@/lib/booking-page/service";
import { logger } from "@/lib/logger";

/** Platform-mode bookings carry a synthetic event id (no provider event). */
export const PLATFORM_EVENT_PREFIX = "platform:";

export type ManageFailure = {
  ok: false;
  detail: "not_found" | "too_late" | "slot_taken" | "invalid_request" | "change_failed";
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
  /** Minutes of notice the business requires, for the explain-why copy. */
  minNoticeMinutes: number;
};

/** Duration to assume for bookings made before the column existed. */
const DEFAULT_DURATION_MINUTES = 30;

type Resolved = {
  row: ManagedBookingRow;
  durationMinutes: number;
  platform: boolean;
  minNoticeMinutes: number;
};

async function resolve(rawToken: string): Promise<Resolved | null> {
  const token = parseBookingManageToken(rawToken);
  if (!token) return null;
  const row = await getBookingByManageToken(token);
  if (!row) return null;
  const page = await getBookingPageForBusiness(row.business_id);
  return {
    row,
    durationMinutes: row.duration_minutes ?? DEFAULT_DURATION_MINUTES,
    platform: (row.event_id ?? "").startsWith(PLATFORM_EVENT_PREFIX),
    minNoticeMinutes: page?.min_notice_minutes ?? 0
  };
}

/** True when the appointment is still far enough out to be changed. */
function withinNotice(startIso: string, minNoticeMinutes: number, now = Date.now()): boolean {
  return new Date(startIso).getTime() - now >= minNoticeMinutes * 60_000;
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
      timezone: business.timezone || "UTC",
      startIso: resolved.row.start_at,
      durationMinutes: resolved.durationMinutes,
      zoomJoinUrl: resolved.row.zoom_meeting_id
        ? `https://zoom.us/j/${resolved.row.zoom_meeting_id}`
        : null,
      changeable: withinNotice(resolved.row.start_at, resolved.minNoticeMinutes),
      minNoticeMinutes: resolved.minNoticeMinutes
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

export async function cancelManagedBooking(
  rawToken: string
): Promise<{ ok: true } | ManageFailure> {
  const resolved = await resolve(rawToken);
  if (!resolved) return { ok: false, detail: "not_found" };
  if (!withinNotice(resolved.row.start_at, resolved.minNoticeMinutes)) {
    return { ok: false, detail: "too_late" };
  }

  try {
    if (resolved.platform) {
      // The ledger is the calendar here: dropping the row IS the
      // cancellation. Zoom cleanup and the waitlist offer mirror what the
      // provider-mode core does.
      await deleteManagedBooking(resolved.row.id);
      if (resolved.row.zoom_meeting_id) {
        await deleteZoomMeetingForBooking(resolved.row.business_id, resolved.row.zoom_meeting_id);
      }
      await offerFreedSlot(resolved.row.business_id, resolved.row.start_at);
      return { ok: true };
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
    return { ok: false, detail: "too_late" };
  }

  try {
    // The new time must be a slot the page is actually offering right now:
    // this is the same re-verify the public submit does, and it is what
    // stops a stale tab from booking over someone else.
    const slots = await listSlotsForBusiness(resolved.row.business_id, resolved.durationMinutes);
    if (!slots.ok) return { ok: false, detail: "change_failed" };
    const offered = slots.slots.some((s) => new Date(s.startIso).getTime() === startMs);
    if (!offered) return { ok: false, detail: "slot_taken" };

    const endIso = new Date(startMs + resolved.durationMinutes * 60_000).toISOString();
    if (resolved.platform) {
      await moveManagedBooking(resolved.row.id, new Date(startMs).toISOString());
      // The old time is free now: same waitlist courtesy as a cancellation.
      await offerFreedSlot(resolved.row.business_id, resolved.row.start_at);
      return { ok: true, startIso: new Date(startMs).toISOString() };
    }

    const result = await rescheduleCalendarAppointment(
      resolved.row.business_id,
      {
        newStartIso: new Date(startMs).toISOString(),
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
    return { ok: true, startIso: new Date(startMs).toISOString() };
  } catch (err) {
    logger.warn("booking-manage: reschedule failed", {
      businessId: resolved.row.business_id,
      error: err instanceof Error ? err.message : String(err)
    });
    return { ok: false, detail: "change_failed" };
  }
}
