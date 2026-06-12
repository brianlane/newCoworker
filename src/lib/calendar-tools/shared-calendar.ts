/**
 * Dedicated "NewCoworker" calendar on the owner's connected account.
 *
 * Bookings move off the owner's primary calendar into a calendar the whole
 * team can see — created lazily via the existing Nango proxy (no new auth),
 * with its id persisted in workspace_oauth_connections.metadata:
 *
 *   metadata.shared_calendar_id   — provider calendar id
 *   metadata.shared_calendar_acl  — emails already granted read access
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

import { nangoProxyForBusiness } from "@/lib/nango/workspace";
import {
  listWorkspaceOAuthConnections,
  upsertWorkspaceOAuthConnection
} from "@/lib/db/workspace-oauth-connections";
import {
  resolveCalendarConnection,
  type ResolvedVoiceConnection
} from "@/lib/voice-tools/connections";
import { listTeamMembers } from "@/lib/db/employees";
import { logger } from "@/lib/logger";

export const SHARED_CALENDAR_NAME = "NewCoworker";

export type SharedCalendarInfo = {
  calendarId: string;
  conn: ResolvedVoiceConnection;
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
  conn: ResolvedVoiceConnection
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
  conn: ResolvedVoiceConnection,
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
    const conn = await resolveCalendarConnection(businessId);
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
 * Employees page share action. Null on any failure — callers fall back to
 * the primary calendar so a Nango hiccup can't block a live booking.
 */
export async function ensureSharedCalendar(
  businessId: string
): Promise<SharedCalendarInfo | null> {
  try {
    const conn = await resolveCalendarConnection(businessId);
    if (!conn) return null;
    const meta = await readConnectionMeta(businessId, conn);
    if (meta.calendarId) return { calendarId: meta.calendarId, conn };

    const proxyTarget = { connectionId: conn.connectionId, providerConfigKey: conn.providerConfigKey };
    let calendarId: string | null = null;
    if (conn.provider === "google") {
      const res = await nangoProxyForBusiness(businessId, proxyTarget, {
        endpoint: "/calendar/v3/calendars",
        method: "POST",
        data: { summary: SHARED_CALENDAR_NAME }
      });
      const data = (res?.data ?? null) as { id?: string } | null;
      calendarId = data?.id ?? null;
    } else {
      const res = await nangoProxyForBusiness(businessId, proxyTarget, {
        endpoint: "/v1.0/me/calendars",
        method: "POST",
        data: { name: SHARED_CALENDAR_NAME }
      });
      const data = (res?.data ?? null) as { id?: string } | null;
      calendarId = data?.id ?? null;
    }
    if (!calendarId) return null;

    await writeConnectionMeta(businessId, conn, {
      ...meta.rowMetadata,
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

/** Current share status for the Employees page ("shared with N employees"). */
export async function sharedCalendarStatus(businessId: string): Promise<SharedCalendarStatus> {
  try {
    const conn = await resolveCalendarConnection(businessId);
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
        const res = await nangoProxyForBusiness(businessId, proxyTarget, {
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
 * Push an all-day "out of office" mirror event for a time-off range. Only
 * mirrors when the shared calendar already exists (adding time off should
 * not create calendars). Returns the provider event id, or null when
 * skipped/failed — strictly display-only either way; routing reads the DB.
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
    const summary = `${memberName} — out of office`;
    const endExclusive = nextDayIsoDate(endsOn);

    if (conn.provider === "google") {
      const res = await nangoProxyForBusiness(businessId, proxyTarget, {
        endpoint: `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
        method: "POST",
        data: {
          summary,
          start: { date: startsOn },
          end: { date: endExclusive },
          transparency: "transparent"
        }
      });
      const data = (res?.data ?? null) as { id?: string } | null;
      return data?.id ?? null;
    }
    const res = await nangoProxyForBusiness(businessId, proxyTarget, {
      endpoint: `/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events`,
      method: "POST",
      data: {
        subject: summary,
        isAllDay: true,
        showAs: "free",
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
      await nangoProxyForBusiness(businessId, proxyTarget, {
        endpoint: `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        method: "DELETE"
      });
      return;
    }
    await nangoProxyForBusiness(businessId, proxyTarget, {
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
