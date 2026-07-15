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
 *     "instagram" = IG DMs) — conversation messages. Each lands in
 *     messenger_conversations/messages (Meta `mid` dedupes redeliveries)
 *     and enqueues a messenger_jobs reply job; a NEW conversation also
 *     fires a first-contact webhook flow event (source
 *     "facebook_messenger" / "instagram_dm", conversation id as the
 *     idempotency key).
 */
import { z } from "zod";
import {
  getActiveMetaConnectionByInstagramId,
  getActiveMetaConnectionByPageId,
  type MetaConnectionRow
} from "@/lib/db/meta-connections";
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

export type MetaLeadgenEvent = {
  pageId: string;
  leadgenId: string;
};

export type MetaMessageEvent = {
  platform: MessengerPlatform;
  /** Page id (Messenger) or IG professional account id (Instagram). */
  accountId: string;
  /** The lead's page-/IG-scoped user id. */
  senderId: string;
  /** Meta message id — the redelivery dedupe key. */
  mid: string;
  text: string;
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
  instagram: "instagram_dm"
};

/**
 * Ingest one conversation message: resolve the tenant, upsert the
 * conversation (bumping the 24h-window clock), append the message (Meta
 * `mid` dedupe), enqueue the reply job, and fire the first-contact flow
 * trigger for brand-new conversations. Never throws — one bad message
 * must not fail the delivery batch. Returns true when a reply job was
 * enqueued.
 */
export async function processMetaMessageEvent(event: MetaMessageEvent): Promise<boolean> {
  const { platform, accountId, senderId, mid, text } = event;

  const limiter = rateLimit(`meta-webhook-msg:${accountId}`, META_WEBHOOK_RATE);
  if (!limiter.success) {
    logger.warn("meta message webhook rate limited", { accountId, platform });
    return false;
  }

  let connection: MetaConnectionRow | null = null;
  try {
    connection =
      platform === "instagram"
        ? await getActiveMetaConnectionByInstagramId(accountId)
        : await getActiveMetaConnectionByPageId(accountId);
  } catch (err) {
    logger.warn("meta message connection lookup failed", {
      accountId,
      platform,
      error: err instanceof Error ? err.message : String(err)
    });
    return false;
  }
  if (!connection?.pageToken || !connection.page_id) {
    // Unknown/disabled account: acknowledge so Meta doesn't retry forever.
    logger.warn("meta message for unconnected account", { accountId, platform });
    return false;
  }

  try {
    const { conversation, isNew } = await upsertMessengerConversation({
      businessId: connection.business_id,
      pageId: connection.page_id,
      platform,
      psid: senderId
    });

    const message = await appendMessengerMessage({
      conversationId: conversation.id,
      businessId: connection.business_id,
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
        await processWebhookFlowEvent(connection.business_id, {
          source: MESSENGER_FLOW_SOURCES[platform],
          eventId: conversation.id,
          data: {
            platform,
            page_id: connection.page_id,
            psid: senderId,
            ...(conversation.display_name
              ? { display_name: conversation.display_name }
              : {}),
            first_message: text
          }
        });
      } catch (err) {
        logger.warn("messenger first-contact flow trigger failed", {
          businessId: connection.business_id,
          conversationId: conversation.id,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    try {
      await insertMessengerJob({
        businessId: connection.business_id,
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
          businessId: connection.business_id,
          messageId: message.id,
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
        });
      }
      throw jobErr;
    }
    return true;
  } catch (err) {
    logger.warn("meta message processing failed", {
      businessId: connection.business_id,
      accountId,
      platform,
      error: err instanceof Error ? err.message : String(err)
    });
    return false;
  }
}

/** Process every event in a delivery; returns the handled counts. */
export async function processMetaWebhookEvents(
  events: MetaWebhookEvents
): Promise<{ handled: number; messagesEnqueued: number }> {
  let handled = 0;
  for (const event of events.leadgen) {
    if (await processMetaLeadgenEvent(event)) handled += 1;
  }
  let messagesEnqueued = 0;
  for (const event of events.messages) {
    if (await processMetaMessageEvent(event)) messagesEnqueued += 1;
  }
  return { handled, messagesEnqueued };
}
