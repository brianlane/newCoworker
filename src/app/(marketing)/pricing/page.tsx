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
import { esAlternates } from "@/lib/i18n/es-routes";
import { getPeriodPricing } from "@/lib/plans/tier";
import { buildComparisonGroups, type ComparisonCell } from "@/lib/plans/comparison";
import { CARRIER_REGISTRATION_FEE_CENTS } from "@/lib/plans/carrier-fee";
import { PRIORITY_SUPPORT_MONTHLY_CENTS } from "@/lib/plans/priority-support";
import { CANADA_MESSAGING_FEE_MONTHLY_CENTS } from "@/lib/plans/canadian-messaging";
import { MEXICO_MESSAGING_FEE_MONTHLY_CENTS } from "@/lib/plans/mexican-messaging";
import { SMS_MONTHLY_CAP_MX } from "../../../../supabase/functions/_shared/sms_monthly_limits";
import { formatPriceCents, formatPricePerMonth } from "@/lib/pricing";
import { contactEmail as resolveContactEmail } from "@/lib/marketing/contact-email";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("marketing.pricing");
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    alternates: esAlternates("/pricing"),
    openGraph: {
      title: t("ogTitle"),
      description: t("ogDescription"),
      url: "/pricing"
    }
  };
}

const CHECK = "✓";
const DASH = "–";

export default async function PricingPage() {
  const t = await getTranslations("marketing.pricing");
  const locale = (await getLocale()) as AppLocale;

  const comparisonGroups = buildComparisonGroups(locale);

  /** Resolves one table cell to the string it renders as. */
  const cellText = (cell: ComparisonCell): string => {
    switch (cell.kind) {
      case "check":
        return CHECK;
      case "dash":
        return DASH;
      case "custom":
        return t("custom");
      case "text":
        return cell.value;
      case "key":
        return t(cell.key);
    }
  };

  // Same env-driven address the footer uses, so the two can't diverge.
  const contactEmail = resolveContactEmail();
  const carrierFee = formatPriceCents(CARRIER_REGISTRATION_FEE_CENTS);
  const canadaFeeMonthly = formatPriceCents(CANADA_MESSAGING_FEE_MONTHLY_CENTS);
  const prioritySupportPrice = formatPriceCents(PRIORITY_SUPPORT_MONTHLY_CENTS);
  const mexicoFeeMonthly = formatPriceCents(MEXICO_MESSAGING_FEE_MONTHLY_CENTS);
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
    {
      question: t("faqMexicoFeeQ", { mexicoFeeMonthly }),
      answer: <>{t("faqMexicoFeeA", { mexicoFeeMonthly, mexicoSmsCap: SMS_MONTHLY_CAP_MX })}</>
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
      question: t("faqPrioritySupportQ"),
      answer: <>{t("faqPrioritySupportA", { prioritySupportPrice })}</>
    },
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
        <PlanCards compareHref="#compare" />
      </section>

      {/* Comparison table. The complete feature record, deliberately always
          open: the plan cards show only a differentiating handful each, which
          is only honest while the full list is on the page and not behind a
          click. `tests/pricing-comparison.test.ts` proves every card bullet
          has a row here. */}
      <section id="compare" className="mx-auto max-w-5xl px-6 pb-20 scroll-mt-8">
        <SectionHeading title={t("compareTitle")} subtitle={t("compareSubtitle")} />
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
            {comparisonGroups.map((group) => (
              <tbody key={group.headingKey}>
                <tr className="border-b border-parchment/10 bg-parchment/[0.05]">
                  <th
                    colSpan={4}
                    scope="colgroup"
                    className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.18em] text-signal-teal"
                  >
                    {t(group.headingKey)}
                  </th>
                </tr>
                {group.rows.map((row) => {
                  const cells = [row.starter, row.standard, row.enterprise];
                  return (
                    <tr key={row.labelKey} className="border-b border-parchment/5">
                      <td className="px-4 py-3 text-parchment/70">{t(row.labelKey)}</td>
                      {cells.map((cell, index) => (
                        <td
                          key={index}
                          className={`px-4 py-3 ${cell.kind === "dash" ? "text-parchment/30" : "text-parchment/85"}`}
                        >
                          {cellText(cell)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            ))}
          </table>
        </div>
      </section>

      {/* Add-ons: purchasable extras that are not tier features, so they get
          cards rather than fake per-tier table rows. */}
      <section className="mx-auto max-w-5xl px-6 pb-20">
        <SectionHeading title={t("addOnsTitle")} subtitle={t("addOnsSubtitle")} />
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-parchment/10 bg-parchment/[0.02] p-6">
            <h3 className="text-base font-semibold text-parchment">{t("addOnPriorityTitle")}</h3>
            <p className="mt-2 text-sm leading-relaxed text-parchment/70">
              {t("addOnPriorityBody", { prioritySupportPrice })}
            </p>
          </div>
          <div className="rounded-xl border border-parchment/10 bg-parchment/[0.02] p-6">
            <h3 className="text-base font-semibold text-parchment">{t("addOnPacksTitle")}</h3>
            <p className="mt-2 text-sm leading-relaxed text-parchment/70">
              {t("addOnPacksBody")}
            </p>
          </div>
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
