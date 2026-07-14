/**
 * Vagaro API client: OAuth2 client-credentials token manager + thin typed
 * helpers over the endpoints the calendar tools and dashboard card use.
 *
 * Vagaro issues per-merchant Client ID / Secret pairs; access tokens are
 * short-lived, so we exchange + cache them in-memory per business and
 * re-exchange on expiry or a 401 (one retry). The cache is process-local by
 * design — a cold serverless instance just performs one extra exchange.
 *
 * Endpoint paths follow Vagaro's published v3 API surface. They are
 * intentionally centralized in the constants below so the first live
 * merchant test (API access is gated behind Vagaro's approval) can adjust
 * them in one place.
 */
import { logger } from "@/lib/logger";
import type { VagaroConnectionRow } from "@/lib/db/vagaro-connections";

export const VAGARO_TOKEN_PATH = "/oauth/token";
export const VAGARO_AVAILABILITY_PATH = "/api/v3/availability";
export const VAGARO_APPOINTMENTS_PATH = "/api/v3/appointments";
export const VAGARO_SERVICES_PATH = "/api/v3/services";

/** Outbound budget per API call — fail fast on a stuck upstream. */
export const VAGARO_REQUEST_TIMEOUT_MS = 15_000;
/** Re-exchange when the cached token has less than this long to live. */
const TOKEN_EXPIRY_SLACK_MS = 60_000;
/** Fallback lifetime when the token response omits expires_in. */
const DEFAULT_TOKEN_TTL_S = 600;

export class VagaroApiError extends Error {
  constructor(
    public readonly code:
      | "auth_failed"
      | "request_failed"
      | "upstream_timeout"
      | "upstream_unreachable",
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "VagaroApiError";
  }
}

type CachedToken = { accessToken: string; expiresAtMs: number };

/** Keyed by connection row id so a credential rotation invalidates cleanly. */
const tokenCache = new Map<string, CachedToken>();

