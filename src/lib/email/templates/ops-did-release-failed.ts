/**
 * Operator email: releasing a tenant DID at Telnyx FAILED during terminal
 * teardown, and there is no automated retry behind it.
 *
 * Terminal teardown stamps the business `wiped`, which removes it from the
 * grace-sweep's queries, so a swallowed release failure would otherwise be
 * invisible while Telnyx keeps billing ~$1.10/mo for the number forever
 * (Bugbot on PR #363: "Wipe stamp blocks DID retry"). This email turns that
 * silent leak into a one-click manual action: release the number in the
 * Telnyx portal.
 */

import { buildBrandedEmailHtml } from "@/lib/email/branded-html";
import { opsNotificationEmail } from "@/lib/email/templates/ops-vps-deletion";

export type OpsDidReleaseFailedInput = {
  businessId: string;
  /** The DID that is still active at Telnyx, e.g. "+16023131823". */
  e164: string;
  /** Why the release didn't happen (error message or "TELNYX_API_KEY missing"). */
  reason: string;
  /** App origin without trailing slash, for the branded shell. */
  siteUrl: string;
};

export type OpsDidReleaseFailedEmail = {
  subject: string;
  text: string;
  html: string;
};

export function buildOpsDidReleaseFailedEmail(
  input: OpsDidReleaseFailedInput
): OpsDidReleaseFailedEmail {
  const subject = `[ops] ACTION REQUIRED: release DID ${input.e164} manually, automated release failed`;
  const textLines = [
    `A terminal account teardown could not release its Telnyx phone number. The business is being wiped, so NOTHING will retry this automatically, until someone releases the number in the Telnyx portal it keeps renting (~$1.10/mo).`,
    [
      `Number: ${input.e164}`,
      `Business id: ${input.businessId}`,
      `Failure: ${input.reason}`
    ].join("\n"),
    `Manual fix: Telnyx portal → Numbers → My Numbers → search ${input.e164} → Release. If the number is already gone there, no action is needed.`
  ];
  const text = textLines.join("\n\n");

  const html = buildBrandedEmailHtml({
    // Internal ops inbox, omit the owner-facing platform signature block.
    platformSignature: false,
    siteUrl: input.siteUrl,
    documentTitle: subject,
    heading: "DID release failed, manual action required",
    bodyBlocks: textLines.map((t) => ({ kind: "text" as const, text: t })),
    cta: {
      label: "Open Telnyx portal",
      href: "https://portal.telnyx.com/#/numbers/my-numbers"
    },
    recipientEmail: opsNotificationEmail()
  });

  return { subject, text, html };
}
