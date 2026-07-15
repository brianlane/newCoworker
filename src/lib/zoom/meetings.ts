/**
 * Zoom meeting operations for booked appointments, over EITHER transport:
 *
 *   1. `zoom-direct` (primary): the business's first-party OAuth connection
 *      (`zoom_connections`), called through the token-managing client.
 *   2. Legacy Nango: a `workspace_oauth_connections` row with
 *      provider_config_key `zoom` from the old Connect UI flow, proxied by
 *      Nango. Honored only while NANGO_SECRET_KEY is configured — without
 *      it, legacy rows resolve to "no Zoom" instead of erroring. Mirrors
 *      the `calendly` / `calendly-direct` split in voice-tools/connections.
 *
 * Every operation here is BEST-EFFORT by contract: Zoom decorates a booking
 * with a video link, and a Zoom hiccup must never fail the booking (or the
 * reschedule/cancel) itself. Failures log and return null/false.
 */
import { logger } from "@/lib/logger";
import { getActiveZoomConnectionId } from "@/lib/db/zoom-connections";
import { listWorkspaceOAuthConnections } from "@/lib/db/workspace-oauth-connections";
import { nangoProxyForBusiness } from "@/lib/nango/workspace";
import { zoomRequestForBusiness, type ZoomApiRequestSpec } from "@/lib/zoom/client";

/** Synthetic key for the first-party transport (cf. `calendly-direct`). */
export const ZOOM_DIRECT_KEY = "zoom-direct";
/** The legacy Nango integration id for Zoom. */
export const ZOOM_NANGO_KEY = "zoom";

export type ZoomTransport =
  | { kind: "direct" }
  | { kind: "nango"; connectionId: string; providerConfigKey: string };

/**
 * Which Zoom transport (if any) serves this business. Direct wins whenever
 * an active first-party connection exists; the legacy Nango link is the
 * fallback for connections made before first-party OAuth shipped.
 */
export async function resolveZoomTransport(
  businessId: string
): Promise<ZoomTransport | null> {
  const directId = await getActiveZoomConnectionId(businessId);
  if (directId) return { kind: "direct" };

  if (!process.env.NANGO_SECRET_KEY) return null;
  const rows = await listWorkspaceOAuthConnections(businessId);
  const legacy = rows.find((r) => r.provider_config_key === ZOOM_NANGO_KEY);
  if (!legacy) return null;
  return {
    kind: "nango",
    connectionId: legacy.connection_id,
    providerConfigKey: legacy.provider_config_key
  };
}

/**
 * One Zoom API call over whichever transport is live. Returns the parsed
 * body (`{ data }`), null when the business has no usable Zoom connection
 * (none, deactivated, or a revoked token). Throws on transport failures —
 * the exported operations below catch and degrade.
 */
async function zoomRequestViaTransport(
  businessId: string,
  transport: ZoomTransport,
  req: ZoomApiRequestSpec
): Promise<{ data: unknown } | null> {
  if (transport.kind === "direct") {
    return zoomRequestForBusiness(businessId, req);
  }
  const res = await nangoProxyForBusiness(
    businessId,
    {
      connectionId: transport.connectionId,
      providerConfigKey: transport.providerConfigKey
    },
    {
      // The meeting operations never use query params, so only the endpoint,
      // method and body translate onto the proxy request.
      endpoint: `/v2${req.endpoint}`,
      method: req.method,
      ...(req.data === undefined ? {} : { data: req.data })
    }
  );
  if (!res) return null;
  return { data: res.data };
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
 * Create the scheduled Zoom meeting for a booking. Null when the business
 * has no Zoom connection or the create didn't yield a usable id + join URL
 * — the booking proceeds without a video link either way.
 */
export async function createZoomMeetingForBooking(
  businessId: string,
  booking: { topic: string; startIso: string; endIso: string; agenda?: string }
): Promise<ZoomBookingMeeting | null> {
  try {
    const transport = await resolveZoomTransport(businessId);
    if (!transport) return null;

    const res = await zoomRequestViaTransport(businessId, transport, {
      endpoint: "/users/me/meetings",
      method: "POST",
      data: {
        topic: booking.topic,
        type: 2, // scheduled meeting
        start_time: new Date(booking.startIso).toISOString(),
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
        businessId,
        transport: transport.kind
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
    const transport = await resolveZoomTransport(businessId);
    if (!transport) return false;
    const res = await zoomRequestViaTransport(businessId, transport, {
      endpoint: `/meetings/${encodeURIComponent(meetingId)}`,
      method: "PATCH",
      data: {
        start_time: new Date(booking.startIso).toISOString(),
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
 * Delete a booking's Zoom meeting (cancellation, or cleanup when the
 * calendar create failed AFTER the meeting was made). Best-effort.
 */
export async function deleteZoomMeetingForBooking(
  businessId: string,
  meetingId: string
): Promise<boolean> {
  try {
    const transport = await resolveZoomTransport(businessId);
    if (!transport) return false;
    const res = await zoomRequestViaTransport(businessId, transport, {
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
