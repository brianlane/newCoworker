/**
 * First-party Google Workspace OAuth (authorization-code flow).
 *
 * This module owns everything that talks to Google's OAuth endpoints:
 *
 *   - the signed `state` parameter binding an authorize redirect to a business,
 *     via the shared codec in `src/lib/oauth/state.ts`;
 *   - the authorize-URL builder;
 *   - code exchange, refresh, and revoke;
 *   - the strict `invalid_grant` classification the token manager depends on to
 *     decide whether a connection is genuinely dead.
 *
 * It deliberately holds NO database access and no transport wiring, so it can
 * ship and be tested ahead of the storage decisions around it.
 *
 * ## The client is shared, and that is the main hazard
 *
 * `GOOGLE_CLIENT_ID` names the SAME OAuth client that backs "Log in
 * with Google" through Supabase Auth (`src/app/(auth)/login/LoginForm.tsx`) and,
 * until its Google rows finish migrating, Nango's `google` integration. Three
 * consumers, one client, one secret. Changing that client's configuration in the
 * Cloud Console can break site login, not just integrations.
 *
 * Two console facts, confirmed 2026-08-11, that the callback route depends on:
 *
 *   - `https://www.newcoworker.com/api/auth/callback/google` is ALREADY a
 *     registered redirect URI. It outlived the direct-Google code deleted in
 *     Apr 2026, so no console change is needed to ship this.
 *   - Authorized domains are DERIVED from the redirect URI list. Adding a URI
 *     under an existing domain is therefore client config and safe; removing
 *     `https://api.nango.dev/oauth/callback` is a consent-screen change and is
 *     deferred to the June 2027 recertification window, even after the last
 *     Google row goes direct.
 *
 * ## Refresh tokens do not rotate
 *
 * Unlike Zoom (`src/lib/zoom/oauth.ts`), Google does NOT rotate the refresh
 * token: the same one keeps working, and two concurrent refreshes simply yield
 * two independently valid access tokens. The token manager therefore needs no
 * optimistic-concurrency fence, which is the bulk of what makes the Zoom client
 * complicated. Do not add one here by analogy.
 *
 * Real-world behavior worth knowing, since all three live connections are
 * consumer Gmail accounts: refresh tokens die after roughly six months of
 * disuse, a consumer account password change revokes the grant, and Google caps
 * refresh tokens per user/client at around 50. So `invalid_grant` in production
 * is normal rather than exceptional, and the product answer is a reconnect card.
 */
import {
  GOOGLE_WORKSPACE_SCOPES,
  googleWorkspaceScopeParam
} from "./workspace-scopes";
import { createOAuthStateCodec } from "@/lib/oauth/state";

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_API_BASE_URL = "https://www.googleapis.com";
/** Outbound budget per OAuth call: fail fast on a stuck upstream. */
export const GOOGLE_REQUEST_TIMEOUT_MS = 15_000;
/** Authorize round-trips older than this are refused. */
export const GOOGLE_STATE_TTL_MS = 10 * 60 * 1000;

export class GoogleOAuthError extends Error {
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
    this.name = "GoogleOAuthError";
  }
}

const stateCodec = createOAuthStateCodec({
  label: "google-oauth-state",
  ttlMs: GOOGLE_STATE_TTL_MS,
  onMissingSecret: () =>
    new GoogleOAuthError("not_configured", "No key available to sign the Google OAuth state")
});

/** Mints a signed state bound to `businessId`. */
export function createGoogleOAuthState(businessId: string, now = Date.now()): string {
  return stateCodec.create(businessId, undefined, now);
}

/** Verifies signature then expiry; returns the bound business, or null. */
export function verifyGoogleOAuthState(
  state: string,
  now = Date.now()
): { businessId: string } | null {
  const result = stateCodec.verify(state, now);
  return result ? { businessId: result.businessId } : null;
}

export type GoogleOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

/**
 * Reads the client credentials.
 *
 * The redirect URI is a fixed path rather than derived from the request, so a
 * host header cannot steer the callback. It must match a URI registered on the
 * client exactly.
 */
export function getGoogleOAuthConfig(): GoogleOAuthConfig {
  const clientId = (process.env.GOOGLE_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET ?? "").trim();
  if (!clientId || !clientSecret) {
    throw new GoogleOAuthError(
      "not_configured",
      "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set"
    );
  }
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/+$/, "");
  if (!appUrl) {
    throw new GoogleOAuthError("not_configured", "NEXT_PUBLIC_APP_URL is not set");
  }
  return { clientId, clientSecret, redirectUri: `${appUrl}/api/auth/callback/google` };
}

/**
 * The consent-screen URL to send the owner to.
 *
 * `access_type=offline` plus `prompt=consent` is what makes Google return a
 * refresh token. Without both, a re-authorization of an already-granted account
 * returns an access token only, and the connection silently cannot survive its
 * first hour.
 *
 * `include_granted_scopes=false` keeps the request to exactly the frozen set:
 * incremental authorization would let a grant accumulate scopes we never
 * declared, which is the one thing verification cannot survive.
 */
export function buildGoogleAuthorizeUrl(state: string): string {
  const config = getGoogleOAuthConfig();
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: googleWorkspaceScopeParam(),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state
  });
  return `${GOOGLE_AUTHORIZE_URL}?${params.toString()}`;
}

export type GoogleTokenSet = {
  accessToken: string;
  /** Absent on a refresh: Google does not reissue one, and the old one stays valid. */
  refreshToken: string | null;
  expiresAt: Date;
  /**
   * The scopes actually granted, from the token response.
   *
   * Persist THIS, never `GOOGLE_WORKSPACE_SCOPES`, which is what we asked for.
   * Granular consent lets an owner untick boxes, and recording the requested set
   * would claim capabilities the owner never gave.
   */
  grantedScope: string | null;
};

