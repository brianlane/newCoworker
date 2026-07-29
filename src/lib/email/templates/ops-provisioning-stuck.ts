/**
 * Operator email: provisioning appears stuck mid-deploy (KYP-class freeze).
 */

import { buildBrandedEmailHtml } from "@/lib/email/branded-html";
import { opsNotificationEmail } from "@/lib/email/templates/ops-vps-deletion";

export type OpsProvisioningStuckInput = {
  businessId: string;
  businessName: string;
  phase: string;
  percent: number;
  ageMinutes: number;
  purpose: string;
  /** Why this tick fired the alert (exhausted job, retry_failed, stuck scan). */
  trigger: string;
  /** App origin without trailing slash, for the branded shell. */
  siteUrl: string;
};

export type OpsProvisioningStuckEmail = {
  subject: string;
  text: string;
  html: string;
};

export function buildOpsProvisioningStuckEmail(
  input: OpsProvisioningStuckInput
): OpsProvisioningStuckEmail {
  const subject =
    `[ops] Provisioning stuck, ` +
    `${input.businessName.trim() || input.businessId} ` +
    `(${input.percent}% ${input.phase})`;

  const textLines = [
    `Provisioning looks stuck for ${input.businessName.trim() || input.businessId}.`,
    [
      `Business id: ${input.businessId}`,
      `Phase: ${input.phase}`,
      `Percent: ${input.percent}`,
      `Age: ${input.ageMinutes} minutes`,
      `Purpose: ${input.purpose}`,
      `Trigger: ${input.trigger}`
    ].join("\n"),
    "Check the admin panel and the tenant VPS. The watchdog may already be retrying."
  ];
  const text = textLines.join("\n\n");

  const html = buildBrandedEmailHtml({
    platformSignature: false,
    siteUrl: input.siteUrl,
    documentTitle: subject,
    heading: "Provisioning stuck",
    bodyBlocks: textLines.map((t) => ({ kind: "text" as const, text: t })),
    cta: {
      label: "Open admin panel",
      href: `${input.siteUrl}/admin/${input.businessId}`
    },
    recipientEmail: opsNotificationEmail()
  });

  return { subject, text, html };
}
