/**
 * Internal AiFlow adapter: read the best-matching recent inbound message from a
 * connected owner mailbox (workspace_oauth_connections.id → Nango Gmail/Outlook).
 *
 * Called by the ai-flow-worker for an `email_extract` step — the worker can't
 * reach Nango (the client lives in this Next.js runtime), so it proxies the read
 * here, then runs its own Gemini extraction over the returned body text.
 *
 * Auth is gateway-only (ROWBOAT_GATEWAY_TOKEN), like /api/aiflows/send-owner-email
 * and the voice-tool adapters. The connection is looked up BY ID and must belong
 * to the businessId in the body, so the worker can never read another tenant's
 * mailbox.
 *
 * Response mirrors the other adapters: `{ ok, detail?, data? }` with HTTP 200 for
 * "configured wrong" outcomes (connection missing / not an email connection → the
 * worker maps to a permanent step failure) and 500 for provider/transport faults
 * (the worker retries). A clean miss is `ok:true, data:{ found:false }`.
 */
import { z } from "zod";
import {
  gatewayBusinessGuard,
  voiceToolResponse,
  voiceToolValidationError
} from "@/lib/voice-tools/common";
import { findMatchingInboundEmail } from "@/lib/ai-flows/email-fetch";
import { logger } from "@/lib/logger";
import { recordSystemLog } from "@/lib/db/system-logs";

export const maxDuration = 60;
export const runtime = "nodejs";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  connectionId: z.string().uuid(),
  fromContains: z.string().max(200).optional(),
  // Each term must appear in the email (all required); narrows to THIS lead.
  bodyContains: z.array(z.string().max(500)).max(5).optional(),
  lookbackMinutes: z.number().int().min(1).max(1440)
});

export async function POST(request: Request) {
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch (err) {
    const detail =
      err instanceof z.ZodError ? err.issues[0]?.message ?? "invalid args" : "invalid body";
    return voiceToolValidationError(detail);
  }

  const bindGuard = await gatewayBusinessGuard(request, body.businessId);
  if (bindGuard) return bindGuard;

  try {
    const result = await findMatchingInboundEmail({
      businessId: body.businessId,
      connectionId: body.connectionId,
      fromContains: body.fromContains,
      bodyContains: body.bodyContains,
      lookbackMinutes: body.lookbackMinutes
    });
    return voiceToolResponse({ ok: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Permanent misconfiguration (no connection / wrong type) → ok:false 200 so
    // the worker fails the step without retrying into the same wall.
    if (message === "connection_not_found" || message === "not_email_connection") {
      return voiceToolResponse({ ok: false, detail: message });
    }
    logger.warn("aiflows/email-fetch failed", { businessId: body.businessId, error: message });
    await recordSystemLog({
      businessId: body.businessId,
      source: "aiflow",
      level: "error",
      event: "ai_flow_email_fetch_failed",
      message: `Mailbox read failed: ${message}`,
      payload: { connection_id: body.connectionId }
    });
    return voiceToolResponse({ ok: false, detail: "email_fetch_failed" }, 500);
  }
}
