/**
 * Operator email: the daily margin alert found paying tenants whose actual
 * monthly margin (vendor actuals where synced) fell below the configured
 * floor. Digest form, one email per sync run while breaches persist.
 */

import { buildBrandedEmailHtml } from "@/lib/email/branded-html";
import { opsNotificationEmail } from "@/lib/email/templates/ops-vps-deletion";
import type { MarginAlertBreach } from "@/lib/admin/margin-alert";

export type OpsMarginAlertInput = {
  breaches: MarginAlertBreach[];
  thresholdCents: number;
  /** App origin without trailing slash, for the branded shell. */
  siteUrl: string;
};

export type OpsMarginAlertEmail = {
  subject: string;
  text: string;
  html: string;
};

function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${Math.abs(cents / 100).toFixed(2)}`;
}

function breachLine(breach: MarginAlertBreach): string {
  return (
    `${breach.businessName} (${breach.businessId}): margin ${money(breach.marginCents)}/mo ` +
    `: revenue ${money(breach.revenueCents)}, cost ${money(breach.costCents)}`
  );
}

export function buildOpsMarginAlertEmail(input: OpsMarginAlertInput): OpsMarginAlertEmail {
  const subject = `[ops] Margin alert: ${input.breaches.length} paying tenant(s) below ${money(input.thresholdCents)}/mo`;

  const textLines = [
    `The daily margin check found paying tenants whose actual monthly margin (Telnyx/Hostinger actuals where synced, per-unit estimates otherwise) is below the configured ${money(input.thresholdCents)}/mo floor.`,
    input.breaches.map(breachLine).join("\n"),
    `Worst offenders first. Drill into each tenant's Economics card for the itemized cost lines, or the Costs page for the fleet view. Common causes: hardware oversized for the tier, usage past the modeled caps, or a stale/renewal-rate mismatch.`
  ];
  const text = textLines.join("\n\n");

  const html = buildBrandedEmailHtml({
    // Internal ops inbox, omit the owner-facing platform signature block.
    platformSignature: false,
    siteUrl: input.siteUrl,
    documentTitle: subject,
    heading: "Tenant margin below floor",
    bodyBlocks: textLines.map((t) => ({ kind: "text" as const, text: t })),
    cta: {
      label: "Open the Costs page",
      href: `${input.siteUrl}/admin/costs`
    },
    recipientEmail: opsNotificationEmail()
  });

  return { subject, text, html };
}
