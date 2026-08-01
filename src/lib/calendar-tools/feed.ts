/**
 * The subscribable calendar feed: booking ledger → ICS.
 *
 * This is the team-calendar mechanism that works for EVERY tenant. The
 * shared "NewCoworker" calendar needs a Google or Microsoft account to
 * live on; none of the dedicated booking tools (Vagaro, Acuity, Calendly)
 * lets an outside app create a calendar, and iCloud refuses CalDAV
 * MKCALENDAR. A read-only feed URL sidesteps all of it: every calendar app
 * can subscribe to one.
 *
 * The feed renders the provider-neutral booking ledger, which is the one
 * store that sees every provider's bookings. Subscription semantics do the
 * lifecycle work for free: clients re-download the feed and replace their
 * copy, so a canceled booking (whose ledger row is deleted) disappears on
 * the next sync and a rescheduled one moves.
 *
 * Privacy: only the attendee's display name is rendered, never phone or
 * email. The URL is a plaintext capability the owner may forward to staff,
 * and a forwarded calendar link must not become a contact-list leak.
 */
import { getBusiness } from "@/lib/db/businesses";
import { listFeedBookings } from "@/lib/db/calendar-feed";
import { buildIcsCalendar, type IcsEvent } from "@/lib/calendar-tools/ics";

/**
 * The ledger stores booking STARTS; duration is only present where a
 * surface recorded it. A missing duration renders as a conservative hour,
 * matching the platform booking page's own busy-block assumption.
 */
export const FEED_DEFAULT_DURATION_MINUTES = 60;

export type CalendarFeedDeps = {
  getBusinessRow?: typeof getBusiness;
  listBookings?: typeof listFeedBookings;
};

/**
 * Render the business's feed as an ICS string, or null when the business
 * does not exist (the route turns that into a 404 without leaking whether
 * the token or the business was the problem).
 */
export async function renderCalendarFeed(
  businessId: string,
  nowMs: number,
  deps: CalendarFeedDeps = {}
): Promise<string | null> {
  const getBusinessRow = deps.getBusinessRow ?? getBusiness;
  const listBookings = deps.listBookings ?? listFeedBookings;

  const business = await getBusinessRow(businessId);
  if (!business) return null;

  const rows = await listBookings(businessId, nowMs);
  const events: IcsEvent[] = [];
  for (const row of rows) {
    const startMs = Date.parse(row.start_at);
    // Skip an unparseable start HERE, not downstream: new Date(NaN)
    // .toISOString() throws, and one bad row must not 500 the whole feed
    // for every subscriber.
    if (!Number.isFinite(startMs)) continue;
    const durationMinutes =
      row.duration_minutes && row.duration_minutes > 0
        ? row.duration_minutes
        : FEED_DEFAULT_DURATION_MINUTES;
    events.push({
      // The ledger row id is stable across reschedules (the row is updated
      // in place), so a moved booking keeps its UID and moves in the
      // subscriber's calendar instead of duplicating.
      uid: `${row.id}@newcoworker`,
      summary: row.attendee_name ? `Booking: ${row.attendee_name}` : "Booking",
      ...(row.booking_source ? { description: `Booked via ${row.booking_source}` } : {}),
      startIso: new Date(startMs).toISOString(),
      endIso: new Date(startMs + durationMinutes * 60_000).toISOString()
    });
  }

  return buildIcsCalendar(`${business.name} bookings`, events);
}