/** Test hook: reset the process-local token cache. */
export function clearVagaroTokenCache(): void {
  tokenCache.clear();
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), VAGARO_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } catch (err) {
    const aborted = (err as Error)?.name === "AbortError";
    throw new VagaroApiError(
      aborted ? "upstream_timeout" : "upstream_unreachable",
      aborted ? "Vagaro API timed out" : "Vagaro API unreachable"
    );
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Exchange the merchant credentials for an access token (cached). Throws
 * VagaroApiError("auth_failed") on a rejected exchange — the caller surfaces
 * that as "check your Client ID / Secret".
 */
export async function getVagaroAccessToken(conn: VagaroConnectionRow): Promise<string> {
  const cached = tokenCache.get(conn.id);
  if (cached && cached.expiresAtMs - TOKEN_EXPIRY_SLACK_MS > Date.now()) {
    return cached.accessToken;
  }

  const res = await fetchWithTimeout(`${conn.api_base_url}${VAGARO_TOKEN_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: conn.client_id,
      client_secret: conn.clientSecret
    }).toString()
  });
  if (!res.ok) {
    throw new VagaroApiError(
      "auth_failed",
      `Vagaro token exchange failed (${res.status})`,
      res.status
    );
  }
  const body = (await res.json().catch(() => null)) as {
    access_token?: string;
    expires_in?: number;
  } | null;
  const accessToken = body?.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new VagaroApiError("auth_failed", "Vagaro token exchange returned no access_token");
  }
  const ttlSeconds =
    typeof body?.expires_in === "number" && body.expires_in > 0
      ? body.expires_in
      : DEFAULT_TOKEN_TTL_S;
  tokenCache.set(conn.id, {
    accessToken,
    expiresAtMs: Date.now() + ttlSeconds * 1000
  });
  return accessToken;
}

export type VagaroRequest = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
};

/**
 * Authenticated JSON call. A 401 clears the cached token and retries ONCE
 * with a fresh exchange (expired/revoked token vs bad credentials are
 * indistinguishable until the second attempt fails).
 */
export async function vagaroFetch(
  conn: VagaroConnectionRow,
  req: VagaroRequest,
  retrying = false
): Promise<unknown> {
  const token = await getVagaroAccessToken(conn);
  const url = new URL(`${conn.api_base_url}${req.path}`);
  for (const [k, v] of Object.entries(req.query ?? {})) {
    url.searchParams.set(k, v);
  }
  const res = await fetchWithTimeout(url.toString(), {
    method: req.method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(req.body === undefined ? {} : { "Content-Type": "application/json" })
    },
    ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) })
  });

  if (res.status === 401 && !retrying) {
    tokenCache.delete(conn.id);
    return vagaroFetch(conn, req, true);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.warn("vagaro api call failed", {
      businessId: conn.business_id,
      path: req.path,
      status: res.status,
      body: text.slice(0, 300)
    });
    throw new VagaroApiError(
      res.status === 401 ? "auth_failed" : "request_failed",
      `Vagaro API ${req.method} ${req.path} failed (${res.status})`,
      res.status
    );
  }
  return res.json().catch(() => null);
}

// ── Typed helpers ────────────────────────────────────────────────────────────

export type VagaroSlot = { startIso: string; endIso: string | null };

/** Pull an item array out of the common Vagaro envelope shapes. */
function itemsOf(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) return payload as Array<Record<string, unknown>>;
  const body = payload as { data?: unknown; items?: unknown } | null;
  if (Array.isArray(body?.data)) return body.data as Array<Record<string, unknown>>;
  if (Array.isArray(body?.items)) return body.items as Array<Record<string, unknown>>;
  return [];
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Open appointment slots for a service (optionally a specific provider)
 * inside [startIso, endIso]. Items missing a parseable start are dropped.
 */
export async function searchVagaroAvailability(
  conn: VagaroConnectionRow,
  args: {
    serviceId: string;
    employeeId?: string | null;
    startIso: string;
    endIso: string;
  }
): Promise<VagaroSlot[]> {
  const payload = await vagaroFetch(conn, {
    method: "GET",
    path: VAGARO_AVAILABILITY_PATH,
    query: {
      serviceId: args.serviceId,
      startDate: args.startIso,
      endDate: args.endIso,
      ...(args.employeeId ? { employeeId: args.employeeId } : {})
    }
  });
  const out: VagaroSlot[] = [];
  for (const item of itemsOf(payload)) {
    const start = str(item.startTime) ?? str(item.start) ?? str(item.startDate);
    if (!start || Number.isNaN(Date.parse(start))) continue;
    const end = str(item.endTime) ?? str(item.end) ?? str(item.endDate);
    out.push({
      startIso: new Date(start).toISOString(),
      endIso: end && !Number.isNaN(Date.parse(end)) ? new Date(end).toISOString() : null
    });
  }
  return out;
}

export type VagaroAppointmentInput = {
  serviceId: string;
  employeeId?: string | null;
  startIso: string;
  endIso: string;
  customerName: string;
  customerPhone?: string | null;
  customerEmail?: string | null;
  notes?: string | null;
};

export type VagaroAppointment = { appointmentId: string | null };

/** Create an appointment on the merchant's Vagaro book. */
export async function createVagaroAppointment(
  conn: VagaroConnectionRow,
  input: VagaroAppointmentInput
): Promise<VagaroAppointment> {
  const payload = await vagaroFetch(conn, {
    method: "POST",
    path: VAGARO_APPOINTMENTS_PATH,
    body: {
      serviceId: input.serviceId,
      ...(input.employeeId ? { employeeId: input.employeeId } : {}),
      startTime: input.startIso,
      endTime: input.endIso,
      customer: {
        name: input.customerName,
        ...(input.customerPhone ? { phone: input.customerPhone } : {}),
        ...(input.customerEmail ? { email: input.customerEmail } : {})
      },
      ...(input.notes ? { notes: input.notes } : {})
    }
  });
  const body = payload as { id?: unknown; appointmentId?: unknown; data?: { id?: unknown } } | null;
  const appointmentId =
    str(body?.id) ?? str(body?.appointmentId) ?? str(body?.data?.id);
  return { appointmentId };
}

/**
 * Move an existing appointment to a new time IN PLACE (PUT on the
 * appointment resource) — Vagaro notifies the customer about the change on
 * the same appointment; no second booking is created.
 */
export async function updateVagaroAppointmentTime(
  conn: VagaroConnectionRow,
  appointmentId: string,
  startIso: string,
  endIso: string
): Promise<void> {
  await vagaroFetch(conn, {
    method: "PUT",
    path: `${VAGARO_APPOINTMENTS_PATH}/${encodeURIComponent(appointmentId)}`,
    body: { startTime: startIso, endTime: endIso }
  });
}

/** Cancel an appointment on the merchant's book (single customer notice). */
export async function deleteVagaroAppointment(
  conn: VagaroConnectionRow,
  appointmentId: string
): Promise<void> {
  await vagaroFetch(conn, {
    method: "DELETE",
    path: `${VAGARO_APPOINTMENTS_PATH}/${encodeURIComponent(appointmentId)}`
  });
}

export type VagaroService = {
  id: string;
  name: string;
  /** Minutes; null when the listing omits it. */
  durationMinutes: number | null;
};

/** The merchant's bookable services (dashboard default-service picker). */
export async function listVagaroServices(
  conn: VagaroConnectionRow
): Promise<VagaroService[]> {
  const payload = await vagaroFetch(conn, {
    method: "GET",
    path: VAGARO_SERVICES_PATH
  });
  const out: VagaroService[] = [];
  for (const item of itemsOf(payload)) {
    const id = str(item.id) ?? str(item.serviceId);
    if (!id) continue;
    const duration =
      typeof item.duration === "number" && item.duration > 0 ? item.duration : null;
    out.push({
      id,
      name: str(item.name) ?? str(item.serviceName) ?? "Service",
      durationMinutes: duration
    });
  }
  return out;
}
