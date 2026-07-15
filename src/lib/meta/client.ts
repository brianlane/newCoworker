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

export const META_GRAPH_VERSION = "v24.0";
export const META_GRAPH_BASE_URL = `https://graph.facebook.com/${META_GRAPH_VERSION}`;
export const META_OAUTH_DIALOG_URL = `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`;

/**
 * Permissions for the Lead Ads use case ("Capture & manage ad leads with
 * Marketing API"): read leads, list/choose the Page, manage its webhook
 * subscription.
 */
export const META_LOGIN_SCOPES = [
  "leads_retrieval",
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_metadata",
  "pages_manage_ads"
] as const;

/** Outbound budget per Graph call — fail fast on a stuck upstream. */
export const META_REQUEST_TIMEOUT_MS = 15_000;

/** OAuth `state` validity window — one login round-trip, not a session. */
export const META_STATE_TTL_MS = 15 * 60 * 1000;

export class MetaApiError extends Error {
  constructor(
    public readonly code: "request_failed" | "upstream_timeout" | "upstream_unreachable",
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "MetaApiError";
  }
}

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
  options?: { method?: "GET" | "POST" | "DELETE" }
): Promise<unknown> {
  const method = options?.method ?? "GET";
  const url = new URL(`${META_GRAPH_BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), META_REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url.toString(), { method, signal: ac.signal });
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
    throw new MetaApiError(
      "request_failed",
      `Meta Graph API ${method} ${path} failed (${res.status})`,
      res.status
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

/** Subscribe our app to the Page's `leadgen` webhook field. */
export async function subscribePageToLeadgen(
  pageId: string,
  pageToken: string
): Promise<void> {
  const payload = await graphRequest(
    `/${pageId}/subscribed_apps`,
    { subscribed_fields: "leadgen", access_token: pageToken },
    { method: "POST" }
  );
  const success = (payload as { success?: unknown } | null)?.success;
  if (success !== true) {
    throw new MetaApiError("request_failed", "Meta leadgen subscription was not confirmed");
  }
}

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
