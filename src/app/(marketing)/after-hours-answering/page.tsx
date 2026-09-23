import type { Metadata } from "next";
import Link from "next/link";
import {
  CalendarCheck,
  MessageSquareText,
  Moon,
  PhoneForwarded,
  PhoneIncoming,
  Server
} from "lucide-react";
import { getTranslations } from "next-intl/server";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import { CtaLink } from "@/components/marketing/CtaLink";
import { JsonLd } from "@/components/marketing/JsonLd";
import {
  CtaBanner,
  FaqAccordion,
  FeatureGrid,
  PageHero,
  SectionHeading,
  type Feature
} from "@/components/marketing/sections";
import { esAlternatesForRequest } from "@/lib/i18n/es-metadata";
import { SITE_URL } from "@/lib/marketing/site-url";

const FEATURE_DEFS: { key: string; Icon: Feature["Icon"] }[] = [
  { key: "nights", Icon: Moon },
  { key: "booking", Icon: CalendarCheck },
  { key: "missed", Icon: PhoneForwarded },
  { key: "overflow", Icon: PhoneIncoming },
  { key: "followup", Icon: MessageSquareText },
  { key: "private", Icon: Server }
];

const DAY_KEYS = ["day1", "day2", "day3", "day4"] as const;
const FAQ_KEYS = ["faq1", "faq2", "faq3", "faq4"] as const;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("marketing.afterHoursAnsweringPage");
  const tNav = await getTranslations("marketing.nav");
  const alternates = await esAlternatesForRequest("/after-hours-answering");
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    alternates,
    openGraph: {
      title: `${t("ogTitle")} | ${tNav("brand")}`,
      description: t("ogDescription"),
      url: alternates.canonical
    }
  };
}

export default async function AfterHoursAnsweringPage() {
  const t = await getTranslations("marketing.afterHoursAnsweringPage");

  const features: Feature[] = FEATURE_DEFS.map(({ key, Icon }) => ({
    title: t(`${key}.title`),
    description: t(`${key}.description`),
    Icon
  }));

  const faq = FAQ_KEYS.map((key) => ({
    question: t(`${key}.q`),
    plainAnswer: t(`${key}.a`),
    answer: <>{t(`${key}.a`)}</>
  }));

  const serviceJsonLd = {
    "@context": "https://schema.org",
    "@type": "Service",
    name: t("jsonLdName"),
    serviceType: t("jsonLdServiceType"),
    description: t("jsonLdDescription"),
    url: `${SITE_URL}/after-hours-answering`,
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
        name: t("jsonLdName"),
        item: `${SITE_URL}/after-hours-answering`
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
      <JsonLd data={serviceJsonLd} />
      <JsonLd data={breadcrumbJsonLd} />
      <JsonLd data={faqJsonLd} />
      <MarketingNav />

      <PageHero
        eyebrow={t("heroEyebrow")}
        title={
          <>
            {t("heroTitle")} <span className="text-claw-green">{t("heroHighlight")}</span>
          </>
        }
        subtitle={t("heroSubtitle")}
      >
        <div className="flex flex-col items-center gap-4">
          <div className="flex flex-wrap items-center justify-center gap-3">
            <CtaLink href="/onboard">{t("primaryCta")}</CtaLink>
            <CtaLink href="/pricing" variant="secondary">
              {t("secondaryCta")}
            </CtaLink>
          </div>
          <Link href="/contact" className="text-sm text-signal-teal hover:underline">
            {t("contactCta")}
          </Link>
        </div>
      </PageHero>

      <section className="mx-auto max-w-3xl px-6 pb-20">
        <SectionHeading eyebrow={t("problemEyebrow")} title={t("problemTitle")} />
        <p className="leading-relaxed text-parchment/65">{t("problemBody")}</p>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-20">
        <SectionHeading eyebrow={t("handlesEyebrow")} title={t("handlesTitle")} />
        <FeatureGrid features={features} />
      </section>

      <section className="mx-auto max-w-3xl px-6 pb-20">
        <SectionHeading eyebrow={t("dayEyebrow")} title={t("dayTitle")} />
        <ol className="relative space-y-6 border-l border-parchment/15 pl-6">
          {DAY_KEYS.map((key) => (
            <li key={key} className="relative">
              <span className="absolute -left-[1.85rem] top-1.5 h-2.5 w-2.5 rounded-full bg-claw-green" />
              <p className="text-sm leading-relaxed text-parchment/65">{t(key)}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="mx-auto max-w-3xl px-6 pb-20">
        <SectionHeading eyebrow={t("faqEyebrow")} title={t("faqTitle")} />
        <FaqAccordion items={faq} />
      </section>

      <CtaBanner title={t("ctaTitle")} subtitle={t("ctaSubtitle")} ctaLabel={t("ctaLabel")} ctaHref="/onboard" />

      <section className="mx-auto max-w-3xl px-6 pb-24 text-center">
        <p className="text-parchment/55">
          {t("contactPrompt")}{" "}
          <Link href="/contact" className="text-signal-teal hover:underline">
            {t("contactLink")}
          </Link>
          .
        </p>
      </section>

      <MarketingFooter />
    </div>
  );
}
