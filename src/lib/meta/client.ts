/**
 * Direct Meta (Facebook) Graph API client for the Lead Ads integration.
 *
 * No SDK — typed fetch helpers against graph.facebook.com, plus the OAuth
 * plumbing (login URL, code/token exchanges, HMAC-signed `state`) and the
 * webhook signature check. Credentials come from the platform Meta app
 * (`META_APP_ID` / `META_APP_SECRET`); per-tenant page tokens live in
 * `meta_connections` (src/lib/db/meta-connections.ts).
 *
 * Token model: the OAuth code is exchanged for a short-lived user token,
 * then a long-lived (~60 day) user token. Page tokens fetched from
 * `/me/accounts` with a long-lived user token DO NOT expire, so there is no
 * refresh flow anywhere in this integration.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { logger } from "@/lib/logger";

// v25.0 matches the app dashboard's webhook field subscription version.
export const META_GRAPH_VERSION = "v25.0";
export const META_GRAPH_BASE_URL = `https://graph.facebook.com/${META_GRAPH_VERSION}`;
export const META_OAUTH_DIALOG_URL = `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`;

/**
 * Permissions for the Lead Ads use case ("Capture & manage ad leads with
 * Marketing API") plus the Messenger/Instagram DM conversation channel and
 * Instagram content publishing (the Marketing page's scheduled posts):
 * read leads, list/choose the Page, manage its webhook subscription,
 * read/send messages on the Page and its linked IG professional account,
 * and publish media to that account. `instagram_manage_comments` backs the
 * IG comment webhook that fires `instagram_comment` AiFlow triggers (see
 * src/lib/meta/webhook.ts). `ads_management` + `business_management` power
 * the Conversions API (Conversion Leads) stage-event uploads; the dataset
 * itself is entered per tenant, never discovered. Existing connections must
 * reconnect once to grant the newer scopes.
 *
 * Requesting a scope App Review has not approved is safe: Meta grants it
 * only to accounts holding a role on the app and silently omits it for
 * everyone else, so login keeps working while a request is pending.
 */
export const META_LOGIN_SCOPES = [
  "leads_retrieval",
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_metadata",
  "pages_manage_ads",
  "pages_messaging",
  "instagram_basic",
  "instagram_manage_messages",
  "instagram_manage_comments",
  "instagram_content_publish",
  "ads_management",
  "business_management"
] as const;

/** Outbound budget per Graph call — fail fast on a stuck upstream. */
export const META_REQUEST_TIMEOUT_MS = 15_000;

/** OAuth `state` validity window — one login round-trip, not a session. */
export const META_STATE_TTL_MS = 15 * 60 * 1000;

export class MetaApiError extends Error {
  constructor(
    public readonly code: "request_failed" | "upstream_timeout" | "upstream_unreachable",
    message: string,
    public readonly status?: number,
    /**
     * Meta's own `error.code` / `error.error_subcode` from the response body.
     * The HTTP status alone cannot tell "this object is gone" (code 100) from
     * "your token expired" (code 190) — both are 400 — and confusing the two
     * would let one bad token mark a tenant's whole feed as deleted.
     */
    public readonly metaCode?: number,
    public readonly metaSubcode?: number
  ) {
    super(message);
    this.name = "MetaApiError";
  }
}

/** Meta's error code for "object does not exist / cannot be loaded". */
export const META_ERROR_CODE_UNKNOWN_OBJECT = 100;
/** Meta's error code for an expired/invalidated access token. */
export const META_ERROR_CODE_BAD_TOKEN = 190;

export function getMetaAppId(): string {
  const id = process.env.META_APP_ID;
  if (!id) throw new Error("META_APP_ID is not configured");
  return id;
}

export function getMetaAppSecret(): string {
  const secret = process.env.META_APP_SECRET;
  if (!secret) throw new Error("META_APP_SECRET is not configured");
  return secret;
}

/* ------------------------------------------------------------------ */
/* OAuth state (HMAC-signed, binds the callback to a business)         */
/* ------------------------------------------------------------------ */

type MetaOAuthStatePayload = {
  businessId: string;
  issuedAt: number;
};

function signStatePayload(encoded: string): string {
  return createHmac("sha256", getMetaAppSecret()).update(encoded).digest("base64url");
}

