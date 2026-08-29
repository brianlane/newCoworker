/**
 * Internal Google Chat delivery endpoint: the bridge the Deno notification
 * mirror calls. The service-account key and the Chat client live in src/lib
 * and need the Node runtime, so no credential ever lands in an edge function
 * (the whatsapp-send, slack-send, telegram-send and teams-send precedent).
 *
 * POST { businessId, summary, details?, detailsUrl? }
 * → 200 with the structured deliverGoogleChatAlert result. ok:false outcomes
 *   are NOT HTTP errors: "not_configured" and friends are honest skips.
 */

import { z } from "zod";
import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { deliverGoogleChatAlert } from "@/lib/google-chat/deliver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  summary: z.string().min(1).max(2_000),
  details: z.string().max(4_000).nullish(),
  detailsUrl: z.string().max(2_048).nullish()
});

export async function POST(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }
  try {
    const body = bodySchema.parse(await request.json());
    return successResponse(await deliverGoogleChatAlert(body));
  } catch (err) {
    return handleRouteError(err);
  }
}
