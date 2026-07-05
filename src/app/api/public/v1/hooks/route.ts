/**
 * REST hooks (Zapier-style webhook subscriptions).
 *
 *   GET  /api/public/v1/hooks           → active subscriptions
 *   POST /api/public/v1/hooks           → subscribe { event, target_url }
 *
 * On POST the subscription starts with last_cursor = now(), so only events
 * that occur AFTER subscribing are delivered — Zapier's expected REST-hook
 * semantics. Delivery itself is the webhook-dispatcher Edge cron.
 *
 * Auth: `Authorization: Bearer nck_…` (public API key).
 */

import { z } from "zod";
import { authenticatePublicApiRequest } from "@/lib/public-api/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import {
  MAX_HOOKS_PER_BUSINESS,
  countActiveWebhookSubscriptions,
  createWebhookSubscription,
  listWebhookSubscriptions
} from "@/lib/db/webhook-subscriptions";
import {
  WEBHOOK_EVENT_TYPES,
  isWebhookEventType
} from "../../../../../../supabase/functions/_shared/webhook_events";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  event: z.string().refine(isWebhookEventType, {
    message: `event must be one of: ${WEBHOOK_EVENT_TYPES.join(", ")}`
  }),
  target_url: z
    .string()
    .url()
    .refine((u) => u.startsWith("https://"), {
      message: "target_url must be https"
    })
    .max(2048)
});

function serialize(sub: {
  id: string;
  event: string;
  target_url: string;
  created_at: string;
}) {
  return {
    id: sub.id,
    event: sub.event,
    target_url: sub.target_url,
    created_at: sub.created_at
  };
}

export async function GET(request: Request) {
  try {
    const auth = await authenticatePublicApiRequest(request);
    if (!auth) return errorResponse("UNAUTHORIZED", "Invalid or missing API key");

    const subs = await listWebhookSubscriptions(auth.businessId);
    return successResponse(subs.map(serialize));
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  try {
    const auth = await authenticatePublicApiRequest(request);
    if (!auth) return errorResponse("UNAUTHORIZED", "Invalid or missing API key");

    const json = (await request.json().catch(() => null)) as unknown;
    const { event, target_url } = createSchema.parse(json);

    const active = await countActiveWebhookSubscriptions(auth.businessId);
    if (active >= MAX_HOOKS_PER_BUSINESS) {
      return errorResponse(
        "CONFLICT",
        `Webhook limit reached (${MAX_HOOKS_PER_BUSINESS}); delete unused hooks first.`
      );
    }

    const sub = await createWebhookSubscription({
      businessId: auth.businessId,
      event,
      targetUrl: target_url,
      apiKeyId: auth.apiKeyId
    });

    return successResponse(serialize(sub), 201);
  } catch (err) {
    return handleRouteError(err);
  }
}
