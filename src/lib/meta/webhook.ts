/**
 * Meta webhook processing (the logic behind /api/webhooks/meta).
 *
 * Mirrors src/lib/vagaro/webhook.ts: the route stays a thin
 * verify-and-delegate layer, and everything after signature verification
 * lives here. Three event families arrive on the same callback:
 *
 *   * `entry[].changes[]` with field "leadgen" (object "page"): lead ads.
 *     Each becomes a webhook flow event with source "facebook_lead_ads"
 *     and the leadgen id as the idempotency key.
 *   * `entry[].messaging[]` (object "page" = Messenger, object
 *     "instagram" = IG DMs) and `entry[].changes[].value.messages[]`
 *     (object "whatsapp_business_account" = WhatsApp): conversation
 *     messages. Each lands in messenger_conversations/messages (Meta
 *     `mid`/wamid dedupes redeliveries) and enqueues a messenger_jobs
 *     reply job; a NEW conversation also fires a first-contact webhook
 *     flow event (source "facebook_messenger" / "instagram_dm" /
 *     "whatsapp", conversation id as the idempotency key).
 *   * `entry[].changes[]` with field "comments" (object "instagram") ,
 *     comments on the linked IG professional account's posts. Each becomes
 *     a webhook flow event with source "instagram_comment" and the comment
 *     id as the idempotency key, so owners can build keyword-scoped
 *     engagement flows (notify, follow up) without any new rules engine.
 *     Requires the platform Meta app's App-Dashboard subscription to the
 *     instagram object's `comments` field.
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
import { clearMetaTokenInvalid, reportMetaCallFailure } from "@/lib/meta/token-health";
import {
  processMetaEchoEvent,
  processMetaReferralEvent,
  processMetaTemplateStatusEvent,
  processMetaMessageStatusEvent
} from "@/lib/meta/webhook-extras";

/** Serialized payload ceiling: a leadgen notification is tiny. */
export const META_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;

// Real lead volume is a handful a day per page; this absorbs Meta's
// redelivery bursts while capping a runaway loop.
const META_WEBHOOK_RATE = { interval: 60 * 1000, maxRequests: 240 };

/**
 * Meta's referral payload: which ad or link brought the person here.
 * `ad_id` is the piece that matters for a lead-ads product.
 */
const referralSchema = z
  .object({
    ref: z.string().optional(),
    source: z.string().optional(),
    type: z.string().optional(),
    ad_id: z.union([z.string(), z.number()]).optional(),
    ads_context_data: z
      .object({ ad_title: z.string().optional(), post_id: z.union([z.string(), z.number()]).optional() })
      .passthrough()
      .optional()
  })
  .passthrough();

/**
 * WhatsApp template status change (object "whatsapp_business_account", field
 * "message_template_status_update"). `event` carries the new status:
 * APPROVED, REJECTED, PAUSED, DISABLED, PENDING_DELETION.
 */
const templateStatusValueSchema = z
  .object({
    message_template_id: z.union([z.string(), z.number()]).optional(),
    message_template_name: z.string().optional(),
    message_template_language: z.string().optional(),
    event: z.string().optional(),
    reason: z.string().optional()
  })
  .passthrough();

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
                /** Which app sent the echoed message; absent for a human. */
                app_id: z.union([z.string(), z.number()]).optional(),
                attachments: z.array(z.unknown()).optional(),
                referral: referralSchema.optional()
              })
              .passthrough()
              .optional(),
            postback: z
              .object({
                mid: z.string().optional(),
                title: z.string().optional(),
                payload: z.string().optional(),
                referral: referralSchema.optional()
              })
              .passthrough()
              .optional(),
            /**
             * Click-to-Messenger / ig.me attribution. Arrives THREE ways: on
             * its own when an existing thread is reopened from an ad, nested
             * in `message.referral` on the first message of a new thread, and
             * nested in `postback.referral` when Get Started came from an ad.
             * Missing any one of them loses the attribution for that entry
             * path, which is why all three are read.
             */
            referral: referralSchema.optional()
          })
        )
        .optional()
    })
  )
});

