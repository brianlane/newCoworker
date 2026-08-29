/**
 * Bot Framework outbound client.
 *
 * Two things make Teams different from every other channel here.
 *
 * THE CREDENTIAL IS OURS, NOT THE TENANT'S. Slack stores a per-workspace bot
 * token and Telegram a per-tenant bot token; Teams authenticates with OUR
 * single Azure app id and secret, exchanged for a short-lived bearer token
 * against Microsoft's own login endpoint. So `coworker_connections` for
 * Teams stores no usable secret: what it stores is WHERE to send (the
 * conversation reference) and WHICH Entra tenant is bound.
 *
 * REPLIES NEED A CONVERSATION REFERENCE, and a "proactive" message (an alert
 * nobody asked for) needs one that was captured earlier. There is no
 * "message this user" call: you can only continue a conversation the bot has
 * already seen. That is why the connect flow ends with "now message your bot
 * once", and why an alert before that first message has nowhere to go.
 *
 * The service URL comes from the activity and is NOT hardcoded: Microsoft
 * varies it by region and reserves the right to change it, and pinning it
 * breaks a tenant in a region we did not anticipate.
 */

import { logger } from "@/lib/logger";

/**
 * The token endpoint is TENANT-SCOPED, and that is not cosmetic.
 *
 * The multi-tenant bot flow posted to the shared `botframework.com` tenant
 * here. Microsoft deprecated multi-tenant bot CREATION after 31 July 2025,
 * so our registration is single-tenant, and a single-tenant app only exists
 * inside the directory that owns it. Posting client credentials to
 * `botframework.com` gets AADSTS700016 (application not found in that
 * directory), which reads like a bad secret and is not one.
 *
 * The tenant here is always OURS, never the customer's. A customer's Entra
 * tenant never appears in this URL: cross-tenant reach comes from the app
 * registration being multi-tenant and the Teams app being installed there,
 * not from where we mint our own bearer token.
 */
function loginUrl(tenantId: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
}

const TOKEN_SCOPE = "https://api.botframework.com/.default";

/** Microsoft's tokens last an hour; refresh early rather than on failure. */
const TOKEN_TTL_MARGIN_MS = 5 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 15_000;

class TeamsApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(`teams: ${message}`);
    this.name = "TeamsApiError";
    this.status = status;
  }
}

let tokenCache: { token: string; expiresAt: number } | null = null;

/** Test seam; see resetTeamsJwksStateForTests for why these exist. */
export function resetTeamsTokenStateForTests(): void {
  tokenCache = null;
}

/**
 * A bearer token for calling the Bot Connector.
 *
 * Cached across requests because it is per-APP rather than per-tenant, so a
 * busy fleet would otherwise hammer Microsoft's login endpoint once per
 * alert and get itself throttled.
 */
async function teamsAccessToken(opts: { now?: number } = {}): Promise<string> {
  const now = opts.now ?? Date.now();
  if (tokenCache && tokenCache.expiresAt - TOKEN_TTL_MARGIN_MS > now) return tokenCache.token;

  const appId = (process.env.MICROSOFT_APP_ID ?? "").trim();
  const appSecret = (process.env.MICROSOFT_APP_SECRET ?? "").trim();
  // Named separately from the id and secret so an operator reading the log
  // knows WHICH of the three to go and set. The tenant id is the one that is
  // easy to miss: it was not needed at all under the multi-tenant flow.
  const tenantId = (process.env.MICROSOFT_APP_TENANT_ID ?? "").trim();
  if (!appId || !appSecret) throw new TeamsApiError("app credentials are not configured", null);
  if (!tenantId) throw new TeamsApiError("app tenant id is not configured", null);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(loginUrl(tenantId), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: appId,
        client_secret: appSecret,
        scope: TOKEN_SCOPE
      }),
      signal: controller.signal
    });
    const body = (await res.json().catch(() => null)) as
      | { access_token?: string; expires_in?: number; error_description?: string }
      | null;
    if (!res.ok || !body?.access_token) {
      // The description can echo the client_id but never the secret.
      throw new TeamsApiError(body?.error_description ?? `token http_${res.status}`, res.status);
    }
    tokenCache = {
      token: body.access_token,
      expiresAt: now + (body.expires_in ?? 3600) * 1000
    };
    return tokenCache.token;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Everything needed to send into a conversation later.
 *
 * Captured from an inbound activity and stored, because a proactive message
 * cannot be composed from a user id alone.
 */
export type TeamsConversationReference = {
  serviceUrl: string;
  conversationId: string;
};

export type TeamsSentMessage = { activityId: string };

