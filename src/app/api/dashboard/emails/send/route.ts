/**
 * Owner-initiated outbound email (dashboard).
 *
 * POST /api/dashboard/emails/send
 *   body: { businessId: uuid, toEmail, subject, bodyText, cc?, bcc? }
 *   → { messageId, provider, logId, logged } on success.
 *
 * Powers two affordances on the Emails page (the email analog of the SMS
 * reply/compose feature):
 *   1. Replying into an existing email thread (Reply button in the reading
 *      pane — recipient + "Re:" subject prefilled).
 *   2. Composing a brand-new email to any address.
 *
 * The subject + body are sent EXACTLY as typed (plain text only — no markup, no
 * templating). Mail goes out from the OWNER's connected mailbox
 * (Gmail/Outlook via Nango), the same primitive the dashboard-chat email tool
 * uses, and we log it to email_log (source 'owner_manual') so it renders inline
 * with the rest of the email activity.
 *
 * Auth: getAuthUser + requireOwner(businessId). Admins may target any business
 * (matches the dashboard-chat / SMS-send convention).
 */

import { z } from "zod";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { sendFromOwnerMailbox } from "@/lib/email/owner-mailbox";
import { normalizeRecipients } from "@/lib/email/recipients";
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
  bcc: recipientList
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const json = (await request.json().catch(() => null)) as unknown;
    const { businessId, toEmail, subject, bodyText, cc, bcc } = bodySchema.parse(json);

    if (!user.isAdmin) await requireOwner(businessId);

    const limiter = rateLimit(`dashboard-email-send:${businessId}:${user.userId}`, EMAIL_SEND_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many sends, please slow down.", 429);
    }

    const ccEmails = normalizeRecipients(cc);
    const bccEmails = normalizeRecipients(bcc);

    let result;
    try {
      result = await sendFromOwnerMailbox(businessId, {
        toEmail,
        subject,
        bodyText,
        ccEmails,
        bccEmails
      });
    } catch (err) {
      // Provider (Gmail/Graph) rejected the send. Surface a trimmed reason so
      // the owner knows WHY rather than a generic failure — they're trusted.
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("dashboard-email-send: provider send failed", { businessId, error: message });
      return errorResponse("INTERNAL_SERVER_ERROR", `Could not send: ${message}`.slice(0, 300), 502);
    }

    if (!result.ok) {
      // The only non-ok result today is a missing connected mailbox. Tell the
      // owner to connect Gmail/Outlook in Settings rather than failing opaquely.
      return errorResponse(
        "CONFLICT",
        "No connected email account. Connect Gmail or Outlook in Settings to send email.",
        409
      );
    }

    // Best-effort durable log so the email renders in the list (source
    // 'owner_manual'). A failed insert must not imply the email didn't go out
    // (it did) — report logged:false so the UI can warn without promising the
    // row will appear (e.g. before the owner_manual migration is applied).
    const db = await createSupabaseServiceClient();
    const { error: logErr } = await db.from("email_log").insert({
      business_id: businessId,
      direction: "outbound",
      to_email: toEmail,
      from_email: null,
      subject,
      body_preview: bodyText.slice(0, 500),
      body_full: bodyText,
      cc_email: recipientsCsv(ccEmails),
      bcc_email: recipientsCsv(bccEmails),
      source: "owner_manual",
      run_id: null,
      flow_id: null,
      provider_message_id: result.messageId
    });
    if (logErr) {
      logger.error("dashboard-email-send: email_log insert failed", {
        businessId,
        error: logErr.message
      });
    }

    logger.info("dashboard-email-send: sent", {
      businessId,
      provider: result.provider,
      logged: !logErr
    });
    return successResponse({
      messageId: result.messageId,
      provider: result.provider,
      logged: !logErr
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
