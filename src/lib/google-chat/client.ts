/**
 * Google Chat outbound client.
 *
 * SENDING IS EASIER THAN EVERY OTHER CHANNEL HERE, and it is worth saying
 * why, because the pattern the other three set does not apply.
 *
 * There is one endpoint, `chat.googleapis.com`, the same for every tenant.
 * Teams needs a per-tenant regional service URL captured from an inbound
 * activity and checked against an allowlist before we post a bearer token
 * to it; Google Chat has nothing of the sort. The only tenant-supplied
 * value that reaches a request here is the SPACE NAME, and it goes into a
 * path segment, so it is validated to the shape Google documents rather
 * than trusted (see `isSpaceName`).
 *
 * THE CREDENTIAL IS OURS, NOT THE TENANT'S, as on Teams: a Google Cloud
 * service account with the `chat.bot` scope, self-signing a JWT and
 * exchanging it for an access token. That flow already exists in
 * `lib/google/bigquery.ts` for the Gemini billing sync, and is reused here
 * rather than written twice.
 *
 * Unlike Teams, Google Chat CAN start a conversation: once the app is a
 * member of a space, `spaces.messages.create` posts into it with no
 * previously-seen message required. So there is no "message your bot once"
 * step and no `no_alert_target` state.
 */

import {
  fetchGoogleAccessToken,
  parseGcpServiceAccountKey,
  type GcpServiceAccountKey
} from "@/lib/google/bigquery";
import { logger } from "@/lib/logger";

const CHAT_API_BASE = "https://chat.googleapis.com/v1/";

/** The scope a Chat app posts with. */
const CHAT_BOT_SCOPE = "https://www.googleapis.com/auth/chat.bot";

/** Google's tokens last an hour; refresh early rather than on failure. */
const TOKEN_TTL_MS = 55 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 15_000;

class GoogleChatApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(`google chat: ${message}`);
    this.name = "GoogleChatApiError";
    this.status = status;
  }
}

let tokenCache: { token: string; expiresAt: number } | null = null;

/** Test seam; see resetWebhookJwksStateForTests for why these exist. */
export function resetGoogleChatTokenStateForTests(): void {
  tokenCache = null;
}

function serviceAccountKey(): GcpServiceAccountKey | null {
  return parseGcpServiceAccountKey(process.env.GOOGLE_CHAT_SERVICE_ACCOUNT_KEY);
}

/** Is the Chat app credential present at all? */
export function googleChatConfigured(): boolean {
  return serviceAccountKey() !== null;
}

/**
 * A bearer token for calling the Chat API.
 *
 * Cached across requests because it is per-APP rather than per-tenant, so a
 * busy fleet would otherwise mint one per alert.
 */
async function googleChatAccessToken(opts: { now?: number } = {}): Promise<string> {
  const now = opts.now ?? Date.now();
  if (tokenCache && tokenCache.expiresAt > now) return tokenCache.token;

  const key = serviceAccountKey();
  if (!key) throw new GoogleChatApiError("service account is not configured", null);

  const token = await fetchGoogleAccessToken({ key, scope: CHAT_BOT_SCOPE, nowMs: now });
  tokenCache = { token, expiresAt: now + TOKEN_TTL_MS };
  return token;
}

/**
 * Is this the name of a Google Chat space?
 *
 * The value arrives inside an event and is interpolated into a request
 * path, so it is checked rather than trusted. Google's own shape is
 * `spaces/<id>` where the id is opaque but URL-safe; anything with a slash,
 * a dot segment or a query in it could reshape the request, so nothing but
 * that shape is accepted.
 */
export function isSpaceName(raw: string | null | undefined): boolean {
  return typeof raw === "string" && /^spaces\/[A-Za-z0-9_-]{1,128}$/.test(raw);
}

/** Where a reply goes: the space, and the thread within it when there is one. */
export type GoogleChatTarget = {
  space: string;
  /** `spaces/X/threads/Y`, or null to start a new thread. */
  thread?: string | null;
};

export type GoogleChatSentMessage = { messageName: string; thread: string | null };

export async function googleChatSendMessage(
  target: GoogleChatTarget,
  message: { text?: string; cardsV2?: unknown[] },
  opts: { token?: string } = {}
): Promise<GoogleChatSentMessage> {
  if (!isSpaceName(target.space)) {
    throw new GoogleChatApiError("refusing a malformed space name", null);
  }

  // The token mint is INSIDE the try, which is not incidental. It performs
  // its own fetch, so leaving it outside lets a network blip or a non-Error
  // throw out of `fetchGoogleAccessToken` escape as itself, past the one
  // error type every caller here branches on.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const token = opts.token ?? (await googleChatAccessToken());
    const url = new URL(`${target.space}/messages`, CHAT_API_BASE);
    // Reply into the thread the question was asked in when we know it, and
    // fall back to a new thread rather than failing if that thread is gone.
    // A space-level reply to a threaded question reads as the app talking
    // over the top of the conversation.
    if (target.thread) {
      url.searchParams.set("messageReplyOption", "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
    }

    const res = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        ...message,
        ...(target.thread ? { thread: { name: target.thread } } : {})
      }),
      signal: controller.signal
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new GoogleChatApiError(`send http_${res.status} ${detail.slice(0, 200)}`, res.status);
    }
    const body = (await res.json().catch(() => null)) as
      | { name?: string; thread?: { name?: string } }
      | null;
    return { messageName: body?.name ?? "", thread: body?.thread?.name ?? null };
  } catch (err) {
    if (err instanceof GoogleChatApiError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("google chat: send failed", { error: message });
    throw new GoogleChatApiError(message, null);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The alert card.
 *
 * A cardsV2 payload rather than formatted text, for the same reason Teams
 * uses an Adaptive Card: the fields are DATA. Nothing here is interpolated
 * into markup, so a customer name containing an asterisk or an underscore
 * is displayed rather than parsed as Chat's own bold and italic syntax.
 */
export function buildGoogleChatAlertCard(input: {
  summary: string;
  details?: string | null;
  detailsUrl?: string | null;
}): unknown {
  const widgets: unknown[] = [{ textParagraph: { text: input.summary } }];
  const details = (input.details ?? "").trim();
  if (details) widgets.push({ textParagraph: { text: details } });

  const url = (input.detailsUrl ?? "").trim();
  // Only http(s): a button is a link we publish on the tenant's behalf, so
  // the same scheme check the other channels apply holds here.
  if (/^https?:\/\//i.test(url)) {
    widgets.push({
      buttonList: {
        buttons: [{ text: "Open in New Coworker", onClick: { openLink: { url } } }]
      }
    });
  }

  return {
    cardId: "new-coworker-alert",
    card: {
      header: { title: "New Coworker Alert" },
      sections: [{ widgets }]
    }
  };
}
