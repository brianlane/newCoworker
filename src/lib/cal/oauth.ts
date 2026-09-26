/**
 * First-party Cal.com OAuth (authorization-code flow). No Nango.
 *
 * Credentials are CAL_CO_CLIENT_ID / CAL_CO_CLIENT_SECRET. The redirect URI
 * is derived from NEXT_PUBLIC_APP_URL and must match the URI registered on
 * the Cal.com OAuth client:
 * https://www.newcoworker.com/api/integrations/cal/callback
 */
import { createOAuthStateCodec } from "@/lib/oauth/state";

const CAL_AUTHORIZE_URL = "https://app.cal.com/auth/oauth2/authorize";
const CAL_TOKEN_URL = "https://api.cal.com/v2/auth/oauth2/token";
const CAL_REQUEST_TIMEOUT_MS = 15_000;
const CAL_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Scopes enabled on the OAuth client. Booking and availability, profile
 * label, webhooks, and the team reads a team event type needs. No credit
 * spend, no profile edits, no org admin.
 */
const CAL_OAUTH_SCOPES = [
  "EVENT_TYPE_READ",
  "BOOKING_READ",
  "BOOKING_WRITE",
  "SCHEDULE_READ",
  "PROFILE_READ",
  "WEBHOOK_READ",
  "WEBHOOK_WRITE",
  "TEAM_EVENT_TYPE_READ",
  "TEAM_BOOKING_READ",
  "TEAM_BOOKING_WRITE",
  "TEAM_SCHEDULE_READ",
  "TEAM_PROFILE_READ"
] as const;

export class CalOAuthError extends Error {
  constructor(
    public readonly code: "not_configured" | "invalid_grant" | "request_failed" | "upstream_timeout" | "upstream_unreachable",
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "CalOAuthError";
  }
}

type CalOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

function getCalOAuthConfig(): CalOAuthConfig {
  const clientId = process.env.CAL_CO_CLIENT_ID;
  const clientSecret = process.env.CAL_CO_CLIENT_SECRET;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!clientId || !clientSecret || !appUrl) {
    throw new CalOAuthError(
      "not_configured",
      "Cal.com OAuth is not configured (CAL_CO_CLIENT_ID / CAL_CO_CLIENT_SECRET / NEXT_PUBLIC_APP_URL)"
    );
  }
  return {
    clientId,
    clientSecret,
    redirectUri: `${appUrl.replace(/\/+$/, "")}/api/integrations/cal/callback`
  };
}

const stateCodec = createOAuthStateCodec({
  label: "cal-oauth-state",
  ttlMs: CAL_STATE_TTL_MS,
  onMissingSecret: () =>
    new CalOAuthError("not_configured", "No key available to sign the Cal.com OAuth state")
});

export function createCalOAuthState(businessId: string, now = Date.now()): string {
  return stateCodec.create(businessId, undefined, now);
}

export function verifyCalOAuthState(
  state: string,
  now = Date.now()
): { businessId: string } | null {
  const parsed = stateCodec.verify(state, now);
  if (!parsed) return null;
  return { businessId: parsed.businessId };
}

export function buildCalAuthorizeUrl(state: string): string {
  const config = getCalOAuthConfig();
  const url = new URL(CAL_AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", CAL_OAUTH_SCOPES.join(" "));
  return url.toString();
}

export type CalTokenSet = {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
};

type TokenBody = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
};

function parseCalTokenResponse(
  status: number,
  body: TokenBody | null,
  previousRefreshToken: string | null,
  now: number
): CalTokenSet {
  if (!body?.access_token || status < 200 || status >= 300) {
    const invalidGrant = body?.error === "invalid_grant";
    throw new CalOAuthError(
      invalidGrant ? "invalid_grant" : "request_failed",
      `Cal.com token endpoint failed (${status}${body?.error ? `: ${body.error}` : ""})`,
      status
    );
  }
  const refreshToken = body.refresh_token ?? previousRefreshToken;
  if (!refreshToken) {
    throw new CalOAuthError("request_failed", "Cal.com token response had no refresh token", status);
  }
  const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 1800;
  return {
    accessToken: body.access_token,
    refreshToken,
    expiresAt: new Date(now + expiresIn * 1000)
  };
}

async function postToken(payload: Record<string, string>, now: number, previousRefresh: string | null): Promise<CalTokenSet> {
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), CAL_REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(CAL_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ac.signal
    });
  } catch (err) {
    const aborted = (err as Error)?.name === "AbortError";
    throw new CalOAuthError(
      aborted ? "upstream_timeout" : "upstream_unreachable",
      aborted ? "Cal.com OAuth timed out" : "Cal.com OAuth unreachable"
    );
  } finally {
    clearTimeout(timeout);
  }
  const body = (await res.json().catch(() => null)) as TokenBody | null;
  return parseCalTokenResponse(res.status, body, previousRefresh, now);
}

export async function exchangeCalAuthCode(code: string, now = Date.now()): Promise<CalTokenSet> {
  const config = getCalOAuthConfig();
  return postToken(
    {
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri
    },
    now,
    null
  );
}

export async function refreshCalTokens(
  refreshToken: string,
  now = Date.now()
): Promise<CalTokenSet> {
  const config = getCalOAuthConfig();
  return postToken(
    {
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken
    },
    now,
    refreshToken
  );
}
