/**
 * Operator email: admin-initiated hardware migration lifecycle
 * (started / completed / failed).
 *
 * The admin migrate-size endpoint answers 202 and runs the migration
 * unattended in the background, so these emails are the operator's only
 * progress signal — mirroring the change-plan "hardware escalation
 * started" pattern, plus terminal completed/failed phases because there is
 * no customer-facing flow (deletion-request email etc.) wrapping this one.
 */

import { buildBrandedEmailHtml } from "@/lib/email/branded-html";
import { opsNotificationEmail } from "@/lib/email/templates/ops-vps-deletion";

export type OpsHardwareMigrationInput = {
  phase: "started" | "completed" | "failed";
  businessId: string;
  businessName: string;
  /** Admin identity (email/user id) that clicked the button. */
  requestedBy: string;
  fromSize: string;
  toSize: string;
  /** Phase-specific detail: flow summary, follow-ups, or the failure. */
  detail: string;
  /** App origin without trailing slash, for the branded shell. */
  siteUrl: string;
};

export type OpsHardwareMigrationEmail = {
  subject: string;
  text: string;
  html: string;
};

const PHASE_LABEL: Record<OpsHardwareMigrationInput["phase"], string> = {
  started: "started",
  completed: "completed",
  failed: "FAILED"
};

export function buildOpsHardwareMigrationEmail(
  input: OpsHardwareMigrationInput
): OpsHardwareMigrationEmail {
  const subject =
    `[ops] Hardware migration ${PHASE_LABEL[input.phase]} — ` +
    `${input.businessName}: ${input.fromSize} → ${input.toSize}`;

  const textLines = [
    `Admin-initiated hardware migration ${PHASE_LABEL[input.phase]} for ${input.businessName}.`,
    [
      `Business id: ${input.businessId}`,
      `Hardware: ${input.fromSize} → ${input.toSize}`,
      `Requested by: ${input.requestedBy}`
    ].join("\n"),
    input.detail
  ];
  const text = textLines.join("\n\n");

  const html = buildBrandedEmailHtml({
    // Internal ops inbox — omit the owner-facing platform signature block.
    platformSignature: false,
    siteUrl: input.siteUrl,
    documentTitle: subject,
    heading: `Hardware migration ${PHASE_LABEL[input.phase]}`,
    bodyBlocks: textLines.map((t) => ({ kind: "text" as const, text: t })),
    cta: {
      label: "Open admin panel",
      href: `${input.siteUrl}/admin/${input.businessId}`
    },
    recipientEmail: opsNotificationEmail()
  });

  return { subject, text, html };
}
