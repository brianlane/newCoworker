/**
 * Operator email: the fleet billing-posture cron found VMs whose Hostinger
 * auto-renew state contradicts their tenant/pool assignment (live tenant on
 * a lapsing box, or an idle pooled box still paying), or a pooled box whose
 * paid period has ended and whose inventory row it retired. Auto-healed
 * findings are included so the operator can see what the cron changed on
 * their behalf; everything else is a manual hPanel action.
 *
 * The framing tracks the contents rather than assuming the worst: a run whose
 * findings were all handled in place says so plainly, and the warning about
 * Hostinger deleting a live tenant's box appears only when something in the
 * body is actually at risk.
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
  // "period ends" states the deadline a finding is RACING. A reaped pool box
  // has no deadline left, and its detail already says when it lapsed, so
  // appending the suffix printed the SAME timestamp twice in one line.
  const expires =
    finding.expiresAt && finding.kind !== "pool_box_lapsed_retired"
      ? `, period ends ${finding.expiresAt}`
      : "";
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

  const scanned = `The daily VPS billing-posture check (${input.checkedTenantVms} tenant VMs, ${input.checkedPoolBoxes} pooled boxes)`;

  // The opening and closing lines describe what is actually in the digest.
  // They used to be fixed text that always announced auto-renew contradictions
  // and warned that Hostinger DELETES a live tenant's box. On an all-healed
  // run (four lapsed pool boxes reaped, say) that described nothing in the
  // body and made routine cleanup read as an incident. An operator who is
  // startled by a digest that turns out to be nothing learns to skim it, and
  // then skims the one that matters.
  const intro =
    actionCount > 0
      ? `${scanned} found ${actionCount} finding(s) that need a human. A live tenant's box with auto-renew off gets DELETED by Hostinger at its paid period's end.`
      : `${scanned} found nothing that needs a human. Everything below was already handled by the check itself.`;

  const closing =
    actionCount > 0
      ? "Auto-healed findings need no action. For the rest: hPanel -> Billing -> Subscriptions, and flip the renewal toggle to match the assignment."
      : "No action needed. Auto-healed means renewal was re-enabled, or a lapsed pool box was retired from inventory.";

  const textLines = [intro, input.findings.map(findingLine).join("\n"), closing];
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
