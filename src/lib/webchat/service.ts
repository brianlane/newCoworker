/**
 * Request-time authorization for the public widget API
 * (/api/widget/session, /message, /poll).
 *
 * Every call is cookie-free and authenticated by two anonymous-internet
 * credentials: the tenant's public site key (`ncw_pub_…`, identifies the
 * business) and — after session start — the per-session bearer
 * (`ncws_…`). On top of those we enforce, in order:
 *
 *   1. key resolves to a chat_widget_settings row
 *   2. widget enabled by the owner
 *   3. tier still Standard+ (a starter downgrade turns the widget off
 *      server-side even if the row says enabled)
 *   4. business not paused / not in Safe Mode (widget goes "offline" —
 *      there is no phone to forward a web visitor to)
 *
 * Where the ORIGIN ALLOWLIST is enforced: NOT here. The widget iframe is
 * served from OUR origin, so its API fetches are same-origin and their
 * Origin header says nothing about the embedding site. The enforceable
 * control is the /widget/frame response's dynamic
 * `Content-Security-Policy: frame-ancestors <allowed origins>` — the
 * BROWSER refuses to render the frame inside an unapproved site, so no
 * session is ever minted there (see frameAncestorsValue +
 * refererAllowedForFrame below). Non-browser callers can spoof any header
 * anyway; for them the controls are rate limits, the daily message
 * ceiling, and the restricted tool surface.
 *
 * Reasons are typed so the routes map them to stable HTTP responses and
 * the widget frame can render honest copy ("chat is offline") instead of a
 * generic error.
 */

import {
  hashWebchatToken,
  parseWidgetKey,
  sessionTokenFromAuthorizationHeader
} from "@/lib/webchat/keys";
import { originAllowed, normalizeOrigin } from "@/lib/webchat/settings-schema";
import { webchatAllowedForTier } from "@/lib/webchat/tier-gate";
import {
  getWebchatSessionByTokenHash,
  getWidgetSettingsByKeyHash,
  type ChatWidgetSettingsRow,
  type WebchatSessionRow
} from "@/lib/webchat/db";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Visitor sessions idle longer than this reject their bearer (re-start). */
export const WEBCHAT_SESSION_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Per-business ceiling on VISITOR messages per rolling 24h — a hard stop on
 * an anonymous surface burning the tenant's shared AI budget. Generous for
 * real traffic (the AI spend fuse degrades to the free local model long
 * before this trips); env-tunable for enterprise deals.
 */
export const WEBCHAT_DAILY_MESSAGE_CAP_DEFAULT = 500;

export function webchatDailyMessageCap(): number {
  const n = Number(process.env.WEBCHAT_DAILY_MESSAGE_CAP);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : WEBCHAT_DAILY_MESSAGE_CAP_DEFAULT;
}

export type WebchatBusinessFlags = {
  id: string;
  name: string;
  tier: string | null;
  is_paused: boolean;
  customer_channels_enabled: boolean;
  timezone: string | null;
};

export async function loadWebchatBusinessFlags(
  businessId: string,
  client?: SupabaseClient
): Promise<WebchatBusinessFlags | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("businesses")
    .select("id, name, tier, is_paused, customer_channels_enabled, timezone")
    .eq("id", businessId)
    .maybeSingle();
  if (error) throw new Error(`loadWebchatBusinessFlags: ${error.message}`);
  if (!data) return null;
  return {
    id: data.id as string,
    name: typeof data.name === "string" ? data.name : "",
    tier: typeof data.tier === "string" ? data.tier : null,
    is_paused: Boolean(data.is_paused),
    customer_channels_enabled: data.customer_channels_enabled !== false,
    timezone: typeof data.timezone === "string" ? data.timezone : null
  };
}

export type WidgetContextFailure =
  /** Key malformed / unknown / business row gone. The widget shows nothing. */
  | { ok: false; reason: "invalid_key" }
  /** Owner turned the widget off, or tier dropped below Standard. */
  | { ok: false; reason: "widget_disabled" }
  /** Paused / Safe Mode — widget renders an honest offline notice. */
  | { ok: false; reason: "offline" };

export type WidgetContextSuccess = {
  ok: true;
  settings: ChatWidgetSettingsRow;
  business: WebchatBusinessFlags;
};

export type WidgetContext = WidgetContextSuccess | WidgetContextFailure;

