/**
 * Central Telegram alert delivery: the one function that turns "post this to
 * the tenant's Telegram" into a sendMessage, shared by the Node dispatcher
 * and the /api/internal/telegram-send bridge the Deno mirror calls.
 *
 * Structured outcomes instead of throws (deliverSlackAlert's contract): the
 * caller decides whether "not_connected" is silence (a never-connected
 * tenant records nothing at all) or an honest skipped row.
 *
 * Tier is RE-CHECKED at delivery time: a downgrade to starter silently
 * stops traffic without deleting the stored connection, the same rule every
 * other gated delivery path follows.
 */

import {
  getCoworkerConnection,
  type CoworkerConnectionRow
} from "@/lib/db/coworker-connections";
import { coworkerChannelAllowedForBusiness } from "@/lib/coworker-channels/tier-gate";
import { escapeTelegramHtml, telegramSendMessage } from "@/lib/telegram/client";
import { logger } from "@/lib/logger";

export type TelegramDeliveryResult =
  | { ok: true; chatId: string; messageId: string }
  | {
      ok: false;
      reason:
        | "not_connected"
        | "needs_reconnect"
        | "no_alert_target"
        | "tier_blocked"
        | "send_failed";
      detail?: string;
    };

export type TelegramDeliveryInput = {
  businessId: string;
  /** One-line summary, shown in the phone's notification. */
  summary: string;
  /** Optional detail body under the summary. */
  details?: string | null;
  /** Optional deep link into the dashboard. */
  detailsUrl?: string | null;
};

/**
 * The alert card.
 *
 * Every interpolated part is HTML-escaped BEFORE the tags go on. These
 * strings carry customer names and free-form notes, and Telegram rejects an
 * entire message whose entities will not parse, so a stray `<` in a
 * customer's note would not garble an alert, it would silently lose one.
 */
function buildTelegramAlertText(input: {
  summary: string;
  details?: string | null;
  detailsUrl?: string | null;
}): string {
  const parts = [`<b>${escapeTelegramHtml(input.summary)}</b>`];
  const details = (input.details ?? "").trim();
  if (details) parts.push(escapeTelegramHtml(details));
  const url = (input.detailsUrl ?? "").trim();
  // Only http(s). A javascript: or data: href in an anchor is a link we
  // would be publishing on the tenant's behalf.
  if (/^https?:\/\//i.test(url)) {
    parts.push(`<a href="${escapeTelegramHtml(url)}">Open in New Coworker</a>`);
  }
  return parts.join("\n\n");
}

export async function deliverTelegramAlert(
  input: TelegramDeliveryInput
): Promise<TelegramDeliveryResult> {
  let connection: CoworkerConnectionRow | null;
  try {
    connection = await getCoworkerConnection(input.businessId, "telegram");
  } catch (err) {
    logger.warn("deliverTelegramAlert: connection read failed", {
      businessId: input.businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return { ok: false, reason: "send_failed", detail: "connection_read_failed" };
  }
  if (!connection) return { ok: false, reason: "not_connected" };
  if (!connection.is_active || connection.credential.length === 0) {
    return { ok: false, reason: "needs_reconnect" };
  }
  if (!connection.alert_target_id) return { ok: false, reason: "no_alert_target" };

  // Delivery-time tier re-check. Fails TOWARD delivering on a read error:
  // an alert must never be lost to a transient tier lookup blip.
  try {
    if (!(await coworkerChannelAllowedForBusiness(input.businessId))) {
      return { ok: false, reason: "tier_blocked" };
    }
  } catch (err) {
    logger.warn("deliverTelegramAlert: tier check failed, delivering anyway", {
      businessId: input.businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }

  try {
    const sent = await telegramSendMessage(connection.credential, {
      chatId: connection.alert_target_id,
      text: buildTelegramAlertText(input)
    });
    return { ok: true, chatId: sent.chatId, messageId: sent.messageId };
  } catch (err) {
    return {
      ok: false,
      reason: "send_failed",
      detail: err instanceof Error ? err.message : String(err)
    };
  }
}

/**
 * Does this channel apply to this business at all?
 *
 * The dispatcher uses this to decide whether to record a row. On a read
 * error it reports CONNECTED, which is the noisier and more honest of the
 * two mistakes: a skipped row that says why beats silence that looks like a
 * tenant who never connected.
 */
export async function telegramAlertTargetState(
  businessId: string
): Promise<{ connected: boolean; hasTarget: boolean }> {
  try {
    const connection = await getCoworkerConnection(businessId, "telegram");
    return {
      connected: connection !== null,
      hasTarget: Boolean(connection?.alert_target_id)
    };
  } catch (err) {
    logger.warn("telegramAlertTargetState: read failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return { connected: true, hasTarget: true };
  }
}
