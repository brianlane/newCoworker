/**
 * Cal.com API v2 calls for a stored OAuth connection.
 *
 * Slot search and booking creation are the calendar-tool path. Event types
 * pick which booking link Quinn uses. Webhooks tell the platform when
 * someone books on the Cal.com page itself.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { CalOAuthError, refreshCalTokens } from "@/lib/cal/oauth";
import {
  getCalConnectionById,
  markCalHealthy,
  updateCalTokens,
  type CalConnectionRow
} from "@/lib/db/cal-connections";
import { markConnectionNeedsReauth } from "@/lib/connections/reauth";

export const CAL_API_BASE = "https://api.cal.com/v2";
export const CAL_API_VERSION_SLOTS = "2024-09-04";
export const CAL_API_VERSION_BOOKINGS = "2024-08-13";
export const CAL_API_VERSION_EVENT_TYPES = "2024-06-14";
export const CAL_API_VERSION_ME = "2024-06-14";
export const CAL_API_VERSION_WEBHOOKS = "2024-06-14";
export const CAL_SIGNATURE_HEADER = "x-cal-signature-256";

export class CalApiError extends Error {
  constructor(
    public readonly code: "needs_reauth" | "request_failed" | "upstream_timeout" | "upstream_unreachable",
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "CalApiError";
  }
}

export type CalEventType = {
  id: string;
  title: string;
  lengthMinutes: number;
};

export type CalProfile = {
  id: string | null;
  email: string | null;
  name: string | null;
  username: string | null;
  timeZone: string | null;
};

export function selectCalEventType(
  types: CalEventType[],
  pinnedId: string | null | undefined,
  durationMinutes: number
): CalEventType | "no_types" {
  if (types.length === 0) return "no_types";
  const pinned = pinnedId?.trim();
  if (pinned) {
    const found = types.find((t) => t.id === pinned);
    if (found) return found;
  }
  if (types.length === 1) return types[0];
  let best = types[0];
  let bestDelta = Math.abs(best.lengthMinutes - durationMinutes);
  for (const type of types.slice(1)) {
    const delta = Math.abs(type.lengthMinutes - durationMinutes);
    if (delta < bestDelta) {
      best = type;
      bestDelta = delta;
    }
  }
  return best;
}

export function parseCalEventTypes(body: unknown): CalEventType[] {
  const data = asRecord(body).data;
  const list = Array.isArray(data)
    ? data
    : Array.isArray(asRecord(data).eventTypes)
      ? (asRecord(data).eventTypes as unknown[])
      : [];
  const out: CalEventType[] = [];
  for (const item of list) {
    const row = asRecord(item);
    const id = row.id;
    const title = typeof row.title === "string" ? row.title : typeof row.slug === "string" ? row.slug : "";
    const length =
      typeof row.lengthInMinutes === "number"
        ? row.lengthInMinutes
        : typeof row.length === "number"
          ? row.length
          : 30;
    if ((typeof id === "number" || typeof id === "string") && title) {
      out.push({ id: String(id), title, lengthMinutes: length });
    }
  }
  return out;
}

export function parseCalProfile(body: unknown): CalProfile {
  const data = asRecord(asRecord(body).data ?? body);
  const id = data.id;
  return {
    id: typeof id === "number" || typeof id === "string" ? String(id) : null,
    email: nonEmpty(data.email),
    name: nonEmpty(data.name),
    username: nonEmpty(data.username),
    timeZone: nonEmpty(data.timeZone) ?? nonEmpty(data.timeFormat)
  };
}

/** Slots keyed by local date, each `{ start }` an ISO instant. */
export function parseCalSlots(body: unknown): string[] {
  const data = asRecord(asRecord(body).data);
  const starts: string[] = [];
  for (const value of Object.values(data)) {
    if (!Array.isArray(value)) continue;
    for (const slot of value) {
      const start = asRecord(slot).start;
      if (typeof start === "string" && start.length > 0) starts.push(start);
    }
  }
  starts.sort();
  return starts;
}

export function parseCalBookingId(body: unknown): string | null {
  const data = asRecord(asRecord(body).data ?? body);
  const uid = data.uid ?? data.id;
  return typeof uid === "string" || typeof uid === "number" ? String(uid) : null;
}

export function verifyCalWebhookSignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const given = header.trim().toLowerCase().replace(/^sha256=/, "");
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function authorizedFetch(
  conn: CalConnectionRow,
  path: string,
  apiVersion: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown }> {
  let token = conn.accessToken;
  if (conn.needs_reauth || token.length === 0) {
    throw new CalApiError("needs_reauth", "Cal.com connection needs a reconnect");
  }
  const expiresMs = Date.parse(conn.token_expires_at);
  if (!Number.isFinite(expiresMs) || expiresMs - Date.now() < 60_000) {
    token = await refreshStoredToken(conn);
  }
  return fetchOnce(token, path, apiVersion, init, conn);
}

async function refreshStoredToken(conn: CalConnectionRow): Promise<string> {
  try {
    const next = await refreshCalTokens(conn.refreshToken);
    await updateCalTokens(conn.id, next);
    conn.accessToken = next.accessToken;
    conn.refreshToken = next.refreshToken;
    conn.token_expires_at = next.expiresAt.toISOString();
    return next.accessToken;
  } catch (err) {
    if (err instanceof CalOAuthError && err.code === "invalid_grant") {
      await markConnectionNeedsReauth("cal_connections", conn.id);
      throw new CalApiError("needs_reauth", "Cal.com refresh token was rejected", err.status);
    }
    throw err;
  }
}