export async function resolveWidgetContext(args: {
  key: unknown;
  client?: SupabaseClient;
}): Promise<WidgetContext> {
  const key = parseWidgetKey(args.key);
  if (!key) return { ok: false, reason: "invalid_key" };

  const db = args.client ?? (await createSupabaseServiceClient());
  const settings = await getWidgetSettingsByKeyHash(hashWebchatToken(key), db);
  if (!settings) return { ok: false, reason: "invalid_key" };

  if (!settings.enabled) return { ok: false, reason: "widget_disabled" };

  const business = await loadWebchatBusinessFlags(settings.business_id, db);
  if (!business) return { ok: false, reason: "invalid_key" };

  // Server-side tier gate: a starter downgrade silently disables the
  // widget even though the settings row still says enabled.
  if (!webchatAllowedForTier(business.tier)) {
    return { ok: false, reason: "widget_disabled" };
  }

  if (business.is_paused || !business.customer_channels_enabled) {
    return { ok: false, reason: "offline" };
  }

  return { ok: true, settings, business };
}

/**
 * Does this session satisfy the owner's pre-chat contact requirement?
 *
 * Enforced at MESSAGE time, not just session mint: bearers created while
 * the form was off (or by a hand-rolled client that skipped it) must not
 * keep chatting past a later-enabled requirement. Same rule the session
 * route applies to the submitted form: a name plus at least one of
 * email/phone. Lead-capture merges count — a visitor who told the AGENT
 * their details mid-conversation passes without re-seeing the form.
 */
export function sessionSatisfiesContactGate(
  settings: Pick<ChatWidgetSettingsRow, "require_contact_form">,
  session: Pick<WebchatSessionRow, "visitor_name" | "visitor_email" | "visitor_phone">
): boolean {
  if (!settings.require_contact_form) return true;
  const name = session.visitor_name?.trim();
  const email = session.visitor_email?.trim();
  const phone = session.visitor_phone?.trim();
  return Boolean(name) && Boolean(email || phone);
}

/**
 * `frame-ancestors` source list for the /widget/frame response. Empty
 * allowlist ⇒ any site may embed (`*`). Non-empty ⇒ the exact origins,
 * with the `www.`/bare twin of each host included — the browser matches
 * frame-ancestors literally, and owners routinely save the variant their
 * visitors don't use.
 */
export function frameAncestorsValue(allowedOrigins: string[]): string {
  const sources: string[] = [];
  for (const entry of allowedOrigins) {
    const normalized = normalizeOrigin(entry);
    if (!normalized) continue;
    const url = new URL(normalized);
    const bareHost = url.hostname.startsWith("www.") ? url.hostname.slice(4) : url.hostname;
    const port = url.port ? `:${url.port}` : "";
    for (const host of [bareHost, `www.${bareHost}`]) {
      const source = `${url.protocol}//${host}${port}`;
      if (!sources.includes(source)) sources.push(source);
    }
  }
  return sources.length > 0 ? sources.join(" ") : "*";
}

/**
 * Soft referer check for the /widget/frame page load. The platform's
 * Referrer-Policy (strict-origin-when-cross-origin) means a real browser
 * embedding the frame cross-origin sends at least the parent's ORIGIN in
 * Referer — when it's present and off-list we can refuse before rendering
 * anything. When it's ABSENT we allow: the dynamic frame-ancestors CSP is
 * the authoritative gate, and rejecting on a stripped Referer would break
 * privacy-tooling users on legitimately allowed sites.
 */
export function refererAllowedForFrame(
  refererHeader: string | null,
  allowedOrigins: string[]
): boolean {
  if (allowedOrigins.length === 0) return true;
  const ref = (refererHeader ?? "").trim();
  if (!ref) return true;
  const origin = normalizeOrigin(ref);
  if (!origin) return true;
  return originAllowed(origin, allowedOrigins);
}

/**
 * Resolve the per-session bearer on a request to a live session row that
 * belongs to `businessId`. Null on any failure (malformed token, unknown
 * hash, cross-tenant token, idle-TTL expiry) — the routes answer 401 and
 * the widget restarts the session.
 */
export async function verifyWebchatSession(args: {
  authorizationHeader: string | null;
  businessId: string;
  client?: SupabaseClient;
  now?: Date;
}): Promise<WebchatSessionRow | null> {
  const token = sessionTokenFromAuthorizationHeader(args.authorizationHeader);
  if (!token) return null;
  const session = await getWebchatSessionByTokenHash(hashWebchatToken(token), args.client);
  if (!session) return null;
  if (session.business_id !== args.businessId) return null;
  const nowMs = (args.now ?? new Date()).getTime();
  const lastSeenMs = new Date(session.last_seen_at).getTime();
  if (!Number.isFinite(lastSeenMs) || nowMs - lastSeenMs > WEBCHAT_SESSION_IDLE_TTL_MS) {
    return null;
  }
  return session;
}
