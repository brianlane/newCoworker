/**
 * Send a plain-text email AS a business's dedicated AI coworker mailbox
 * (xxx@<tenant domain>), via the platform Resend transport.
 *
 * This is the app-side counterpart to the AiFlow worker's tenant-mailbox send
 * (supabase/functions/ai-flow-worker deliverFlowEmail default path): same
 * identity rules — always send FROM the coworker's own address with reply_to
 * pointing back at it, so replies re-enter the tenant_email inbound flow. Used
 * by the dashboard Emails composer when the owner picks "AI coworker's email"
 * as the sender. Plain text only by design.
 */

import { Resend } from "resend";
import {
  ensureTenantMailbox,
  tenantMailboxAddress
} from "@/lib/email/tenant-mailbox";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export type TenantMailboxSendArgs = {
  toEmail: string;
  subject: string;
  bodyText: string;
  ccEmails?: string[];
  bccEmails?: string[];
};

export type TenantMailboxSendResult = {
  provider: "tenant";
  messageId: string | null;
  /** The bare coworker address the mail was sent from (for email_log.from_email). */
  fromAddress: string;
  /** The display "Name <addr>" form used in the From header. */
  fromHeader: string;
};

/**
 * Resolve the coworker From identity for a business: its reserved mailbox
 * local-part (created on the fly if missing, mirroring the worker) at the
 * tenant email domain, displayed with the business name when available.
 */
async function resolveTenantFrom(
  businessId: string
): Promise<{ address: string; header: string }> {
  const mailbox = await ensureTenantMailbox(businessId);
  const address = tenantMailboxAddress(mailbox.local_part);
  const db = await createSupabaseServiceClient();
  const { data: biz } = await db
    .from("businesses")
    .select("name")
    .eq("id", businessId)
    .maybeSingle();
  const name = (biz as { name?: string } | null)?.name?.trim();
  return { address, header: name ? `${name} <${address}>` : address };
}

/**
 * Send from the business's AI coworker mailbox. Throws on a missing
 * RESEND_API_KEY (setup error) or a Resend transport failure so the caller can
 * surface the reason — the dashboard send route maps these to a 502.
 */
export async function sendFromTenantMailbox(
  businessId: string,
  args: TenantMailboxSendArgs
): Promise<TenantMailboxSendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY is not configured");

  const { address, header } = await resolveTenantFrom(businessId);
  const resend = new Resend(apiKey);
  const result = await resend.emails.send({
    from: header,
    to: args.toEmail,
    subject: args.subject,
    text: args.bodyText,
    replyTo: address,
    ...(args.ccEmails && args.ccEmails.length > 0 ? { cc: args.ccEmails } : {}),
    ...(args.bccEmails && args.bccEmails.length > 0 ? { bcc: args.bccEmails } : {})
  });
  if (result.error) {
    throw new Error(result.error.message || "Resend send failed");
  }
  return {
    provider: "tenant",
    messageId: result.data?.id ?? null,
    fromAddress: address,
    fromHeader: header
  };
}
