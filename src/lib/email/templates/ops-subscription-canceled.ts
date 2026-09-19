/**
 * Operator email: a tenant subscription was canceled.
 *
 * Signup, plan-change, and VPS-deletion already page ops. Cancel did not,
 * so a Stripe Customer Portal / Dashboard cancel (no in-app lifecycle
 * reason) left the owner un-emailed and ops unaware. This fires on every
 * real leave: in-app refund, scheduled period-end, payment failure, admin
 * force, and stripe_external. Plan-change (`upgrade_switch`) does not use
 * this template.
 */

import { buildBrandedEmailHtml } from "@/lib/email/branded-html";
import { opsNotificationEmail } from "@/lib/email/templates/ops-vps-deletion";

export type OpsSubscriptionCanceledInput = {
  businessId: string;
  businessName: string;
  ownerName: string | null;
  ownerEmail: string;
  tier: string;
  /** Lifecycle cancel_reason, or stripe_external. */
  cancelReason: string;
  /** How the cancel entered the system. */
  cancelPath: string;
  /** ISO grace deadline, or null when period-end is only scheduled. */
  graceEndsAt: string | null;
  /** Hostinger prepaid `expires_at` when known. */
  hostingerExpiresAt: string | null;
  /** Stripe cancellation_details blob, when the event carried one. */
  stripeCancellationDetails?: string | null;
  /** App origin without trailing slash, for the branded shell. */
  siteUrl: string;
};

export type OpsSubscriptionCanceledEmail = {
  subject: string;
  text: string;
  html: string;
};

export function buildOpsSubscriptionCanceledEmail(
  input: OpsSubscriptionCanceledInput
): OpsSubscriptionCanceledEmail {
  const who = input.ownerName?.trim() ? input.ownerName.trim() : input.ownerEmail;
  const business = input.businessName.trim() || "(unnamed)";
  const subject = `[ops] Subscription canceled, ${business} (${input.tier}, ${input.cancelReason})`;
  const textLines = [
    `${who} canceled (or Stripe canceled) the ${input.tier} subscription for ${business}.`,
    [
      `Business: ${business}`,
      `Business id: ${input.businessId}`,
      `Owner: ${who}`,
      `Owner email: ${input.ownerEmail}`,
      `Tier: ${input.tier}`,
      `Cancel reason: ${input.cancelReason}`,
      `Cancel path: ${input.cancelPath}`,
      `Grace ends at: ${input.graceEndsAt ?? "(not started; scheduled period-end)"}`,
      `Hostinger expires at: ${input.hostingerExpiresAt ?? "(none on file)"}`,
      ...(input.stripeCancellationDetails
        ? [`Stripe cancellation details: ${input.stripeCancellationDetails}`]
        : [])
    ].join("\n")
  ];
  const text = textLines.join("\n\n");

  const html = buildBrandedEmailHtml({
    platformSignature: false,
    siteUrl: input.siteUrl,
    documentTitle: subject,
    heading: "Subscription canceled",
    bodyBlocks: textLines.map((t) => ({ kind: "text" as const, text: t })),
    cta: {
      label: "Open admin panel",
      href: `${input.siteUrl}/admin/${input.businessId}`
    },
    recipientEmail: opsNotificationEmail()
  });

  return { subject, text, html };
}
