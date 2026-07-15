/**
 * First-party Zoom OAuth (authorization-code flow) — the Nango-free primary
 * path for Zoom. This module owns everything that talks to zoom.us/oauth:
 *
 *   - the signed `state` parameter binding an authorize redirect to a
 *     business (HMAC, 10-minute expiry, no server-side session storage);
 *   - the authorize-URL builder for /api/integrations/zoom/connect;
 *   - code exchange, refresh (Zoom ROTATES refresh tokens), and revoke;
 *   - the users/me profile fetch used to label the dashboard card.
 *
 * Credentials come from ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET (the published
 * "New Coworker OAuth" Marketplace app); the redirect URI is derived from
 * NEXT_PUBLIC_APP_URL so dev/prod each register their own callback.
 */
import { createHmac, randomBytes, timingSafeEqual } from "crypto";

export const ZOOM_OAUTH_BASE_URL = "https://zoom.us/oauth";
export const ZOOM_API_BASE_URL = "https://api.zoom.us/v2";
/** Outbound budget per OAuth/API call — fail fast on a stuck upstream. */
export const ZOOM_REQUEST_TIMEOUT_MS = 15_000;
/** Authorize round-trips older than this are refused. */
export const ZOOM_STATE_TTL_MS = 10 * 60 * 1000;

export class ZoomOAuthError extends Error {
  constructor(
    public readonly code:
      | "not_configured"
      | "invalid_grant"
      | "request_failed"
      | "upstream_timeout"
      | "upstream_unreachable",
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "ZoomOAuthError";
  }
}

export type ZoomOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

/** Env-derived OAuth config; throws `not_configured` when incomplete. */
export function getZoomOAuthConfig(): ZoomOAuthConfig {
  const clientId = process.env.ZOOM_CLIENT_ID;
  const clientSecret = process.env.ZOOM_CLIENT_SECRET;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!clientId || !clientSecret || !appUrl) {
    throw new ZoomOAuthError(
      "not_configured",
      "Zoom OAuth is not configured (ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET / NEXT_PUBLIC_APP_URL)"
    );
  }
  return {
    clientId,
    clientSecret,
    redirectUri: `${appUrl.replace(/\/+$/, "")}/api/integrations/zoom/callback`
  };
}

function stateKey(): Buffer {
  // Same key source as the integration-secret envelope: a dedicated key when
  // set, else the service-role key (always present server-side).
  const secret =
    process.env.INTEGRATIONS_ENCRYPTION_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) {
    throw new ZoomOAuthError(
      "not_configured",
      "No key available to sign the Zoom OAuth state"
    );
  }
  return createHmac("sha256", "zoom-oauth-state").update(secret).digest();
}

function signStatePayload(payload: string): string {
  return createHmac("sha256", stateKey()).update(payload).digest("base64url");
}

/** Opaque, signed state: base64url(JSON{businessId, exp, nonce}) + "." + HMAC. */
export function createZoomOAuthState(businessId: string, now = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({
      b: businessId,
      e: now + ZOOM_STATE_TTL_MS,
      n: randomBytes(8).toString("base64url")
    }),
    "utf8"
  ).toString("base64url");
  return `${payload}.${signStatePayload(payload)}`;
}

/** Verifies signature + expiry; returns the bound businessId or null. */
export function verifyZoomOAuthState(
  state: string,
  now = Date.now()
): { businessId: string } | null {
  const dot = state.indexOf(".");
  if (dot <= 0 || dot === state.length - 1) return null;
  const payload = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = signStatePayload(payload);
  const sigBuf = Buffer.from(sig, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }
  let parsed: { b?: unknown; e?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed.b !== "string" || typeof parsed.e !== "number") return null;
  if (parsed.e < now) return null;
  return { businessId: parsed.b };
}