export function createMetaOAuthState(businessId: string): string {
  const payload: MetaOAuthStatePayload = { businessId, issuedAt: Date.now() };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${signStatePayload(encoded)}`;
}

/** Returns the bound businessId, or null for a forged/expired state. */
export function verifyMetaOAuthState(state: string): string | null {
  const parts = state.split(".");
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts;
  if (!encoded || !signature) return null;

  const expected = Buffer.from(signStatePayload(encoded), "utf8");
  const provided = Buffer.from(signature, "utf8");
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8")
    ) as MetaOAuthStatePayload;
    if (typeof payload.businessId !== "string" || payload.businessId.length === 0) {
      return null;
    }
    if (typeof payload.issuedAt !== "number") return null;
    if (Date.now() - payload.issuedAt > META_STATE_TTL_MS) return null;
    return payload.businessId;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Facebook Login dialog                                               */
/* ------------------------------------------------------------------ */

/**
 * The OAuth redirect URI — must byte-match a "Valid OAuth Redirect URI" on
 * the Meta app. Prefers the public app URL so the registered production URI
 * is used even behind proxies; request origin covers local dev.
 */
export function metaCallbackUrl(requestOrigin: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? requestOrigin).replace(/\/$/, "");
  return `${base}/api/integrations/meta/callback`;
}

export function buildMetaLoginUrl(input: { redirectUri: string; state: string }): string {
  const url = new URL(META_OAUTH_DIALOG_URL);
  url.searchParams.set("client_id", getMetaAppId());
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", META_LOGIN_SCOPES.join(","));
  return url.toString();
}

/* ------------------------------------------------------------------ */
/* Graph transport                                                     */
/* ------------------------------------------------------------------ */

async function graphRequest(
  path: string,
  params: Record<string, string>,
  options?: {
    method?: "GET" | "POST" | "DELETE";
    /** JSON request body (Cloud API style) instead of query params. */
    jsonBody?: unknown;
    /** Send the token as an Authorization bearer instead of a query param. */
    bearerToken?: string;
  }
): Promise<unknown> {
  const method = options?.method ?? "GET";
  const url = new URL(`${META_GRAPH_BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (options?.jsonBody !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.jsonBody);
  }
  if (options?.bearerToken) {
    headers.Authorization = `Bearer ${options.bearerToken}`;
  }

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), META_REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url.toString(), { method, headers, body, signal: ac.signal });
  } catch (err) {
    const aborted = (err as Error)?.name === "AbortError";
    throw new MetaApiError(
      aborted ? "upstream_timeout" : "upstream_unreachable",
      aborted ? "Meta Graph API timed out" : "Meta Graph API unreachable"
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.warn("meta graph api call failed", {
      path,
      status: res.status,
      body: text.slice(0, 300)
    });
    // Carry Meta's own codes: callers that must act differently on "gone"
    // vs "bad token" cannot tell them apart from the HTTP status alone.
    let metaCode: number | undefined;
    let metaSubcode: number | undefined;
    try {
      const parsed = JSON.parse(text) as { error?: { code?: unknown; error_subcode?: unknown } };
      if (typeof parsed?.error?.code === "number") metaCode = parsed.error.code;
      if (typeof parsed?.error?.error_subcode === "number") {
        metaSubcode = parsed.error.error_subcode;
      }
    } catch {
      // Non-JSON error body (HTML error page, empty): codes stay undefined,
      // which callers must treat as "unknown", never as a definitive verdict.
    }
    throw new MetaApiError(
      "request_failed",
      `Meta Graph API ${method} ${path} failed (${res.status})`,
      res.status,
      metaCode,
      metaSubcode
    );
  }
  return res.json().catch(() => null);
}

/* ------------------------------------------------------------------ */
/* OAuth token exchanges                                               */
/* ------------------------------------------------------------------ */

function extractAccessToken(payload: unknown, step: string): string {
  const token = (payload as { access_token?: unknown } | null)?.access_token;
  if (typeof token !== "string" || token.length === 0) {
    throw new MetaApiError("request_failed", `Meta ${step} returned no access token`);
  }
  return token;
}

/** OAuth callback: code → short-lived user token. */
export async function exchangeCodeForToken(
  code: string,
  redirectUri: string
): Promise<string> {
  const payload = await graphRequest("/oauth/access_token", {
    client_id: getMetaAppId(),
    client_secret: getMetaAppSecret(),
    redirect_uri: redirectUri,
    code
  });
  return extractAccessToken(payload, "code exchange");
}

/** Short-lived user token → long-lived (~60 day) user token. */
export async function exchangeForLongLivedToken(shortLivedToken: string): Promise<string> {
  const payload = await graphRequest("/oauth/access_token", {
    grant_type: "fb_exchange_token",
    client_id: getMetaAppId(),
    client_secret: getMetaAppSecret(),
    fb_exchange_token: shortLivedToken
  });
  return extractAccessToken(payload, "long-lived exchange");
}

/* ------------------------------------------------------------------ */
/* Pages + leadgen subscription                                        */
/* ------------------------------------------------------------------ */

export type MetaManagedPage = {
  id: string;
  name: string;
  /** Page access token — permanent when derived from a long-lived user token. */
  accessToken: string;
};

