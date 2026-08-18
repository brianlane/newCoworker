/**
 * The three Meta webhook families that used to be dropped on the floor:
 * Page-side echoes, Click-to-Messenger referrals, and WhatsApp template
 * status changes.
 *
 * Each was arriving (or would have, once subscribed) and being discarded by a
 * field filter, so the consequence was silent in all three cases:
 *
 *   - echoes: a colleague replying in Meta's Page Inbox was invisible, so the
 *     AI answered the customer's next message on top of them;
 *   - referrals: which ad produced a conversation was unknowable, on a
 *     lead-ads-first product;
 *   - template statuses: a template PAUSED or REJECTED after approval kept
 *     being sent against, because deliverWhatsApp gates on a stored status
 *     that nothing refreshed outside a manual reconnect.
 */
import {
  getActiveMetaConnectionByInstagramId,
  getActiveMetaConnectionByPageId
} from "@/lib/db/meta-connections";
import {
  appendMessengerMessage,
  findMessengerConversation,
  setMessengerConversationReferral,
  type MessengerPlatform
} from "@/lib/messenger/db";
import {
  getWhatsAppConnectionByWabaId,
  updateWhatsAppTemplates
} from "@/lib/db/whatsapp-connections";
import { getMetaAppId } from "@/lib/meta/client";
import { recordSystemLog } from "@/lib/db/system-logs";
import { logger } from "@/lib/logger";
import type {
  MetaEchoEvent,
  MetaReferralEvent,
  MetaTemplateStatusEvent
} from "@/lib/meta/webhook";

/** Our app id, or null when unset (tests, misconfigured env). */
function appIdOrNull(): string | null {
  try {
    return getMetaAppId();
  } catch {
    return null;
  }
}

/** Resolve the tenant behind a Page id or IG account id. */
async function connectionFor(platform: MessengerPlatform, accountId: string) {
  if (platform === "whatsapp") return null;
  return platform === "instagram"
    ? await getActiveMetaConnectionByInstagramId(accountId).catch(() => null)
    : await getActiveMetaConnectionByPageId(accountId).catch(() => null);
}

/**
 * A Page-side send we did not make: record it as an `owner` turn.
 *
 * That single write is the whole fix for the AI talking over staff.
 * `buildMessengerContents` returns null when a model-side row trails the last
 * user turn, so the queued job fails as `no_input` and the AI stays quiet
 * until the customer speaks again. No new suppression machinery, no new
 * column, and the reply also lands in the transcript the owner reads.
 *
 * OURS are filtered out by mid: every send records the id Meta returned, so a
 * mid we already hold is our own echo coming home. Anything else is a person.
 */
