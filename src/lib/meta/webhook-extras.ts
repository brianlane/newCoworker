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
  applyMessengerDeliveryStatus,
  findMessengerConversation,
  setMessengerConversationReferral,
  type MessengerDeliveryStatus,
  type MessengerPlatform
} from "@/lib/messenger/db";
import {
  getActiveWhatsAppConnectionByPhoneNumberId,
  listActiveWhatsAppConnectionsByWabaId,
  updateWhatsAppTemplates
} from "@/lib/db/whatsapp-connections";
import { getMetaAppId, whatsappTemplateStateKey } from "@/lib/meta/client";
import { recordSystemLog } from "@/lib/db/system-logs";
import { logger } from "@/lib/logger";
import type {
  MetaEchoEvent,
  MetaMessageStatusEvent,
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
 * Meta's template events that still mean "you can send this".
 *
 * deliverWhatsApp gates on `status === "APPROVED"` and nothing else, so
 * writing an event verbatim is wrong in BOTH directions, and the dangerous
 * direction is blocking a template that works:
 *
 *   REINSTATED  no longer flagged or disabled, sendable again
 *   FLAGGED     negative feedback, AT RISK but still sendable
 *   LOCKED      cannot be EDITED, still sendable
 *
 * Everything else (PAUSED, REJECTED, DISABLED, PENDING, IN_APPEAL, ARCHIVED,
 * DELETED, PENDING_DELETION, LIMIT_EXCEEDED) genuinely stops sends.
 */
const SENDABLE_TEMPLATE_EVENTS = new Set(["APPROVED", "REINSTATED", "FLAGGED", "LOCKED"]);

/**
 * Normalize Meta's language code to the one our template keys use.
 *
 * We key English as `en_US`; the webhook sends `en-US` or plain `en`
 * depending on how the template was created. Without this a Spanish update
 * would land on the English entry, or an English one would create a phantom
 * `nc_owner_alert:en-US` key that nothing reads.
 */
function templateLanguageKey(language: string): string {
  const normalized = language.trim().replace("-", "_");
  if (!normalized || normalized === "en" || normalized.startsWith("en_")) return "en_US";
  // "es_MX" and "es" both address our single Spanish variant.
  return normalized.split("_")[0];
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
  // Plural: a WABA can be shared across tenants, and a singular lookup would
  // error on that and drop the update for all of them.
  const connections = await listActiveWhatsAppConnectionsByWabaId(event.wabaId).catch(() => []);
  if (connections.length === 0) {
    logger.warn("meta template status for unconnected waba", { wabaId: event.wabaId });
    return false;
  }

  // Language-aware key: en_US keeps the bare name, other languages are
  // suffixed. Getting this wrong points a Spanish update at the English entry.
  const key = whatsappTemplateStateKey(event.templateName, templateLanguageKey(event.language));
  const sendable = SENDABLE_TEMPLATE_EVENTS.has(event.status);
  // What deliverWhatsApp gates on. The raw event is kept alongside so the
  // owner-facing detail can still name the real state.
  const status = sendable ? "APPROVED" : event.status;

  let applied = false;
  for (const connection of connections) {
    const templates = connection.templates ?? {};
    const existing = templates[key];
    // Only touch a template we already track. An unknown key is somebody
    // else's template on the same WABA, and inventing an entry for it would
    // make deliverWhatsApp consider sending something we never registered.
    if (!existing) continue;

    try {
      await updateWhatsAppTemplates(connection.business_id, {
        ...templates,
        [key]: { ...existing, status, lastEvent: event.status }
      });
    } catch (err) {
      logger.error("meta template status write failed", {
        businessId: connection.business_id,
        error: err instanceof Error ? err.message : String(err)
      });
      continue;
    }
    applied = true;

    // A template that stopped being sendable is the case worth surfacing: it
    // means out-of-window WhatsApp sends are about to start skipping.
    if (!sendable) {
      await recordSystemLog({
        businessId: connection.business_id,
        source: "app",
        level: "warn",
        event: "whatsapp_template_status_changed",
        message:
          `WhatsApp template ${event.templateName} is now ${event.status}` +
          (event.reason ? ` (${event.reason})` : "") +
          ". Messages sent outside the 24-hour window will be skipped until it is approved again.",
        payload: {
          template: event.templateName,
          key,
          status: event.status,
          reason: event.reason
        }
      });
    }
    logger.info("meta template status applied", {
      businessId: connection.business_id,
      key,
      event: event.status,
      status
    });
  }
  return applied;
}

/** Meta's receipt vocabulary, narrowed to what the column accepts. */
const DELIVERY_STATUSES = new Set<MessengerDeliveryStatus>([
  "sent",
  "delivered",
  "read",
  "failed"
]);

function asDeliveryStatus(raw: string): MessengerDeliveryStatus | null {
  const normalized = raw.trim().toLowerCase();
  return DELIVERY_STATUSES.has(normalized as MessengerDeliveryStatus)
    ? (normalized as MessengerDeliveryStatus)
    : null;
}

/**
 * Record a Meta delivery receipt against the message it belongs to.
 *
 * Why this exists: the send call returning `ok` means Meta ACCEPTED the
 * message, not that anyone received it. Until this landed, that was the only
 * signal the platform kept, so a message accepted and then dropped looked
 * exactly like a delivered one, forever. KYP Ads spent two weeks unable to
 * start a single WhatsApp conversation, and every internal record said its
 * sends were fine.
 *
 * A `failed` receipt is the whole point, so it is escalated to a system log
 * (owner-visible) rather than an info line. The routine sent/delivered/read
 * receipts stay quiet.
 */
export async function processMetaMessageStatusEvent(
  event: MetaMessageStatusEvent
): Promise<boolean> {
  const status = asDeliveryStatus(event.status);
  // Meta adds states over time (e.g. "deleted"). An unknown one is not an
  // error, it is simply not something this column models.
  if (!status) return false;

  const connection = await getActiveWhatsAppConnectionByPhoneNumberId(event.accountId).catch(
    () => null
  );
  if (!connection) {
    logger.warn("meta message status for unconnected number", { accountId: event.accountId });
    return false;
  }

  let outcome: Awaited<ReturnType<typeof applyMessengerDeliveryStatus>>;
  try {
    outcome = await applyMessengerDeliveryStatus({
      businessId: connection.business_id,
      mid: event.mid,
      status,
      errorCode: event.errorCode,
      errorTitle: event.errorTitle,
      timestamp: event.occurredAt
    });
  } catch (err) {
    logger.warn("meta message status apply failed", {
      businessId: connection.business_id,
      mid: event.mid,
      error: err instanceof Error ? err.message : String(err)
    });
    return false;
  }

  // Receipts also arrive for messages this system never wrote (a human
  // replying from the Meta inbox), and for anything sent before the wamid
  // was stored. Neither is a problem worth reporting.
  if (outcome !== "applied") return false;

  if (status === "failed") {
    await recordSystemLog({
      businessId: connection.business_id,
      level: "error",
      source: "whatsapp",
      event: "whatsapp_message_failed",
      message:
        "WhatsApp did not deliver a message" +
        (event.errorTitle ? `: ${event.errorTitle}` : "") +
        (event.errorCode ? ` (Meta code ${event.errorCode})` : ""),
      payload: {
        mid: event.mid,
        errorCode: event.errorCode,
        errorTitle: event.errorTitle
      }
    });
  }
  return true;
}