/** Where /api/integrations/zoom/connect sends the owner's browser. */
export function buildZoomAuthorizeUrl(state: string): string {
  const config = getZoomOAuthConfig();
  const url = new URL(`${ZOOM_OAUTH_BASE_URL}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export type ZoomTokenSet = {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
};

async function tokenEndpointRequest(
  params: URLSearchParams,
  now: number
): Promise<ZoomTokenSet> {
  const config = getZoomOAuthConfig();
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`, "utf8").toString(
    "base64"
  );

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), ZOOM_REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${ZOOM_OAUTH_BASE_URL}/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString(),
      signal: ac.signal
    });
  } catch (err) {
    const aborted = (err as Error)?.name === "AbortError";
    throw new ZoomOAuthError(
      aborted ? "upstream_timeout" : "upstream_unreachable",
      aborted ? "Zoom OAuth timed out" : "Zoom OAuth unreachable"
    );
  } finally {
    clearTimeout(timeout);
  }

  const body = (await res.json().catch(() => null)) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    reason?: string;
    error?: string;
  } | null;

  if (!res.ok || !body?.access_token || !body.refresh_token) {
    // Zoom reports a consumed/revoked grant as HTTP 400 with error/reason —
    // callers deactivate the connection on this instead of retry-looping.
    const invalidGrant = res.status === 400 || res.status === 401;
    throw new ZoomOAuthError(
      invalidGrant ? "invalid_grant" : "request_failed",
      `Zoom token endpoint failed (${res.status}${body?.reason ? `: ${body.reason}` : ""})`,
      res.status
    );
  }

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: new Date(now + (body.expires_in ?? 3600) * 1000)
  };
}

/** Authorization-code exchange (the callback route). */
export async function exchangeZoomAuthCode(
  code: string,
  now = Date.now()
): Promise<ZoomTokenSet> {
  const config = getZoomOAuthConfig();
  return tokenEndpointRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri
    }),
    now
  );
}

/**
 * Refresh-token exchange. Zoom ROTATES the refresh token: the returned set
 * contains a NEW refresh token and the presented one is dead — persist the
 * new pair before using the access token.
 */
export async function refreshZoomTokens(
  refreshToken: string,
  now = Date.now()
): Promise<ZoomTokenSet> {
  return tokenEndpointRequest(
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
    now
  );
}

/** Best-effort revoke on disconnect. Never throws. */
export async function revokeZoomToken(accessToken: string): Promise<boolean> {
  let config: ZoomOAuthConfig;
  try {
    config = getZoomOAuthConfig();
  } catch {
    return false;
  }
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`, "utf8").toString(
    "base64"
  );
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), ZOOM_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${ZOOM_OAUTH_BASE_URL}/revoke`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({ token: accessToken }).toString(),
      signal: ac.signal
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export type ZoomUserProfile = {
  zoomUserId: string | null;
  email: string | null;
  displayName: string | null;
};

/**
 * GET /users/me with a fresh access token — labels the dashboard card.
 * Returns null on 401/403 (token rejected); throws on other failures.
 */
export async function fetchZoomUserProfile(
  accessToken: string
): Promise<ZoomUserProfile | null> {
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), ZOOM_REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${ZOOM_API_BASE_URL}/users/me`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      signal: ac.signal
    });
  } catch (err) {
    const aborted = (err as Error)?.name === "AbortError";
    throw new ZoomOAuthError(
      aborted ? "upstream_timeout" : "upstream_unreachable",
      aborted ? "Zoom API timed out" : "Zoom API unreachable"
    );
  } finally {
    clearTimeout(timeout);
  }

  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) {
    throw new ZoomOAuthError(
      "request_failed",
      `Zoom users/me failed (${res.status})`,
      res.status
    );
  }
  const body = (await res.json().catch(() => null)) as {
    id?: string;
    email?: string;
    display_name?: string;
    first_name?: string;
    last_name?: string;
  } | null;
  const assembled = [body?.first_name, body?.last_name].filter(Boolean).join(" ");
  return {
    zoomUserId: typeof body?.id === "string" ? body.id : null,
    email: typeof body?.email === "string" ? body.email : null,
    displayName:
      typeof body?.display_name === "string" && body.display_name.length > 0
        ? body.display_name
        : assembled.length > 0
          ? assembled
          : null
  };
}
