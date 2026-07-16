/**
 * Meta webhook processing (the logic behind /api/webhooks/meta).
 *
 * Mirrors src/lib/vagaro/webhook.ts: the route stays a thin
 * verify-and-delegate layer, and everything after signature verification
 * lives here. Two event families arrive on the same callback:
 *
 *   * `entry[].changes[]` with field "leadgen" (object "page") — lead ads.
 *     Each becomes a webhook flow event with source "facebook_lead_ads"
 *     and the leadgen id as the idempotency key.
 *   * `entry[].messaging[]` (object "page" = Messenger, object
 *     "instagram" = IG DMs) and `entry[].changes[].value.messages[]`
 *     (object "whatsapp_business_account" = WhatsApp) — conversation
 *     messages. Each lands in messenger_conversations/messages (Meta
 *     `mid`/wamid dedupes redeliveries) and enqueues a messenger_jobs
 *     reply job; a NEW conversation also fires a first-contact webhook
 *     flow event (source "facebook_messenger" / "instagram_dm" /
 *     "whatsapp", conversation id as the idempotency key).
 */
import { z } from "zod";
import {
  getActiveMetaConnectionByInstagramId,
  getActiveMetaConnectionByPageId
} from "@/lib/db/meta-connections";
import { getActiveWhatsAppConnectionByPhoneNumberId } from "@/lib/db/whatsapp-connections";
import { fetchLead } from "@/lib/meta/client";
import {
  appendMessengerMessage,
  deleteMessengerMessage,
  insertMessengerJob,
  upsertMessengerConversation,
  type MessengerPlatform
} from "@/lib/messenger/db";
import { processWebhookFlowEvent } from "@/lib/ai-flows/webhook-events";
import { rateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

/** Serialized payload ceiling — a leadgen notification is tiny. */
export const META_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;

// Real lead volume is a handful a day per page; this absorbs Meta's
// redelivery bursts while capping a runaway loop.
const META_WEBHOOK_RATE = { interval: 60 * 1000, maxRequests: 240 };

const webhookBodySchema = z.object({
  object: z.string(),
  entry: z.array(
    z.object({
      id: z.union([z.string(), z.number()]).optional(),
      changes: z
        .array(
          z.object({
            field: z.string(),
            value: z
              .object({
                leadgen_id: z.union([z.string(), z.number()]).optional(),
                page_id: z.union([z.string(), z.number()]).optional()
              })
              .passthrough()
          })
        )
        .optional(),
      messaging: z
        .array(
          z.object({
            sender: z.object({ id: z.union([z.string(), z.number()]) }).optional(),
            recipient: z.object({ id: z.union([z.string(), z.number()]) }).optional(),
            message: z
              .object({
                mid: z.string().optional(),
                text: z.string().optional(),
                is_echo: z.boolean().optional(),
                attachments: z.array(z.unknown()).optional()
              })
              .passthrough()
              .optional(),
            postback: z
              .object({
                mid: z.string().optional(),
                title: z.string().optional(),
                payload: z.string().optional()
              })
              .passthrough()
              .optional()
          })
        )
        .optional()
    })
  )
});

/**
 * WhatsApp deliveries carry a different change shape than leadgen:
 * value.messages[] (inbound texts) + value.statuses[] (receipts, ignored)
 * + value.contacts[] (sender profile names) under field "messages".
 */
const whatsappChangeValueSchema = z
  .object({
    metadata: z
      .object({
        phone_number_id: z.union([z.string(), z.number()]).optional()
      })
      .passthrough()
      .optional(),
    contacts: z
      .array(
        z.object({
          wa_id: z.union([z.string(), z.number()]).optional(),
          profile: z.object({ name: z.string().optional() }).passthrough().optional()
        })
      )
      .optional(),
    messages: z
      .array(
        z.object({
          id: z.string().optional(),
          from: z.union([z.string(), z.number()]).optional(),
          type: z.string().optional(),
          text: z.object({ body: z.string().optional() }).passthrough().optional(),
          button: z
            .object({ text: z.string().optional(), payload: z.string().optional() })
            .passthrough()
            .optional()
        })
      )
      .optional()
  })
  .passthrough();

export type MetaLeadgenEvent = {
  pageId: string;
  leadgenId: string;
};

export type MetaMessageEvent = {
  platform: MessengerPlatform;
  /**
   * Business-side account key: Page id (messenger), IG professional
   * account id (instagram), or phone_number_id (whatsapp).
   */
  accountId: string;
  /** The lead's page-/IG-scoped user id, or wa_id for WhatsApp. */
  senderId: string;
  /** Meta message id (wamid for WhatsApp) — the redelivery dedupe key. */
  mid: string;
  text: string;
  /** Sender profile name when the delivery carried one (WhatsApp does). */
  displayName?: string | null;
};

export type MetaWebhookEvents = {
  leadgen: MetaLeadgenEvent[];
  messages: MetaMessageEvent[];
};

/** Shown in transcripts for image/audio/file messages we don't ingest. */
export const MESSENGER_ATTACHMENT_PLACEHOLDER = "[attachment]";

/**
 * Extract the leadgen changes and conversation messages from a
 * (signature-verified) webhook body. Returns null for a body that isn't a
 * Meta webhook payload at all; empty arrays for valid payloads with
 * nothing to do (unknown objects, echoes, receipts) — those are
 * acknowledged, not errored.
 */
export function parseMetaWebhookBody(json: unknown): MetaWebhookEvents | null {
  const parsed = webhookBodySchema.safeParse(json);
  if (!parsed.success) return null;

  const events: MetaWebhookEvents = { leadgen: [], messages: [] };
  const object = parsed.data.object;
  if (object === "whatsapp_business_account") {
    for (const entry of parsed.data.entry) {
      for (const change of entry.changes ?? []) {
        if (change.field !== "messages") continue;
        const value = whatsappChangeValueSchema.safeParse(change.value);
        if (!value.success) continue;
        const phoneNumberId = String(value.data.metadata?.phone_number_id ?? "");
        if (!phoneNumberId) continue;
        // Sender display names ride along in contacts[], keyed by wa_id.
        const names = new Map<string, string>();
        for (const contact of value.data.contacts ?? []) {
          const waId = String(contact.wa_id ?? "");
          const name = contact.profile?.name?.trim();
          if (waId && name) names.set(waId, name);
        }
        for (const message of value.data.messages ?? []) {
          const mid = message.id ?? "";
          const senderId = String(message.from ?? "");
          if (!mid || !senderId) continue;
          const text = message.text?.body?.trim() ?? "";
          // Quick-reply button taps read as the customer's turn.
          const buttonLabel =
            message.button?.text?.trim() || message.button?.payload?.trim() || "";
          const content =
            text ||
            buttonLabel ||
            // Non-text types (image/audio/document/...) get the placeholder;
            // `unsupported`/reaction noise is skipped entirely.
            (message.type && !["unsupported", "reaction"].includes(message.type)
              ? MESSENGER_ATTACHMENT_PLACEHOLDER
              : "");
          if (!content) continue;
          events.messages.push({
            platform: "whatsapp",
            accountId: phoneNumberId,
            senderId,
            mid,
            text: content,
            displayName: names.get(senderId) ?? null
          });
        }
        // value.statuses[] (sent/delivered/read receipts) intentionally ignored.
      }
    }
    return events;
  }
  if (object !== "page" && object !== "instagram") return events;
  const platform: MessengerPlatform = object === "instagram" ? "instagram" : "messenger";

  for (const entry of parsed.data.entry) {
    const entryId = String(entry.id ?? "");

    if (platform === "messenger") {
      for (const change of entry.changes ?? []) {
        if (change.field !== "leadgen") continue;
        const pageId = String(change.value.page_id ?? entry.id ?? "");
        const leadgenId = String(change.value.leadgen_id ?? "");
        if (!pageId || !leadgenId) continue;
        events.leadgen.push({ pageId, leadgenId });
      }
    }

    for (const item of entry.messaging ?? []) {
      const senderId = String(item.sender?.id ?? "");
      // The page/IG account echoing its own sends must never loop back in.
      if (!entryId || !senderId || senderId === entryId) continue;

      if (item.message) {
        if (item.message.is_echo) continue;
        const mid = item.message.mid ?? "";
        if (!mid) continue;
        const text = item.message.text?.trim() ?? "";
        const hasAttachments =
          Array.isArray(item.message.attachments) && item.message.attachments.length > 0;
        const content = text || (hasAttachments ? MESSENGER_ATTACHMENT_PLACEHOLDER : "");
        if (!content) continue; // delivery/read-style noise
        events.messages.push({ platform, accountId: entryId, senderId, mid, text: content });
        continue;
      }

      if (item.postback) {
        // A tapped button (e.g. "Get started") reads as the lead's turn.
        const mid = item.postback.mid ?? "";
        const label = item.postback.title?.trim() || item.postback.payload?.trim() || "";
        if (!mid || !label) continue;
        events.messages.push({ platform, accountId: entryId, senderId, mid, text: label });
      }
    }
  }
  return events;
}

/**
 * Resolve, fetch, and enqueue one leadgen event. Never throws — a failure
 * for one lead must not fail the delivery batch (Meta redelivers, and the
 * dedupe key makes the retry safe). Returns true when a lead reached the
 * flow engine.
 */
export async function processMetaLeadgenEvent(
  event: MetaLeadgenEvent
): Promise<boolean> {
  const { pageId, leadgenId } = event;

  const limiter = rateLimit(`meta-webhook:${pageId}`, META_WEBHOOK_RATE);
  if (!limiter.success) {
    logger.warn("meta webhook rate limited", { pageId });
    return false;
  }

  const connection = await getActiveMetaConnectionByPageId(pageId).catch((err) => {
    logger.warn("meta webhook connection lookup failed", {
      pageId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  });
  if (!connection?.pageToken) {
    // Unknown/disabled page: acknowledge so Meta doesn't retry forever.
    logger.warn("meta webhook for unconnected page", { pageId });
    return false;
  }

  try {
    const lead = await fetchLead(leadgenId, connection.pageToken);
    const result = await processWebhookFlowEvent(connection.business_id, {
      source: "facebook_lead_ads",
      eventId: leadgenId,
      data: {
        ...lead.fields,
        leadgen_id: lead.id,
        ...(lead.formId ? { form_id: lead.formId } : {}),
        ...(lead.adId ? { ad_id: lead.adId } : {}),
        ...(lead.createdTime ? { created_time: lead.createdTime } : {}),
        page_id: pageId
      }
    });
    logger.info("meta lead processed", {
      businessId: connection.business_id,
      pageId,
      leadgenId,
      enqueued: result.enqueued,
      flowsMatched: result.flowsMatched
    });
    return true;
  } catch (err) {
    logger.warn("meta lead processing failed", {
      businessId: connection.business_id,
      pageId,
      leadgenId,
      error: err instanceof Error ? err.message : String(err)
    });
    return false;
  }
}

/** Flow-trigger source labels for first-contact conversation events. */
export const MESSENGER_FLOW_SOURCES: Record<MessengerPlatform, string> = {
  messenger: "facebook_messenger",
  instagram: "instagram_dm",
  whatsapp: "whatsapp"
};

/**
 * The business-side send credentials for one inbound message, platform-
 * normalized: Page token + page id for Messenger/IG, Cloud API token +
 * phone_number_id for WhatsApp.
 */
type ResolvedMessageAccount = {
  businessId: string;
  /** Value stored in messenger_conversations.page_id. */
  accountKey: string;
};

async function resolveMessageAccount(
  platform: MessengerPlatform,
  accountId: string
): Promise<ResolvedMessageAccount | null> {
  if (platform === "whatsapp") {
    const connection = await getActiveWhatsAppConnectionByPhoneNumberId(accountId);
    if (!connection?.accessToken) return null;
    return { businessId: connection.business_id, accountKey: connection.phone_number_id };
  }
  const connection =
    platform === "instagram"
      ? await getActiveMetaConnectionByInstagramId(accountId)
      : await getActiveMetaConnectionByPageId(accountId);
  if (!connection?.pageToken || !connection.page_id) return null;
  return { businessId: connection.business_id, accountKey: connection.page_id };
}

/**
 * Ingest one conversation message: resolve the tenant, upsert the
 * conversation (bumping the 24h-window clock), append the message (Meta
 * `mid` dedupe), enqueue the reply job, and fire the first-contact flow
 * trigger for brand-new conversations. Never throws — one bad message
 * must not fail the delivery batch. Returns true when a reply job was
 * enqueued.
 */
export async function processMetaMessageEvent(
  event: MetaMessageEvent
): Promise<boolean | "rate_limited"> {
  const { platform, accountId, senderId, mid, text } = event;

  // "rate_limited" (unlike a plain skip) makes the route answer non-200
  // so Meta REDELIVERS the batch once the window clears — the mid dedupe
  // makes reprocessing the already-ingested events a no-op, so nothing is
  // silently dropped and nothing double-enqueues.
  const limiter = rateLimit(`meta-webhook-msg:${accountId}`, META_WEBHOOK_RATE);
  if (!limiter.success) {
    logger.warn("meta message webhook rate limited; requesting redelivery", {
      accountId,
      platform
    });
    return "rate_limited";
  }

  let account: ResolvedMessageAccount | null = null;
  try {
    account = await resolveMessageAccount(platform, accountId);
  } catch (err) {
    logger.warn("meta message connection lookup failed", {
      accountId,
      platform,
      error: err instanceof Error ? err.message : String(err)
    });
    return false;
  }
  if (!account) {
    // Unknown/disabled account: acknowledge so Meta doesn't retry forever.
    logger.warn("meta message for unconnected account", { accountId, platform });
    return false;
  }

  try {
    const { conversation, isNew } = await upsertMessengerConversation({
      businessId: account.businessId,
      pageId: account.accountKey,
      platform,
      psid: senderId,
      // WhatsApp deliveries carry the sender's profile name inline.
      displayName: event.displayName ?? null
    });

    const message = await appendMessengerMessage({
      conversationId: conversation.id,
      businessId: account.businessId,
      role: "user",
      content: text,
      mid
    });
    if (!message) {
      // Duplicate redelivery — the original already has a job.
      return false;
    }

    if (isNew) {
      // First contact starts matching webhook flows exactly like a lead-ads
      // event (exactly-once via the conversation-id dedupe key). Reply
      // generation is the conversational engine's job, not the flow's.
      try {
        await processWebhookFlowEvent(account.businessId, {
          source: MESSENGER_FLOW_SOURCES[platform],
          eventId: conversation.id,
          data: {
            platform,
            page_id: account.accountKey,
            psid: senderId,
            ...(conversation.display_name
              ? { display_name: conversation.display_name }
              : {}),
            first_message: text
          }
        });
      } catch (err) {
        logger.warn("messenger first-contact flow trigger failed", {
          businessId: account.businessId,
          conversationId: conversation.id,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    try {
      await insertMessengerJob({
        businessId: account.businessId,
        conversationId: conversation.id,
        userMessageId: message.id
      });
    } catch (jobErr) {
      // Compensating delete: a stored message with no reply job would
      // never be answered (we ack Meta 200 either way), and its mid row
      // would block a redelivery from re-ingesting. Removing it keeps the
      // transcript consistent with what the engine will actually answer.
      try {
        await deleteMessengerMessage(message.id);
      } catch (cleanupErr) {
        logger.error("meta message job-insert cleanup failed; orphan transcript row", {
          businessId: account.businessId,
          messageId: message.id,
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
        });
      }
      throw jobErr;
    }
    return true;
  } catch (err) {
    logger.warn("meta message processing failed", {
      businessId: account.businessId,
      accountId,
      platform,
      error: err instanceof Error ? err.message : String(err)
    });
    return false;
  }
}

/**
 * Process every event in a delivery; returns the handled counts plus how
 * many message events were shed by the rate limiter (the route answers
 * non-200 when any were, so Meta redelivers them).
 */
export async function processMetaWebhookEvents(
  events: MetaWebhookEvents
): Promise<{ handled: number; messagesEnqueued: number; messagesRateLimited: number }> {
  let handled = 0;
  for (const event of events.leadgen) {
    if (await processMetaLeadgenEvent(event)) handled += 1;
  }
  let messagesEnqueued = 0;
  let messagesRateLimited = 0;
  for (const event of events.messages) {
    const result = await processMetaMessageEvent(event);
    if (result === "rate_limited") messagesRateLimited += 1;
    else if (result) messagesEnqueued += 1;
  }
  return { handled, messagesEnqueued, messagesRateLimited };
}
