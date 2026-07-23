/**
 * Operator email: a hardware escalation (tier change) has STARTED.
 *
 * Tier changes are tenant-initiated (Stripe change-plan checkout) and run
 * minutes of unattended migration, snapshot, backup, new-VM purchase,
 * restore, old-box teardown. The operator previously only heard about the
 * END of the process (the VPS deletion-request email); this one fires at
 * initiation so an in-flight migration is visible the moment money has been
 * taken and hardware is about to be purchased, mirroring the
 * ops-vps-deletion pattern.
 */

import { buildBrandedEmailHtml } from "@/lib/email/branded-html";
import { opsNotificationEmail } from "@/lib/email/templates/ops-vps-deletion";

export type OpsPlanChangeInput = {
  businessId: string;
  ownerName: string | null;
  ownerEmail: string;
  fromTier: string;
  toTier: string;
  billingPeriod: string;
  /** Old Hostinger VM id; null when the business had no box recorded. */
  oldVirtualMachineId: number | null;
  /** Resolved hardware labels, e.g. "kvm2" → "kvm8". */
  fromHardware: string;
  toHardware: string;
  /** App origin without trailing slash, for the branded shell. */
  siteUrl: string;
};

export type OpsPlanChangeEmail = {
  subject: string;
  text: string;
  html: string;
};

export function buildOpsPlanChangeEmail(input: OpsPlanChangeInput): OpsPlanChangeEmail {
  const who = input.ownerName?.trim() ? input.ownerName.trim() : input.ownerEmail;
  const oldBox =
    input.oldVirtualMachineId === null
      ? "no VM recorded"
      : `srv${input.oldVirtualMachineId}.hstgr.cloud`;

  const subject = `[ops] Hardware escalation started, ${who}: ${input.fromTier}/${input.fromHardware} → ${input.toTier}/${input.toHardware}`;
  const textLines = [
    `${who} paid for a plan change and the automated hardware migration just started.`,
    [
      `Owner email: ${input.ownerEmail}`,
      `Business id: ${input.businessId}`,
      `Tier: ${input.fromTier} → ${input.toTier} (${input.billingPeriod})`,
      `Hardware: ${input.fromHardware} → ${input.toHardware}`,
      `Old box: ${oldBox}`
    ].join("\n"),
    "What happens next automatically: snapshot + SSH backup of the old box, purchase + bootstrap of the new box, data restore, Stripe swap, then old-box stop + auto-renew disable. A separate deletion-request email arrives when the old box is ready for manual hPanel deletion. If no such email lands within the hour, check the change-plan logs for this business id."
  ];
  const text = textLines.join("\n\n");

  const html = buildBrandedEmailHtml({
    // Internal ops inbox, omit the owner-facing platform signature block.
    platformSignature: false,
    siteUrl: input.siteUrl,
    documentTitle: subject,
    heading: "Hardware escalation started",
    bodyBlocks: textLines.map((t) => ({ kind: "text" as const, text: t })),
    cta: {
      label: "Open admin panel",
      href: `${input.siteUrl}/admin/${input.businessId}`
    },
    recipientEmail: opsNotificationEmail()
  });

  return { subject, text, html };
}
