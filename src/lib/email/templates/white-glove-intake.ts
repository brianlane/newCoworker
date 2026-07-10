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

export type WhiteGloveIntakeEmailInput = {
  /** The durable public questionnaire link (/intake/<token>). */
  intakeUrl: string;
  recipientEmail: string;
  /** App origin without trailing slash (e.g. https://www.newcoworker.com). */
  siteUrl: string;
};

export type WhiteGloveIntakeEmail = {
  subject: string;
  text: string;
  html: string;
};

export function buildWhiteGloveIntakeEmail(
  input: WhiteGloveIntakeEmailInput
): WhiteGloveIntakeEmail {
  const subject = "Your NewCoworker white-glove setup questionnaire";
  const textLines = [
    "We're getting your white-glove build ready. To set everything up exactly the way you want it, we have a short questionnaire for you — mostly multiple choice, about 5 minutes.",
    "It covers how your AI assistant should greet new leads, when it follows up, how appointments get booked, and which topics should always go straight to your team.",
    `Fill it out here: ${input.intakeUrl}`,
    "Your answers become the build plan our team installs from, so the more accurate they are, the better your assistant will fit your business from day one.",
    "Questions? Just reply to this email.",
    "— The NewCoworker Team"
  ];
  const text = textLines.join("\n\n");
  const normalizedSite = input.siteUrl.replace(/\/$/, "");
  const html = buildBrandedEmailHtml({
    siteUrl: normalizedSite,
    documentTitle: subject,
    heading: subject,
    bodyBlocks: textLines.map((t) => ({ kind: "text" as const, text: t })),
    cta: { label: "Start the questionnaire", href: input.intakeUrl },
    recipientEmail: input.recipientEmail
  });

  return { subject, text, html };
}
