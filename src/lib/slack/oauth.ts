/**
 * First-party Slack OAuth v2 (workspace install flow). This module owns
 * everything that talks to slack.com/oauth and the token lifecycle:
 *
 *   - the signed `state` parameter binding an authorize redirect to a
 *     business (HMAC, 10-minute expiry, no server-side session storage,
 *     same construction as src/lib/zoom/oauth.ts);
 *   - the authorize-URL builder for /api/integrations/slack/connect;
 *   - the oauth.v2.access code exchange (one xoxb bot token per workspace,
 *     no refresh: Slack bot tokens do not expire), and best-effort revoke.
 *
 * Credentials come from SLACK_CLIENT_ID / SLACK_CLIENT_SECRET (the "New
 * Coworker" Slack app created via the App Manifest API); the redirect URI is
 * derived from NEXT_PUBLIC_APP_URL so dev/prod each register their own
 * callback at /api/integrations/slack/callback.
 */
import { createHmac, randomBytes, timingSafeEqual } from "crypto";

export const SLACK_OAUTH_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
export const SLACK_API_BASE_URL = "https://slack.com/api";
/** Outbound budget per OAuth call: fail fast on a stuck upstream. */
export const SLACK_REQUEST_TIMEOUT_MS = 15_000;
/** Authorize round-trips older than this are refused. */
export const SLACK_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Bot scopes requested at install. Keep MINIMAL: the Slack Marketplace
 * review asks for a written reason per scope (docs/SLACK-INTEGRATION.md
 * carries them), and scopes are additive across reinstalls.
 *
 *   assistant:write   the AI-agent surface (status, titles, prompts)
 *   chat:write        post messages as the bot
 *   chat:write.public post alerts into public channels without an invite
 *   channels:read     list public channels (the alert-channel picker)
 *   groups:read       list private channels the bot was invited to (same)
 *   im:history        receive message.im events (DMs with the coworker)
 *   app_mentions:read receive app_mention events in channels
 *   users:read(.email) resolve a Slack user to a verified email, which is
 *                     how the owner is recognized for owner-power tools
 */
export const SLACK_BOT_SCOPES = [
  "assistant:write",
  "chat:write",
  "chat:write.public",
  "channels:read",
  "groups:read",
  "im:history",
  "app_mentions:read",
  "users:read",
  "users:read.email"
] as const;

export class SlackOAuthError extends Error {
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
    this.name = "SlackOAuthError";
  }
}

export type SlackOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

/** Env-derived OAuth config; throws `not_configured` when incomplete. */
export function getSlackOAuthConfig(): SlackOAuthConfig {
  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!clientId || !clientSecret || !appUrl) {
    throw new SlackOAuthError(
      "not_configured",
      "Slack OAuth is not configured (SLACK_CLIENT_ID / SLACK_CLIENT_SECRET / NEXT_PUBLIC_APP_URL)"
    );
  }
  return {
    clientId,
    clientSecret,
    redirectUri: `${appUrl.replace(/\/+$/, "")}/api/integrations/slack/callback`
  };
}

function stateKey(): Buffer {
  // Same key source as the integration-secret envelope: a dedicated key when
  // set, else the service-role key (always present server-side).
  const secret =
    process.env.INTEGRATIONS_ENCRYPTION_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) {
    throw new SlackOAuthError(
      "not_configured",
      "No key available to sign the Slack OAuth state"
    );
  }
  return createHmac("sha256", "slack-oauth-state").update(secret).digest();
}

function signStatePayload(payload: string): string {
  return createHmac("sha256", stateKey()).update(payload).digest("base64url");
}

/**
 * Opaque, signed state: base64url(JSON{businessId, exp, nonce}) + "." + HMAC.
 */
export function createSlackOAuthState(businessId: string, now = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({
      b: businessId,
      e: now + SLACK_STATE_TTL_MS,
      n: randomBytes(8).toString("base64url")
    }),
    "utf8"
  ).toString("base64url");
  return `${payload}.${signStatePayload(payload)}`;
}

/** Verifies signature + expiry; returns the bound business, or null. */
export function verifySlackOAuthState(
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

/** Where /api/integrations/slack/connect sends the owner's browser. */
export function buildSlackAuthorizeUrl(state: string): string {
  const config = getSlackOAuthConfig();
  const url = new URL(SLACK_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("scope", SLACK_BOT_SCOPES.join(","));
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

/** What oauth.v2.access hands back for a workspace install. */
export type SlackInstall = {
  /** Bot token (xoxb-…). Slack bot tokens do not expire. */
  accessToken: string;
  teamId: string;
  teamName: string | null;
  enterpriseId: string | null;
  botUserId: string;
  appId: string;
  /** Comma-separated bot scopes actually granted. */
  scopes: string;
};

/**
 * Authorization-code exchange (the callback route). Slack answers HTTP 200
 * with `ok:false` + an error code on failure, so both the transport status
 * AND the body's `ok` are checked. A consumed/expired code (`invalid_code`,
 * `code_already_used`) maps to `invalid_grant`; everything else is
 * `request_failed`.
 */
export async function exchangeSlackAuthCode(code: string): Promise<SlackInstall> {
  const config = getSlackOAuthConfig();
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), SLACK_REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${SLACK_API_BASE_URL}/oauth.v2.access`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri
      }).toString(),
      signal: ac.signal
    });
  } catch (err) {
    const aborted = (err as Error)?.name === "AbortError";
    throw new SlackOAuthError(
      aborted ? "upstream_timeout" : "upstream_unreachable",
      aborted ? "Slack OAuth timed out" : "Slack OAuth unreachable"
    );
  } finally {
    clearTimeout(timeout);
  }

  const body = (await res.json().catch(() => null)) as {
    ok?: boolean;
    error?: string;
    access_token?: string;
    token_type?: string;
    scope?: string;
    bot_user_id?: string;
    app_id?: string;
    team?: { id?: string; name?: string } | null;
    enterprise?: { id?: string; name?: string } | null;
  } | null;

  if (
    !res.ok ||
    body?.ok !== true ||
    !body.access_token ||
    !body.bot_user_id ||
    !body.app_id ||
    !body.team?.id
  ) {
    const invalidGrant =
      body?.error === "invalid_code" || body?.error === "code_already_used";
    throw new SlackOAuthError(
      invalidGrant ? "invalid_grant" : "request_failed",
      `Slack oauth.v2.access failed (${res.status}${body?.error ? `: ${body.error}` : ""})`,
      res.status
    );
  }

  return {
    accessToken: body.access_token,
    teamId: body.team.id,
    teamName: typeof body.team.name === "string" && body.team.name.length > 0 ? body.team.name : null,
    enterpriseId:
      typeof body.enterprise?.id === "string" && body.enterprise.id.length > 0
        ? body.enterprise.id
        : null,
    botUserId: body.bot_user_id,
    appId: body.app_id,
    scopes: typeof body.scope === "string" ? body.scope : ""
  };
}

/**
 * Best-effort revoke on disconnect (auth.revoke). Never throws: deletion
 * proceeds regardless, and an already-dead token 4xxes harmlessly.
 */
export async function revokeSlackToken(accessToken: string): Promise<boolean> {
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), SLACK_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${SLACK_API_BASE_URL}/auth.revoke`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: "",
      signal: ac.signal
    });
    const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    return res.ok && body?.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
