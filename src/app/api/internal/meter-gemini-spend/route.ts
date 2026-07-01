/**
 * POST /api/internal/meter-gemini-spend
 *
 * VPS → app callback for EXACT AI-chat-budget metering. The per-tenant
 * `vps/llm-router` sidecar is the only component on the box that sees both the
 * request model and the response token `usage` for the Gemini calls Rowboat
 * makes (owner dashboard chat, inbound SMS replies, and the rolling
 * summarizers). Rowboat's `/chat` reply hides usage from the chat-worker / SMS
 * worker, which is why those surfaces previously metered a chars/4 ESTIMATE.
 *
 * The router POSTs the exact billed tokens here and we record them into the
 * same `owner_chat_model_spend` pool the billing page reads — via the shared
 * `meterGeminiSpendForBusiness` path the platform's own Gemini surfaces
 * (website-ingest, knowledge, AiFlow) already use. So every chat-budget Gemini
 * call now meters the same way: exact tokens, one pool, one number.
 *
 * Auth is the per-tenant gateway token bound to the posted businessId
 * (`verifyGatewayTokenForBusiness`), identical to /api/provisioning/progress
 * and /api/voice/tools/*. The router presents the box's own
 * ROWBOAT_GATEWAY_TOKEN.
 */

import { z } from "zod";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { verifyGatewayTokenForBusiness } from "@/lib/rowboat/gateway-token";
import { meterGeminiSpendForBusiness } from "@/lib/billing/ai-spend-meter";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  model: z.string().min(1).max(200),
  usage: z.object({
    promptTokens: z.number().finite().nonnegative(),
    outputTokens: z.number().finite().nonnegative(),
    // Optional modality split (Gemini Live voice): the audio portion of the
    // prompt/output tokens, priced at the audio rate. Omitted for text surfaces.
    promptAudioTokens: z.number().finite().nonnegative().optional(),
    outputAudioTokens: z.number().finite().nonnegative().optional()
  })
});

export async function POST(request: Request) {
  try {
    const json = await request.json();
    const parsed = bodySchema.parse(json);

    const authorized = await verifyGatewayTokenForBusiness(request, parsed.businessId);
    if (!authorized) {
      return errorResponse("UNAUTHORIZED", "Invalid gateway token", 401);
    }

    // Best-effort + never throws (the model call already happened on the VPS);
    // a metering failure can only under-count the fuse, never break a turn.
    await meterGeminiSpendForBusiness({
      businessId: parsed.businessId,
      model: parsed.model,
      surface: "vps_rowboat",
      usage: parsed.usage
    });

    return successResponse({ metered: true });
  } catch (e) {
    return handleRouteError(e);
  }
}
