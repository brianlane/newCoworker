/**
 * Owner-initiated outbound email (dashboard).
 *
 * POST /api/dashboard/emails/send
 *   body: { businessId: uuid, toEmail, subject, bodyText, cc?, bcc?, fromConnectionId? }
 *   → { messageId, provider, logged } on success.
 *
 * Powers two affordances on the Emails page (the email analog of the SMS
 * reply/compose feature):
 *   1. Replying into an existing email thread (Reply button in the reading
 *      pane — recipient + "Re:" subject prefilled).
 *   2. Composing a brand-new email to any address.
 *
 * The subject + body are sent EXACTLY as typed (plain text only — no markup, no
 * templating). The sender is chosen by `fromConnectionId`, mirroring the AiFlow
 * send_email "From" picker:
 *   - empty/omitted → the business's AI coworker mailbox (Resend transport,
 *     logged as 'tenant_mailbox_outbound', labelled "AI Mailbox");
 *   - a workspace_oauth_connections.id → the owner's connected Gmail/Outlook
 *     (Nango, logged as 'owner_manual', labelled "You").
 * Either way we log to email_log so it renders inline with the rest of the
 * email activity.
 *
 * Auth: getAuthUser + requireOwner(businessId). Admins may target any business
 * (matches the dashboard-chat / SMS-send convention).
 */

import { z } from "zod";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { sendFromMailboxConnection } from "@/lib/email/owner-mailbox";
import { sendFromTenantMailbox } from "@/lib/email/tenant-send";
import { connectionEmail } from "@/lib/email/mailbox-options";
import { getWorkspaceOAuthConnection } from "@/lib/db/workspace-oauth-connections";
import { isEmailProviderConfigKey, providerFromKey } from "@/lib/voice-tools/connections";
import { normalizeRecipients } from "@/lib/email/recipients";
import type { EmailLogSource } from "@/lib/db/email-log";
import { logger } from "@/lib/logger";

/** Join a recipient list into the stored CSV form, or null when empty. */
function recipientsCsv(recipients: string[]): string | null {
  return recipients.length > 0 ? recipients.join(", ") : null;
}

export const dynamic = "force-dynamic";

// A human at a keyboard sends a handful a minute; this keeps a double-click
// loop or stray script from spamming the owner's mailbox.
const EMAIL_SEND_RATE = { interval: 60 * 1000, maxRequests: 20 };

const recipientList = z.union([z.string(), z.array(z.string())]).optional();

const bodySchema = z.object({
  businessId: z.string().uuid(),
  toEmail: z.string().email("Enter a valid email address"),
  subject: z.string().min(1, "Subject can't be empty").max(150),
  bodyText: z.string().min(1, "Message can't be empty").max(4000),
  cc: recipientList,
  bcc: recipientList,
  // Which mailbox to send AS. Empty/omitted = the AI coworker's own mailbox;
  // otherwise a workspace_oauth_connections.id (the owner's connected
  // Gmail/Outlook). Mirrors the AiFlow send_email "From" picker.
  fromConnectionId: z.string().optional()
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const json = (await request.json().catch(() => null)) as unknown;
    const { businessId, toEmail, subject, bodyText, cc, bcc, fromConnectionId } =
      bodySchema.parse(json);

    if (!user.isAdmin) await requireOwner(businessId);

    const limiter = rateLimit(`dashboard-email-send:${businessId}:${user.userId}`, EMAIL_SEND_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many sends, please slow down.", 429);
    }

    const ccEmails = normalizeRecipients(cc);
    const bccEmails = normalizeRecipients(bcc);
    // Empty/omitted = the AI coworker's own mailbox; a non-empty value selects
    // one of the owner's connected mailboxes by workspace_oauth_connections.id.
    const useConnection =
      typeof fromConnectionId === "string" && fromConnectionId.trim().length > 0;

    // Resolve the sender, send, and capture what to record. A provider/transport
    // failure returns a 502 with a trimmed reason; a missing/invalid connection
    // is a 409 (the owner picks another sender).
    let provider: string;
    let messageId: string | null;
    let fromEmail: string | null;
    let source: EmailLogSource;

    if (useConnection) {
      const conn = await getWorkspaceOAuthConnection(businessId, fromConnectionId!.trim());
      if (!conn || !isEmailProviderConfigKey(conn.provider_config_key)) {
        return errorResponse(
          "CONFLICT",
          "That mailbox isn't connected anymore. Pick another sender.",
          409
        );
      }
      try {
        const result = await sendFromMailboxConnection(
          businessId,
          {
            provider: providerFromKey(conn.provider_config_key),
            providerConfigKey: conn.provider_config_key,
            connectionId: conn.connection_id
          },
          { toEmail, subject, bodyText, ccEmails, bccEmails }
        );
        if (!result.ok) {
          return errorResponse(
            "CONFLICT",
            "That mailbox isn't connected anymore. Pick another sender.",
            409
          );
        }
        provider = result.provider;
        messageId = result.messageId;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("dashboard-email-send: connected-mailbox send failed", { businessId, error: message });
        return errorResponse("INTERNAL_SERVER_ERROR", `Could not send: ${message}`.slice(0, 300), 502);
      }
      // Owner sent by hand from a connected mailbox → labels as "You".
      fromEmail = connectionEmail(conn.metadata);
      source = "owner_manual";
    } else {
      try {
        const result = await sendFromTenantMailbox(businessId, {
          toEmail,
          subject,
          bodyText,
          ccEmails,
          bccEmails
        });
        provider = result.provider;
        messageId = result.messageId;
        fromEmail = result.fromAddress;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("dashboard-email-send: coworker-mailbox send failed", { businessId, error: message });
        return errorResponse("INTERNAL_SERVER_ERROR", `Could not send: ${message}`.slice(0, 300), 502);
      }
      // Sent as the coworker's own address → labels as "AI Mailbox".
      source = "tenant_mailbox_outbound";
    }

    // Best-effort durable log so the email renders in the list. The email
    // already went out, so this MUST NOT be able to fail the request — a 500
    // here would make the owner retry and send a duplicate. Any throw (client
    // creation, insert) is swallowed to logged:false; the UI then warns instead
    // of promising the row will appear.
    let logged = false;
    try {
      const db = await createSupabaseServiceClient();
      const { error: logErr } = await db.from("email_log").insert({
        business_id: businessId,
        direction: "outbound",
        to_email: toEmail,
        from_email: fromEmail,
        subject,
        body_preview: bodyText.slice(0, 500),
        body_full: bodyText,
        cc_email: recipientsCsv(ccEmails),
        bcc_email: recipientsCsv(bccEmails),
        source,
        run_id: null,
        flow_id: null,
        provider_message_id: messageId
      });
      if (logErr) {
        logger.error("dashboard-email-send: email_log insert failed", {
          businessId,
          error: logErr.message
        });
      } else {
        logged = true;
      }
    } catch (logErr) {
      logger.error("dashboard-email-send: email_log insert threw", {
        businessId,
        error: logErr instanceof Error ? logErr.message : String(logErr)
      });
    }

    logger.info("dashboard-email-send: sent", { businessId, provider, source, logged });
    return successResponse({ messageId, provider, logged });
  } catch (err) {
    return handleRouteError(err);
  }
}