export async function processMetaEchoEvent(event: MetaEchoEvent): Promise<boolean> {
  // OUR OWN reply coming home. Dropped here rather than downstream, because
  // recording it as an owner turn would silence the AI immediately after it
  // spoke and stall every conversation.
  //
  // app_id is Meta's own discriminator and is always present since Graph
  // v12.0: a person typing in the Page Inbox produces
  // META_PAGE_INBOX_APP_ID, and any other app id is likewise not us. An
  // ABSENT app id is treated as not-ours too, which is the safe direction:
  // the cost is one extra owner turn, versus an AI that talks over staff.
  if (event.appId && event.appId === appIdOrNull()) return false;

  const connection = await connectionFor(event.platform, event.accountId);
  if (!connection) return false;

  const conversation = await findMessengerConversation(
    connection.business_id,
    event.platform,
    event.recipientId
  ).catch(() => null);
  // No thread means the Page started a conversation we have never seen, which
  // is not something to reconstruct from an echo.
  if (!conversation) return false;

  // Empty echoes (an attachment-only reply) still prove a human is present,
  // so they are recorded with a readable placeholder rather than skipped.
  const text = event.text || "[replied in Meta inbox]";
  // mid carries the partial unique index, so OUR OWN echo is a duplicate and
  // returns null: that is the filter, enforced by the database rather than by
  // comparing app ids Meta does not always send.
  const row = await appendMessengerMessage({
    conversationId: conversation.id,
    businessId: connection.business_id,
    role: "owner",
    content: text,
    mid: event.mid
  }).catch((err) => {
    logger.warn("meta echo append failed", {
      businessId: connection.business_id,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  });
  if (!row) return false;

  logger.info("meta echo recorded as an owner turn", {
    businessId: connection.business_id,
    platform: event.platform,
    conversationId: conversation.id
  });
  return true;
}

/**
 * Stamp Click-to-Messenger attribution on the conversation, once.
 *
 * Written only when the thread has none: the referral that STARTED the
 * conversation is the one worth reporting, and a later re-entry from a
 * different ad must not overwrite it.
 */
export async function processMetaReferralEvent(event: MetaReferralEvent): Promise<boolean> {
  // A referral with no ad and no ref code carries nothing worth storing.
  if (!event.adId && !event.ref) return false;
  const connection = await connectionFor(event.platform, event.accountId);
  if (!connection) return false;

  const conversation = await findMessengerConversation(
    connection.business_id,
    event.platform,
    event.senderId
  ).catch(() => null);
  // The referral often arrives on the SAME delivery as the first message, and
  // ordering between them is not guaranteed. No thread yet simply means the
  // message half has not landed; the next referral for this person will stamp
  // it, and losing an edge case beats inventing a conversation row here.
  if (!conversation) return false;

  const stamped = await setMessengerConversationReferral(conversation.id, {
    ref: event.ref,
    source: event.source,
    type: event.type,
    ad_id: event.adId,
    ad_title: event.adTitle
  }).catch((err) => {
    logger.warn("meta referral stamp failed", {
      businessId: connection.business_id,
      error: err instanceof Error ? err.message : String(err)
    });
    return false;
  });
  if (stamped) {
    logger.info("meta referral attributed", {
      businessId: connection.business_id,
      platform: event.platform,
      adId: event.adId || null,
      ref: event.ref || null
    });
  }
  return stamped;
}

/**
 * Apply a WhatsApp template status change to the stored template state.
 *
 * deliverWhatsApp refuses to send an out-of-window message unless the stored
 * status is APPROVED, so writing the new status here is the entire fix: a
 * PAUSED or REJECTED template stops being used the moment Meta says so,
 * instead of at the owner's next manual reconnect.
 */
export async function processMetaTemplateStatusEvent(
  event: MetaTemplateStatusEvent
): Promise<boolean> {
  const connection = await getWhatsAppConnectionByWabaId(event.wabaId).catch(() => null);
  if (!connection) {
    logger.warn("meta template status for unconnected waba", { wabaId: event.wabaId });
    return false;
  }
  const templates = connection.templates ?? {};
  const existing = templates[event.templateName];
  // Only touch a template we already track. An unknown name is somebody
  // else's template on the same WABA, and inventing an entry for it would
  // make deliverWhatsApp consider sending something we never registered.
  if (!existing) return false;

  const next = {
    ...templates,
    [event.templateName]: { ...existing, status: event.status }
  };
  await updateWhatsAppTemplates(connection.business_id, next);

  // An approved template going bad is the case worth surfacing: it means
  // out-of-window WhatsApp sends are about to start skipping.
  if (event.status !== "APPROVED") {
    await recordSystemLog({
      businessId: connection.business_id,
      source: "app",
      level: "warn",
      event: "whatsapp_template_status_changed",
      message:
        `WhatsApp template ${event.templateName} is now ${event.status}` +
        (event.reason ? ` (${event.reason})` : "") +
        ". Messages sent outside the 24-hour window will be skipped until it is approved again.",
      payload: { template: event.templateName, status: event.status, reason: event.reason }
    });
  }
  logger.info("meta template status applied", {
    businessId: connection.business_id,
    template: event.templateName,
    status: event.status
  });
  return true;
}