async function fetchOnce(
  token: string,
  path: string,
  apiVersion: string,
  init: RequestInit,
  conn: CalConnectionRow
): Promise<{ status: number; body: unknown }> {
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(`${CAL_API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "cal-api-version": apiVersion,
        "Content-Type": "application/json",
        ...(init.headers ?? {})
      },
      signal: ac.signal
    });
  } catch (err) {
    const aborted = (err as Error)?.name === "AbortError";
    throw new CalApiError(
      aborted ? "upstream_timeout" : "upstream_unreachable",
      aborted ? "Cal.com timed out" : "Cal.com unreachable"
    );
  } finally {
    clearTimeout(timeout);
  }
  const body = await res.json().catch(() => null);
  if (res.status === 401) {
    await markConnectionNeedsReauth("cal_connections", conn.id);
    throw new CalApiError("needs_reauth", "Cal.com rejected the access token", 401);
  }
  if (!res.ok) {
    throw new CalApiError("request_failed", `Cal.com ${path} failed (${res.status})`, res.status);
  }
  await markCalHealthy(conn.id);
  return { status: res.status, body };
}

export async function fetchCalProfile(accessToken: string): Promise<CalProfile> {
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 15_000);
  try {
    const res = await fetch(`${CAL_API_BASE}/me`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "cal-api-version": CAL_API_VERSION_ME
      },
      signal: ac.signal
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) return { id: null, email: null, name: null, username: null, timeZone: null };
    return parseCalProfile(body);
  } catch {
    return { id: null, email: null, name: null, username: null, timeZone: null };
  } finally {
    clearTimeout(timeout);
  }
}

export async function listCalEventTypes(conn: CalConnectionRow): Promise<CalEventType[]> {
  const { body } = await authorizedFetch(conn, "/event-types", CAL_API_VERSION_EVENT_TYPES);
  return parseCalEventTypes(body);
}

export async function listCalSlotStarts(
  conn: CalConnectionRow,
  args: { eventTypeId: string; startIso: string; endIso: string; timeZone: string }
): Promise<string[]> {
  const params = new URLSearchParams({
    eventTypeId: args.eventTypeId,
    start: args.startIso,
    end: args.endIso,
    timeZone: args.timeZone
  });
  const { body } = await authorizedFetch(
    conn,
    `/slots?${params.toString()}`,
    CAL_API_VERSION_SLOTS,
    { method: "GET" }
  );
  return parseCalSlots(body);
}

export async function createCalBooking(
  conn: CalConnectionRow,
  args: {
    eventTypeId: string;
    startIso: string;
    name: string;
    email: string;
    timeZone: string;
    phone: string | null;
    notes: string | null;
  }
): Promise<string | null> {
  const attendee: Record<string, string> = {
    name: args.name,
    email: args.email,
    timeZone: args.timeZone
  };
  if (args.phone) attendee.phoneNumber = args.phone;
  const payload: Record<string, unknown> = {
    start: args.startIso,
    eventTypeId: Number(args.eventTypeId) || args.eventTypeId,
    attendee
  };
  if (args.notes) payload.metadata = { notes: args.notes };
  const { body } = await authorizedFetch(conn, "/bookings", CAL_API_VERSION_BOOKINGS, {
    method: "POST",
    body: JSON.stringify(payload)
  });
  return parseCalBookingId(body);
}

export async function cancelCalBooking(conn: CalConnectionRow, bookingUid: string): Promise<void> {
  await authorizedFetch(conn, `/bookings/${encodeURIComponent(bookingUid)}/cancel`, CAL_API_VERSION_BOOKINGS, {
    method: "POST",
    body: JSON.stringify({ cancellationReason: "Canceled by the AI coworker" })
  });
}

export async function rescheduleCalBooking(
  conn: CalConnectionRow,
  bookingUid: string,
  startIso: string
): Promise<string | null> {
  const { body } = await authorizedFetch(
    conn,
    `/bookings/${encodeURIComponent(bookingUid)}/reschedule`,
    CAL_API_VERSION_BOOKINGS,
    {
      method: "POST",
      body: JSON.stringify({ start: startIso })
    }
  );
  return parseCalBookingId(body) ?? bookingUid;
}

export async function createCalWebhook(
  conn: CalConnectionRow,
  args: { subscriberUrl: string; secret: string }
): Promise<string | null> {
  const { body } = await authorizedFetch(conn, "/webhooks", CAL_API_VERSION_WEBHOOKS, {
    method: "POST",
    body: JSON.stringify({
      subscriberUrl: args.subscriberUrl,
      triggers: ["BOOKING_CREATED", "BOOKING_CANCELLED", "BOOKING_RESCHEDULED"],
      active: true,
      secret: args.secret
    })
  });
  return parseCalBookingId(body);
}

export async function loadCalConnectionForTools(connectionId: string): Promise<CalConnectionRow | null> {
  return getCalConnectionById(connectionId);
}