/**
 * WhatsApp deliveries carry a different change shape than leadgen:
 * value.messages[] (inbound texts) + value.statuses[] (delivery receipts for
 * what WE sent) + value.contacts[] (sender profile names), all under field
 * "messages".
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
      .optional(),
    /**
     * Receipts for messages WE sent, keyed by the wamid the send returned.
     * `errors[]` is present only on `failed` and is the only place Meta ever
     * explains a message it accepted and then did not deliver.
     */
    statuses: z
      .array(
        z.object({
          id: z.string().optional(),
          status: z.string().optional(),
          timestamp: z.union([z.string(), z.number()]).optional(),
          recipient_id: z.union([z.string(), z.number()]).optional(),
          errors: z
            .array(
              z
                .object({
                  code: z.union([z.string(), z.number()]).optional(),
                  title: z.string().optional(),
                  message: z.string().optional()
                })
                .passthrough()
            )
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

export type CommentPlatform = "instagram" | "facebook";

export type MetaCommentEvent = {
  /**
   * Which surface the comment is on. The two arrive in COMPLETELY different
   * shapes: Instagram sends object "instagram" field "comments" with the
   * comment under `value.id`, Facebook sends object "page" field "feed" with
   * an `item`/`verb` pair and the comment under `value.comment_id`.
   */
  platform: CommentPlatform;
  /** IG professional account id, or the Page id for Facebook. */
  accountId: string;
  /** Comment id: the flow-event idempotency key. */
  commentId: string;
  /** The commented media (IG) or post (Facebook), when carried. */
  mediaId: string;
  text: string;
  /** Scoped commenter id + display name / username (may be absent). */
  fromId: string;
  fromUsername: string;
};

/**
 * Instagram comment change payload (object "instagram", field "comments"):
 * value.id is the comment id; from/media/text ride alongside.
 */
const commentChangeValueSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    text: z.string().optional(),
    from: z
      .object({
        id: z.union([z.string(), z.number()]).optional(),
        username: z.string().optional()
      })
      .passthrough()
      .optional(),
    media: z
      .object({ id: z.union([z.string(), z.number()]).optional() })
      .passthrough()
      .optional()
  })
  .passthrough();

/**
 * Facebook Page feed change payload (object "page", field "feed"). The feed
 * field carries EVERYTHING that happens on the Page's posts: comments, the
 * posts themselves, likes, reactions, shares. `item` says which, and `verb`
 * says whether it was added, edited, removed, or hidden, so both must be
 * checked or a flow fires on a like, or twice on an edit.
 */
const feedChangeValueSchema = z
  .object({
    item: z.string().optional(),
    verb: z.string().optional(),
    comment_id: z.union([z.string(), z.number()]).optional(),
    post_id: z.union([z.string(), z.number()]).optional(),
    parent_id: z.union([z.string(), z.number()]).optional(),
    // Facebook says "message"; Instagram says "text".
    message: z.string().optional(),
    from: z
      .object({
        id: z.union([z.string(), z.number()]).optional(),
        // Facebook says "name"; Instagram says "username".
        name: z.string().optional()
      })
      .passthrough()
      .optional()
  })
  .passthrough();

export type MetaMessageEvent = {
  platform: MessengerPlatform;
  /**
   * Business-side account key: Page id (messenger), IG professional
   * account id (instagram), or phone_number_id (whatsapp).
   */
  accountId: string;
  /** The lead's page-/IG-scoped user id, or wa_id for WhatsApp. */
  senderId: string;
  /** Meta message id (wamid for WhatsApp): the redelivery dedupe key. */
  mid: string;
  text: string;
  /** Sender profile name when the delivery carried one (WhatsApp does). */
  displayName?: string | null;
};

/**
 * A message the PAGE sent that our own system did not: a human replied from
 * Meta's Page Inbox or the Business Suite app.
 *
 * Meta echoes every Page-side send back to us (once subscribed to
 * `message_echoes`), including our own. Ours are recognizable because we
 * record the message id Meta hands back; anything else is a person. Recording
 * theirs as an `owner` turn is all it takes to stop the AI talking over them:
 * buildMessengerContents already returns null when a model-side row trails the
 * last user turn, which fails the job as `no_input`.
 */
export type MetaEchoEvent = {
  platform: MessengerPlatform;
  accountId: string;
  /** The person the Page replied TO. */
  recipientId: string;
  mid: string;
  text: string;
  /**
   * Which app sent it. Always present since Graph v12.0, and a send typed by
   * a person in Meta's Page Inbox carries Meta's own inbox app id
   * (META_PAGE_INBOX_APP_ID). Comparing it to OUR app id is what separates
   * our own reply coming home from a colleague joining the thread, with no
   * race against recording our outbound message ids.
   */
  appId: string;
};

/** Click-to-Messenger / ig.me attribution for one conversation. */
export type MetaReferralEvent = {
  platform: MessengerPlatform;
  accountId: string;
  senderId: string;
  ref: string;
  source: string;
  type: string;
  adId: string;
  adTitle: string;
};

/** A WhatsApp template Meta approved, paused, rejected, or disabled. */
export type MetaTemplateStatusEvent = {
  wabaId: string;
  templateName: string;
  language: string;
  status: string;
  reason: string;
};

/**
 * A delivery receipt for one message we sent. `mid` is the wamid the send
 * stored on the transcript row, which is what joins the two.
 */
export type MetaMessageStatusEvent = {
  /** Phone number id: resolves to the tenant that owns the send. */
  accountId: string;
  mid: string;
  /** Raw Meta status; the processor validates it against the known set. */
  status: string;
  errorCode: string | null;
  errorTitle: string | null;
  /** Meta's unix-seconds stamp, already widened to an ISO string. */
  occurredAt: string | null;
};

export type MetaWebhookEvents = {
  leadgen: MetaLeadgenEvent[];
  messages: MetaMessageEvent[];
  comments: MetaCommentEvent[];
  /** Page-side sends we did not make: a human took the thread. */
  echoes: MetaEchoEvent[];
  referrals: MetaReferralEvent[];
  templateStatuses: MetaTemplateStatusEvent[];
  /** Delivery receipts for messages we sent (WhatsApp only). */
  messageStatuses: MetaMessageStatusEvent[];
};

/** Shown in transcripts for image/audio/file messages we don't ingest. */
export const MESSENGER_ATTACHMENT_PLACEHOLDER = "[attachment]";

/**
 * Extract the leadgen changes and conversation messages from a
 * (signature-verified) webhook body. Returns null for a body that isn't a
 * Meta webhook payload at all; empty arrays for valid payloads with
 * nothing to do (unknown objects, echoes, receipts): those are
 * acknowledged, not errored.
 */
export function parseMetaWebhookBody(json: unknown): MetaWebhookEvents | null {
  const parsed = webhookBodySchema.safeParse(json);
  if (!parsed.success) return null;

  const events: MetaWebhookEvents = {
    leadgen: [],
    messages: [],
    comments: [],
    echoes: [],
    referrals: [],
    templateStatuses: [],
    messageStatuses: []
  };
  const object = parsed.data.object;
  if (object === "whatsapp_business_account") {
    for (const entry of parsed.data.entry) {
      for (const change of entry.changes ?? []) {
        if (change.field === "message_template_status_update") {
          // Dropped until now, which meant a template PAUSED or REJECTED
          // after approval kept being sent against: deliverWhatsApp gates on
          // the stored status, and nothing ever refreshed it outside a manual
          // reconnect.
          const t = templateStatusValueSchema.safeParse(change.value);
          if (!t.success) continue;
          const templateName = String(t.data.message_template_name ?? "");
          const status = String(t.data.event ?? "");
          if (!templateName || !status) continue;
          events.templateStatuses.push({
            wabaId: String(entry.id ?? ""),
            templateName,
            language: String(t.data.message_template_language ?? ""),
            status,
            reason: String(t.data.reason ?? "")
          });
          continue;
        }
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
        // Delivery receipts. These used to be dropped on the floor, which
        // left `ok` from the send call as the only thing the platform ever
        // recorded, and `ok` means Meta ACCEPTED the message, not that it
        // arrived. A tenant whose sends were all being rejected downstream
        // looked identical to a healthy one.
        for (const status of value.data.statuses ?? []) {
          const mid = status.id ?? "";
          const state = status.status?.trim() ?? "";
          if (!mid || !state) continue;
          const firstError = status.errors?.[0];
          // Meta sends unix SECONDS; a bare Number() would land in 1970.
          const seconds = Number(status.timestamp ?? Number.NaN);
          events.messageStatuses.push({
            accountId: phoneNumberId,
            mid,
            status: state,
            errorCode:
              firstError?.code === undefined || firstError.code === null
                ? null
                : String(firstError.code),
            errorTitle: firstError?.title?.trim() || firstError?.message?.trim() || null,
            occurredAt: Number.isFinite(seconds)
              ? new Date(seconds * 1000).toISOString()
              : null
          });
        }
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
        if (change.field === "leadgen") {
          const pageId = String(change.value.page_id ?? entry.id ?? "");
          const leadgenId = String(change.value.leadgen_id ?? "");
          if (!pageId || !leadgenId) continue;
          events.leadgen.push({ pageId, leadgenId });
          continue;
        }
        if (change.field !== "feed") continue;
        const feed = feedChangeValueSchema.safeParse(change.value);
        if (!feed.success) continue;
        // The feed field carries the whole Page: posts, likes, reactions,
        // shares. Only a NEWLY ADDED comment starts a flow: without the
        // verb check an edit would re-fire, and without the item check a
        // like would fire at all.
        if (feed.data.item !== "comment" || feed.data.verb !== "add") continue;
        const commentId = String(feed.data.comment_id ?? "");
        const fromId = String(feed.data.from?.id ?? "");
        // The Page commenting or replying on its own post must never trigger
        // flows, or our own reply starts another run (the IG echo rule).
        if (!entryId || !commentId || fromId === entryId) continue;
        events.comments.push({
          platform: "facebook",
          accountId: entryId,
          commentId,
          mediaId: String(feed.data.post_id ?? ""),
          text: feed.data.message?.trim() ?? "",
          fromId,
          fromUsername: feed.data.from?.name?.trim() ?? ""
        });
      }
    }

    if (platform === "instagram") {
      for (const change of entry.changes ?? []) {
        // live_comments carries the same value shape as comments; the only
        // difference is the reply window (during the broadcast only, which
        // the reply route already reports honestly when Meta refuses).
        if (change.field !== "comments" && change.field !== "live_comments") continue;
        const value = commentChangeValueSchema.safeParse(change.value);
        if (!value.success) continue;
        const commentId = String(value.data.id ?? "");
        const fromId = String(value.data.from?.id ?? "");
        // The business commenting/replying on its own media must never
        // trigger flows (the DM path's echo rule, applied to comments).
        if (!entryId || !commentId || fromId === entryId) continue;
        events.comments.push({
          platform: "instagram",
          accountId: entryId,
          commentId,
          mediaId: String(value.data.media?.id ?? ""),
          text: value.data.text?.trim() ?? "",
          fromId,
          fromUsername: value.data.from?.username?.trim() ?? ""
        });
      }
    }

    for (const item of entry.messaging ?? []) {
      const senderId = String(item.sender?.id ?? "");

      // Echoes are handled BEFORE the sender-is-page guard below, because an
      // echo's sender IS the page: the guard exists to stop our own sends
      // looping back in as inbound, and it would drop these too.
      if (item.message?.is_echo) {
        // Every Page-side send echoes back, ours included. The handler tells
        // them apart by app_id; see MetaEchoEvent.appId. What matters is the
        // foreign ones: the AI would otherwise answer the next customer
        // message on top of a colleague mid-conversation.
        const echoMid = item.message.mid ?? "";
        const echoTo = String(item.recipient?.id ?? "");
        if (entryId && echoMid && echoTo) {
          events.echoes.push({
            platform,
            accountId: entryId,
            recipientId: echoTo,
            mid: echoMid,
            text: item.message.text?.trim() ?? "",
            appId: String(item.message.app_id ?? "")
          });
        }
        continue;
      }

      // The page/IG account echoing its own sends must never loop back in.
      if (!entryId || !senderId || senderId === entryId) continue;

      // Attribution first: a referral can ride alone, on the first message,
      // or on a Get Started postback, and all three mean the same thing.
      const referral = item.referral ?? item.message?.referral ?? item.postback?.referral;
      if (referral && senderId) {
        events.referrals.push({
          platform,
          accountId: entryId,
          senderId,
          ref: referral.ref?.trim() ?? "",
          source: referral.source?.trim() ?? "",
          type: referral.type?.trim() ?? "",
          adId: String(referral.ad_id ?? ""),
          adTitle: referral.ads_context_data?.ad_title?.trim() ?? ""
        });
      }

      if (item.message) {
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
 * Resolve, fetch, and enqueue one leadgen event. Never throws: a failure
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
    // The token demonstrably works, so heal the card without waiting for the
    // owner to notice. Cheap: the write is a no-op when nothing was flagged.
    await clearMetaTokenInvalid(connection.business_id);
    logger.info("meta lead processed", {
      businessId: connection.business_id,
      pageId,
      leadgenId,
      enqueued: result.enqueued,
      flowsMatched: result.flowsMatched
    });
    return true;
  } catch (err) {
    // A dead token here loses the lead permanently: Meta gets a 200 and never
    // redelivers, and there is no dead-letter row to replay from. Awaited, not
    // fire-and-forget: this runs in a serverless handler that may freeze the
    // moment it returns.
    await reportMetaCallFailure(connection.business_id, err, { surface: "lead_fetch" });
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

/** Flow-trigger source labels for comment events, per surface. */
export const INSTAGRAM_COMMENT_FLOW_SOURCE = "instagram_comment";
export const FACEBOOK_COMMENT_FLOW_SOURCE = "facebook_comment";

/**
 * Resolve and enqueue one IG comment event as a webhook flow event. Never
 * throws: a failure for one comment must not fail the delivery batch
 * (Meta redelivers, and the comment-id dedupe key makes the retry safe).
 * Returns true when the comment reached the flow engine.
 */
export async function processMetaCommentEvent(event: MetaCommentEvent): Promise<boolean> {
  const { platform, accountId, commentId } = event;
  const isInstagram = platform === "instagram";

  const limiter = rateLimit(`meta-webhook-comment:${accountId}`, META_WEBHOOK_RATE);
  if (!limiter.success) {
    logger.warn("meta comment webhook rate limited", { platform, accountId });
    return false;
  }

  // Instagram deliveries key on the IG professional account; Facebook feed
  // deliveries key on the Page itself.
  const connection = await (isInstagram
    ? getActiveMetaConnectionByInstagramId(accountId)
    : getActiveMetaConnectionByPageId(accountId)
  ).catch((err) => {
    logger.warn("meta comment connection lookup failed", {
      platform,
      accountId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  });
  if (!connection) {
    // Unknown/disabled account: acknowledge so Meta doesn't retry forever.
    logger.warn("meta comment for unconnected account", { platform, accountId });
    return false;
  }

  try {
    const result = await processWebhookFlowEvent(connection.business_id, {
      source: isInstagram ? INSTAGRAM_COMMENT_FLOW_SOURCE : FACEBOOK_COMMENT_FLOW_SOURCE,
      eventId: event.commentId,
      data: {
        comment_id: event.commentId,
        comment_text: event.text,
        ...(event.fromUsername ? { username: event.fromUsername } : {}),
        ...(event.fromId ? { from_id: event.fromId } : {}),
        ...(event.mediaId ? { media_id: event.mediaId } : {}),
        ...(isInstagram ? { instagram_account_id: accountId } : { page_id: accountId })
      }
    });
    logger.info("meta comment processed", {
      businessId: connection.business_id,
      platform,
      accountId,
      commentId,
      enqueued: result.enqueued,
      flowsMatched: result.flowsMatched
    });
    return true;
  } catch (err) {
    logger.warn("meta comment processing failed", {
      businessId: connection.business_id,
      platform,
      accountId,
      commentId,
      error: err instanceof Error ? err.message : String(err)
    });
    return false;
  }
}

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
 * trigger for brand-new conversations. Never throws: one bad message
 * must not fail the delivery batch. Returns true when a reply job was
 * enqueued.
 */
export async function processMetaMessageEvent(
  event: MetaMessageEvent
): Promise<boolean | "rate_limited"> {
  const { platform, accountId, senderId, mid, text } = event;

  // "rate_limited" (unlike a plain skip) makes the route answer non-200
  // so Meta REDELIVERS the batch once the window clears: the mid dedupe
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
      // Duplicate redelivery: the original already has a job.
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
  for (const event of events.comments) {
    if (await processMetaCommentEvent(event)) handled += 1;
  }
  let messagesEnqueued = 0;
  let messagesRateLimited = 0;
  for (const event of events.messages) {
    const result = await processMetaMessageEvent(event);
    if (result === "rate_limited") messagesRateLimited += 1;
    else if (result) messagesEnqueued += 1;
  }
  // Echoes BEFORE referrals is deliberate only in that both must run after
  // the messages above: a referral needs the conversation the first message
  // creates, and an echo needs the thread to exist too.
  for (const event of events.echoes) {
    if (await processMetaEchoEvent(event)) handled += 1;
  }
  for (const event of events.referrals) {
    if (await processMetaReferralEvent(event)) handled += 1;
  }
  for (const event of events.templateStatuses) {
    if (await processMetaTemplateStatusEvent(event)) handled += 1;
  }
  for (const event of events.messageStatuses) {
    if (await processMetaMessageStatusEvent(event)) handled += 1;
  }
  return { handled, messagesEnqueued, messagesRateLimited };
}
