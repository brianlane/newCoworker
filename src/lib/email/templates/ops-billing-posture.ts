/**
 * Operator email: the fleet billing-posture cron found VMs whose Hostinger
 * auto-renew state contradicts their tenant/pool assignment (live tenant on
 * a lapsing box, or an idle pooled box still paying). Auto-healed findings
 * are included so the operator can see what the cron changed on their
 * behalf; everything else is a manual hPanel action.
 */

import { buildBrandedEmailHtml } from "@/lib/email/branded-html";
import { opsNotificationEmail } from "@/lib/email/templates/ops-vps-deletion";
import type { BillingPostureFinding } from "@/lib/vps/billing-posture";

export type OpsBillingPostureInput = {
  findings: BillingPostureFinding[];
  checkedTenantVms: number;
  checkedPoolBoxes: number;
  /** App origin without trailing slash, for the branded shell. */
  siteUrl: string;
};

export type OpsBillingPostureEmail = {
  subject: string;
  text: string;
  html: string;
};

function findingLine(finding: BillingPostureFinding): string {
  const who = finding.businessName
    ? `${finding.businessName} (${finding.businessId})`
    : "pool";
  const expires = finding.expiresAt ? ` — period ends ${finding.expiresAt}` : "";
  const healed = finding.autoHealed ? " [AUTO-HEALED]" : " [ACTION REQUIRED]";
  return `VM ${finding.vmId} / ${who}: ${finding.detail}${expires}${healed}`;
}

export function buildOpsBillingPostureEmail(
  input: OpsBillingPostureInput
): OpsBillingPostureEmail {
  const actionCount = input.findings.filter((f) => !f.autoHealed).length;
  const subject =
    actionCount > 0
      ? `[ops] ACTION REQUIRED: ${actionCount} VPS billing posture finding(s) — live boxes at risk of lapsing`
      : `[ops] VPS billing posture: ${input.findings.length} finding(s) auto-healed`;

  const textLines = [
    `The daily VPS billing-posture check (${input.checkedTenantVms} tenant VMs, ${input.checkedPoolBoxes} pooled boxes) found auto-renew states that contradict fleet assignments. A live tenant's box with auto-renew off gets DELETED by Hostinger at its paid period's end.`,
    input.findings.map(findingLine).join("\n"),
    `Auto-healed findings need no action (renewal was re-enabled). For the rest: hPanel -> Billing -> Subscriptions, and flip the renewal toggle to match the assignment.`
  ];
  const text = textLines.join("\n\n");

  const html = buildBrandedEmailHtml({
    // Internal ops inbox — omit the owner-facing platform signature block.
    platformSignature: false,
    siteUrl: input.siteUrl,
    documentTitle: subject,
    heading: "VPS billing posture findings",
    bodyBlocks: textLines.map((t) => ({ kind: "text" as const, text: t })),
    cta: {
      label: "Open hPanel subscriptions",
      href: "https://hpanel.hostinger.com/billing/subscriptions"
    },
    recipientEmail: opsNotificationEmail()
  });

  return { subject, text, html };
}
