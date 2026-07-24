/**
 * Waitlist lifecycle resolution for booking-core outcomes.
 *
 * Kept separate from waitlist-fill.ts so the booking core (handlers.ts) can
 * import it without a cycle: waitlist-fill imports the booking core's
 * free/busy helpers, and this module imports neither.
 *
 * Both entry points are BEST-EFFORT BY CONTRACT: they never throw and never
 * alter the booking/reschedule/cancel result, the provider write already
 * happened.
 */
import {
  findLiveWaitlistEntriesForAttendee,
  setWaitlistStatus,
  updateWaitlistBookingLink
} from "@/lib/db/booking-waitlist";
import { logger } from "@/lib/logger";

export type WaitlistAttendee = {
  phones: string[];
  email?: string | null;
};

/**
 * A booking (create or reschedule) just CONFIRMED for this attendee at
 * `newStartIso`. Their live waitlist entries resolve:
 *
 *  - the new start is at or before the entry's pending offer, or earlier
 *    than the booking the entry was trying to beat → FULFILLED (they got
 *    their earlier time);
 *  - otherwise (they moved their appointment LATER, booked an additional
 *    later slot, or an UNLINKED entry just got its first booking) → the
 *    entry stays live and re-points at the new booking, so "earlier"
 *    keeps meaning earlier than what they hold. An unlinked entry must
 *    NOT fulfill on a plain first booking (Bugbot Medium on PR #903):
 *    "text me if anything sooner opens up" survives booking the earliest
 *    time available today.
 */
export async function resolveWaitlistAfterBooking(
  businessId: string,
  attendee: WaitlistAttendee,
  newStartIso: string
): Promise<void> {
  try {
    const newStartMs = Date.parse(newStartIso);
    if (!Number.isFinite(newStartMs)) return;
    const entries = await findLiveWaitlistEntriesForAttendee(businessId, attendee);
    for (const entry of entries) {
      const offeredMs = entry.offered_start_at ? Date.parse(entry.offered_start_at) : NaN;
      const currentMs = entry.current_booking_start_at
        ? Date.parse(entry.current_booking_start_at)
        : NaN;
      const acceptedOffer = Number.isFinite(offeredMs) && newStartMs <= offeredMs;
      const beatCurrent = Number.isFinite(currentMs) && newStartMs < currentMs;
      if (acceptedOffer || beatCurrent) {
        await setWaitlistStatus(entry.id, "fulfilled");
      } else {
        await updateWaitlistBookingLink(entry.id, {
          currentBookingStartAtIso: new Date(newStartMs).toISOString()
        });
      }
    }
  } catch (err) {
    logger.warn("waitlist-resolve: after-booking resolution failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/**
 * The attendee just CANCELED their appointment outright. A live entry that
 * was waiting for something earlier than that appointment is moot, cancel
 * it rather than texting offers to someone who walked away.
 */
export async function cancelWaitlistForAttendee(
  businessId: string,
  attendee: WaitlistAttendee
): Promise<void> {
  try {
    const entries = await findLiveWaitlistEntriesForAttendee(businessId, attendee);
    for (const entry of entries) {
      await setWaitlistStatus(entry.id, "canceled");
    }
  } catch (err) {
    logger.warn("waitlist-resolve: cancel resolution failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
