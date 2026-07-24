/**
 * `calendar_join_waitlist`, the capture side of the cancellation
 * waitlist ("if you can come any sooner please let me know").
 *
 * Channel-agnostic core shared by every surface that exposes the tool
 * (texting coworker, dashboard chat inline + Rowboat twin, voice bridge
 * adapter, public booking page opt-in). Writes ONE live entry per
 * (business, phone); joining again refreshes the window.
 *
 * The entry links to the attendee's soonest upcoming booking when one
 * exists (shared attendee-bookings lookup, any provider): a freed slot is
 * then only offered when it is EARLIER than that booking, and the entry
 * expires when the booking starts. With no booking, the entry watches a
 * default 14-day window.
 */
import {
  formatBookingStartLocal,
  resolveToolTimezone,
  type CalendarToolResult
} from "@/lib/calendar-tools/handlers";
import { findUpcomingBookingsForAttendee } from "@/lib/calendar-tools/attendee-bookings";
import {
  getWaitlistSettings,
  upsertLiveWaitlistEntry,
  WAITLIST_DEFAULT_DURATION_MINUTES,
  WAITLIST_DEFAULT_WINDOW_DAYS
} from "@/lib/db/booking-waitlist";
import { normalizeContactNumber } from "@/lib/telnyx/format";
import { logger } from "@/lib/logger";

export type JoinWaitlistArgs = {
  attendeeName?: string;
  attendeeEmail?: string;
  attendeePhone?: string;
  /** Appointment length they want (defaults to 30). */
  durationMinutes?: number;
  /** Outer bound of interest, ISO. Defaults to their current booking start
   * (they want something sooner), else 14 days out. */
  latestIso?: string;
  timezone?: string;
};

/** Full E.164 only, offers ride SMS, so short codes are not reachable. */
const E164_FULL_RE = /^\+[1-9]\d{7,14}$/;

/**
 * @param fallbackPhone surface-provided phone when the model omits one
 *   (the voice bridge passes the caller's number).
 */
export async function joinCalendarWaitlist(
  businessId: string,
  args: JoinWaitlistArgs,
  fallbackPhone?: string | null
): Promise<CalendarToolResult> {
  try {
    const rawPhone = (args.attendeePhone ?? fallbackPhone ?? "").trim();
    const normalized = normalizeContactNumber(rawPhone);
    if (!normalized.ok || !E164_FULL_RE.test(normalized.value)) {
      return {
        ok: false,
        detail: "phone_required",
        message:
          "A valid mobile number is required to join the waitlist (the earlier-time " +
          "offer arrives by text). Ask the customer for their mobile number and call " +
          "this tool again with attendeePhone set."
      };
    }
    const phone = normalized.value;

    const settings = await getWaitlistSettings(businessId);
    if (!settings.enabled) {
      return {
        ok: false,
        detail: "waitlist_disabled",
        message:
          "The owner has turned the cancellation waitlist off, so you cannot promise " +
          "a text when an earlier time opens up. Offer to pass the request to the team " +
          "with notify_team instead."
      };
    }

    // Link the entry to their soonest upcoming booking (any provider, via
    // the shared adapter). Fail-open: a lookup hiccup joins them unlinked.
    const email = args.attendeeEmail?.trim().toLowerCase() || null;
    let currentStartIso: string | null = null;
    let currentEventId: string | null = null;
    try {
      const nowMs = Date.now();
      const upcoming = await findUpcomingBookingsForAttendee(
        businessId,
        { phones: [phone], email, name: args.attendeeName ?? null },
        {},
        { mode: "detail" }
      );
      const soonest = upcoming
        .filter((b) => {
          const ms = Date.parse(b.startIso);
          return Number.isFinite(ms) && ms > nowMs;
        })
        .sort((a, b) => Date.parse(a.startIso) - Date.parse(b.startIso))[0];
      if (soonest) {
        currentStartIso = new Date(Date.parse(soonest.startIso)).toISOString();
        currentEventId = soonest.eventId;
      }
    } catch (err) {
      logger.warn("waitlist-join: upcoming-booking lookup failed (joining unlinked)", {
        businessId,
        error: err instanceof Error ? err.message : String(err)
      });
    }

    const latestMs = args.latestIso ? Date.parse(args.latestIso) : NaN;
    const latestIso = Number.isFinite(latestMs)
      ? new Date(latestMs).toISOString()
      : currentStartIso ??
        new Date(Date.now() + WAITLIST_DEFAULT_WINDOW_DAYS * 24 * 60 * 60_000).toISOString();

    const upserted = await upsertLiveWaitlistEntry(businessId, {
      phone,
      email,
      name: args.attendeeName ?? null,
      durationMinutes:
        typeof args.durationMinutes === "number" && args.durationMinutes > 0
          ? Math.round(args.durationMinutes)
          : WAITLIST_DEFAULT_DURATION_MINUTES,
      latestAtIso: latestIso,
      currentBookingStartAtIso: currentStartIso,
      currentEventId
    });
    if (!upserted) {
      return { ok: false, detail: "waitlist_failed" };
    }

    const tz = await resolveToolTimezone(businessId, args.timezone);
    const currentStartLocal = currentStartIso
      ? formatBookingStartLocal(currentStartIso, tz)
      : null;
    return {
      ok: true,
      detail: upserted.created ? "waitlist_joined" : "waitlist_updated",
      data: {
        phone,
        currentBookingStartLocal: currentStartLocal,
        watchUntilIso: latestIso
      },
      message:
        `They are on the waitlist. Tell them you will text ${phone} the moment an ` +
        `earlier time opens up${currentStartLocal ? `, and that their current appointment (${currentStartLocal}) stays as is until then` : ""}. ` +
        "Do not promise that an earlier time WILL open up."
    };
  } catch (err) {
    logger.warn("waitlist-join failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return { ok: false, detail: "waitlist_failed" };
  }
}
