/**
 * Operator email: a signup deploy reported failure and nobody else will say
 * so. The owner's "you're live" email/SMS is deliberately suppressed on a
 * failed deploy, the ops new-signup alert is gated on deploySucceeded, a
 * signup job is marked succeeded on a normal orchestrate return (so the
 * watchdog never retries it), and the stuck scan excludes error-status
 * progress rows from its band check. This alert is therefore the one place
 * a human learns the tenant is flagged online with a broken stack.
 */

import { buildBrandedEmailHtml } from "@/lib/email/branded-html";
import { opsNotificationEmail } from "@/lib/email/templates/ops-vps-deletion";

export type OpsDeployFailedInput = {
  businessId: string;
  businessName: string;
  virtualMachineId: string;
  /** Which failure site fired: deploy_failed (script) or deploy_exception (SSH/poll). */
  phase: string;
  /** The failure text the deploy client or exception produced. */
  reason: string;
  /** App origin without trailing slash, for the branded shell. */
  siteUrl: string;
};

export type OpsDeployFailedEmail = {
  subject: string;
  text: string;
  html: string;
};

export function buildOpsDeployFailedEmail(input: OpsDeployFailedInput): OpsDeployFailedEmail {
  const name = input.businessName.trim() || input.businessId;
  const subject = `[ops] Signup deploy FAILED, ${name} (vm ${input.virtualMachineId})`;

  const textLines = [
    `The signup deploy for ${name} reported failure. The tenant's business row is flagged online but the stack did not come up.`,
    [
      `Business id: ${input.businessId}`,
      `VPS: srv${input.virtualMachineId}.hstgr.cloud`,
      `Failure site: ${input.phase}`,
      `Reason: ${input.reason}`
    ].join("\n"),
    `The owner was NOT notified (no "you're live" email or SMS goes out on a failed deploy). Nothing retries this automatically: reprovision from the admin panel.`
  ];
  const text = textLines.join("\n\n");

  const html = buildBrandedEmailHtml({
    // Internal ops inbox, omit the owner-facing platform signature block.
    platformSignature: false,
    siteUrl: input.siteUrl,
    documentTitle: subject,
    heading: "Signup deploy failed",
    bodyBlocks: textLines.map((t) => ({ kind: "text" as const, text: t })),
    cta: {
      label: "Open admin panel",
      href: `${input.siteUrl}/admin/${input.businessId}`
    },
    recipientEmail: opsNotificationEmail()
  });

  return { subject, text, html };
}
