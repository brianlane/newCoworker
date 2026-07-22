/**
 * Transactional email: the white-glove intake questionnaire invitation.
 *
 * Sent by the admin "Send questionnaire" action
 * (POST /api/admin/white-glove-intakes) to a prospective white-glove client.
 * Carries the durable public /intake/<token> link where the prospect answers
 * a short, mostly multiple-choice questionnaire (no account needed); their
 * answers become the build document our team installs from.
 */

import { buildBrandedEmailHtml } from "@/lib/email/branded-html";
import type { AppLocale } from "@/i18n/routing";
import { defaultLocale } from "@/i18n/routing";
import { emailMessagesForLocale, fmtEmail } from "@/lib/i18n/email-copy";

export type WhiteGloveIntakeEmailInput = {
  /** The durable public questionnaire link (/intake/<token>). */
  intakeUrl: string;
  recipientEmail: string;
  /** App origin without trailing slash (e.g. https://www.newcoworker.com). */
  siteUrl: string;
  /** Recipient's UI locale; defaults to English. */
  locale?: AppLocale;
};

export type WhiteGloveIntakeEmail = {
  subject: string;
  text: string;
  html: string;
};

export function buildWhiteGloveIntakeEmail(
  input: WhiteGloveIntakeEmailInput
): WhiteGloveIntakeEmail {
  const copy = emailMessagesForLocale(input.locale ?? defaultLocale);
  const c = copy.whiteGloveIntake;
  const subject = c.subject;
  const textLines = [
    c.line1,
    c.line2,
    fmtEmail(c.fillOut, { intakeUrl: input.intakeUrl }),
    c.line4,
    copy.questionsReply
  ];
  // Signoff rides only the plain-text body — the HTML shell renders the full
  // platform signature block, so repeating it there would double the contact info.
  const text = [...textLines, copy.ncSignoff].join("\n\n");
  const normalizedSite = input.siteUrl.replace(/\/$/, "");
  const html = buildBrandedEmailHtml({
    siteUrl: normalizedSite,
    documentTitle: subject,
    heading: subject,
    bodyBlocks: textLines.map((t) => ({ kind: "text" as const, text: t })),
    cta: { label: c.cta, href: input.intakeUrl },
    recipientEmail: input.recipientEmail
  });

  return { subject, text, html };
}