/** The authorizing user's display name (shown on the dashboard card). */
export async function getUserName(userToken: string): Promise<string | null> {
  const payload = await graphRequest("/me", {
    fields: "name",
    access_token: userToken
  });
  const name = (payload as { name?: unknown } | null)?.name;
  return typeof name === "string" && name.length > 0 ? name : null;
}

/** Pages the user manages (with their page tokens), for the picker. */
export async function listManagedPages(userToken: string): Promise<MetaManagedPage[]> {
  const payload = await graphRequest("/me/accounts", {
    fields: "id,name,access_token",
    limit: "100",
    access_token: userToken
  });
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const pages: MetaManagedPage[] = [];
  for (const item of data) {
    const row = item as { id?: unknown; name?: unknown; access_token?: unknown };
    if (typeof row.id !== "string" || typeof row.access_token !== "string") continue;
    pages.push({
      id: row.id,
      name: typeof row.name === "string" ? row.name : row.id,
      accessToken: row.access_token
    });
  }
  return pages;
}

/**
 * Webhook fields subscribed on the app<->page edge: lead ads plus the
 * Messenger conversation events (message text + button postbacks). The
 * POST replaces the edge's field set, so every field must be listed on
 * every (re)subscribe.
 */
export const META_PAGE_SUBSCRIBED_FIELDS = [
  "leadgen",
  "messages",
  "messaging_postbacks"
] as const;

/** Subscribe our app to the Page's webhook fields (leadgen + messaging). */
export async function subscribePageToLeadgen(
  pageId: string,
  pageToken: string
): Promise<void> {
  const payload = await graphRequest(
    `/${pageId}/subscribed_apps`,
    { subscribed_fields: META_PAGE_SUBSCRIBED_FIELDS.join(","), access_token: pageToken },
    { method: "POST" }
  );
  const success = (payload as { success?: unknown } | null)?.success;
  if (success !== true) {
    throw new MetaApiError("request_failed", "Meta leadgen subscription was not confirmed");
  }
}

/* ------------------------------------------------------------------ */
/* Instagram content publishing (Marketing page scheduled posts)       */
/* ------------------------------------------------------------------ */

/**
 * Step 1 of the IG publish two-step: create a media container for a
 * single-image feed post. Meta fetches `imageUrl` server-side, so it must
 * be a publicly reachable https URL. Returns the container (creation) id.
 */
export async function createInstagramMediaContainer(
  igUserId: string,
  pageToken: string,
  imageUrl: string,
  caption: string
): Promise<string> {
  const payload = await graphRequest(
    `/${igUserId}/media`,
    { image_url: imageUrl, caption, access_token: pageToken },
    { method: "POST" }
  );
  const id = (payload as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new MetaApiError("request_failed", "Instagram media container returned no id");
  }
  return id;
}

/**
 * A media container's publish state (`GET /{creation_id}?fields=status_code`).
 * PUBLISHED means the post is live even if our publish call's response was
 * lost — the stale-publish sweep uses this to resolve interrupted publishes
 * truthfully instead of guessing.
 */
export async function getInstagramContainerStatus(
  creationId: string,
  pageToken: string
): Promise<string> {
  const payload = await graphRequest(`/${creationId}`, {
    fields: "status_code",
    access_token: pageToken
  });
  const status = (payload as { status_code?: unknown } | null)?.status_code;
  return typeof status === "string" ? status : "";
}

/**
 * Step 2: publish a previously created container. Returns the published
 * media id (the permalink handle).
 */
export async function publishInstagramMedia(
  igUserId: string,
  pageToken: string,
  creationId: string
): Promise<string> {
  const payload = await graphRequest(
    `/${igUserId}/media_publish`,
    { creation_id: creationId, access_token: pageToken },
    { method: "POST" }
  );
  const id = (payload as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new MetaApiError("request_failed", "Instagram media publish returned no id");
  }
  return id;
}

/**
 * A published media's public URL (`GET /{media_id}?fields=permalink`) —
 * what the dashboard links "view the post" to. Best-effort: a missing or
 * malformed permalink returns null rather than failing a publish that
 * already succeeded.
 */
export async function getInstagramMediaPermalink(
  mediaId: string,
  pageToken: string
): Promise<string | null> {
  try {
    const payload = await graphRequest(`/${mediaId}`, {
      fields: "permalink",
      access_token: pageToken
    });
    const permalink = (payload as { permalink?: unknown } | null)?.permalink;
    return typeof permalink === "string" && permalink.startsWith("https://") ? permalink : null;
  } catch {
    return null;
  }
}

