/**
 * Operator email: a new tenant finished first-time provisioning and is live.
 */

import { buildBrandedEmailHtml } from "@/lib/email/branded-html";
import { opsNotificationEmail } from "@/lib/email/templates/ops-vps-deletion";

export type OpsNewSignupInput = {
  businessId: string;
  businessName: string;
  ownerName: string | null;
  ownerEmail: string | null;
  ownerPhone: string | null;
  tier: string;
  billingPeriod: string | null;
  virtualMachineId: string;
  didE164: string | null;
  /** App origin without trailing slash, for the branded shell. */
  siteUrl: string;
};

export type OpsNewSignupEmail = {
  subject: string;
  text: string;
  html: string;
};

export function buildOpsNewSignupEmail(input: OpsNewSignupInput): OpsNewSignupEmail {
  const who =
    input.ownerName?.trim() ||
    input.ownerEmail?.trim() ||
    input.businessName.trim() ||
    input.businessId;
  const subject = `[ops] New signup live — ${input.businessName.trim() || input.businessId}`;
  const textLines = [
    `${who} finished onboarding and their coworker is online.`,
    [
      `Business: ${input.businessName.trim() || "(unnamed)"}`,
      `Business id: ${input.businessId}`,
      `Owner email: ${input.ownerEmail?.trim() || "(none on file)"}`,
      `Owner phone: ${input.ownerPhone?.trim() || "(none on file)"}`,
      `Tier: ${input.tier}${input.billingPeriod ? ` (${input.billingPeriod})` : ""}`,
      `VPS: srv${input.virtualMachineId}.hstgr.cloud`,
      `DID: ${input.didE164?.trim() || "(not assigned yet)"}`
    ].join("\n")
  ];
  const text = textLines.join("\n\n");

  const html = buildBrandedEmailHtml({
    siteUrl: input.siteUrl,
    documentTitle: subject,
    heading: "New signup live",
    bodyBlocks: textLines.map((t) => ({ kind: "text" as const, text: t })),
    cta: {
      label: "Open admin panel",
      href: `${input.siteUrl}/admin/${input.businessId}`
    },
    recipientEmail: opsNotificationEmail()
  });

  return { subject, text, html };
}