async function tokenEndpointRequest(
  body: URLSearchParams,
  now: number
): Promise<GoogleTokenSet> {
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), GOOGLE_REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: ac.signal
    });
  } catch (err) {
    const aborted = (err as Error)?.name === "AbortError";
    throw new GoogleOAuthError(
      aborted ? "upstream_timeout" : "upstream_unreachable",
      aborted ? "Google token endpoint timed out" : "Google token endpoint unreachable"
    );
  } finally {
    clearTimeout(timeout);
  }

  const payload = (await res.json().catch(() => null)) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  } | null;

  if (!res.ok || !payload?.access_token) {
    // ONLY a genuine dead grant may deactivate a connection. Google answers
    // `invalid_grant` when the owner revoked access, changed a consumer-account
    // password, or the refresh token aged out. `invalid_client` means OUR
    // credentials are wrong, which is exactly what a botched secret rotation
    // looks like: classify it as request_failed so one config mistake cannot
    // soft-disable every tenant whose grant is perfectly healthy.
    const invalidGrant = payload?.error === "invalid_grant";
    const detail = payload?.error_description ?? payload?.error;
    throw new GoogleOAuthError(
      invalidGrant ? "invalid_grant" : "request_failed",
      `Google token endpoint failed (${res.status}${detail ? `: ${detail}` : ""})`,
      res.status
    );
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    expiresAt: new Date(now + (payload.expires_in ?? 3600) * 1000),
    grantedScope: payload.scope ?? null
  };
}

/**
 * Authorization-code exchange, for the callback route.
 *
 * A code exchange that comes back without a refresh token is rejected rather
 * than stored: it means `prompt=consent` did not take, and persisting it would
 * create a connection that dies within the hour with no way to recover except a
 * reconnect the owner has no reason to expect.
 */
export async function exchangeGoogleAuthCode(
  code: string,
  now = Date.now()
): Promise<GoogleTokenSet> {
  const config = getGoogleOAuthConfig();
  const tokens = await tokenEndpointRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri
    }),
    now
  );
  if (!tokens.refreshToken) {
    throw new GoogleOAuthError(
      "request_failed",
      "Google returned no refresh token; the grant would expire within the hour"
    );
  }
  return tokens;
}

/**
 * Refresh exchange.
 *
 * The response carries no `refresh_token`, because Google does not rotate it.
 * `refreshToken` is null in the returned set and callers keep the one they hold.
 */
export async function refreshGoogleTokens(
  refreshToken: string,
  now = Date.now()
): Promise<GoogleTokenSet> {
  const config = getGoogleOAuthConfig();
  return tokenEndpointRequest(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret
    }),
    now
  );
}

/**
 * Best-effort revoke at Google, for owner-initiated disconnect.
 *
 * Returns whether Google acknowledged it. Never throws: a disconnect must
 * succeed locally even when Google is unreachable, otherwise an owner cannot
 * remove a connection during an outage. Revoking the refresh token invalidates
 * the whole grant, access token included.
 *
 * This is what makes Disconnect actually mean disconnected rather than merely
 * forgotten, which is a claim the CASA evidence now makes on our behalf.
 */
export async function revokeGoogleToken(token: string): Promise<boolean> {
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), GOOGLE_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
      signal: ac.signal
    });
    // 400 with invalid_token means it was already revoked or expired, which is
    // the desired end state, so treat it as success rather than a failure the
    // caller has to interpret.
    return res.ok || res.status === 400;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export type GoogleAccountIdentity = {
  /** Stable Google account id (the OIDC `sub`), independent of the address. */
  accountId: string | null;
  email: string | null;
  displayName: string | null;
};

/**
 * Which Google account was actually connected.
 *
 * NOT best-effort labeling. The reconnect match keys on this email, so without
 * it the callback cannot tell a reconnect from a second mailbox, and guessing
 * either strands a live AiFlow binding or burns a connection seat. The callback
 * refuses to write anything when this returns null.
 *
 * The owner's dashboard login is not a substitute: they may well connect a
 * different Google account than the one they signed in with, which is exactly
 * the case that produced the mislabeled rows `debug/backfill-nango-account-identity.ts`
 * had to repair.
 *
 * Returns null on 401/403, meaning the token cannot see its own account, which
 * the caller treats as "ask them to try again" rather than an error.
 */
export async function fetchGoogleIdentity(
  accessToken: string
): Promise<GoogleAccountIdentity | null> {
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), GOOGLE_REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${GOOGLE_API_BASE_URL}/oauth2/v3/userinfo`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      signal: ac.signal
    });
  } catch (err) {
    const aborted = (err as Error)?.name === "AbortError";
    throw new GoogleOAuthError(
      aborted ? "upstream_timeout" : "upstream_unreachable",
      aborted ? "Google userinfo timed out" : "Google userinfo unreachable"
    );
  } finally {
    clearTimeout(timeout);
  }

  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) {
    throw new GoogleOAuthError(
      "request_failed",
      `Google userinfo failed (${res.status})`,
      res.status
    );
  }

  const body = (await res.json().catch(() => null)) as {
    sub?: string;
    email?: string;
    name?: string;
  } | null;
  if (!body) return null;
  return {
    accountId: body.sub ?? null,
    email: body.email ?? null,
    displayName: body.name ?? null
  };
}

/** Re-exported so callers building an authorize flow cannot drift from the frozen set. */
export { GOOGLE_WORKSPACE_SCOPES };
