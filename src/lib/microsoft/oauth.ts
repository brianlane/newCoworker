/**
 * First-party Microsoft OAuth (authorization-code flow), the Nango-free path
 * for Outlook mail and calendar. This module owns everything that talks to
 * login.microsoftonline.com:
 *
 *   - the signed `state` parameter binding an authorize redirect to a business
 *     (HMAC, 10-minute expiry, no server-side session storage);
 *   - the authorize-URL builder for /api/integrations/microsoft/connect;
 *   - code exchange and refresh (Microsoft ROTATES refresh tokens);
 *   - the Graph /me fetch that labels the dashboard card.
 *
 * Credentials come from MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET; the
 * redirect URI is derived from NEXT_PUBLIC_APP_URL so dev and prod each
 * register their own callback.
 *
 * THREE PLACES THIS DELIBERATELY DIVERGES FROM src/lib/zoom/oauth.ts, which is
 * otherwise the template:
 *
 * 1. `common` authority. It is the only value that admits BOTH personal
 *    Microsoft accounts and work/school tenants. `organizations` excludes
 *    personal, `consumers` excludes work. The app registration must therefore
 *    be signInAudience = AzureADandPersonalMicrosoftAccount.
 * 2. `client_secret_post`, not HTTP Basic. Zoom authenticates the token
 *    endpoint with an Authorization: Basic header; Microsoft expects the id
 *    and secret in the form body. Copying Zoom's header here yields
 *    invalid_client.
 * 3. No PKCE. Microsoft mandates it only for PUBLIC clients (SPA, native). We
 *    are a confidential client with a real client secret, and the state here is
 *    deliberately stateless, so a code_verifier would have to ride to the
 *    browser and back inside the state, which removes the only thing PKCE buys.
 *    If this ever becomes a public client, PKCE stops being optional.
 */
import { createOAuthStateCodec } from "@/lib/oauth/state";

/**
 * `common` = personal Microsoft accounts AND work/school tenants. See the
 * module doc; changing this silently locks out one whole class of owner.
 */
export const MICROSOFT_OAUTH_BASE_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0";
export const GRAPH_API_BASE_URL = "https://graph.microsoft.com";
/** Outbound budget per OAuth/API call: fail fast on a stuck upstream. */
export const MICROSOFT_REQUEST_TIMEOUT_MS = 15_000;
/** Authorize round-trips older than this are refused. */
export const MICROSOFT_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * One grant covering every Graph endpoint the app actually calls.
 *
 * - `offline_access` is what yields a refresh token at all. Without it the
 *   connection dies in an hour with no way to renew.
 * - `Mail.ReadWrite` covers reading the inbox and the organize actions
 *   (isRead, categories, move, and the mailFolders lookups).
 * - `Mail.Send` covers /me/sendMail and /me/messages/{id}/reply.
 * - `Calendars.ReadWrite` covers events, calendarView, and creating the shared
 *   "NewCoworker" calendar.
 * - `Calendars.Read.Shared` is the easy one to miss: /me/calendar/getSchedule
 *   (free/busy) is NOT covered by Calendars.ReadWrite, because the `.Shared`
 *   variants are separate permissions.
 *
 * None of these require admin consent by default, so self-serve connect works
 * for most org tenants; a tenant that disables user consent bounces with
 * AADSTS65001 and needs an admin, which the callback reports as its own case.
 */
export const MICROSOFT_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "User.Read",
  "Mail.ReadWrite",
  "Mail.Send",
  "Calendars.ReadWrite",
  "Calendars.Read.Shared"
] as const;

export class MicrosoftOAuthError extends Error {
  constructor(
    public readonly code:
      | "not_configured"
      | "invalid_grant"
      | "consent_required"
      | "request_failed"
      | "upstream_timeout"
      | "upstream_unreachable",
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "MicrosoftOAuthError";
  }
}