export async function teamsSendActivity(
  reference: TeamsConversationReference,
  activity: { text?: string; attachments?: unknown[] },
  opts: { token?: string } = {}
): Promise<TeamsSentMessage> {
  // The service URL comes from the tenant's own activity. Anchor the path
  // onto it with the URL constructor so a hostile value cannot smuggle a
  // different path in, and refuse anything that is not Microsoft's.
  const base = normalizeServiceUrl(reference.serviceUrl);
  if (!base) throw new TeamsApiError("refusing a non-Microsoft service url", null);

  const token = opts.token ?? (await teamsAccessToken());
  const url = new URL(
    `v3/conversations/${encodeURIComponent(reference.conversationId)}/activities`,
    base
  ).toString();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ type: "message", ...activity }),
      signal: controller.signal
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new TeamsApiError(`send http_${res.status} ${detail.slice(0, 200)}`, res.status);
    }
    const body = (await res.json().catch(() => null)) as { id?: string } | null;
    return { activityId: body?.id ?? "" };
  } catch (err) {
    if (err instanceof TeamsApiError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("teams: send failed", { error: message });
    throw new TeamsApiError(message, null);
  } finally {
    clearTimeout(timer);
  }
}

export type TeamsMember = {
  aadObjectId: string | null;
  email: string | null;
  name: string | null;
};

/**
 * Look one conversation member up in the directory.
 *
 * This is where a Teams identity actually comes from, and it is worth being
 * explicit because the obvious guess is wrong: an inbound activity does NOT
 * carry the sender's address. `activity.from` is a ChannelAccount with an
 * id, a display name and an Entra object id, and `activity.entities` holds
 * clientInfo and mentions. The address lives behind
 * `/v3/conversations/{id}/members/{userId}`, which is what the Bot Framework
 * SDK's TeamsInfo.getMember calls.
 *
 * Returns null rather than throwing when the directory withholds it: a
 * tenant can configure Teams so apps never see addresses, and that is a
 * "fall back to a link code" condition, not an error.
 */
export async function teamsFetchMember(
  reference: TeamsConversationReference,
  userId: string,
  opts: { token?: string } = {}
): Promise<TeamsMember | null> {
  const base = normalizeServiceUrl(reference.serviceUrl);
  if (!base) return null;
  try {
    const token = opts.token ?? (await teamsAccessToken());
    const url = new URL(
      `v3/conversations/${encodeURIComponent(reference.conversationId)}/members/${encodeURIComponent(userId)}`,
      base
    ).toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal
      });
      if (!res.ok) return null;
      const body = (await res.json().catch(() => null)) as
        | { objectId?: string; email?: string; userPrincipalName?: string; name?: string }
        | null;
      if (!body) return null;
      const address = (body.email ?? body.userPrincipalName ?? "").trim().toLowerCase();
      return {
        aadObjectId: body.objectId?.trim() || null,
        email: address.includes("@") ? address : null,
        name: body.name?.trim() || null
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    logger.warn("teams: member lookup failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

/**
 * Accept only a Microsoft-hosted service URL.
 *
 * The value arrives inside an activity, and although the activity itself is
 * token-verified, the URL is where we later send a bearer token that is good
 * for our whole app. Posting it at an attacker-chosen host would hand over
 * the credential for every tenant, so the host is checked rather than
 * trusted. Returns a normalised origin+path base, or null to refuse.
 */
function normalizeServiceUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  const allowed =
    // Teams itself: Microsoft routes by region under one host
    // (smba.trafficmanager.net/amer/, /emea/, /apac/ and friends). Pinned
    // EXACTLY rather than by suffix, because trafficmanager.net is a shared
    // Azure domain that anyone with a subscription can get a name under, so
    // `*.trafficmanager.net` would allow an attacker-controlled host.
    host === "smba.trafficmanager.net" ||
    // The Bot Framework's own endpoints.
    host === "botframework.com" ||
    host.endsWith(".botframework.com") ||
    // US government cloud.
    host.endsWith(".botframework.azure.us");
  if (!allowed) return null;
  // Trailing slash so `new URL("v3/...", base)` appends rather than replaces
  // the last path segment.
  return url.origin + (url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`);
}

/**
 * The alert card.
 *
 * An Adaptive Card rather than markdown text, because Teams renders one
 * consistently across desktop, web and mobile, and because the card's fields
 * are DATA: nothing here is interpolated into markup, so a customer name
 * containing angle brackets or an underscore is displayed rather than
 * parsed. That is the same class of problem Telegram's HTML escaping solves,
 * avoided instead by not building markup at all.
 */
export function buildTeamsAlertCard(input: {
  summary: string;
  details?: string | null;
  detailsUrl?: string | null;
}): unknown {
  const body: unknown[] = [
    { type: "TextBlock", text: "New Coworker Alert", weight: "Bolder", size: "Medium" },
    { type: "TextBlock", text: input.summary, wrap: true }
  ];
  const details = (input.details ?? "").trim();
  if (details) body.push({ type: "TextBlock", text: details, wrap: true, isSubtle: true });

  const url = (input.detailsUrl ?? "").trim();
  // Only http(s): an Action.OpenUrl is a link we publish on the tenant's
  // behalf, so the same scheme check the other channels apply holds here.
  const actions = /^https?:\/\//i.test(url)
    ? [{ type: "Action.OpenUrl", title: "Open in New Coworker", url }]
    : [];

  return {
    contentType: "application/vnd.microsoft.card.adaptive",
    content: {
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      type: "AdaptiveCard",
      version: "1.4",
      body,
      ...(actions.length > 0 ? { actions } : {})
    }
  };
}
