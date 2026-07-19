import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import type { AppLocale } from "@/i18n/routing";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import {
  CtaBanner,
  FaqAccordion,
  PageHero,
  SectionHeading,
  type FaqItem
} from "@/components/marketing/sections";
import { PlanCards } from "@/components/pricing/PlanCards";
import { TIER_LIMITS } from "@/lib/plans/limits";
import { getPeriodPricing } from "@/lib/plans/tier";
import { concurrentCallsLine, imageGenerationLine, voiceMinutesLine } from "@/lib/plans/usage-copy";
import { CARRIER_REGISTRATION_FEE_CENTS } from "@/lib/plans/carrier-fee";
import { CANADA_MESSAGING_FEE_MONTHLY_CENTS } from "@/lib/plans/canadian-messaging";
import { formatPriceCents, formatPricePerMonth } from "@/lib/pricing";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("marketing.pricing");
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    alternates: { canonical: "/pricing" },
    openGraph: {
      title: t("ogTitle"),
      description: t("ogDescription"),
      url: "/pricing"
    }
  };
}

type ComparisonRow = {
  label: string;
  starter: string;
  standard: string;
  enterprise: string;
};

const CHECK = "✓";
const DASH = "–";

export default async function PricingPage() {
  const t = await getTranslations("marketing.pricing");
  const locale = (await getLocale()) as AppLocale;

  const custom = t("custom");
  const comparisonRows: ComparisonRow[] = [
    {
      label: t("rowVoiceMinutes"),
      starter: voiceMinutesLine("starter", undefined, locale),
      standard: voiceMinutesLine("standard", undefined, locale),
      enterprise: custom
    },
    {
      label: t("rowSmsPerMonth"),
      starter: `${TIER_LIMITS.starter.smsPerMonth}`,
      standard: `${TIER_LIMITS.standard.smsPerMonth}`,
      enterprise: custom
    },
    {
      label: t("rowConcurrentCalls"),
      starter: concurrentCallsLine(TIER_LIMITS.starter.maxConcurrentCalls, locale),
      standard: concurrentCallsLine(TIER_LIMITS.standard.maxConcurrentCalls, locale),
      enterprise: custom
    },
    { label: t("rowAiBudget"), starter: "$5", standard: "$10", enterprise: custom },
    {
      label: t("rowImageGen"),
      starter: imageGenerationLine("starter", undefined, locale),
      standard: imageGenerationLine("standard", undefined, locale),
      enterprise: custom
    },
    { label: t("rowDedicated"), starter: CHECK, standard: CHECK, enterprise: CHECK },
    { label: t("rowBooking"), starter: CHECK, standard: CHECK, enterprise: CHECK },
    { label: t("rowMemory"), starter: CHECK, standard: CHECK, enterprise: CHECK },
    { label: t("rowWidget"), starter: DASH, standard: CHECK, enterprise: CHECK },
    { label: t("rowByon"), starter: DASH, standard: CHECK, enterprise: CHECK },
    { label: t("rowRcs"), starter: DASH, standard: DASH, enterprise: CHECK },
    { label: t("rowZapier"), starter: DASH, standard: CHECK, enterprise: CHECK },
    { label: t("rowTextsDuringCalls"), starter: DASH, standard: CHECK, enterprise: CHECK },
    { label: t("rowScheduledTexts"), starter: DASH, standard: CHECK, enterprise: CHECK },
    { label: t("rowSummaries"), starter: DASH, standard: CHECK, enterprise: CHECK },
    { label: t("rowAnalytics"), starter: DASH, standard: CHECK, enterprise: CHECK },
    { label: t("rowWarmHandoff"), starter: DASH, standard: CHECK, enterprise: CHECK },
    {
      label: t("rowBrowserSkills"),
      starter: t("browserStarter"),
      standard: t("browserStandard"),
      enterprise: t("browserStandard")
    },
    {
      label: t("rowSupport"),
      starter: t("supportStarter"),
      standard: t("supportStandard"),
      enterprise: t("supportEnterprise")
    },
    { label: t("rowWhiteLabel"), starter: DASH, standard: DASH, enterprise: CHECK }
  ];

  // Same env-driven address the footer uses, so the two can't diverge.
  const contactEmail = process.env.CONTACT_EMAIL ?? "team@newcoworker.com";
  const carrierFee = formatPriceCents(CARRIER_REGISTRATION_FEE_CENTS);
  const canadaFeeMonthly = formatPriceCents(CANADA_MESSAGING_FEE_MONTHLY_CENTS);
  const starterRenewal = formatPricePerMonth(getPeriodPricing("starter", "biennial").renewalMonthlyCents);
  const standardRenewal = formatPricePerMonth(getPeriodPricing("standard", "biennial").renewalMonthlyCents);

  const faq: FaqItem[] = [
    { question: t("faqBillingQ"), answer: <>{t("faqBillingA")}</> },
    {
      question: t("faqTermEndQ"),
      answer: <>{t("faqTermEndA", { starterRenewal, standardRenewal })}</>
    },
    {
      question: t("faqCarrierFeeQ", { carrierFee }),
      answer: <>{t("faqCarrierFeeA", { carrierFee })}</>
    },
    { question: t("faqGuaranteeQ"), answer: <>{t("faqGuaranteeA")}</> },
    {
      question: t("faqCanadaFeeQ", { canadaFeeMonthly }),
      answer: <>{t("faqCanadaFeeA", { canadaFeeMonthly })}</>
    },
    { question: t("faqKeepNumberQ"), answer: <>{t("faqKeepNumberA")}</> },
    {
      question: t("faqExtraNumbersQ"),
      answer: (
        <>
          {t.rich("faqExtraNumbersA", {
            contactEmail,
            email: () => (
              <a href={`mailto:${contactEmail}`} className="text-signal-teal hover:underline">
                {contactEmail}
              </a>
            )
          })}
        </>
      )
    },
    { question: t("faqUsageCapsQ"), answer: <>{t("faqUsageCapsA")}</> },
    {
      question: t("faqWhiteGloveQ"),
      answer: (
        <>
          {t.rich("faqWhiteGloveA", {
            b: (chunks) => <b>{chunks}</b>,
            link: (chunks) => (
              <Link href="/contact?topic=white-glove" className="text-signal-teal hover:underline">
                {chunks}
              </Link>
            )
          })}
        </>
      )
    }
  ];

  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
      <MarketingNav />

      <PageHero
        eyebrow={t("heroEyebrow")}
        title={t("heroTitle")}
        subtitle={t("heroSubtitle")}
      />

      <section className="mx-auto max-w-5xl px-6 pb-20">
        <PlanCards />
      </section>

      {/* Comparison table */}
      <section className="mx-auto max-w-5xl px-6 pb-20">
        <SectionHeading title={t("compareTitle")} />
        <div className="mobile-scroll-x rounded-xl border border-parchment/10">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-parchment/10 bg-parchment/[0.03] text-left">
                <th className="px-4 py-3 font-semibold text-parchment/60">{t("tableFeature")}</th>
                <th className="px-4 py-3 font-semibold text-parchment">{t("tierStarter")}</th>
                <th className="px-4 py-3 font-semibold text-signal-teal">{t("tierStandard")}</th>
                <th className="px-4 py-3 font-semibold text-parchment">{t("tierEnterprise")}</th>
              </tr>
            </thead>
            <tbody>
              {comparisonRows.map((row) => (
                <tr key={row.label} className="border-b border-parchment/5 last:border-b-0">
                  <td className="px-4 py-3 text-parchment/70">{row.label}</td>
                  <td className={`px-4 py-3 ${row.starter === DASH ? "text-parchment/30" : "text-parchment/85"}`}>
                    {row.starter}
                  </td>
                  <td className={`px-4 py-3 ${row.standard === DASH ? "text-parchment/30" : "text-parchment/85"}`}>
                    {row.standard}
                  </td>
                  <td className={`px-4 py-3 ${row.enterprise === DASH ? "text-parchment/30" : "text-parchment/85"}`}>
                    {row.enterprise}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Pricing FAQ */}
      <section className="mx-auto max-w-3xl px-6 pb-24">
        <SectionHeading title={t("faqTitle")} />
        <FaqAccordion items={faq} />
      </section>

      <CtaBanner
        title={t("ctaTitle")}
        subtitle={t("ctaSubtitle")}
        ctaLabel={t("ctaLabel")}
        ctaHref="/onboard"
      />

      <MarketingFooter />
    </div>
  );
}
