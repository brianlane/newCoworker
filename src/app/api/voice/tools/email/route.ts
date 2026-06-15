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

/**
 * `send_follow_up_email` — sends a short email from the owner's connected
 * Google or Microsoft account. We deliberately only allow plain text here so
 * a runaway model can't inject markup/scripts; the voice agent is expected
 * to dictate a 1-3 sentence follow-up, not a newsletter. The actual provider
 * call lives in src/lib/email/owner-mailbox.ts (shared with the dashboard
 * chat email adapter).
 *
 * Per product decision: if no Nango email connection exists we return
 * `email_not_connected` so Gemini Live switches to an SMS follow-up path.
 * If the owner disabled the tool (Settings → Coworker tools) we return
 * `tool_disabled` for the same graceful-degradation reason.
 */

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

  const parsed = argsSchema.safeParse(envelope.args);
  if (!parsed.success) {
    return voiceToolValidationError(parsed.error.issues[0]?.message ?? "invalid args");
  }
  const args = parsed.data;
  const ccEmails = normalizeRecipients(args.cc);
  const bccEmails = normalizeRecipients(args.bcc);

  try {
    const enabled = await isAgentToolEnabled(envelope.businessId, "voice", "send_follow_up_email");
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
      source: "voice_assistant",
      providerMessageId: result.messageId,
      ccEmails,
      bccEmails
    });
    return voiceToolResponse({
      ok: true,
      data: { messageId: result.messageId, provider: result.provider }
    });
  } catch (err) {
    logger.warn("voice-tools/email failed", {
      businessId: envelope.businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return voiceToolResponse({ ok: false, detail: "email_send_failed" }, 500);
  }
}
