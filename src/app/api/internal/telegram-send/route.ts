/**
 * Internal Telegram delivery endpoint: the bridge the Deno notification
 * mirror calls. Token decryption and the Bot API client live in src/lib and
 * need the Node runtime, so no bot token or crypto ever lands in an edge
 * function (the whatsapp-send and slack-send precedent).
 *
 * Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>` (assertCronAuth,
 * same as the other internal routes).
 *
 * POST { businessId, summary, details?, detailsUrl? }
 * → 200 with the structured deliverTelegramAlert result. ok:false outcomes
 *   are NOT HTTP errors: "no_alert_target" and friends are honest skips the
 *   caller records, not transport failures.
 */

import { z } from "zod";
import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { deliverTelegramAlert } from "@/lib/telegram/deliver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  summary: z.string().min(1).max(2_000),
  details: z.string().max(4_000).nullish(),
  // Bounded because it is rendered into an anchor; deliverTelegramAlert
  // also refuses anything that is not http(s).
  detailsUrl: z.string().max(2_048).nullish()
});

export async function POST(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }
  try {
    const body = bodySchema.parse(await request.json());
    const result = await deliverTelegramAlert(body);
    return successResponse(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
