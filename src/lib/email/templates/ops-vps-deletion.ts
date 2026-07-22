/**
 * Operator email: manual Hostinger VPS deletion request.
 *
 * Hostinger removed the public cancel-subscription API (DELETE
 * /api/billing/v1/subscriptions/{id} → 404, verified Jul 2026), so automated
 * cancels can only disable auto-renewal. Actually deleting the VM (and, for
 * 30-day-window refunds, requesting the Hostinger refund) is a manual hPanel
 * action. The lifecycle executor and change-plan orchestrator send this email
 * to the ops inbox whenever a box needs that manual follow-up.
 */

import { buildBrandedEmailHtml } from "@/lib/email/branded-html";

/** Ops inbox for manual Hostinger actions. Overridable for staging. */
export function opsNotificationEmail(): string {
  return process.env.OPS_NOTIFICATION_EMAIL ?? "team@newcoworker.com";
}

export const HOSTINGER_INVOICES_URL = "https://hpanel.hostinger.com/paid-invoices";

export type OpsVpsDeletionInput = {
  businessId: string;
  virtualMachineId: number | null;
  hostingerBillingSubscriptionId: string | null;
  ownerName: string | null;
  ownerEmail: string;
  tier: string;
  /** ISO timestamp of the subscription row creation (signup). */
  signupDate: string;
  refundIssued: boolean;
  cancelReason: string;
  vmState: string;
  /** App origin without trailing slash, for the branded shell. */
  siteUrl: string;
};

export type OpsVpsDeletionEmail = {
  subject: string;
  text: string;
  html: string;
};

export function vpsHostname(virtualMachineId: number | null): string | null {
  return virtualMachineId === null ? null : `srv${virtualMachineId}.hstgr.cloud`;
}

export function buildOpsVpsDeletionEmail(input: OpsVpsDeletionInput): OpsVpsDeletionEmail {
  const hostname = vpsHostname(input.virtualMachineId);
  const target = hostname ?? "(no VM id recorded — check the billing subscription below)";
  const who = input.ownerName?.trim() ? input.ownerName.trim() : input.ownerEmail;
  const signup = input.signupDate.slice(0, 10);

  const subject = `[ops] Delete ${hostname ?? "VPS"} in hPanel — ${who} (${input.tier})`;
  const textLines = [
    `Please delete ${target} at ${HOSTINGER_INVOICES_URL} for user ${who}, ${input.tier} tier.`,
    [
      `Owner email: ${input.ownerEmail}`,
      `Business id: ${input.businessId}`,
      `Signup date: ${signup}`,
      `Cancel reason: ${input.cancelReason}`,
      `Stripe refund issued: ${input.refundIssued ? "yes" : "no"}`,
      `VM state: ${input.vmState}`,
      `Hostinger billing subscription: ${input.hostingerBillingSubscriptionId ?? "unknown"}`
    ].join("\n"),
    "Auto-renewal has already been disabled where possible, so this box stops billing at its period end even if deletion waits. Deleting it in hPanel frees the resource immediately."
  ];
  const text = textLines.join("\n\n");

  const html = buildBrandedEmailHtml({
    // Internal ops inbox — omit the owner-facing platform signature block.
    platformSignature: false,
    siteUrl: input.siteUrl,
    documentTitle: subject,
    heading: "Manual Hostinger deletion needed",
    bodyBlocks: textLines.map((t) => ({ kind: "text" as const, text: t })),
    cta: { label: "Open Hostinger invoices", href: HOSTINGER_INVOICES_URL },
    recipientEmail: opsNotificationEmail()
  });

  return { subject, text, html };
}
