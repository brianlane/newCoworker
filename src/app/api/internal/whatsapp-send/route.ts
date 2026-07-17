/**
 * Internal WhatsApp delivery endpoint — the bridge the Deno AiFlow worker
 * calls for `send_whatsapp` steps (the Cloud API client, token decryption,
 * 24h-window check, and template fallback all live in src/lib and need
 * the Node runtime).
 *
 * Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>` (assertCronAuth,
 * same as the other internal routes).
 *
 * POST { businessId, to, text, audience: "contact" | "owner" }
 * → 200 with the structured deliverWhatsApp result (ok:false outcomes are
 *   NOT HTTP errors: "template_not_approved" etc. are step-level skips
 *   the flow worker reports in actions_taken, not transport failures).
 */

import { z } from "zod";
import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { deliverWhatsApp } from "@/lib/whatsapp/deliver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  to: z.string().min(5).max(32),
  text: z.string().min(1).max(4096),
  audience: z.enum(["contact", "owner"])
});

export async function POST(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }
  try {
    const body = bodySchema.parse(await request.json());
    const result = await deliverWhatsApp(body);
    return successResponse(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
