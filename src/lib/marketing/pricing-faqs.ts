/**
 * Visible `/pricing` FAQ Q&A, in the order the accordion already renders.
 *
 * Keys are the `marketing.pricing` catalog pairs (`faqBillingQ` /
 * `faqBillingA`, …). `tests/pricing-faq-json-ld.test.ts` pins this list to
 * every `faq…Q` key in en.json and es.json so a new accordion entry without
 * schema (or schema without a visible FAQ) fails CI. Do not add copy here.
 */

import { stripFaqRichMarkup, type FaqJsonLdItem } from "./faq-json-ld";

export const PRICING_FAQ_KEYS = [
  { q: "faqBillingQ", a: "faqBillingA" },
  { q: "faqTermEndQ", a: "faqTermEndA" },
  { q: "faqCarrierFeeQ", a: "faqCarrierFeeA" },
  { q: "faqGuaranteeQ", a: "faqGuaranteeA" },
  { q: "faqCanadaFeeQ", a: "faqCanadaFeeA" },
  { q: "faqMexicoFeeQ", a: "faqMexicoFeeA" },
  { q: "faqKeepNumberQ", a: "faqKeepNumberA" },
  { q: "faqExtraNumbersQ", a: "faqExtraNumbersA" },
  { q: "faqUsageCapsQ", a: "faqUsageCapsA" },
  { q: "faqPrioritySupportQ", a: "faqPrioritySupportA" },
  { q: "faqWhiteGloveQ", a: "faqWhiteGloveA" }
] as const;

export type PricingFaqKey =
  (typeof PRICING_FAQ_KEYS)[number]["q"] | (typeof PRICING_FAQ_KEYS)[number]["a"];

/** Interpolations the existing pricing FAQ strings already accept. */
export type PricingFaqVars = {
  carrierFee: string;
  canadaFeeMonthly: string;
  mexicoFeeMonthly: string;
  prioritySupportPrice: string;
  starterRenewal: string;
  standardRenewal: string;
  mexicoSmsCap: string | number;
  contactEmail: string;
};

export type PricingFaqTranslate = (
  key: PricingFaqKey,
  values: PricingFaqVars
) => string;

export function pricingFaqEntries(
  t: PricingFaqTranslate,
  values: PricingFaqVars
): FaqJsonLdItem[] {
  return PRICING_FAQ_KEYS.map(({ q, a }) => ({
    question: t(q, values),
    plainAnswer: stripFaqRichMarkup(t(a, values))
  }));
}
