/**
 * Direct Zoom API client (first-party OAuth transport).
 *
 * `getZoomAccessToken` is the token manager: it returns a live access token
 * for the business's direct connection, refreshing when <60s of validity
 * remain. Zoom ROTATES refresh tokens (the presented token is single-use),
 * so refreshes are single-flighted per business and the new pair is
 * persisted BEFORE the access token is handed out — two concurrent callers
 * racing a rotation would otherwise strand the connection.
 *
 * `zoomApiRequest` mirrors the calendly-direct contract so a future
 * dual-transport resolver can treat Nango-proxied and direct responses
 * interchangeably:
 *   - 401/403 → null (revoked token — "not connected" semantics);
 *   - other non-2xx → throw ZoomApiError("request_failed");
 *   - timeouts/network failures → throw with a typed code.
 */
import { logger } from "@/lib/logger";
import {
  getZoomConnection,
  setZoomConnectionActive,
  updateZoomTokens
} from "@/lib/db/zoom-connections";
import { refreshZoomTokens, ZOOM_API_BASE_URL, ZoomOAuthError } from "@/lib/zoom/oauth";

/** Refresh when less than this much validity remains. */
export const ZOOM_TOKEN_REFRESH_MARGIN_MS = 60_000;
/** Outbound budget per API call — fail fast on a stuck upstream. */
export const ZOOM_API_TIMEOUT_MS = 15_000;

export class ZoomApiError extends Error {
  constructor(
    public readonly code: "request_failed" | "upstream_timeout" | "upstream_unreachable",
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "ZoomApiError";
  }
}

/**
 * In-flight refreshes keyed by business — every concurrent caller awaits the
 * same rotation instead of burning the single-use refresh token twice.
 */
const inflightRefreshes = new Map<string, Promise<string | null>>();

/** Test-only: reset the single-flight table between cases. */
export function resetZoomRefreshStateForTests(): void {
  inflightRefreshes.clear();
}

async function refreshAndPersist(
  businessId: string,
  refreshToken: string
): Promise<string | null> {
  let tokens;
  try {
    tokens = await refreshZoomTokens(refreshToken);
  } catch (err) {
    if (err instanceof ZoomOAuthError && err.code === "invalid_grant") {
      // Revoked / already-consumed refresh token: the connection is dead
      // until the owner reconnects. Deactivate so the dashboard says so and
      // callers stop retrying a grant Zoom will never honor again.
      logger.warn("zoom refresh token rejected; deactivating connection", {
        businessId
      });
      await setZoomConnectionActive(businessId, false);
      return null;
    }
    throw err;
  }
  // Persist the rotated pair BEFORE handing the access token out — the old
  // refresh token is already dead on Zoom's side.
  await updateZoomTokens(businessId, tokens);
  return tokens.accessToken;
}

/**
 * A live access token for the business's ACTIVE direct connection, or null
 * when there is no usable connection (none stored, soft-disabled, or the
 * refresh grant was rejected). Transient refresh failures throw.
 */
export async function getZoomAccessToken(
  businessId: string,
  now = Date.now()
): Promise<string | null> {
  const row = await getZoomConnection(businessId);
  if (!row || !row.is_active) return null;

  const expiresAt = new Date(row.token_expires_at).getTime();
  if (Number.isFinite(expiresAt) && expiresAt - now > ZOOM_TOKEN_REFRESH_MARGIN_MS) {
    return row.accessToken;
  }

  const existing = inflightRefreshes.get(businessId);
  if (existing) return existing;

  const refresh = refreshAndPersist(businessId, row.refreshToken).finally(() => {
    inflightRefreshes.delete(businessId);
  });
  inflightRefreshes.set(businessId, refresh);
  return refresh;
}

export type ZoomApiRequestSpec = {
  /** Path on api.zoom.us/v2, e.g. "/users/me/meetings". */
  endpoint: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  params?: Record<string, string>;
  data?: unknown;
};

/**
 * Authenticated JSON call with the resolver-compatible contract described
 * in the module doc. 204s resolve to `{ data: null }`.
 */
export async function zoomApiRequest(
  accessToken: string,
  req: ZoomApiRequestSpec
): Promise<{ data: unknown } | null> {
  const url = new URL(`${ZOOM_API_BASE_URL}${req.endpoint}`);
  for (const [k, v] of Object.entries(req.params ?? {})) {
    url.searchParams.set(k, v);
  }

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), ZOOM_API_TIMEOUT_MS);
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
    throw new ZoomApiError(
      aborted ? "upstream_timeout" : "upstream_unreachable",
      aborted ? "Zoom API timed out" : "Zoom API unreachable"
    );
  } finally {
    clearTimeout(timeout);
  }

  if (res.status === 401 || res.status === 403) {
    // Revoked / insufficient token: same "not connected" semantics as a
    // stale Nango link.
    return null;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.warn("zoom direct api call failed", {
      endpoint: req.endpoint,
      status: res.status,
      body: text.slice(0, 300)
    });
    throw new ZoomApiError(
      "request_failed",
      `Zoom API ${req.method} ${req.endpoint} failed (${res.status})`,
      res.status
    );
  }
  if (res.status === 204) return { data: null };
  return { data: await res.json().catch(() => null) };
}

/**
 * Convenience: resolve the business's token (refreshing as needed) and make
 * the call. Null when the business has no usable direct connection.
 */
export async function zoomRequestForBusiness(
  businessId: string,
  req: ZoomApiRequestSpec
): Promise<{ data: unknown } | null> {
  const accessToken = await getZoomAccessToken(businessId);
  if (accessToken === null) return null;
  return zoomApiRequest(accessToken, req);
}
