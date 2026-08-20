/**
 * Dedicated "NewCoworker" calendar on the owner's connected account.
 *
 * Bookings move off the owner's primary calendar into a calendar the whole
 * team can see, created lazily via the existing Nango proxy (no new auth),
 * with its id persisted in workspace_oauth_connections.metadata:
 *
 * The HOST is resolved independently of who takes the bookings
 * (`resolveSharedCalendarHost`, not `resolveCalendarConnection`). A merchant
 * who books on Vagaro but runs on Google Workspace used to get no team
 * calendar at all, because the booking provider won resolution and then
 * failed the Google/Microsoft check. The calendar is a place to SHOW the team
 * what is booked, so any connected Google/Microsoft account will do.
 *
 *   metadata.shared_calendar_id, provider calendar id
 *   metadata.shared_calendar_acl, emails already granted read access
 *
 * Consumers:
 *   - bookCalendarAppointment  → ensureSharedCalendar (creates on first booking)
 *   - findCalendarSlots        → getSharedCalendar (read-only; busy across
 *     primary AND shared so owner personal events still block double-booking)
 *   - Employees page           → shareSharedCalendarWithEmployees + the
 *     time-off mirror (all-day "out of office" events, display only)
 *
 * Everything here is best-effort by design: a calendar/ACL/mirror failure
 * must never block a booking or a roster edit.
 */

import { workspaceProxyForBusiness } from "@/lib/workspace/proxy";
import {
  listWorkspaceOAuthConnections,
  upsertWorkspaceOAuthConnection
} from "@/lib/db/workspace-oauth-connections";
import {
  resolveSharedCalendarHost,
  type ResolvedCalendarHost
} from "@/lib/voice-tools/connections";
import { listTeamMembers } from "@/lib/db/employees";
import { logger } from "@/lib/logger";

export const SHARED_CALENDAR_NAME = "NewCoworker";

export type SharedCalendarInfo = {
  calendarId: string;
  conn: ResolvedCalendarHost;
};

export type SharedCalendarStatus = {
  calendarId: string | null;
  sharedWith: string[];
};

/** The day after a YYYY-MM-DD date (all-day event ends are exclusive). */
export function nextDayIsoDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

type ConnectionMeta = {
  rowMetadata: Record<string, unknown>;
  calendarId: string | null;
  acl: string[];
};

/** Read shared-calendar state stored on the connection row's metadata. */
async function readConnectionMeta(
  businessId: string,
  conn: ResolvedCalendarHost
): Promise<ConnectionMeta> {
  const rows = await listWorkspaceOAuthConnections(businessId);
  const row = rows.find(
    (r) =>
      r.provider_config_key === conn.providerConfigKey && r.connection_id === conn.connectionId
  );
  const metadata = (row?.metadata ?? {}) as Record<string, unknown>;
  const calendarId =
    typeof metadata.shared_calendar_id === "string" && metadata.shared_calendar_id
      ? metadata.shared_calendar_id
      : null;
  const acl = Array.isArray(metadata.shared_calendar_acl)
    ? (metadata.shared_calendar_acl as unknown[]).filter(
        (e): e is string => typeof e === "string"
      )
    : [];
  return { rowMetadata: metadata, calendarId, acl };
}

async function writeConnectionMeta(
  businessId: string,
  conn: ResolvedCalendarHost,
  metadata: Record<string, unknown>
): Promise<void> {
  await upsertWorkspaceOAuthConnection({
    businessId,
    providerConfigKey: conn.providerConfigKey,
    connectionId: conn.connectionId,
    metadata
  });
}

/**
 * Read-only lookup: the shared calendar IF it already exists. Used on the
 * find-slots hot path, which must not create calendars as a side effect.
 * Null when no calendar connection or no shared calendar yet; never throws.
 */
