/**
 * Transactional email: pre-term contract rollover nudge (Shape B).
 *
 * Sent once by the daily contract-term-nudge sweep, 5 business days before
 * term end, for annual/biennial owners with contract auto-renew OFF.
 *
 * Keep this file deterministic and input-pure: no DB reads, no Date.now(),
 * no env lookups.
 */

import { buildBrandedEmailHtml } from "@/lib/email/branded-html";
import type { BillingPeriod, PlanTier } from "@/lib/plans/tier";
import { getCommitmentMonths, getPeriodPricing } from "@/lib/plans/tier";
import { formatPriceCents } from "@/lib/pricing";
import type { AppLocale } from "@/i18n/routing";
import { defaultLocale } from "@/i18n/routing";
import { emailDate, emailMessagesForLocale, fmtEmail } from "@/lib/i18n/email-copy";
import { ratePerMonthDisplay } from "@/lib/email/templates/monthly-intro-nudge";

export type ContractTermNudgeInput = {
  tier: Exclude<PlanTier, "enterprise">;
  billingPeriod: Exclude<BillingPeriod, "monthly">;
  /** ISO timestamp of stripe_current_period_end (term end). */
  periodEndAt: string;
  recipientEmail: string;
  /** App origin without trailing slash. */
  siteUrl: string;
  timeZone?: string;
  locale?: AppLocale;
};

export type ContractTermNudgeEmail = {
  subject: string;
  text: string;
  html: string;
};

export function contractTermNudgeAmounts(
  tier: Exclude<PlanTier, "enterprise">,
  billingPeriod: Exclude<BillingPeriod, "monthly">
): {
  term: string;
  contractRate: string;
  contractTotal: string;
  renewalRate: string;
} {
  const termPricing = getPeriodPricing(tier, billingPeriod);
  const months = getCommitmentMonths(billingPeriod);
  return {
    term: billingPeriod === "biennial" ? "24-month" : "12-month",
    contractRate: ratePerMonthDisplay(termPricing.monthlyCents),
    contractTotal: formatPriceCents(termPricing.monthlyCents * months),
    // The TERM's renewal price, not the monthly plan's. contract_auto_renew
    // = false means "roll to month-to-month at the renewal price" and
    // /api/billing/auto-renew OFF re-creates the commitment schedule whose
    // phase 2 is resolveRenewalPriceId(tier, billingPeriod). Reading
    // getPeriodPricing(tier, "monthly") instead had the email quoting
    // $279/mo to a biennial Standard tenant whose billing page, and whose
    // Stripe schedule, both said $189/mo.
    //
    // #1021's monthly nudge legitimately uses the monthly plan's renewal
    // rate, because a monthly plan really does roll to its own ongoing
    // price. Reusing that shape here is what broke it.
    renewalRate: ratePerMonthDisplay(termPricing.renewalMonthlyCents)
  };
}

export function buildContractTermNudgeEmail(input: ContractTermNudgeInput): ContractTermNudgeEmail {
  const locale = input.locale ?? defaultLocale;
  const copy = emailMessagesForLocale(locale).contractTermNudge;
  const amounts = contractTermNudgeAmounts(input.tier, input.billingPeriod);
  // Spanish uses the localized term label from the catalog.
  const term =
    locale === "es"
      ? input.billingPeriod === "biennial"
        ? copy.termBiennial
        : copy.termAnnual
      : amounts.term;
  const date = emailDate(new Date(input.periodEndAt), locale, input.timeZone);
  const normalizedSite = input.siteUrl.replace(/\/$/, "");
  const billingUrl = `${normalizedSite}/dashboard/billing`;

  const subject = copy.subject;
  const textLines = [
    copy.line1,
    fmtEmail(copy.line2, {
      term,
      contractRate: amounts.contractRate,
      date,
      renewalRate: amounts.renewalRate
    }),
    fmtEmail(copy.line3, {
      term,
      contractRate: amounts.contractRate,
      contractTotal: amounts.contractTotal
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
