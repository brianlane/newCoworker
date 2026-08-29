/**
 * Telegram Bot API client.
 *
 * Every call is `POST https://api.telegram.org/bot<token>/<method>` with a
 * JSON body, and every response is `{ ok, result }` or `{ ok: false,
 * description, error_code }`. There is no SDK here on purpose: the four
 * methods this channel needs are a thin wrapper each, and a dependency
 * would be more surface than code.
 *
 * PER-TENANT BOTS, NOT ONE SHARED BOT, and the token below is why. Slack,
 * Teams and Google Chat all hand us an organisation id on every inbound
 * event (`team_id`, an Entra tenant, a Workspace), so a shared app still
 * has a platform-enforced boundary between tenants. Telegram has no concept
 * of an organisation at all: with one shared bot every tenant's owner would
 * sit in a single DM pool separated only by our own row lookup, one token
 * would expose everybody, one noisy tenant would exhaust a global rate
 * limit, and one spam report would take the channel down for the whole
 * fleet. A bot per tenant restores the boundary: its own id becomes the
 * `external_workspace_id`, and it carries the tenant's own name and avatar.
 *
 * The cost is a token paste, which this codebase otherwise does not have
 * (`there is no token-paste path`, in the Slack management route). Telegram
 * offers no OAuth, so the alternative was the shared bot above. It is a
 * one-time guided step, and we call setWebhook on the tenant's behalf so
 * they never touch it again.
 */

import { logger } from "@/lib/logger";

const TELEGRAM_API_BASE_URL = "https://api.telegram.org";

/** Telegram is fast; a hung call must not eat a webhook's ack window. */
const TELEGRAM_REQUEST_TIMEOUT_MS = 10_000;

/** Telegram rejects anything longer; we clip before it has to. */
const TELEGRAM_MESSAGE_MAX_CHARS = 4096;

export class TelegramApiError extends Error {
  readonly method: string;
  readonly errorCode: number | null;
  constructor(method: string, description: string, errorCode: number | null) {
    super(`telegram ${method}: ${description}`);
    this.name = "TelegramApiError";
    this.method = method;
    this.errorCode = errorCode;
  }
}

async function telegramCall<T>(
  token: string,
  method: string,
  body: Record<string, unknown>
): Promise<T> {
  // A bot token IS the credential and it travels in the URL, so nothing
  // below ever logs `token` or the built URL. `method` is safe to log
  // because all four call sites pass a literal.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEGRAM_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${TELEGRAM_API_BASE_URL}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const payload = (await res.json().catch(() => null)) as
      | { ok?: boolean; result?: T; description?: string; error_code?: number }
      | null;
    if (!payload?.ok) {
      throw new TelegramApiError(
        method,
        payload?.description ?? `http_${res.status}`,
        payload?.error_code ?? res.status
      );
    }
    return payload.result as T;
  } catch (err) {
    if (err instanceof TelegramApiError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("telegram: call failed", { method, error: message });
    throw new TelegramApiError(method, message, null);
  } finally {
    clearTimeout(timer);
  }
}

export type TelegramBotIdentity = {
  id: number;
  username: string | null;
  firstName: string | null;
};

/** Identifies the bot behind a pasted token; its id is the tenant boundary. */
export async function telegramGetMe(token: string): Promise<TelegramBotIdentity> {
  const me = await telegramCall<{ id: number; username?: string; first_name?: string }>(
    token,
    "getMe",
    {}
  );
  return {
    id: me.id,
    username: me.username ?? null,
    firstName: me.first_name ?? null
  };
}

/**
 * Point the bot at our receiver.
 *
 * `secret_token` is Telegram's only inbound authentication: it echoes the
 * value back in `X-Telegram-Bot-Api-Secret-Token` on every delivery. There
 * is no signature, so this shared secret plus the per-connection URL is the
 * whole of it.
 *
 * `allowed_updates` is narrowed to what this channel handles. Telegram
 * defaults to a broader set, and accepting updates we never read costs an
 * ack round trip per event for nothing.
 */
export async function telegramSetWebhook(
  token: string,
  input: { url: string; secretToken: string }
): Promise<void> {
  await telegramCall(token, "setWebhook", {
    url: input.url,
    secret_token: input.secretToken,
    allowed_updates: ["message"],
    // A pending backlog from a previous owner of this bot is not ours to
    // answer, and replaying it would look like a burst of stale questions.
    drop_pending_updates: true
  });
}

/** Used on disconnect, so a revoked connection stops receiving traffic. */
export async function telegramDeleteWebhook(token: string): Promise<void> {
  await telegramCall(token, "deleteWebhook", { drop_pending_updates: true });
}

export type TelegramSentMessage = { messageId: string; chatId: string };

export async function telegramSendMessage(
  token: string,
  input: {
    chatId: string | number;
    text: string;
    /** Anchors a reply into an existing thread where the channel has one. */
    replyToMessageId?: number | null;
    /** Ask the speaker to share the number Telegram verified at signup. */
    requestContact?: { buttonText: string } | null;
  }
): Promise<TelegramSentMessage> {
  const result = await telegramCall<{ message_id: number; chat: { id: number } }>(
    token,
    "sendMessage",
    {
      chat_id: input.chatId,
      text: input.text.slice(0, TELEGRAM_MESSAGE_MAX_CHARS),
      // HTML rather than Markdown: Telegram's Markdown dialects reject
      // unescaped underscores and asterisks, which ordinary prose contains,
      // and a rejected send is worse than an unformatted one.
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(input.replyToMessageId
        ? { reply_parameters: { message_id: input.replyToMessageId, allow_sending_without_reply: true } }
        : {}),
      ...(input.requestContact
        ? {
            reply_markup: {
              keyboard: [[{ text: input.requestContact.buttonText, request_contact: true }]],
              one_time_keyboard: true,
              resize_keyboard: true
            }
          }
        : {})
    }
  );
  return { messageId: String(result.message_id), chatId: String(result.chat.id) };
}

/**
 * HTML-escape before interpolating anything into a message.
 *
 * Alert text carries customer names and free-form notes. Sent with
 * parse_mode HTML, a stray `<` makes Telegram reject the whole message with
 * "can't parse entities", so an unescaped alert is not a rendering glitch,
 * it is a silently undelivered alert.
 */
export function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Escape for use INSIDE a double-quoted attribute, e.g. an anchor's href.
 *
 * The text escaper above is not enough there, and the difference matters:
 * it leaves `"` alone, so a URL carrying one would close the attribute
 * early and let whatever followed be parsed as further markup. Telegram
 * renders a restricted HTML subset, but "restricted" is not "inert", and
 * the URL is data we hand it on a tenant's behalf.
 */
export function escapeTelegramAttribute(value: string): string {
  return escapeTelegramHtml(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