/**
 * Shared signed-state codec (src/lib/oauth/state.ts). Microsoft is the fifth
 * first-party integration; that module was extracted specifically so this one
 * would not be a fifth copy of the same HMAC dance. The label is domain
 * separation: a state minted for Google can never verify here.
 */
const stateCodec = createOAuthStateCodec({
  label: "microsoft-oauth-state",
  ttlMs: MICROSOFT_STATE_TTL_MS,
  onMissingSecret: () =>
    new MicrosoftOAuthError(
      "not_configured",
      "No key available to sign the Microsoft OAuth state"
    )
});

/** Mints a signed state bound to `businessId`. */
export function createMicrosoftOAuthState(businessId: string, now = Date.now()): string {
  return stateCodec.create(businessId, undefined, now);
}

/** Verifies signature then expiry; returns the bound business, or null. */
export function verifyMicrosoftOAuthState(
  state: string,
  now = Date.now()
): { businessId: string } | null {
  return stateCodec.verify(state, now);
}

export type MicrosoftOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

/** Env-derived OAuth config; throws `not_configured` when incomplete. */
export function getMicrosoftOAuthConfig(): MicrosoftOAuthConfig {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!clientId || !clientSecret || !appUrl) {
    throw new MicrosoftOAuthError(
      "not_configured",
      "Microsoft OAuth is not configured (MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET / NEXT_PUBLIC_APP_URL)"
    );
  }
  return {
    clientId,
    clientSecret,
    redirectUri: `${appUrl.replace(/\/+$/, "")}/api/integrations/microsoft/callback`
  };
}

/** True when the Microsoft credentials are present at all. */
export function microsoftOAuthConfigured(): boolean {
  try {
    getMicrosoftOAuthConfig();
    return true;
  } catch {
    return false;
  }
}

/**
 * Where /api/integrations/microsoft/connect sends the owner's browser.
 *
 * `prompt=select_account` so an owner adding a SECOND mailbox is offered the
 * account picker instead of being silently re-connected to the one Microsoft
 * already has a session for. `forceConsent` switches to `prompt=consent`,
 * which is what a deliberate reconnect wants: it re-issues a refresh token
 * even when the grant already exists.
 */