/**
 * Does this published Instagram media still exist?
 *
 *   "exists"  — Meta returned the media.
 *   "missing" — Meta says the object is gone (owner deleted the post).
 *   "unknown" — anything else: timeout, 5xx, rate limit, expired token.
 *
 * The three-way answer is the point. A deleted post and an expired page
 * token BOTH come back as HTTP 400, so a caller that treats every failure
 * as "deleted" would mark a tenant's entire feed removed the day their
 * token lapses. Only Meta's own code 100 (unknown object) is a verdict;
 * code 190 (bad token) and everything unrecognized stay "unknown", which
 * callers must treat as "check again later".
 */
export async function getInstagramMediaState(
  mediaId: string,
  pageToken: string
): Promise<"exists" | "missing" | "unknown"> {
  try {
    const payload = await graphRequest(`/${mediaId}`, {
      fields: "id",
      access_token: pageToken
    });
    const id = (payload as { id?: unknown } | null)?.id;
    return typeof id === "string" && id.length > 0 ? "exists" : "unknown";
  } catch (err) {
    // graphRequest only ever throws MetaApiError.
    const metaCode = (err as MetaApiError).metaCode;
    return metaCode === META_ERROR_CODE_UNKNOWN_OBJECT ? "missing" : "unknown";
  }
}

/*
 * There is deliberately NO dataset-discovery helper here.
 *
 * We used to call `POST /{page_id}/dataset` to get-or-create the Page's
 * Conversions API dataset. That endpoint appears nowhere in Meta's public
 * Graph API reference, and it answers every caller with
 * `(#200) App does not have page_events permission on the Page` — the same
 * 403 for a page token and for a user token carrying ads_management +
 * business_management, so it is an app-level gap no scope of ours closes.
 * `page_events` is not attached to any use case and is absent from this
 * app's entire privilege list, so it cannot even be requested.
 *
 * Meta's documented flow for a platform (Conversions API for CRM: Integrate
 * as a Platform) has no discovery step at all: the ADVERTISER creates the
 * CRM dataset in Events Manager, connects it to the partner, and the
 * partner posts to `/{dataset_id}/events`. So the dataset id is a per-tenant
 * onboarding INPUT (owner-entered on /dashboard/integrations/meta), never
 * something we derive. See src/lib/meta/capi.ts for the upload half.
 */

/** Best-effort unsubscribe on disconnect — never throws. */
export async function unsubscribePage(pageId: string, pageToken: string): Promise<void> {
  try {
    await graphRequest(
      `/${pageId}/subscribed_apps`,
      { access_token: pageToken },
      { method: "DELETE" }
    );
  } catch (err) {
    // graphRequest only ever throws MetaApiError.
    logger.warn("meta page unsubscribe failed (ignored)", {
      pageId,
      error: (err as Error).message
    });
  }
}

/* ------------------------------------------------------------------ */
/* Messenger / Instagram DM messaging                                  */
/* ------------------------------------------------------------------ */

/** Messenger Send API hard limit per text message. */
export const MESSENGER_MAX_TEXT_LENGTH = 2000;

/**
 * Send a text reply to a Messenger PSID or Instagram-scoped user id —
 * the same `/{page_id}/messages` edge serves both platforms with the
 * page token. `messaging_type: "RESPONSE"` declares this a reply inside
 * Meta's 24h standard messaging window (the caller gates on the window
 * BEFORE calling). Returns Meta's message id when provided.
 */
export async function sendMessengerMessage(
  pageId: string,
  pageToken: string,
  recipientId: string,
  text: string
): Promise<{ messageId: string | null }> {
  const trimmed = text.length > MESSENGER_MAX_TEXT_LENGTH
    ? `${text.slice(0, MESSENGER_MAX_TEXT_LENGTH - 1)}…`
    : text;
  const payload = await graphRequest(
    `/${pageId}/messages`,
    {
      recipient: JSON.stringify({ id: recipientId }),
      messaging_type: "RESPONSE",
      message: JSON.stringify({ text: trimmed }),
      access_token: pageToken
    },
    { method: "POST" }
  );
  const messageId = (payload as { message_id?: unknown } | null)?.message_id;
  return { messageId: typeof messageId === "string" ? messageId : null };
}

/* ------------------------------------------------------------------ */
/* Instagram comment replies                                           */
/* ------------------------------------------------------------------ */

/**
 * Instagram's comment ceiling. Meta rejects longer text outright rather
 * than truncating, so we trim before sending.
 */
export const INSTAGRAM_COMMENT_MAX_LENGTH = 2200;

/**
 * Reply publicly, on the comment thread itself: `POST /{comment_id}/replies`
 * with the tenant's PAGE token. Everyone who reads the post sees it.
 *
 * Permission: `instagram_manage_comments` (plus `instagram_basic` and
 * `pages_read_engagement`, both already in META_LOGIN_SCOPES). Returns the
 * new comment's id when Meta provides one.
 *
 * Docs: Instagram Platform → Comment Moderation ("Reply to a comment").
 */
