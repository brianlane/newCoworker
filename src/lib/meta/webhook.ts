/**
 * Meta leadgen webhook processing (the logic behind /api/webhooks/meta).
 *
 * Mirrors src/lib/vagaro/webhook.ts: the route stays a thin
 * verify-and-delegate layer, and everything after signature verification
 * lives here — payload parsing, page→tenant resolution, the Graph lead
 * fetch, and the flow-engine enqueue. Each `leadgen` change becomes a
 * webhook flow event with source "facebook_lead_ads" and the leadgen id
 * as the idempotency key, so Meta redeliveries never double-enqueue.
 */
import { z } from "zod";
import { getActiveMetaConnectionByPageId } from "@/lib/db/meta-connections";
import { fetchLead } from "@/lib/meta/client";
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
        .optional()
    })
  )
});

export type MetaLeadgenEvent = {
  pageId: string;
  leadgenId: string;
};

/**
 * Extract the leadgen changes from a (signature-verified) webhook body.
 * Returns null for a body that isn't a Meta webhook payload at all;
 * returns [] for valid payloads with nothing to do (e.g. non-Page objects,
 * non-leadgen fields) — those are acknowledged, not errored.
 */
export function parseMetaWebhookBody(json: unknown): MetaLeadgenEvent[] | null {
  const parsed = webhookBodySchema.safeParse(json);
  if (!parsed.success) return null;
  if (parsed.data.object !== "page") return [];

  const events: MetaLeadgenEvent[] = [];
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "leadgen") continue;
      const pageId = String(change.value.page_id ?? entry.id ?? "");
      const leadgenId = String(change.value.leadgen_id ?? "");
      if (!pageId || !leadgenId) continue;
      events.push({ pageId, leadgenId });
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

/** Process every leadgen change in a delivery; returns the handled count. */
export async function processMetaWebhookEvents(
  events: MetaLeadgenEvent[]
): Promise<{ handled: number }> {
  let handled = 0;
  for (const event of events) {
    if (await processMetaLeadgenEvent(event)) handled += 1;
  }
  return { handled };
}
