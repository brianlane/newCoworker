/**
 * Operator email: a same-tier contract-period switch finished, reporting
 * what happened to the tenant's Hostinger billing term.
 *
 * Hostinger term SKUs are ~40-65% cheaper per month than monthly renewal,
 * and the public API cannot change an existing subscription's billing cycle
 * so when a customer commits to a longer contract the change-plan
 * orchestrator migrates them onto a freshly term-bought box automatically.
 * This email is the operator's confirmation (or the flag that the
 * automation had to leave the box alone and hPanel needs a manual look).
 */

import { buildBrandedEmailHtml } from "@/lib/email/branded-html";
import { opsNotificationEmail } from "@/lib/email/templates/ops-vps-deletion";

export type OpsTermAlignmentInput = {
  businessId: string;
  ownerName: string | null;
  ownerEmail: string;
  tier: string;
  oldBillingPeriod: string | null;
  newBillingPeriod: string;
  /**
   * aligned:      box migrated onto a term-priced purchase.
   * not_needed:   box's Hostinger cycle already covers the target term
   *                (or the new contract is month-to-month).
   * skipped:      a longer term was wanted but the automation couldn't
   *                verify/act; `detail` says why and hPanel needs a look.
   */
  outcome: "aligned" | "not_needed" | "skipped";
  /** Months per Hostinger billing cycle before the switch; null = unknown. */
  currentCycleMonths: number | null;
  /** Hostinger term (months) the new contract maps to. */
  targetTermMonths: number;
  /** Old / new Hostinger VM ids; newVirtualMachineId set only when aligned. */
  oldVirtualMachineId: number | null;
  newVirtualMachineId: string | null;
  /** One-line human explanation of the outcome. */
  detail: string;
  /** App origin without trailing slash, for the branded shell. */
  siteUrl: string;
};

export type OpsTermAlignmentEmail = {
  subject: string;
  text: string;
  html: string;
};

const OUTCOME_LABEL: Record<OpsTermAlignmentInput["outcome"], string> = {
  aligned: "Hostinger term aligned",
  not_needed: "no Hostinger change needed",
  skipped: "MANUAL CHECK NEEDED"
};

export function buildOpsTermAlignmentEmail(
  input: OpsTermAlignmentInput
): OpsTermAlignmentEmail {
  const who = input.ownerName?.trim() ? input.ownerName.trim() : input.ownerEmail;
  const subject = `[ops] Contract switch, ${who}: ${input.oldBillingPeriod ?? "unknown"} → ${input.newBillingPeriod} (${OUTCOME_LABEL[input.outcome]})`;

  const cycleLine =
    `Hostinger cycle: ${input.currentCycleMonths !== null ? `${input.currentCycleMonths}mo` : "unknown"}` +
    ` → target ${input.targetTermMonths}mo`;
  const boxLine =
    input.outcome === "aligned"
      ? `Box: srv${input.oldVirtualMachineId ?? "?"} → srv${input.newVirtualMachineId ?? "?"} (old box pooled, auto-renew off)`
      : `Box: srv${input.oldVirtualMachineId ?? "?"} (unchanged)`;

  const textLines = [
    `${who} switched their contract period (${input.tier} tier unchanged). ${input.detail}`,
    [
      `Owner email: ${input.ownerEmail}`,
      `Business id: ${input.businessId}`,
      `Contract: ${input.oldBillingPeriod ?? "unknown"} → ${input.newBillingPeriod}`,
      cycleLine,
      boxLine
    ].join("\n")
  ];
  if (input.outcome === "skipped") {
    textLines.push(
      "Action needed: verify the box's billing cycle in hPanel (Billing → Subscriptions) and change the renewal period to match the new contract if it is still monthly."
    );
  }
  const text = textLines.join("\n\n");

  const html = buildBrandedEmailHtml({
    // Internal ops inbox, omit the owner-facing platform signature block.
    platformSignature: false,
    siteUrl: input.siteUrl,
    documentTitle: subject,
    heading: OUTCOME_LABEL[input.outcome],
    bodyBlocks: textLines.map((t) => ({ kind: "text" as const, text: t })),
    cta: {
      label: "Open admin panel",
      href: `${input.siteUrl}/admin/${input.businessId}`
    },
    recipientEmail: opsNotificationEmail()
  });

  return { subject, text, html };
}