export function buildMicrosoftAuthorizeUrl(
  state: string,
  opts: { forceConsent?: boolean } = {}
): string {
  const config = getMicrosoftOAuthConfig();
  const url = new URL(`${MICROSOFT_OAUTH_BASE_URL}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", MICROSOFT_SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", opts.forceConsent ? "consent" : "select_account");
  return url.toString();
}

/**
 * Where an owner whose tenant blocks user consent sends their admin. Returning
 * from this leg lands on our callback with `admin_consent=True` and NO code,
 * which the callback treats as "now retry the normal authorize", not as a
 * cancellation.
 *
 * `organizations` rather than `common`: admin consent is a work/school concept
 * and the endpoint rejects personal accounts outright.
 */
export function buildMicrosoftAdminConsentUrl(state: string): string {
  const config = getMicrosoftOAuthConfig();
  const url = new URL("https://login.microsoftonline.com/organizations/adminconsent");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export type MicrosoftTokenSet = {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scope: string;
};

async function tokenEndpointRequest(
  params: URLSearchParams,
  now: number
): Promise<MicrosoftTokenSet> {
  const config = getMicrosoftOAuthConfig();
  // client_secret_post: Microsoft wants the credentials in the body. This is
  // the one line NOT to copy from the Zoom module, which uses Basic auth.
  params.set("client_id", config.clientId);
  params.set("client_secret", config.clientSecret);

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), MICROSOFT_REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${MICROSOFT_OAUTH_BASE_URL}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      signal: ac.signal
    });
  } catch (err) {
    const aborted = (err as Error)?.name === "AbortError";
    throw new MicrosoftOAuthError(
      aborted ? "upstream_timeout" : "upstream_unreachable",
      aborted ? "Microsoft OAuth timed out" : "Microsoft OAuth unreachable"
    );
  } finally {
    clearTimeout(timeout);
  }

  const body = (await res.json().catch(() => null)) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  } | null;

  if (!res.ok || !body?.access_token || !body.refresh_token) {
    // Only a genuine dead grant may deactivate a connection. `invalid_client`
    // means OUR credentials are wrong, and an unrelated 400 is a config or
    // request bug; both stay `request_failed` so a mistake on our side never
    // soft-disables tenants whose grants are still valid.
    const error = body?.error;
    const code =
      error === "invalid_grant"
        ? "invalid_grant"
        : error === "consent_required" || error === "interaction_required"
          ? "consent_required"
          : "request_failed";
    throw new MicrosoftOAuthError(
      code,
      `Microsoft token endpoint failed (${res.status}${
        body?.error_description ? `: ${body.error_description}` : ""
      })`,
      res.status
    );
  }

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: new Date(now + (body.expires_in ?? 3600) * 1000),
    // What Microsoft actually granted, which can be narrower than what we
    // asked for. Stored so a missing-permission failure is diagnosable without
    // re-running consent.
    scope: typeof body.scope === "string" ? body.scope : ""
  };
}

/** Authorization-code exchange (the callback route). */
export async function exchangeMicrosoftAuthCode(
  code: string,
  now = Date.now()
): Promise<MicrosoftTokenSet> {
  const config = getMicrosoftOAuthConfig();
  return tokenEndpointRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
      scope: MICROSOFT_SCOPES.join(" ")
    }),
    now
  );
}

/**
 * Refresh-token exchange. Microsoft ROTATES the refresh token: the returned
 * set carries a NEW one, so persist the pair before using the access token.
 */
export async function refreshMicrosoftTokens(
  refreshToken: string,
  now = Date.now()
): Promise<MicrosoftTokenSet> {
  return tokenEndpointRequest(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: MICROSOFT_SCOPES.join(" ")
    }),
    now
  );
}

export type MicrosoftAccountIdentity = {
  accountId: string | null;
  email: string | null;
  displayName: string | null;
};

/**
 * GET /v1.0/me with a fresh access token: which mailbox did they actually
 * connect? The dashboard login that started the flow is NOT the answer, since
 * an owner can connect a mailbox that is not their own login.
 *
 * `mail` is null on accounts with no Exchange mailbox, so fall back to
 * userPrincipalName, matching what the Nango identity probe already does.
 * Returns null on 401/403 (token rejected); throws on other failures.
 */
export async function fetchMicrosoftIdentity(
  accessToken: string
): Promise<MicrosoftAccountIdentity | null> {
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), MICROSOFT_REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${GRAPH_API_BASE_URL}/v1.0/me`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      signal: ac.signal
    });
  } catch (err) {
    const aborted = (err as Error)?.name === "AbortError";
    throw new MicrosoftOAuthError(
      aborted ? "upstream_timeout" : "upstream_unreachable",
      aborted ? "Microsoft Graph timed out" : "Microsoft Graph unreachable"
    );
  } finally {
    clearTimeout(timeout);
  }

  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) {
    throw new MicrosoftOAuthError(
      "request_failed",
      `Microsoft Graph /me failed (${res.status})`,
      res.status
    );
  }
  const body = (await res.json().catch(() => null)) as {
    id?: string;
    mail?: string;
    userPrincipalName?: string;
    displayName?: string;
  } | null;
  const email =
    typeof body?.mail === "string" && body.mail.length > 0
      ? body.mail
      : typeof body?.userPrincipalName === "string" && body.userPrincipalName.length > 0
        ? body.userPrincipalName
        : null;
  return {
    accountId: typeof body?.id === "string" ? body.id : null,
    email,
    displayName:
      typeof body?.displayName === "string" && body.displayName.length > 0
        ? body.displayName
        : null
  };
}
