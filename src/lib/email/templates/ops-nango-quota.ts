/**
 * Operator email: the platform Nango account is nearing its connection
 * limit. Fired (deduped, 24h) when a new tenant workspace connection
 * completes with account-wide usage at or past the alert threshold.
 */

import { buildBrandedEmailHtml } from "@/lib/email/branded-html";
import { opsNotificationEmail } from "@/lib/email/templates/ops-vps-deletion";

export type OpsNangoQuotaInput = {
  used: number;
  limit: number;
  /** App origin without trailing slash, for the branded shell. */
  siteUrl: string;
};

export type OpsNangoQuotaEmail = {
  subject: string;
  text: string;
  html: string;
};

export function buildOpsNangoQuotaEmail(input: OpsNangoQuotaInput): OpsNangoQuotaEmail {
  const subject = `[ops] Nango connections at ${input.used}/${input.limit}`;
  const textLines = [
    `The platform Nango account is using ${input.used} of ${input.limit} connections.`,
    [
      "At the limit, every tenant's next workspace connect (Gmail / Outlook / calendar) fails.",
      "Options: upgrade the Nango plan, or reclaim orphaned connections with debug/nango-audit.ts.",
      "Live count: /admin/system → Nango connections card."
    ].join("\n")
  ];
  const text = textLines.join("\n\n");

  const html = buildBrandedEmailHtml({
    siteUrl: input.siteUrl,
    documentTitle: subject,
    heading: "Nango account nearing its connection limit",
    bodyBlocks: textLines.map((t) => ({ kind: "text" as const, text: t })),
    cta: {
      label: "Open system page",
      href: `${input.siteUrl}/admin/system`
    },
    recipientEmail: opsNotificationEmail()
  });

  return { subject, text, html };
}
