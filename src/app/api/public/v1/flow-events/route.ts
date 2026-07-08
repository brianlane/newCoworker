/**
 * POST /api/public/v1/flow-events — start `webhook`-triggered AiFlows.
 *
 * The inbound half of the public API: a bridge (Zapier "Send Lead to
 * Coworker", a Make.com HTTP module, or any client) POSTs an event payload
 * and every enabled webhook flow whose conditions match gets a queued run.
 * This is how external lead sources — e.g. Meta Lead Ads via an approved
 * bridge — reach the flow engine without a phone/email/browser trigger.
 *
 * Auth: `Authorization: Bearer nck_…` (public API key). No session, no CSRF.
 * Idempotent per event: redeliveries with the same `event_id` (or identical
 * payload) never double-enqueue (ai_flow_runs dedupe_key).
 */

import { z } from "zod";
import { authenticatePublicApiRequest } from "@/lib/public-api/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { processWebhookFlowEvent } from "@/lib/ai-flows/webhook-events";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

// Real lead volume is a handful a day; 120/min absorbs a bridge's replay
// burst while capping a runaway Zap loop well below anything that could
// flood the run queue.
const API_FLOW_EVENT_RATE = { interval: 60 * 1000, maxRequests: 120 };

/** Serialized payload ceiling — a lead form is KBs, not MBs. */
const MAX_DATA_BYTES = 64 * 1024;

const bodySchema = z.object({
  /** Where the event came from; matched by `from_matches` conditions. */
  source: z.string().min(1).max(120).optional(),
  /** Caller idempotency key (e.g. the Meta leadgen id a bridge forwards). */
  event_id: z.string().min(1).max(180).optional(),
  /** The event payload — lead fields as a flat-ish JSON object. */
  data: z.record(z.string(), z.unknown())
});

export async function POST(request: Request) {
  try {
    const auth = await authenticatePublicApiRequest(request);
    if (!auth) return errorResponse("UNAUTHORIZED", "Invalid or missing API key");
    const { businessId } = auth;

    const json = (await request.json().catch(() => null)) as unknown;
    const body = bodySchema.parse(json);
    if (JSON.stringify(body.data).length > MAX_DATA_BYTES) {
      return errorResponse("VALIDATION_ERROR", "data payload too large (64KB max)", 413);
    }

    const limiter = rateLimit(`public-api-flow-events:${businessId}`, API_FLOW_EVENT_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Rate limit exceeded, retry shortly.", 429);
    }

    const result = await processWebhookFlowEvent(businessId, {
      source: body.source?.trim() || "webhook",
      data: body.data,
      eventId: body.event_id
    });

    return successResponse({
      enqueued: result.enqueued,
      flows_evaluated: result.flowsEvaluated,
      // matched > 0 with enqueued 0 = duplicate redelivery (already handled).
      flows_matched: result.flowsMatched
    });
  } catch (err) {
    logger.warn("public-api flow-events failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    return handleRouteError(err);
  }
}
