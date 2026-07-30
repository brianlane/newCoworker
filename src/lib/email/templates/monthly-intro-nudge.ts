/**
 * Transactional email: month-to-month first-month intro nudge (Shape B).
 *
 * Sent once by the daily monthly-intro-nudge sweep, 5 business days before
 * the first renewal, so the owner has clear notice that the intro rate ends
 * and can review 12/24-month contract options on Billing.
 *
 * Keep this file deterministic and input-pure: no DB reads, no Date.now(),
 * no env lookups.
 */

import { buildBrandedEmailHtml } from "@/lib/email/branded-html";
import type { PlanTier } from "@/lib/plans/tier";
import { getCommitmentMonths, getPeriodPricing } from "@/lib/plans/tier";
import { formatPriceCents } from "@/lib/pricing";
import type { AppLocale } from "@/i18n/routing";
import { defaultLocale } from "@/i18n/routing";
import { emailDate, emailMessagesForLocale, fmtEmail } from "@/lib/i18n/email-copy";

export type MonthlyIntroNudgeInput = {
  tier: Exclude<PlanTier, "enterprise">;
  /** ISO timestamp of stripe_current_period_end (first cycle). */
  periodEndAt: string;
  recipientEmail: string;
  /** App origin without trailing slash. */
  siteUrl: string;
  timeZone?: string;
  locale?: AppLocale;
};

export type MonthlyIntroNudgeEmail = {
  subject: string;
  text: string;
  html: string;
};

/** "$195/mo" style: omit .00 when whole dollars (matches marketing copy). */
export function ratePerMonthDisplay(cents: number): string {
  return `${formatPriceCents(cents)}/mo`;
}

export function monthlyIntroNudgeAmounts(tier: Exclude<PlanTier, "enterprise">): {
  introRate: string;
  renewalRate: string;
  biennialRate: string;
  biennialTotal: string;
  annualRate: string;
  annualTotal: string;
} {
  const monthly = getPeriodPricing(tier, "monthly");
  const biennial = getPeriodPricing(tier, "biennial");
  const annual = getPeriodPricing(tier, "annual");
  return {
    introRate: ratePerMonthDisplay(monthly.monthlyCents),
    renewalRate: ratePerMonthDisplay(monthly.renewalMonthlyCents),
    biennialRate: ratePerMonthDisplay(biennial.monthlyCents),
    biennialTotal: formatPriceCents(biennial.monthlyCents * getCommitmentMonths("biennial")),
    annualRate: ratePerMonthDisplay(annual.monthlyCents),
    annualTotal: formatPriceCents(annual.monthlyCents * getCommitmentMonths("annual"))
  };
}

export function buildMonthlyIntroNudgeEmail(input: MonthlyIntroNudgeInput): MonthlyIntroNudgeEmail {
  const locale = input.locale ?? defaultLocale;
  const copy = emailMessagesForLocale(locale).monthlyIntroNudge;
  const amounts = monthlyIntroNudgeAmounts(input.tier);
  const date = emailDate(new Date(input.periodEndAt), locale, input.timeZone);
  const normalizedSite = input.siteUrl.replace(/\/$/, "");
  const billingUrl = `${normalizedSite}/dashboard/billing`;

  const subject = copy.subject;
  const textLines = [
    copy.line1,
    fmtEmail(copy.line2, {
      introRate: amounts.introRate,
      date,
      renewalRate: amounts.renewalRate
    }),
    copy.line3,
    fmtEmail(copy.biennialLine, {
      biennialRate: amounts.biennialRate,
      biennialTotal: amounts.biennialTotal
    }),
    fmtEmail(copy.annualLine, {
      annualRate: amounts.annualRate,
      annualTotal: amounts.annualTotal
    }),
    copy.line4
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
