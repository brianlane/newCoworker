import type { Metadata } from "next";
import Link from "next/link";
import { Brain, CalendarCheck, Clock, MessageSquareText, Phone } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import { CtaLink } from "@/components/marketing/CtaLink";
import { TrackedCtaLink } from "@/components/marketing/TrackedCtaLink";
import { JsonLd } from "@/components/marketing/JsonLd";
import {
  CtaBanner,
  FeatureGrid,
  FaqAccordion,
  PageHero,
  SectionHeading,
  StatBand
} from "@/components/marketing/sections";
import type { AppLocale } from "@/i18n/routing";
import { esAlternatesForRequest } from "@/lib/i18n/es-metadata";
import { formatPricePerMonthLocalized } from "@/lib/i18n/format";
import { getPeriodPricing } from "@/lib/plans/tier";
import { SITE_URL } from "@/lib/marketing/site-url";

const PAGE_PATH = "/ai-receptionist";
const PAGE_URL = `${SITE_URL}${PAGE_PATH}`;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("marketing.callAnsweringPage");
  const tNav = await getTranslations("marketing.nav");
  const brand = tNav("brand");
  const alternates = await esAlternatesForRequest(PAGE_PATH);
  return {
    title: t("metaTitle"),
    description: t("metaDescription", { brand }),
    alternates,
    openGraph: {
      title: t("ogTitle", { brand }),
      description: t("ogDescription"),
      url: alternates.canonical
    }
  };
}

export default async function LandingPage() {
  const t = await getTranslations("marketing.callAnsweringPage");
  const tNav = await getTranslations("marketing.nav");
  const brand = tNav("brand");
  const locale = (await getLocale()) as AppLocale;
  const starterFrom = formatPricePerMonthLocalized(
    getPeriodPricing("starter", "biennial").monthlyCents,
    locale
  );

  const problems = [
    { title: t("p1Title"), description: t("p1Body"), Icon: Clock },
    { title: t("p2Title"), description: t("p2Body"), Icon: CalendarCheck },
    { title: t("p3Title"), description: t("p3Body"), Icon: MessageSquareText }
  ];

  const does = [
    { title: t("does1Title"), description: t("does1Body"), Icon: Phone },
    { title: t("does2Title"), description: t("does2Body"), Icon: MessageSquareText },
    { title: t("does3Title"), description: t("does3Body"), Icon: CalendarCheck },
    { title: t("does4Title"), description: t("does4Body"), Icon: Brain }
  ];

  const faq = [
    { question: t("faq1q"), plainAnswer: t("faq1a"), answer: <>{t("faq1a")}</> },
    { question: t("faq2q"), plainAnswer: t("faq2a"), answer: <>{t("faq2a")}</> },
    { question: t("faq3q"), plainAnswer: t("faq3a"), answer: <>{t("faq3a")}</> },
    { question: t("faq4q"), plainAnswer: t("faq4a"), answer: <>{t("faq4a")}</> }
  ];

  const softwareJsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: brand,
    alternateName: t("jsonLdAlternateName"),
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    url: PAGE_URL,
    description: t("metaDescription", { brand }),
    offers: {
      "@type": "AggregateOffer",
      priceCurrency: "USD",
      lowPrice: (getPeriodPricing("starter", "biennial").monthlyCents / 100).toFixed(2),
      highPrice: (getPeriodPricing("standard", "monthly").monthlyCents / 100).toFixed(2),
      offerCount: 3,
      url: `${SITE_URL}/pricing`
    }
  };

  const serviceJsonLd = {
    "@context": "https://schema.org",
    "@type": "Service",
    name: t("jsonLdServiceName"),
    serviceType: t("jsonLdServiceType"),
    description: t("metaDescription", { brand }),
    url: PAGE_URL,
    provider: { "@id": `${SITE_URL}/#organization` }
  };

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
      {
        "@type": "ListItem",
        position: 2,
        name: t("heroTitle"),
        item: PAGE_URL
      }
    ]
  };

  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faq.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: { "@type": "Answer", text: item.plainAnswer }
    }))
  };

  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
      <JsonLd data={softwareJsonLd} />
      <JsonLd data={serviceJsonLd} />
      <JsonLd data={breadcrumbJsonLd} />
      <JsonLd data={faqJsonLd} />
      <MarketingNav />

      <PageHero
        glow
        eyebrow={t("heroEyebrow")}
        title={
          <>
            {t("heroTitle")} <span className="text-claw-green">{t("heroHighlight")}</span>
          </>
        }
        subtitle={t("heroSubtitle")}
      >
        <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
          <TrackedCtaLink href="/onboard" event="cta_get_started" eventProps={{ source: "hero" }}>
            {t("startCta", { price: starterFrom })}
          </TrackedCtaLink>
          <CtaLink href="/pricing" variant="secondary">
            {t("pricingCta")}
          </CtaLink>
        </div>
        <p className="mt-5 text-sm text-parchment/50">
          <Link href="/contact" className="text-signal-teal hover:underline">
            {t("contactCta")}
          </Link>
        </p>
      </PageHero>

      <StatBand
        stats={[
          { value: t("stat1Value"), label: t("stat1Label") },
          { value: t("stat2Value"), label: t("stat2Label") },
          { value: t("stat3Value"), label: t("stat3Label") },
          { value: t("stat4Value"), label: t("stat4Label") }
        ]}
      />

      <section className="mx-auto max-w-6xl px-6 pb-20">
        <SectionHeading
          eyebrow={t("problemEyebrow")}
          title={t("problemTitle")}
          subtitle={t("problemSubtitle")}
        />
        <FeatureGrid features={problems} />
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-20">
        <SectionHeading
          eyebrow={t("doesEyebrow")}
          title={t("doesTitle")}
          subtitle={t("doesSubtitle")}
        />
        <FeatureGrid features={does} />
      </section>

      <div className="border-y border-parchment/10 bg-parchment/[0.02]">
        <section className="mx-auto max-w-3xl px-6 py-20 text-center">
          <SectionHeading eyebrow={t("contrastEyebrow")} title={t("contrastTitle")} />
          <p className="mx-auto max-w-2xl text-parchment/55">{t("contrastBody")}</p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <CtaLink href="/compare/answering-service" variant="secondary">
              {t("contrastCompareCta")}
            </CtaLink>
            <CtaLink href="/contact" variant="secondary">
              {t("contactCta")}
            </CtaLink>
          </div>
        </section>
      </div>

      <section className="mx-auto max-w-3xl px-6 py-20">
        <SectionHeading eyebrow={t("faqEyebrow")} title={t("faqTitle")} />
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
