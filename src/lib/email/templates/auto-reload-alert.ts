/**
 * Transactional emails for auto-reload states a tenant cannot discover on
 * their own.
 *
 * Auto-reload runs unattended, so silence is the default experience. Three
 * states genuinely need a nudge: the rule was switched off after repeated
 * declines, the bank wants the cardholder present, and the monthly budget
 * ceiling was reached. Everything else (a successful top-up, a soft decline
 * that will retry) is visible in the billing page ledger and does not warrant
 * an interruption.
 *
 * Deterministic and input-pure: no DB reads, no Date.now(), no env lookups.
 */

import { buildBrandedEmailHtml } from "@/lib/email/branded-html";
import type { AppLocale } from "@/i18n/routing";
import { defaultLocale } from "@/i18n/routing";
import { emailMessagesForLocale, fmtEmail } from "@/lib/i18n/email-copy";

export type AutoReloadAlertKind = "disabled" | "paused_authentication" | "monthly_limit";

export type AutoReloadAlertInput = {
  kind: AutoReloadAlertKind;
  category: "voice" | "sms" | "chat";
  businessName: string;
  recipientEmail: string;
  /** App origin without a trailing slash. */
  siteUrl: string;
  /** Consecutive declines, for the disabled email. */
  attempts?: number;
  locale?: AppLocale;
};

export type AutoReloadAlertEmail = {
  subject: string;
  text: string;
  html: string;
};

export function buildAutoReloadAlertEmail(input: AutoReloadAlertInput): AutoReloadAlertEmail {
  const locale = input.locale ?? defaultLocale;
  const messages = emailMessagesForLocale(locale);
  const copy = messages.autoReload;
  const normalizedSite = input.siteUrl.replace(/\/$/, "");
  const billingUrl = `${normalizedSite}/dashboard/billing`;

  const familyName =
    input.category === "voice"
      ? copy.familyVoice
      : input.category === "sms"
        ? copy.familySms
        : copy.familyChat;

  let subject: string;
  let textLines: string[];

  if (input.kind === "disabled") {
    subject = fmtEmail(copy.disabledSubject, { business: input.businessName });
    textLines = [
      copy.disabledLine1,
      fmtEmail(copy.disabledLine2, {
        attempts: String(input.attempts ?? 3),
        familyName
      }),
      copy.disabledLine3
    ];
  } else if (input.kind === "paused_authentication") {
    subject = fmtEmail(copy.pausedSubject, { business: input.businessName });
    textLines = [copy.pausedLine1, fmtEmail(copy.pausedLine2, { familyName })];
  } else {
    subject = fmtEmail(copy.limitSubject, { business: input.businessName });
    textLines = [copy.limitLine1, fmtEmail(copy.limitLine2, { familyName })];
  }

  const text = [...textLines, billingUrl, messages.ncSignoff].join("\n\n");

  const html = buildBrandedEmailHtml({
    siteUrl: normalizedSite,
    documentTitle: subject,
    heading: subject,
    bodyBlocks: textLines.map((t) => ({ kind: "text" as const, text: t })),
    cta: { label: copy.cta, href: billingUrl },
    includeFallbackLink: true,
    recipientEmail: input.recipientEmail
  });

  return { subject, text, html };
}
