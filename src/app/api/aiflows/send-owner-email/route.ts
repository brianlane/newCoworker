/**
 * Internal AiFlow adapter: send a plain-text email from a SPECIFIC connected
 * owner mailbox (workspace_oauth_connections.id → Nango Gmail/Outlook).
 *
 * Called by the ai-flow-worker when a `send_email` step (or a send_sms
 * quiet-hours email fallback) carries `fromConnectionId` — the owner picked
 * "send as me" in the flow editor instead of the platform Resend sender.
 *
 * Auth is gateway-only (ROWBOAT_GATEWAY_TOKEN), like the other VPS/worker
 * adapters under /api/voice/tools and /api/integrations/custom. The connection
 * is looked up BY ID and must belong to the businessId in the body, so the
 * worker can never send through another tenant's mailbox.
 *
 * Response contract mirrors the voice-tool adapters: `{ ok, detail?, data? }`
 * with HTTP 200 for "configured wrong" outcomes (the worker maps those to a
 * permanent step failure) and 500 only for provider/transport faults (the
 * worker retries those).
 */
import { z } from "zod";
import {
  gatewayGuard,
  gatewayBusinessGuard,
  voiceToolResponse,
  voiceToolValidationError
} from "@/lib/voice-tools/common";
import { getWorkspaceOAuthConnection } from "@/lib/db/workspace-oauth-connections";
import { isEmailProviderConfigKey, providerFromKey } from "@/lib/voice-tools/connections";
import { sendFromMailboxConnection } from "@/lib/email/owner-mailbox";
import { normalizeRecipients } from "@/lib/email/recipients";
import { logger } from "@/lib/logger";
import { recordSystemLog } from "@/lib/db/system-logs";

const recipientList = z.union([z.string(), z.array(z.string())]).optional();

const bodySchema = z.object({
  businessId: z.string().uuid(),
  connectionId: z.string().uuid(),
  toEmail: z.string().email(),
  subject: z.string().min(1).max(300),
  bodyText: z.string().min(1).max(8000),
  cc: recipientList,
  bcc: recipientList
});

export async function POST(request: Request) {
  const guard = gatewayGuard(request);
  if (guard) return guard;

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
    const row = await getWorkspaceOAuthConnection(body.businessId, body.connectionId);
    if (!row) return voiceToolResponse({ ok: false, detail: "connection_not_found" });
    if (!isEmailProviderConfigKey(row.provider_config_key)) {
      return voiceToolResponse({ ok: false, detail: "not_email_connection" });
    }

    const result = await sendFromMailboxConnection(
      body.businessId,
      {
        provider: providerFromKey(row.provider_config_key),
        providerConfigKey: row.provider_config_key,
        connectionId: row.connection_id
      },
      {
        toEmail: body.toEmail,
        subject: body.subject,
        bodyText: body.bodyText,
        ccEmails: normalizeRecipients(body.cc),
        bccEmails: normalizeRecipients(body.bcc)
      }
    );
    if (!result.ok) {
      return voiceToolResponse({ ok: false, detail: result.detail });
    }
    return voiceToolResponse({
      ok: true,
      data: { messageId: result.messageId, provider: result.provider }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("aiflows/send-owner-email failed", {
      businessId: body.businessId,
      error: message
    });
    await recordSystemLog({
      businessId: body.businessId,
      source: "aiflow",
      level: "error",
      event: "ai_flow_owner_email_failed",
      message: `Owner-mailbox email send failed: ${message}`,
      payload: { to: body.toEmail, connection_id: body.connectionId }
    });
    return voiceToolResponse({ ok: false, detail: "email_send_failed" }, 500);
  }
}
