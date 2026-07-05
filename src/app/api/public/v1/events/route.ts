/**
 * GET /api/public/v1/events?event=sms.inbound&limit=3
 *
 * Recent events for one webhook event type, shaped EXACTLY like the
 * payloads the webhook-dispatcher POSTs. Zapier's REST-hook triggers
 * require a `performList` endpoint that returns sample rows for the Zap
 * editor; any client can also use it to poll instead of subscribing.
 *
 * Auth: `Authorization: Bearer nck_…` (public API key).
 */

import { z } from "zod";
import { authenticatePublicApiRequest } from "@/lib/public-api/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  WEBHOOK_EVENT_SOURCES,
  WEBHOOK_EVENT_TYPES,
  buildWebhookPayload,
  isWebhookEventType,
  type WebhookSourceRow
} from "../../../../../../supabase/functions/_shared/webhook_events";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  event: z.string().refine(isWebhookEventType, {
    message: `event must be one of: ${WEBHOOK_EVENT_TYPES.join(", ")}`
  }),
  limit: z.coerce.number().int().min(1).max(25).default(3)
});

export async function GET(request: Request) {
  try {
    const auth = await authenticatePublicApiRequest(request);
    if (!auth) return errorResponse("UNAUTHORIZED", "Invalid or missing API key");

    const url = new URL(request.url);
    const { event, limit } = querySchema.parse({
      event: url.searchParams.get("event") ?? "",
      limit: url.searchParams.get("limit") ?? undefined
    });

    const source = WEBHOOK_EVENT_SOURCES[event];
    const db = await createSupabaseServiceClient();
    let query = db
      .from(source.table)
      .select(source.select)
      .eq("business_id", auth.businessId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (source.filter) {
      const [column, operator, value] = source.filter;
      query = query.filter(column, operator, value);
    }

    const { data, error } = await query;
    if (error) {
      return errorResponse("DB_ERROR", `Could not load events: ${error.message}`);
    }

    const rows = (data ?? []) as unknown as WebhookSourceRow[];
    return successResponse(rows.map((row) => buildWebhookPayload(event, row)));
  } catch (err) {
    return handleRouteError(err);
  }
}
