import type { Metadata } from "next";
import type { ReactNode } from "react";
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
import { TIER_LIMITS } from "@/lib/plans/limits";
import { concurrentCallsLine, voiceMinutesLine } from "@/lib/plans/usage-copy";
import { getPeriodPricing } from "@/lib/plans/tier";
import { CARRIER_REGISTRATION_FEE_CENTS } from "@/lib/plans/carrier-fee";
import { formatPriceCents, formatPricePerMonth } from "@/lib/pricing";
import { JsonLd } from "@/components/marketing/JsonLd";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("marketing.faqPage");
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    alternates: { canonical: "/faq" },
    openGraph: {
      title: t("ogTitle"),
      description: t("ogDescription"),
      url: "/faq"
    }
  };
}

type FaqSection = {
  title: string;
  items: (FaqItem & { plainAnswer: string })[];
};

export default async function FaqPage() {
  const t = await getTranslations("marketing.faqPage");
  const locale = (await getLocale()) as AppLocale;

  const starterPrice = formatPricePerMonth(getPeriodPricing("starter", "biennial").monthlyCents);
  const carrierFee = formatPriceCents(CARRIER_REGISTRATION_FEE_CENTS);
  // e.g. "250 voice minutes" / "up to 10 concurrent calls" — same helpers as /pricing.
  const standardVoice = voiceMinutesLine("standard", undefined, locale);
  const standardConcurrent = concurrentCallsLine(
    TIER_LIMITS.standard.maxConcurrentCalls,
    locale
  ).toLowerCase();
  // Stringified so ICU doesn't re-format the count with digit grouping.
  const standardSms = String(TIER_LIMITS.standard.smsPerMonth);

  const pricingLink = (chunks: ReactNode) => (
    <Link href="/pricing" className="text-signal-teal hover:underline">
      {chunks}
    </Link>
  );
  const bold = (chunks: ReactNode) => <b>{chunks}</b>;

  const sections: FaqSection[] = [
    {
      title: t("productTitle"),
      items: [
        { question: t("whatIsQ"), plainAnswer: t("whatIsA"), answer: <>{t("whatIsA")}</> },
        { question: t("differentQ"), plainAnswer: t("differentA"), answer: <>{t("differentA")}</> },
        { question: t("knowledgeQ"), plainAnswer: t("knowledgeA"), answer: <>{t("knowledgeA")}</> },
        { question: t("transfersQ"), plainAnswer: t("transfersA"), answer: <>{t("transfersA")}</> }
      ]
    },
    {
      title: t("setupTitle"),
      items: [
        { question: t("setupTimeQ"), plainAnswer: t("setupTimeA"), answer: <>{t("setupTimeA")}</> },
        { question: t("keepNumberQ"), plainAnswer: t("keepNumberA"), answer: <>{t("keepNumberA")}</> },
        {
          question: t("whiteGloveQ"),
          plainAnswer: t("whiteGlovePlain"),
          answer: <>{t.rich("whiteGloveA", { b: bold, link: pricingLink })}</>
        },
        {
          question: t("carrierFeeQ", { carrierFee }),
          plainAnswer: t("carrierFeeA", { carrierFee }),
          answer: <>{t("carrierFeeA", { carrierFee })}</>
        }
      ]
    },
    {
      title: t("privacyTitle"),
      items: [
        { question: t("dataQ"), plainAnswer: t("dataA"), answer: <>{t("dataA")}</> },
        { question: t("trainingQ"), plainAnswer: t("trainingA"), answer: <>{t("trainingA")}</> },
        { question: t("complianceQ"), plainAnswer: t("complianceA"), answer: <>{t("complianceA")}</> }
      ]
    },
    {
      title: t("billingTitle"),
      items: [
        {
          question: t("costQ"),
          plainAnswer: t("costPlain", { starterPrice, standardConcurrent }),
          answer: <>{t.rich("costA", { starterPrice, standardConcurrent, link: pricingLink })}</>
        },
        { question: t("upfrontQ"), plainAnswer: t("upfrontA"), answer: <>{t("upfrontA")}</> },
        { question: t("cancelQ"), plainAnswer: t("cancelA"), answer: <>{t("cancelA")}</> },
        {
          question: t("capsQ"),
          plainAnswer: t("capsA", { standardVoice, standardSms }),
          answer: <>{t("capsA", { standardVoice, standardSms })}</>
        },
        { question: t("supportQ"), plainAnswer: t("supportA"), answer: <>{t("supportA")}</> }
      ]
    }
  ];

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: sections.flatMap((s) =>
      s.items.map((item) => ({
        "@type": "Question",
        name: item.question,
        acceptedAnswer: { "@type": "Answer", text: item.plainAnswer }
      }))
    )
  };

  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
      <JsonLd data={jsonLd} />
      <MarketingNav />

      <PageHero
        eyebrow={t("heroEyebrow")}
        title={t("heroTitle")}
        subtitle={t("heroSubtitle")}
      />

      {sections.map((section) => (
        <section key={section.title} className="mx-auto max-w-3xl px-6 pb-14">
          <SectionHeading title={section.title} />
          <FaqAccordion items={section.items} />
        </section>
      ))}

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
