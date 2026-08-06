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
import { getEmailLogThreadIdentity } from "@/lib/db/email-log";
import { rememberSentThread } from "@/lib/email-coworker/threads";

const recipientList = z.union([z.string(), z.array(z.string())]).optional();

const bodySchema = z.object({
  businessId: z.string().uuid(),
  connectionId: z.string().uuid(),
  toEmail: z.string().email(),
  subject: z.string().min(1).max(300),
  bodyText: z.string().min(1).max(8000),
  cc: recipientList,
  bcc: recipientList,
  /**
   * email_log row to answer INSIDE, from a send_email step's
   * replyToEmailLogId. Absent (or a row with no stored thread) sends a new
   * conversation, exactly as before.
   */
  replyToEmailLogId: z.string().uuid().optional()
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
    const row = await getWorkspaceOAuthConnection(body.businessId, body.connectionId);
    if (!row) return voiceToolResponse({ ok: false, detail: "connection_not_found" });
    if (!isEmailProviderConfigKey(row.provider_config_key)) {
      return voiceToolResponse({ ok: false, detail: "not_email_connection" });
    }

    // A reply target whose row never stored a thread id resolves to null and
    // sends unthreaded: the mail is still worth delivering, it just opens its
    // own conversation rather than failing the step over a missing header.
    const thread = body.replyToEmailLogId
      ? await getEmailLogThreadIdentity(body.businessId, body.replyToEmailLogId)
      : null;

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
        bccEmails: normalizeRecipients(body.bcc),
        ...(thread ? { thread } : {})
      }
    );
    if (!result.ok) {
      return voiceToolResponse({ ok: false, detail: result.detail });
    }

    // Claim the conversation for the autonomous email coworker. This is the
    // hinge of the whole feature: its poll filters strictly to threads the
    // assistant owns, so without this the reply goes out and turn two is
    // back to paging a human. Best-effort, exactly like the other three
    // callers of rememberSentThread: a failed claim costs autonomy on later
    // messages, never the send that already succeeded.
    // Graph's /reply returns no ids at all (owner-mailbox.ts), so a Microsoft
    // reply would register no ownership and its follow-ups would go back to
    // paging a human. But when we THREADED the send we already know the
    // conversation, because we just read it off the email_log row: prefer the
    // provider's echo, fall back to the id we replied into.
    const ownedThreadId = result.threadId ?? thread?.threadId ?? null;
    if (ownedThreadId) {
      try {
        await rememberSentThread({
          businessId: body.businessId,
          provider: providerFromKey(row.provider_config_key) === "microsoft" ? "microsoft" : "google",
          threadId: ownedThreadId,
          subject: body.subject,
          correspondentEmail: body.toEmail,
          sentMessageRef: result.messageId ?? null
        });
      } catch (claimErr) {
        logger.warn("aiflows/send-owner-email: thread claim failed", {
          businessId: body.businessId,
          error: claimErr instanceof Error ? claimErr.message : String(claimErr)
        });
      }
    }
    return voiceToolResponse({
      ok: true,
      // fromEmail rides along so the worker can log the REAL sending address
      // on email_log instead of the provider name.
      data: { messageId: result.messageId, provider: result.provider, fromEmail: result.fromEmail }
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
