/**
 * Transactional email: priority support is about to lapse.
 *
 * Sent once by the daily priority-support-nudge sweep, a few business days
 * before `businesses.priority_support_until` passes, for tenants whose
 * coverage is NOT renewing (canceled subscription, or a comped window).
 *
 * Keep this file deterministic and input-pure: no DB reads, no Date.now(),
 * no env lookups. Same contract as contract-term-nudge.ts.
 */

import { buildBrandedEmailHtml } from "@/lib/email/branded-html";
import { formatPriceCents } from "@/lib/pricing";
import { PRIORITY_SUPPORT_MONTHLY_CENTS } from "@/lib/plans/priority-support";
import type { AppLocale } from "@/i18n/routing";
import { defaultLocale } from "@/i18n/routing";
import { emailDate, emailMessagesForLocale, fmtEmail } from "@/lib/i18n/email-copy";

export type PrioritySupportNudgeInput = {
  /** ISO timestamp of businesses.priority_support_until. */
  coverageEndsAt: string;
  /** Whole days from "now" to the end, as the sweep computed it. */
  daysLeft: number;
  recipientEmail: string;
  /** App origin without trailing slash. */
  siteUrl: string;
  timeZone?: string;
  locale?: AppLocale;
};

export type PrioritySupportNudgeEmail = {
  subject: string;
  text: string;
  html: string;
};

export function buildPrioritySupportNudgeEmail(
  input: PrioritySupportNudgeInput
): PrioritySupportNudgeEmail {
  const locale = input.locale ?? defaultLocale;
  const copy = emailMessagesForLocale(locale).prioritySupportNudge;
  const date = emailDate(new Date(input.coverageEndsAt), locale, input.timeZone);
  // Singular/plural without ICU: these catalogs are plain-string templates
  // interpolated by fmtEmail, outside next-intl's pipeline.
  const days =
    input.daysLeft === 1
      ? copy.dayCount
      : fmtEmail(copy.dayCountPlural, { days: String(input.daysLeft) });
  const price = formatPriceCents(PRIORITY_SUPPORT_MONTHLY_CENTS);
  const normalizedSite = input.siteUrl.replace(/\/$/, "");
  const billingUrl = `${normalizedSite}/dashboard/billing`;

  const subject = copy.subject;
  const textLines = [
    copy.line1,
    fmtEmail(copy.line2, { date, days }),
    copy.line3,
    fmtEmail(copy.line4, { price })
  ];
  const signoff = emailMessagesForLocale(locale).ncSignoff;
  const text = [
    ...textLines,
    fmtEmail(copy.openBillingFallback, { billingUrl }),
    signoff
  ].join("\n\n");

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