export async function replyToInstagramComment(
  commentId: string,
  pageToken: string,
  message: string
): Promise<{ commentId: string | null }> {
  const trimmed =
    message.length > INSTAGRAM_COMMENT_MAX_LENGTH
      ? `${message.slice(0, INSTAGRAM_COMMENT_MAX_LENGTH - 1)}…`
      : message;
  const payload = await graphRequest(
    `/${commentId}/replies`,
    { message: trimmed, access_token: pageToken },
    { method: "POST" }
  );
  const id = (payload as { id?: unknown } | null)?.id;
  return { commentId: typeof id === "string" ? id : null };
}

/**
 * Reply privately, in the commenter's Instagram inbox: the SAME
 * `/{page_id}/messages` edge sendMessengerMessage uses, but addressed by
 * `recipient: {comment_id}` instead of a user id, which is what makes Meta
 * treat it as a private reply.
 *
 * We are a Facebook Login app, so the node is the PAGE id. The
 * `/{ig_user_id}/messages` form in Meta's docs is the Instagram Login
 * variant on graph.instagram.com and does not apply here.
 *
 * Permissions: `instagram_manage_comments` + `pages_messaging`.
 *
 * Meta's hard limits, which the caller cannot work around: ONE private
 * reply per comment, and only within 7 days of the comment (during the
 * broadcast only, for a Live). A second attempt comes back as an API
 * error, not a silent no-op.
 *
 * Docs: Instagram Messaging → Private Replies.
 */
export async function sendInstagramPrivateReply(
  pageId: string,
  pageToken: string,
  commentId: string,
  text: string
): Promise<{ messageId: string | null }> {
  const trimmed =
    text.length > MESSENGER_MAX_TEXT_LENGTH
      ? `${text.slice(0, MESSENGER_MAX_TEXT_LENGTH - 1)}…`
      : text;
  const payload = await graphRequest(
    `/${pageId}/messages`,
    {
      recipient: JSON.stringify({ comment_id: commentId }),
      message: JSON.stringify({ text: trimmed }),
      access_token: pageToken
    },
    { method: "POST" }
  );
  const messageId = (payload as { message_id?: unknown } | null)?.message_id;
  return { messageId: typeof messageId === "string" ? messageId : null };
}

/**
 * Best-effort display name for a Messenger PSID / IG-scoped id — profile
 * access is permission- and window-limited, so failures return null and
 * the conversation just shows the raw id.
 */
export async function getMessengerProfile(
  pageToken: string,
  userId: string,
  platform: "messenger" | "instagram"
): Promise<{ name: string | null }> {
  try {
    const fields = platform === "instagram" ? "name,username" : "first_name,last_name";
    const payload = (await graphRequest(`/${userId}`, {
      fields,
      access_token: pageToken
    })) as {
      name?: unknown;
      username?: unknown;
      first_name?: unknown;
      last_name?: unknown;
    } | null;
    const joined = [payload?.first_name, payload?.last_name]
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .join(" ");
    const name =
      (typeof payload?.name === "string" && payload.name) ||
      joined ||
      (typeof payload?.username === "string" && payload.username) ||
      null;
    return { name: name || null };
  } catch (err) {
    // graphRequest only ever throws MetaApiError.
    logger.warn("meta messenger profile lookup failed (ignored)", {
      userId,
      error: (err as Error).message
    });
    return { name: null };
  }
}

/**
 * The IG professional account linked to a Page (null when none) —
 * captured at page-pick time so instagram-object webhook entries can be
 * resolved to the owning tenant.
 */
