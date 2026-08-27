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
 *
 * Findings also split by WHAT THE OPERATOR MUST DO, not just by whether the
 * cron healed them. Advisory findings (see ADVISORY_FINDING_KINDS) need a
 * human but not a renewal change, so they never trigger the lapse warning and
 * never inherit the "flip the renewal toggle" closing, which for them would
 * be an instruction to break a perfectly healthy box.
 */

import { buildBrandedEmailHtml } from "@/lib/email/branded-html";
import { opsNotificationEmail } from "@/lib/email/templates/ops-vps-deletion";
import { isLapseRiskFinding, type BillingPostureFinding } from "@/lib/vps/billing-posture";

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
  // exists, which is the whole finding. A billing_cycle_price_stale row is
  // ownerless only when the Hostinger VM listing failed, so we genuinely do
  // not know who runs it; calling that "pool" asserts something false.
  // A stale_assigned_row is ownerless only when the business row is GONE;
  // the vm is still marked assigned, so "pool" would assert the opposite of
  // the finding.
  const ownerless =
    finding.kind === "untracked_vm"
      ? "untracked"
      : finding.kind === "billing_cycle_price_stale"
        ? "unattributed"
        : finding.kind === "stale_assigned_row"
          ? `assigned to missing business ${finding.businessId ?? "(unknown)"}`
          : "pool";
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
  // Three tags, not two. An advisory finding does need a human, but not the
  // renewal action the closing line describes, so it must not carry the same
  // tag as a box that is about to be deleted. The closing text refers to this
  // tag by name, so it has to actually appear on the line.
  const healed = finding.autoHealed
    ? " [AUTO-HEALED]"
    : isLapseRiskFinding(finding)
      ? " [ACTION REQUIRED]"
      : " [REVIEW: reconciliation note]";
  // online_tenant_no_box is about a tenant, not a box, so there is no VM id.
  const subject = finding.vmId === null ? who : `VM ${finding.vmId} / ${who}`;
  return `${subject}: ${finding.detail}${expires}${healed}`;
}

export function buildOpsBillingPostureEmail(
  input: OpsBillingPostureInput
): OpsBillingPostureEmail {
  const needsHuman = input.findings.filter((f) => !f.autoHealed);
  // Split by what the operator is actually being asked to DO. The lapse
  // framing and the "flip the renewal toggle" instruction are correct only
  // for the auto-renew directions; applying them to an advisory finding
  // tells the operator to disable renewal on a healthy tenant box.
  const lapseRisk = needsHuman.filter(isLapseRiskFinding);
  const advisory = needsHuman.filter((f) => !isLapseRiskFinding(f));
  const actionCount = needsHuman.length;
  const subject =
    lapseRisk.length > 0
      ? `[ops] ACTION REQUIRED: ${actionCount} VPS billing posture finding(s), live boxes at risk of lapsing`
      : advisory.length > 0
        ? `[ops] VPS billing posture: ${advisory.length} finding(s) to review`
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
    lapseRisk.length > 0
      ? `${scanned} found ${actionCount} finding(s) that need a human. A live tenant's box with auto-renew off gets DELETED by Hostinger at its paid period's end.`
      : advisory.length > 0
        ? `${scanned} found ${advisory.length} finding(s) to review. Nothing is at risk of lapsing: these are reconciliation notes, not renewal problems.`
        : `${scanned} found nothing that needs a human. Everything below was already handled by the check itself.`;

  // The renewal-toggle instruction is appended only when something in the
  // body actually needs it. An advisory-only digest that ended with it would
  // be inviting the operator to turn off renewal on a box that is fine.
  const closing =
    lapseRisk.length > 0
      ? "Auto-healed findings need no action. For renewal findings: hPanel -> Billing -> Subscriptions, and flip the renewal toggle to match the assignment." +
        (advisory.length > 0
          ? " Lines tagged REVIEW are NOT renewal problems: do not touch their toggle, follow the line itself."
          : "")
      : advisory.length > 0
        ? "No renewal toggle to flip. Each line says what to reconcile and where to read the real number."
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
