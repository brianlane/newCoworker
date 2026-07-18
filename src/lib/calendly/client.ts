/**
 * Direct Calendly API client (Personal Access Token transport).
 *
 * The zero-setup sibling of the Nango OAuth path: requests go straight to
 * api.calendly.com with the tenant's PAT as the bearer. The response shape
 * (`{ data }` or null) deliberately matches what the Nango proxy returns to
 * the calendar-tools Calendly cores, so both transports are interchangeable
 * there:
 *   - 401/403 → null (revoked/wrong token — same "not connected" semantics
 *     as a stale Nango link);
 *   - other non-2xx → throw (mapped by handlers.ts to calendar_lookup_failed
 *     / calendar_book_failed);
 *   - timeouts/network failures → throw with a typed code.
 */
import { logger } from "@/lib/logger";

export const CALENDLY_API_BASE_URL = "https://api.calendly.com";
/** Outbound budget per API call — fail fast on a stuck upstream. */
export const CALENDLY_REQUEST_TIMEOUT_MS = 15_000;

export class CalendlyApiError extends Error {
  constructor(
    public readonly code: "request_failed" | "upstream_timeout" | "upstream_unreachable",
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "CalendlyApiError";
  }
}

export type CalendlyDirectRequest = {
  /** Path on api.calendly.com, e.g. "/users/me". */
  endpoint: string;
  method: "GET" | "POST" | "DELETE";
  params?: Record<string, string>;
  data?: unknown;
};

/**
 * Authenticated JSON call with the Nango-proxy-compatible contract
 * described in the module doc.
 */
export async function calendlyDirectRequest(
  accessToken: string,
  req: CalendlyDirectRequest
): Promise<{ data: unknown } | null> {
  const url = new URL(`${CALENDLY_API_BASE_URL}${req.endpoint}`);
  for (const [k, v] of Object.entries(req.params ?? {})) {
    url.searchParams.set(k, v);
  }

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), CALENDLY_REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: req.method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...(req.data === undefined ? {} : { "Content-Type": "application/json" })
      },
      ...(req.data === undefined ? {} : { body: JSON.stringify(req.data) }),
      signal: ac.signal
    });
  } catch (err) {
    const aborted = (err as Error)?.name === "AbortError";
    throw new CalendlyApiError(
      aborted ? "upstream_timeout" : "upstream_unreachable",
      aborted ? "Calendly API timed out" : "Calendly API unreachable"
    );
  } finally {
    clearTimeout(timeout);
  }

  if (res.status === 401 || res.status === 403) {
    // Revoked / wrong PAT: same semantics as a stale Nango link.
    return null;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.warn("calendly direct api call failed", {
      endpoint: req.endpoint,
      status: res.status,
      body: text.slice(0, 300)
    });
    throw new CalendlyApiError(
      "request_failed",
      `Calendly API ${req.method} ${req.endpoint} failed (${res.status})`,
      res.status
    );
  }
  return { data: await res.json().catch(() => null) };
}

export type CalendlyTokenVerification =
  | { ok: true; name: string | null; email: string | null }
  | { ok: false; reason: "invalid_token" | "request_failed" };

/**
 * Verify a PAT end-to-end (GET /users/me) and capture the connected
 * account's identity for the dashboard card. Never throws — the connect
 * flow reports the outcome instead of 500ing.
 */
export async function verifyCalendlyToken(
  accessToken: string
): Promise<CalendlyTokenVerification> {
  try {
    const res = await calendlyDirectRequest(accessToken, {
      endpoint: "/users/me",
      method: "GET"
    });
    if (!res) return { ok: false, reason: "invalid_token" };
    const resource = (res.data as { resource?: { name?: string; email?: string } })
      ?.resource;
    return {
      ok: true,
      name: typeof resource?.name === "string" ? resource.name : null,
      email: typeof resource?.email === "string" ? resource.email : null
    };
  } catch {
    return { ok: false, reason: "request_failed" };
  }
}
