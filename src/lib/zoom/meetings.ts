/**
 * Zoom meeting operations for booked appointments, over the business's
 * first-party OAuth connection (`zoom_connections`) via the token-managing
 * client in src/lib/zoom/client.ts.
 *
 * There is deliberately no second transport any more. Until Aug 2026 these
 * operations could also ride a legacy Nango `workspace_oauth_connections`
 * row (provider_config_key `zoom`); production held zero such rows, and the
 * Nango-side integration (which still carried the DEVELOPMENT Marketplace
 * client's credentials) was deleted after the first-party app's update
 * review cleared, so the fallback became unreachable and was removed.
 *
 * Every operation here is BEST-EFFORT by contract: Zoom decorates a booking
 * with a video link, and a Zoom hiccup must never fail the booking (or the
 * reschedule/cancel) itself. Failures log and return null/false.
 */
import { logger } from "@/lib/logger";
import { zoomRequestForBusiness, type ZoomApiRequestSpec } from "@/lib/zoom/client";

/**
 * One Zoom API call for the business. Returns the parsed body (`{ data }`),
 * null when the business has no usable Zoom connection (none, deactivated,
 * or a revoked token). Throws on transport failures, the exported
 * operations below catch and degrade.
 */
async function zoomRequest(
  businessId: string,
  req: ZoomApiRequestSpec
): Promise<{ data: unknown } | null> {
  return zoomRequestForBusiness(businessId, req);
}

export type ZoomBookingMeeting = {
  meetingId: string;
  joinUrl: string;
};

/** Minutes between two instants, floored to at least 1. */
function durationMinutes(startIso: string, endIso: string): number {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  return Math.max(1, Math.round(ms / 60_000));
}

/**
 * Zoom Create/Update Meeting wants `yyyy-MM-ddTHH:mm:ssZ` with no
 * milliseconds. `Date.toISOString()` emits `.000Z`, and Zoom's API has
 * been observed to ignore the Z and treat the time digits as the host's
 * local wall clock when milliseconds are present (e.g. 16:00 UTC for a
 * Phoenix 9 AM booking becomes 4 PM local). Pairing the Z-form with an
 * explicit `timezone: "UTC"` keeps display aligned with Google Calendar,
 * which gets the same instant plus an IANA zone.
 */
function zoomStartTimeUtc(iso: string): string {
  return new Date(iso).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Create the scheduled Zoom meeting for a booking. Null when the business
 * has no Zoom connection or the create didn't yield a usable id + join URL,
 * the booking proceeds without a video link either way.
 */
export async function createZoomMeetingForBooking(
  businessId: string,
  booking: { topic: string; startIso: string; endIso: string; agenda?: string }
): Promise<ZoomBookingMeeting | null> {
  try {
    const res = await zoomRequest(businessId, {
      endpoint: "/users/me/meetings",
      method: "POST",
      data: {
        topic: booking.topic,
        type: 2, // scheduled meeting
        start_time: zoomStartTimeUtc(booking.startIso),
        timezone: "UTC",
        duration: durationMinutes(booking.startIso, booking.endIso),
        ...(booking.agenda ? { agenda: booking.agenda } : {})
      }
    });
    if (!res) return null;

    const data = res.data as { id?: number | string; join_url?: string } | null;
    const meetingId =
      typeof data?.id === "number" || typeof data?.id === "string"
        ? String(data.id)
        : null;
    const joinUrl = typeof data?.join_url === "string" ? data.join_url : null;
    if (!meetingId || !joinUrl) {
      logger.warn("zoom meeting create returned no id/join_url; booking proceeds without", {
        businessId
      });
      return null;
    }
    return { meetingId, joinUrl };
  } catch (err) {
    logger.warn("zoom meeting create failed; booking proceeds without", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

/**
 * Move a booking's Zoom meeting to the rescheduled time. Best-effort: the
 * calendar event has already moved; a stale meeting time is a nuisance, a
 * failed reschedule is a lost customer.
 */
export async function updateZoomMeetingForBooking(
  businessId: string,
  meetingId: string,
  booking: { startIso: string; endIso: string }
): Promise<boolean> {
  try {
    const res = await zoomRequest(businessId, {
      endpoint: `/meetings/${encodeURIComponent(meetingId)}`,
      method: "PATCH",
      data: {
        start_time: zoomStartTimeUtc(booking.startIso),
        timezone: "UTC",
        duration: durationMinutes(booking.startIso, booking.endIso)
      }
    });
    return res !== null;
  } catch (err) {
    logger.warn("zoom meeting update failed", {
      businessId,
      meetingId,
      error: err instanceof Error ? err.message : String(err)
    });
    return false;
  }
}

/**
 * The meeting's real join URL, read back from Zoom.
 *
 * Only the meeting ID is persisted on a booking, and a join URL rebuilt
 * from that ID alone drops the `?pwd=` a password-protected meeting needs,
 * so the invitee lands on a page that will not let them in. Null when the
 * meeting or the connection is gone; callers show no link rather than a
 * broken one.
 */
export async function getZoomJoinUrl(
  businessId: string,
  meetingId: string
): Promise<string | null> {
  try {
    const res = await zoomRequest(businessId, {
      endpoint: `/meetings/${encodeURIComponent(meetingId)}`,
      method: "GET"
    });
    const joinUrl = (res?.data as { join_url?: unknown } | null)?.join_url;
    return typeof joinUrl === "string" && joinUrl ? joinUrl : null;
  } catch (err) {
    logger.warn("zoom join url read failed", {
      businessId,
      meetingId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

/**
 * Delete a booking's Zoom meeting (cancellation, or cleanup when the
 * calendar create failed AFTER the meeting was made). Best-effort.
 */
export async function deleteZoomMeetingForBooking(
  businessId: string,
  meetingId: string
): Promise<boolean> {
  try {
    const res = await zoomRequest(businessId, {
      endpoint: `/meetings/${encodeURIComponent(meetingId)}`,
      method: "DELETE"
    });
    return res !== null;
  } catch (err) {
    logger.warn("zoom meeting delete failed", {
      businessId,
      meetingId,
      error: err instanceof Error ? err.message : String(err)
    });
    return false;
  }
}
