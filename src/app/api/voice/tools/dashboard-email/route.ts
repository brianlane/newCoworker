/**
 * `send_email` (dashboard chat) — sends an email from the owner's connected
 * mailbox on behalf of the **owner Dashboard chat**. Called by the VPS
 * chat-worker after it parses a structured EMAIL_SEND block out of the
 * assistant reply (vps/chat-worker/email-tool.mjs).
 *
 * Lives under /api/voice/tools/ because that prefix is the established home
 * for ALL gateway-token-authenticated platform tool adapters (CSRF-exempt in
 * src/proxy.ts) — the chat-worker's owner-append-business-memory adapter
 * already lives here for the same reason.
 *
 * Authorization layers:
 *   1. ROWBOAT_GATEWAY_TOKEN bearer (gatewayGuard) — only the tenant
 *      VPS/Rowboat can call.
 *   2. The owner's Settings → Coworker tools toggle (`dashboard.send_email`,
 *      default OFF). Checked here authoritatively so a stale worker or a
 *      hallucinated block can never send mail the owner didn't opt into.
 *   3. Defense in depth: refuse envelopes carrying `callerE164` — this tool
 *      is owner-dashboard-only, never a customer voice/SMS surface.
 */

import { z } from "zod";
import {
  gatewayGuard,
  parseVoiceToolRequest,
  voiceToolResponse,
  voiceToolValidationError
} from "@/lib/voice-tools/common";
import { sendFromOwnerMailbox } from "@/lib/email/owner-mailbox";
import { normalizeRecipients } from "@/lib/email/recipients";
import { isAgentToolEnabled } from "@/lib/db/agent-tool-settings";
import { recordOutboundAssistantEmail } from "@/lib/db/email-log";
import { logger } from "@/lib/logger";

const recipientList = z.union([z.string(), z.array(z.string())]).optional();

const argsSchema = z.object({
  toEmail: z.string().email(),
  subject: z.string().min(1).max(150),
  bodyText: z.string().min(1).max(4000),
  cc: recipientList,
  bcc: recipientList
});

export async function POST(request: Request) {
  const guard = gatewayGuard(request);
  if (guard) return guard;

  let envelope;
  try {
    envelope = await parseVoiceToolRequest(request);
  } catch (err) {
    return voiceToolValidationError(
      err instanceof z.ZodError ? err.issues[0]?.message ?? "invalid envelope" : "invalid body"
    );
  }

  if ((envelope.callerE164 ?? "").trim() !== "") {
    return voiceToolResponse({ ok: false, detail: "owner_dashboard_only" });
  }

  const parsed = argsSchema.safeParse(envelope.args);
  if (!parsed.success) {
    return voiceToolValidationError(parsed.error.issues[0]?.message ?? "invalid args");
  }
  const args = parsed.data;
  const ccEmails = normalizeRecipients(args.cc);
  const bccEmails = normalizeRecipients(args.bcc);

  try {
    const enabled = await isAgentToolEnabled(envelope.businessId, "dashboard", "send_email");
    if (!enabled) {
      return voiceToolResponse({ ok: false, detail: "tool_disabled" });
    }

    const result = await sendFromOwnerMailbox(envelope.businessId, {
      toEmail: args.toEmail,
      subject: args.subject,
      bodyText: args.bodyText,
      ccEmails,
      bccEmails
    });
    if (!result.ok) {
      return voiceToolResponse({ ok: false, detail: result.detail });
    }

    await recordOutboundAssistantEmail({
      businessId: envelope.businessId,
      toEmail: args.toEmail,
      subject: args.subject,
      bodyText: args.bodyText,
      source: "dashboard_chat",
      providerMessageId: result.messageId,
      ccEmails,
      bccEmails
    });
    logger.info("voice-tools/dashboard-email: sent", {
      businessId: envelope.businessId,
      provider: result.provider
    });
    return voiceToolResponse({
      ok: true,
      data: { messageId: result.messageId, provider: result.provider }
    });
  } catch (err) {
    logger.warn("voice-tools/dashboard-email failed", {
      businessId: envelope.businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return voiceToolResponse({ ok: false, detail: "email_send_failed" }, 500);
  }
}
