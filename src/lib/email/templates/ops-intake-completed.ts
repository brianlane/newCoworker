/**
 * Operator email: a prospect completed a white-glove intake questionnaire.
 *
 * The prospect submits on the public /intake/<token> page, and nothing else
 * pings the team, so without this alert a finished questionnaire sits until
 * someone happens to open the admin panel. The build should start while the
 * prospect is still warm.
 */

import { buildBrandedEmailHtml } from "@/lib/email/branded-html";
import { opsNotificationEmail } from "@/lib/email/templates/ops-vps-deletion";
import { INDUSTRY_OPTIONS } from "@/lib/white-glove/template";

export type OpsIntakeCompletedInput = {
  intakeId: string;
  businessName: string;
  /** INDUSTRY_OPTIONS value; unknown values render as-is. */
  industry: string;
  /** Null when the admin shared the link by hand instead of emailing it. */
  recipientEmail: string | null;
  /** ISO timestamp of the submission. */
  completedAt: string;
  /** App origin without trailing slash, for the branded shell. */
  siteUrl: string;
};

export type OpsIntakeCompletedEmail = {
  subject: string;
  text: string;
  html: string;
};

/**
 * "2026-08-21 19:56 UTC" from an ISO stamp. Rendered server-side, so a
 * locale-dependent format would silently follow whatever timezone the
 * serverless region runs in; explicit UTC is unambiguous everywhere. An
 * unparseable stamp renders as-is rather than as "Invalid Date".
 */
export function formatIntakeCompletedAtUtc(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function buildOpsIntakeCompletedEmail(
  input: OpsIntakeCompletedInput
): OpsIntakeCompletedEmail {
  const name =
    input.businessName.trim() || input.recipientEmail?.trim() || input.intakeId;
  const industryLabel =
    INDUSTRY_OPTIONS.find((o) => o.value === input.industry)?.label ?? input.industry;
  const docUrl = `${input.siteUrl}/admin/intake-doc/${input.intakeId}`;

  const subject = `[ops] White-glove questionnaire completed, ${name}`;
  const textLines = [
    `${name} finished the white-glove setup questionnaire; their answers filled out the build document.`,
    [
      `Business: ${input.businessName.trim() || "(unnamed)"}`,
      `Industry: ${industryLabel}`,
      `Prospect email: ${input.recipientEmail?.trim() || "(link was shared by hand)"}`,
      `Completed: ${formatIntakeCompletedAtUtc(input.completedAt)}`
    ].join("\n"),
    `Build document: ${docUrl}`
  ];
  const text = textLines.join("\n\n");

  const html = buildBrandedEmailHtml({
    // Internal ops inbox, omit the owner-facing platform signature block.
    platformSignature: false,
    siteUrl: input.siteUrl,
    documentTitle: subject,
    heading: "White-glove questionnaire completed",
    bodyBlocks: textLines.map((t) => ({ kind: "text" as const, text: t })),
    cta: {
      label: "View build document",
      href: docUrl
    },
    recipientEmail: opsNotificationEmail()
  });

  return { subject, text, html };
}
