/**
 * Internal Slack delivery endpoint — the bridge the Deno notification
 * mirrors call (urgent alerts, digests). Token decryption and the Web API
 * client live in src/lib and need the Node runtime, so no Slack secret or
 * crypto ever lands in an edge function (the whatsapp-send precedent).
 *
 * Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>` (assertCronAuth,
 * same as the other internal routes).
 *
 * POST { businessId, text, blocks? }
 * → 200 with the structured deliverSlackAlert result (ok:false outcomes are
 *   NOT HTTP errors: "no_alert_channel" etc. are honest skips the caller
 *   records, not transport failures).
 */

import { z } from "zod";
import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { deliverSlackAlert } from "@/lib/slack/deliver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  text: z.string().min(1).max(12_000),
  blocks: z.array(z.unknown()).max(50).optional()
});

export async function POST(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }
  try {
    const body = bodySchema.parse(await request.json());
    const result = await deliverSlackAlert(body);
    return successResponse(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
