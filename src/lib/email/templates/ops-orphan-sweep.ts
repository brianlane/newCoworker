/**
 * Operator email: the daily fleet orphan sweep found Hostinger VMs the
 * platform has no `vps_inventory` row for. Boxes it could safely pool are
 * listed so the operator knows they are now reusable and will lapse if
 * nobody adopts them; everything else needs a human, because a box that was
 * set up may be serving a tenant whose bookkeeping write failed.
 */

import { buildBrandedEmailHtml } from "@/lib/email/branded-html";
import { opsNotificationEmail } from "@/lib/email/templates/ops-vps-deletion";
import type { OrphanSweepFinding } from "@/lib/vps/orphan-sweep";

export type OpsOrphanSweepInput = {
  findings: OrphanSweepFinding[];
  /** VMs on the Hostinger account this run compared against inventory. */
  checkedVms: number;
  dryRun: boolean;
  /** App origin without trailing slash, for the branded shell. */
  siteUrl: string;
};

export type OpsOrphanSweepEmail = {
  subject: string;
  text: string;
  html: string;
};

function findingLine(finding: OrphanSweepFinding): string {
  const created = finding.createdAt ? `, created ${finding.createdAt}` : "";
  const expires = finding.expiresAt ? `, paid through ${finding.expiresAt}` : "";
  const tag = finding.kind === "pooled" ? "[POOLED]" : "[ACTION REQUIRED]";
  return (
    `VM ${finding.vmId} (${finding.plan ?? "unknown plan"}, state ${finding.state}` +
    `${created}${expires}): ${finding.detail} ${tag}`
  );
}

export function buildOpsOrphanSweepEmail(input: OpsOrphanSweepInput): OpsOrphanSweepEmail {
  const pooled = input.findings.filter((f) => f.kind === "pooled").length;
  const actionCount = input.findings.length - pooled;
  const prefix = input.dryRun ? "[ops][dry run]" : "[ops]";
  const subject =
    actionCount > 0
      ? `${prefix} ACTION REQUIRED: ${actionCount} untracked Hostinger VM(s) the sweep would not touch`
      : `${prefix} Orphan sweep: ${pooled} untracked paid box(es) pooled for reuse`;

  const textLines = [
    `The daily fleet orphan sweep compared ${input.checkedVms} Hostinger VMs against vps_inventory and found ${input.findings.length} the platform had no row for. An untracked box is one we are paying for that no signup can reuse, because the pool does not know it exists.`,
    input.findings.map(findingLine).join("\n"),
    "POOLED boxes are now adopt-first inventory with auto-renew off: a signup of the matching size can reuse one, and any that goes unadopted lapses at its paid period end. Boxes under a 72h runway floor are never handed to a new tenant.",
    "ACTION REQUIRED boxes were deliberately left alone. A box that was set up, or that a business row still points at, may be serving someone: check it in hPanel before deciding to pool, retire, or reattach it."
  ];
  const text = textLines.join("\n\n");

  const html = buildBrandedEmailHtml({
    // Internal ops inbox, omit the owner-facing platform signature block.
    platformSignature: false,
    siteUrl: input.siteUrl,
    documentTitle: subject,
    heading: "Untracked Hostinger VMs",
    bodyBlocks: textLines.map((t) => ({ kind: "text" as const, text: t })),
    cta: {
      label: "Open hPanel VPS list",
      href: "https://hpanel.hostinger.com/vps"
    },
    recipientEmail: opsNotificationEmail()
  });

  return { subject, text, html };
}