export async function getLinkedInstagramAccount(
  pageToken: string,
  pageId: string
): Promise<{ id: string; username: string | null } | null> {
  try {
    const payload = (await graphRequest(`/${pageId}`, {
      fields: "instagram_business_account{id,username}",
      access_token: pageToken
    })) as { instagram_business_account?: { id?: unknown; username?: unknown } } | null;
    const account = payload?.instagram_business_account;
    if (!account || typeof account.id !== "string" || account.id.length === 0) {
      return null;
    }
    return {
      id: account.id,
      username: typeof account.username === "string" ? account.username : null
    };
  } catch (err) {
    logger.warn("meta linked instagram lookup failed (ignored)", {
      pageId,
      error: (err as Error).message
    });
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* WhatsApp Business (Cloud API)                                       */
/* ------------------------------------------------------------------ */

/** Cloud API hard limit for a text message body. */
export const WHATSAPP_MAX_TEXT_LENGTH = 4096;

/**
 * The stock utility templates auto-registered on every tenant WABA at
 * connect time. Bodies carry a fixed frame + variables (Meta rejects
 * variable-only bodies); category "utility" keeps them out of marketing
 * review. Sends outside the 24h service window use these; inside it,
 * free-form text goes out instead.
 *
 * Each template name is registered in BOTH English and Spanish so the
 * out-of-window fallback can follow the recipient's language; Meta treats
 * language variants of the same name as one template with per-language
 * review status.
 */

/**
 * Language code for the Spanish template variants.
 *
 * Generic `es`, NOT a regional code: our contact language model is just
 * "en"/"es", so one Spanish variant has to serve Mexican, Spanish,
 * Argentine, and US-Hispanic recipients alike, and WE pick the language at
 * send time (the recipient's device locale never chooses for us).
 *
 * This was `es_US` until Aug 2026, which is NOT in Meta's supported
 * template-language list (`es`, `es_AR`, `es_ES`, `es_MX`, ... are; `es_US`
 * is a Meta ads locale, not a WhatsApp template one). Every Spanish
 * registration therefore failed on every WABA, and because an
 * unapproved Spanish variant silently falls back to the English template,
 * Spanish-speaking customers had been getting English out-of-window
 * messages with nothing surfacing the cause. Keep this a single constant so
 * the definitions and the send path can never drift apart again.
 */
export const WHATSAPP_TEMPLATE_LANGUAGE_ES = "es";

export const WHATSAPP_STOCK_TEMPLATES = [
  {
    name: "nc_owner_alert",
    language: "en_US",
    category: "UTILITY" as const,
    bodyText: "Update from your {{1}} assistant: {{2}}",
    exampleParams: ["Acme Plumbing", "You have a new lead waiting."]
  },
  {
    name: "nc_owner_alert",
    language: WHATSAPP_TEMPLATE_LANGUAGE_ES,
    category: "UTILITY" as const,
    bodyText: "Actualización de tu asistente de {{1}}: {{2}}",
    exampleParams: ["Acme Plumbing", "Tienes un lead nuevo esperando."]
  },
  {
    name: "nc_contact_followup",
    language: "en_US",
    category: "UTILITY" as const,
    bodyText: "Hello from {{1}}: {{2}} Reply here and we can pick it up on WhatsApp.",
    exampleParams: ["Acme Plumbing", "Just checking in about your appointment."]
  },
  {
    name: "nc_contact_followup",
    language: WHATSAPP_TEMPLATE_LANGUAGE_ES,
    category: "UTILITY" as const,
    bodyText: "Hola de parte de {{1}}: {{2}} Responde aquí y seguimos por WhatsApp.",
    exampleParams: ["Acme Plumbing", "Solo dando seguimiento a tu cita."]
  }
] as const;

export type WhatsAppStockTemplateName = (typeof WHATSAPP_STOCK_TEMPLATES)[number]["name"];

/**
 * Key a template's per-language review state in the connection's
 * `templates` map. en_US keeps the bare name (backward compatible with
 * rows written before the Spanish variants existed); other languages are
 * suffixed.
 */
export function whatsappTemplateStateKey(name: string, language: string): string {
  return language === "en_US" ? name : `${name}:${language}`;
}

/**
 * Send a free-form text to a WhatsApp user (wa_id / E.164 digits) from
 * the tenant's business number. Only valid inside the 24h customer
 * service window — the deliver helper gates on that BEFORE calling.
 */
export async function sendWhatsAppMessage(
  phoneNumberId: string,
  token: string,
  to: string,
  text: string
): Promise<{ messageId: string | null }> {
  const trimmed =
    text.length > WHATSAPP_MAX_TEXT_LENGTH
      ? `${text.slice(0, WHATSAPP_MAX_TEXT_LENGTH - 1)}…`
      : text;
  const payload = (await graphRequest(
    `/${phoneNumberId}/messages`,
    {},
    {
      method: "POST",
      bearerToken: token,
      jsonBody: {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { body: trimmed }
      }
    }
  )) as { messages?: Array<{ id?: unknown }> } | null;
  const messageId = payload?.messages?.[0]?.id;
  return { messageId: typeof messageId === "string" ? messageId : null };
}

/**
 * Cloud API constraint on template body parameters: no runs of
 * whitespace/newlines, 1024 chars max. Exported so the deliver helper can
 * store EXACTLY what the recipient read in the transcript.
 */
export function sanitizeWhatsAppTemplateParam(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 1024);
}

/**
 * Send an approved template message (the out-of-window path). Variables
 * map positionally onto the template's {{1}}, {{2}}, ... body slots.
 */
export async function sendWhatsAppTemplate(
  phoneNumberId: string,
  token: string,
  to: string,
  template: { name: string; language: string; bodyParams: string[] }
): Promise<{ messageId: string | null }> {
  const payload = (await graphRequest(
    `/${phoneNumberId}/messages`,
    {},
    {
      method: "POST",
      bearerToken: token,
      jsonBody: {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "template",
        template: {
          name: template.name,
          language: { code: template.language },
          components: [
            {
              type: "body",
              parameters: template.bodyParams.map((text) => ({
                type: "text",
                // Cloud API rejects params with newlines/tabs or >1024 chars.
                text: sanitizeWhatsAppTemplateParam(text)
              }))
            }
          ]
        }
      }
    }
  )) as { messages?: Array<{ id?: unknown }> } | null;
  const messageId = payload?.messages?.[0]?.id;
  return { messageId: typeof messageId === "string" ? messageId : null };
}

/**
 * Exchange the Embedded Signup popup's code for a business-integration
 * system-user token (does not expire; no long-lived exchange needed).
 */
export async function exchangeEmbeddedSignupCode(code: string): Promise<string> {
  const payload = await graphRequest("/oauth/access_token", {
    client_id: getMetaAppId(),
    client_secret: getMetaAppSecret(),
    code
  });
  const token = (payload as { access_token?: unknown } | null)?.access_token;
  if (typeof token !== "string" || token.length === 0) {
    throw new MetaApiError("request_failed", "Embedded Signup code exchange returned no token");
  }
  return token;
}

/**
 * Deterministic 6-digit Cloud API registration PIN for a phone number.
 *
 * The `/register` call sets (or must match) the number's two-step
 * verification PIN. Deriving it from a server secret + the phone number id
 * means a reconnect re-registers with the SAME PIN — idempotent, no stored
 * secret, no "PIN mismatch" on the second connect. Mapped to 100000–999999
 * so it is always six digits with no leading zero and never all-zero.
 */
export function deriveWhatsAppRegistrationPin(phoneNumberId: string): string {
  const secret = process.env.INTEGRATIONS_ENCRYPTION_KEY ?? "";
  const digest = createHmac("sha256", secret).update(`wa-register:${phoneNumberId}`).digest();
  const n = digest.readUInt32BE(0) % 900000;
  return String(100000 + n);
}

/**
 * Register a phone number on the Cloud API so it can send and receive.
 * Embedded Signup verifies the number but does NOT put it on the Cloud
 * API — until this runs, `platform_type` stays `NOT_APPLICABLE` and
 * consumers see "invite on WhatsApp". Idempotent: re-registering an
 * already-registered number with the same derived PIN succeeds.
 */
export async function registerWhatsAppPhoneNumber(
  phoneNumberId: string,
  token: string,
  pin: string
): Promise<void> {
  const payload = (await graphRequest(
    `/${phoneNumberId}/register`,
    {},
    { method: "POST", bearerToken: token, jsonBody: { messaging_product: "whatsapp", pin } }
  )) as { success?: unknown } | null;
  if (payload?.success !== true) {
    throw new MetaApiError("request_failed", "WhatsApp phone registration was not confirmed");
  }
}

/** Subscribe our app to the WABA's webhooks (inbound message delivery). */
export async function subscribeWabaToApp(wabaId: string, token: string): Promise<void> {
  const payload = await graphRequest(
    `/${wabaId}/subscribed_apps`,
    {},
    { method: "POST", bearerToken: token }
  );
  const success = (payload as { success?: unknown } | null)?.success;
  if (success !== true) {
    throw new MetaApiError("request_failed", "WABA webhook subscription was not confirmed");
  }
}

/** Best-effort unsubscribe on disconnect — never throws. */
export async function unsubscribeWabaFromApp(wabaId: string, token: string): Promise<void> {
  try {
    await graphRequest(
      `/${wabaId}/subscribed_apps`,
      {},
      { method: "DELETE", bearerToken: token }
    );
  } catch (err) {
    // graphRequest only ever throws MetaApiError.
    logger.warn("waba unsubscribe failed (ignored)", {
      wabaId,
      error: (err as Error).message
    });
  }
}

export type WhatsAppTemplateStatus = {
  name: string;
  language: string;
  status: string;
  /**
   * Why a FAILED registration failed (truncated Graph message). Absent on
   * success. Registration failures used to record a bare "FAILED", which
   * is what let an invalid language code (`es_US`) sit unnoticed: the
   * templates simply never existed and nothing said why.
   */
  error?: string;
};

/**
 * Register the stock utility templates on a WABA (idempotent: an
 * already-exists error is treated as registered/PENDING). Returns the
 * per-template outcome so the connection row can track review status.
 */
export async function registerWhatsAppTemplates(
  wabaId: string,
  token: string
): Promise<WhatsAppTemplateStatus[]> {
  const results: WhatsAppTemplateStatus[] = [];
  for (const template of WHATSAPP_STOCK_TEMPLATES) {
    try {
      const payload = (await graphRequest(
        `/${wabaId}/message_templates`,
        {},
        {
          method: "POST",
          bearerToken: token,
          jsonBody: {
            name: template.name,
            language: template.language,
            category: template.category,
            components: [
              {
                type: "BODY",
                text: template.bodyText,
                example: { body_text: [[...template.exampleParams]] }
              }
            ]
          }
        }
      )) as { status?: unknown } | null;
      results.push({
        name: template.name,
        language: template.language,
        status: typeof payload?.status === "string" ? payload.status : "PENDING"
      });
    } catch (err) {
      // Every registration failure reports FAILED — including the
      // reconnect-time "name already exists" 400, which is
      // indistinguishable from a genuinely rejected payload at this
      // layer. The connect route follows up with
      // fetchWhatsAppTemplateStatuses, which flips truly-registered
      // templates to their LIVE review status; a template that stays
      // FAILED just falls back to window-only sends instead of posing as
      // pending review forever.
      // graphRequest always throws an Error (it wraps transport failures),
      // so no non-Error arm is needed here.
      const message = (err as Error).message;
      logger.warn("whatsapp template registration failed", {
        wabaId,
        template: template.name,
        language: template.language,
        error: message
      });
      results.push({
        name: template.name,
        language: template.language,
        status: "FAILED",
        error: message.slice(0, 300)
      });
    }
  }
  return results;
}

/**
 * Current review status of our stock templates on a WABA (used to flip
 * PENDING → APPROVED on later reads). Returns only the stock names.
 */
export async function fetchWhatsAppTemplateStatuses(
  wabaId: string,
  token: string
): Promise<WhatsAppTemplateStatus[]> {
  const payload = (await graphRequest(
    `/${wabaId}/message_templates`,
    { fields: "name,language,status", limit: "100" },
    { bearerToken: token }
  )) as { data?: Array<{ name?: unknown; language?: unknown; status?: unknown }> } | null;
  const stockNames = new Set<string>(WHATSAPP_STOCK_TEMPLATES.map((t) => t.name));
  const out: WhatsAppTemplateStatus[] = [];
  for (const row of payload?.data ?? []) {
    if (typeof row.name !== "string" || !stockNames.has(row.name)) continue;
    out.push({
      name: row.name,
      language: typeof row.language === "string" ? row.language : "en_US",
      status: typeof row.status === "string" ? row.status : "PENDING"
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Lead retrieval                                                      */
/* ------------------------------------------------------------------ */

export type MetaLead = {
  id: string;
  createdTime: string | null;
  formId: string | null;
  adId: string | null;
  /** Instant-form answers, flattened to `{question_key: answer}`. */
  fields: Record<string, string>;
};

/**
 * Flatten Graph `field_data` (`[{name, values[]}]`) into the flat lead
 * object webhook flows extract from. Multi-value answers join with ", ".
 */
export function flattenLeadFields(fieldData: unknown): Record<string, string> {
  if (!Array.isArray(fieldData)) return {};
  const fields: Record<string, string> = {};
  for (const item of fieldData) {
    const row = item as { name?: unknown; values?: unknown };
    if (typeof row.name !== "string" || row.name.length === 0) continue;
    const values = Array.isArray(row.values)
      ? row.values.filter((v): v is string => typeof v === "string")
      : [];
    fields[row.name] = values.join(", ");
  }
  return fields;
}

/** Fetch a lead's submitted answers by the webhook's `leadgen_id`. */
export async function fetchLead(leadgenId: string, pageToken: string): Promise<MetaLead> {
  const payload = await graphRequest(`/${leadgenId}`, {
    fields: "id,created_time,field_data,form_id,ad_id",
    access_token: pageToken
  });
  const row = payload as {
    id?: unknown;
    created_time?: unknown;
    field_data?: unknown;
    form_id?: unknown;
    ad_id?: unknown;
  } | null;
  return {
    id: typeof row?.id === "string" ? row.id : leadgenId,
    createdTime: typeof row?.created_time === "string" ? row.created_time : null,
    formId: typeof row?.form_id === "string" ? row.form_id : null,
    adId: typeof row?.ad_id === "string" ? row.ad_id : null,
    fields: flattenLeadFields(row?.field_data)
  };
}

/* ------------------------------------------------------------------ */
/* Webhook signature                                                   */
/* ------------------------------------------------------------------ */

/**
 * Verify Meta's `X-Hub-Signature-256` header (`sha256=<hex hmac>` of the
 * raw body keyed by the app secret), timing-safe.
 */
export function verifyMetaWebhookSignature(
  rawBody: string,
  signatureHeader: string | null
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const provided = signatureHeader.slice("sha256=".length);
  const expected = createHmac("sha256", getMetaAppSecret())
    .update(rawBody, "utf8")
    .digest("hex");
  const providedBuf = Buffer.from(provided, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  return providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
}
