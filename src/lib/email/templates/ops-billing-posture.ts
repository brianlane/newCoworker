/**
 * Operator email: the fleet billing-posture cron found VMs whose Hostinger
 * auto-renew state contradicts their tenant/pool assignment (live tenant on
 * a lapsing box, or an idle pooled box still paying), or a pooled box whose
 * paid period has ended and whose inventory row it retired. Auto-healed
 * findings are included so the operator can see what the cron changed on
 * their behalf; everything else is a manual hPanel action.
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
  // "pool" is only right for the pool direction. An untracked_vm with no
  // owner is the opposite of a pool box: nothing in vps_inventory knows it
  // exists, which is the whole finding.
  const ownerless = finding.kind === "untracked_vm" ? "untracked" : "pool";
  const who = finding.businessName
    ? `${finding.businessName} (${finding.businessId})`
    : ownerless;
  const expires = finding.expiresAt ? `, period ends ${finding.expiresAt}` : "";
  const healed = finding.autoHealed ? " [AUTO-HEALED]" : " [ACTION REQUIRED]";
  // online_tenant_no_box is about a tenant, not a box, so there is no VM id.
  const subject = finding.vmId === null ? who : `VM ${finding.vmId} / ${who}`;
  return `${subject}: ${finding.detail}${expires}${healed}`;
}

export function buildOpsBillingPostureEmail(
  input: OpsBillingPostureInput
): OpsBillingPostureEmail {
  const actionCount = input.findings.filter((f) => !f.autoHealed).length;
  const subject =
    actionCount > 0
      ? `[ops] ACTION REQUIRED: ${actionCount} VPS billing posture finding(s), live boxes at risk of lapsing`
      : `[ops] VPS billing posture: ${input.findings.length} finding(s) auto-healed`;

  const textLines = [
    `The daily VPS billing-posture check (${input.checkedTenantVms} tenant VMs, ${input.checkedPoolBoxes} pooled boxes) found auto-renew states that contradict fleet assignments. A live tenant's box with auto-renew off gets DELETED by Hostinger at its paid period's end.`,
    input.findings.map(findingLine).join("\n"),
    `Auto-healed findings need no action: renewal was re-enabled, or a lapsed pool box was retired from inventory. For the rest: hPanel -> Billing -> Subscriptions, and flip the renewal toggle to match the assignment.`
  ];
  const text = textLines.join("\n\n");

  const html = buildBrandedEmailHtml({
    // Internal ops inbox, omit the owner-facing platform signature block.
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