export async function getSharedCalendar(businessId: string): Promise<SharedCalendarInfo | null> {
  try {
    const conn = await resolveSharedCalendarHost(businessId);
    if (!conn) return null;
    const meta = await readConnectionMeta(businessId, conn);
    return meta.calendarId ? { calendarId: meta.calendarId, conn } : null;
  } catch (err) {
    logger.warn("shared-calendar: read failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

/**
 * Get-or-create the shared calendar. Called on first booking and from the
 * Employees page share action. Null on any failure, callers fall back to
 * the primary calendar so a Nango hiccup can't block a live booking.
 */
export async function ensureSharedCalendar(
  businessId: string
): Promise<SharedCalendarInfo | null> {
  try {
    const conn = await resolveSharedCalendarHost(businessId);
    if (!conn) return null;
    const meta = await readConnectionMeta(businessId, conn);
    if (meta.calendarId) return { calendarId: meta.calendarId, conn };

    const proxyTarget = { connectionId: conn.connectionId, providerConfigKey: conn.providerConfigKey };
    let calendarId: string | null = null;
    if (conn.provider === "google") {
      const res = await workspaceProxyForBusiness(businessId, proxyTarget, {
        endpoint: "/calendar/v3/calendars",
        method: "POST",
        data: { summary: SHARED_CALENDAR_NAME }
      });
      const data = (res?.data ?? null) as { id?: string } | null;
      calendarId = data?.id ?? null;
    } else {
      const res = await workspaceProxyForBusiness(businessId, proxyTarget, {
        endpoint: "/v1.0/me/calendars",
        method: "POST",
        data: { name: SHARED_CALENDAR_NAME }
      });
      const data = (res?.data ?? null) as { id?: string } | null;
      calendarId = data?.id ?? null;
    }
    if (!calendarId) return null;

    // Concurrent first-bookings (or "Set up & share" racing a booking) can
    // both pass the calendarId-null check above and each create a provider
    // calendar. Re-read before persisting: if another caller already stored
    // an id, prefer theirs and best-effort delete the one we just created so
    // it doesn't linger as an orphan on the owner's account.
    const recheck = await readConnectionMeta(businessId, conn);
    if (recheck.calendarId && recheck.calendarId !== calendarId) {
      await deleteProviderCalendar(businessId, conn, calendarId);
      return { calendarId: recheck.calendarId, conn };
    }

    await writeConnectionMeta(businessId, conn, {
      ...recheck.rowMetadata,
      shared_calendar_id: calendarId
    });
    return { calendarId, conn };
  } catch (err) {
    logger.warn("shared-calendar: ensure failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

/** Best-effort delete of a just-created duplicate calendar (race loser). */
async function deleteProviderCalendar(
  businessId: string,
  conn: ResolvedCalendarHost,
  calendarId: string
): Promise<void> {
  try {
    const proxyTarget = { connectionId: conn.connectionId, providerConfigKey: conn.providerConfigKey };
    const endpoint =
      conn.provider === "google"
        ? `/calendar/v3/calendars/${encodeURIComponent(calendarId)}`
        : `/v1.0/me/calendars/${encodeURIComponent(calendarId)}`;
    await workspaceProxyForBusiness(businessId, proxyTarget, { endpoint, method: "DELETE" });
  } catch (err) {
    logger.warn("shared-calendar: duplicate calendar cleanup failed", {
      businessId,
      calendarId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/** Current share status for the Employees page ("shared with N employees"). */
export async function sharedCalendarStatus(businessId: string): Promise<SharedCalendarStatus> {
  try {
    const conn = await resolveSharedCalendarHost(businessId);
    if (!conn) return { calendarId: null, sharedWith: [] };
    const meta = await readConnectionMeta(businessId, conn);
    return { calendarId: meta.calendarId, sharedWith: meta.acl };
  } catch (err) {
    logger.warn("shared-calendar: status read failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return { calendarId: null, sharedWith: [] };
  }
}

/**
 * Create the shared calendar if needed and grant read access to every roster
 * member with an email that hasn't been granted yet. Per-email failures are
 * skipped (a typo'd address must not block the rest of the team).
 */
export async function shareSharedCalendarWithEmployees(businessId: string): Promise<
  | { ok: true; calendarId: string; sharedWith: string[]; added: number; failed: number }
  | { ok: false; detail: "calendar_not_connected" | "share_failed" }
> {
  try {
    const shared = await ensureSharedCalendar(businessId);
    if (!shared) return { ok: false, detail: "calendar_not_connected" };
    const { calendarId, conn } = shared;
    const proxyTarget = { connectionId: conn.connectionId, providerConfigKey: conn.providerConfigKey };

    const meta = await readConnectionMeta(businessId, conn);
    const already = new Set(meta.acl.map((e) => e.toLowerCase()));
    const members = await listTeamMembers(businessId);
    const targets = [
      ...new Set(
        members
          .map((m) => m.email?.trim().toLowerCase() ?? "")
          .filter((e) => e.length > 0 && !already.has(e))
      )
    ];

    const granted: string[] = [];
    let failed = 0;
    for (const email of targets) {
      try {
        const grantRequest =
          conn.provider === "google"
            ? {
                endpoint: `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/acl`,
                data: { role: "reader", scope: { type: "user", value: email } }
              }
            : {
                endpoint: `/v1.0/me/calendars/${encodeURIComponent(calendarId)}/calendarPermissions`,
                data: { emailAddress: { address: email }, role: "read" }
              };
        const res = await workspaceProxyForBusiness(businessId, proxyTarget, {
          ...grantRequest,
          method: "POST"
        });
        if (!res) throw new Error("proxy returned null");
        granted.push(email);
      } catch (err) {
        failed += 1;
        logger.warn("shared-calendar: ACL grant failed", {
          businessId,
          email,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    const sharedWith = [...meta.acl, ...granted];
    if (granted.length > 0) {
      await writeConnectionMeta(businessId, conn, {
        ...meta.rowMetadata,
        shared_calendar_id: calendarId,
        shared_calendar_acl: sharedWith
      });
    }
    return { ok: true, calendarId, sharedWith, added: granted.length, failed };
  } catch (err) {
    logger.warn("shared-calendar: share failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return { ok: false, detail: "share_failed" };
  }
}

/**
 * Providers whose bookings live on the merchant's OWN book rather than on
 * the workspace calendar, and therefore need mirroring for the team to see
 * them. Google and Microsoft are absent on purpose: when they are the host,
 * `bookOnProvider` already wrote the event onto this very calendar, and
 * mirroring would give every one of those tenants duplicate events.
 */
const PROVIDERS_NEEDING_MIRROR = new Set([
  "vagaro",
  "acuity",
  "calendly",
  "caldav"
]);

/** True when a booking taken on `bookingProvider` needs a mirror event. */
export function bookingNeedsSharedCalendarMirror(bookingProvider: string): boolean {
  return PROVIDERS_NEEDING_MIRROR.has(bookingProvider);
}

export type BookingMirrorInput = {
  summary: string;
  startIso: string;
  endIso: string;
  attendeeName?: string | null;
  attendeePhone?: string | null;
  attendeeEmail?: string | null;
  notes?: string | null;
};

/**
 * Put a booking taken on another provider onto the shared calendar, so the
 * team sees it alongside everything else.
 *
 * Returns the mirror event's provider id, which the caller stores on the
 * ledger row: without a handle the mirror goes stale the first time the
 * customer reschedules or cancels, and a lingering event for an appointment
 * that no longer exists is worse than no mirror, because the team acts on it.
 *
 * Read-only about the calendar's existence, deliberately: like the time-off
 * mirror, this uses `getSharedCalendar` rather than `ensureSharedCalendar`,
 * so a booking never brings a calendar into being as a side effect. Null on
 * anything going wrong, always: a display convenience must never fail a real
 * booking.
 */
export async function mirrorBookingToSharedCalendar(
  businessId: string,
  bookingProvider: string,
  booking: BookingMirrorInput
): Promise<string | null> {
  try {
    if (!bookingNeedsSharedCalendarMirror(bookingProvider)) return null;
    const shared = await getSharedCalendar(businessId);
    if (!shared) return null;
    const { calendarId, conn } = shared;
    const proxyTarget = { connectionId: conn.connectionId, providerConfigKey: conn.providerConfigKey };
    const description = [
      booking.notes ?? "",
      booking.attendeeName ? `Attendee: ${booking.attendeeName}` : "",
      booking.attendeePhone ? `Phone: ${booking.attendeePhone}` : "",
      booking.attendeeEmail ? `Email: ${booking.attendeeEmail}` : "",
      `Booked on ${bookingProvider}`
    ]
      .filter((line) => line.trim().length > 0)
      .join("\n");

    if (conn.provider === "google") {
      const res = await workspaceProxyForBusiness(businessId, proxyTarget, {
        endpoint: `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
        method: "POST",
        data: {
          summary: booking.summary,
          description,
          start: { dateTime: booking.startIso },
          end: { dateTime: booking.endIso }
        }
      });
      const data = (res?.data ?? null) as { id?: string } | null;
      return data?.id ?? null;
    }
    const res = await workspaceProxyForBusiness(businessId, proxyTarget, {
      endpoint: `/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events`,
      method: "POST",
      data: {
        subject: booking.summary,
        body: { contentType: "text", content: description },
        start: { dateTime: booking.startIso, timeZone: "UTC" },
        end: { dateTime: booking.endIso, timeZone: "UTC" }
      }
    });
    const data = (res?.data ?? null) as { id?: string } | null;
    return data?.id ?? null;
  } catch (err) {
    logger.warn("shared-calendar: booking mirror failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

/** Move a mirror event when the real appointment moves. Best-effort. */
export async function moveSharedCalendarMirror(
  businessId: string,
  eventId: string,
  startIso: string,
  endIso: string
): Promise<void> {
  try {
    const shared = await getSharedCalendar(businessId);
    if (!shared) return;
    const { calendarId, conn } = shared;
    const proxyTarget = { connectionId: conn.connectionId, providerConfigKey: conn.providerConfigKey };
    if (conn.provider === "google") {
      await workspaceProxyForBusiness(businessId, proxyTarget, {
        endpoint: `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        method: "PATCH",
        data: { start: { dateTime: startIso }, end: { dateTime: endIso } }
      });
      return;
    }
    await workspaceProxyForBusiness(businessId, proxyTarget, {
      endpoint: `/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      method: "PATCH",
      data: {
        start: { dateTime: startIso, timeZone: "UTC" },
        end: { dateTime: endIso, timeZone: "UTC" }
      }
    });
  } catch (err) {
    logger.warn("shared-calendar: booking mirror move failed", {
      businessId,
      eventId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/**
 * Remove a mirror event when the real appointment is canceled.
 *
 * This is the half that makes mirroring safe to ship at all: a mirror left
 * behind after a cancellation shows the team an appointment that is not
 * happening, and they will act on it.
 */
export async function removeSharedCalendarMirror(
  businessId: string,
  eventId: string
): Promise<void> {
  await removeTimeOffEvent(businessId, eventId);
}

/**
 * Push an all-day "out of office" mirror event for a time-off range. Only
 * mirrors when the shared calendar already exists (adding time off should
 * not create calendars). Returns the provider event id, or null when
 * skipped/failed. Routing never reads it (the DB row stays authoritative
 * there), but availability now does: the event is written BUSY on purpose
 * (Google `transparency: "opaque"`, Graph `showAs: "oof"`), so free/busy
 * carries the range and the booking page, find-slots, and waitlist fill
 * all stop offering those days. That is the Aug 19 2026 convention: the
 * Busy/Free flag decides what blocks. Until then this mirror was written
 * transparent as "display-only", which is exactly why the founder's own
 * marked-off days kept being offered to visitors. Pre-existing mirrors are
 * re-marked by scripts/oneshot/opaque-time-off-mirrors.ts.
 */
export async function mirrorTimeOffEvent(
  businessId: string,
  memberName: string,
  startsOn: string,
  endsOn: string
): Promise<string | null> {
  try {
    const shared = await getSharedCalendar(businessId);
    if (!shared) return null;
    const { calendarId, conn } = shared;
    const proxyTarget = { connectionId: conn.connectionId, providerConfigKey: conn.providerConfigKey };
    const summary = `${memberName}: out of office`;
    const endExclusive = nextDayIsoDate(endsOn);

    if (conn.provider === "google") {
      const res = await workspaceProxyForBusiness(businessId, proxyTarget, {
        endpoint: `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
        method: "POST",
        data: {
          summary,
          start: { date: startsOn },
          end: { date: endExclusive },
          transparency: "opaque"
        }
      });
      const data = (res?.data ?? null) as { id?: string } | null;
      return data?.id ?? null;
    }
    const res = await workspaceProxyForBusiness(businessId, proxyTarget, {
      endpoint: `/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events`,
      method: "POST",
      data: {
        subject: summary,
        isAllDay: true,
        showAs: "oof",
        start: { dateTime: `${startsOn}T00:00:00`, timeZone: "UTC" },
        end: { dateTime: `${endExclusive}T00:00:00`, timeZone: "UTC" }
      }
    });
    const data = (res?.data ?? null) as { id?: string } | null;
    return data?.id ?? null;
  } catch (err) {
    logger.warn("shared-calendar: time-off mirror failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

/** Delete a time-off mirror event. Best-effort: failures are logged and swallowed. */
export async function removeTimeOffEvent(businessId: string, eventId: string): Promise<void> {
  try {
    const shared = await getSharedCalendar(businessId);
    if (!shared) return;
    const { calendarId, conn } = shared;
    const proxyTarget = { connectionId: conn.connectionId, providerConfigKey: conn.providerConfigKey };
    if (conn.provider === "google") {
      await workspaceProxyForBusiness(businessId, proxyTarget, {
        endpoint: `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        method: "DELETE"
      });
      return;
    }
    await workspaceProxyForBusiness(businessId, proxyTarget, {
      endpoint: `/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      method: "DELETE"
    });
  } catch (err) {
    logger.warn("shared-calendar: time-off mirror delete failed", {
      businessId,
      eventId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
