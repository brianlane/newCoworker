import type { Metadata } from "next";
import Link from "next/link";
import {
  CalendarCheck,
  Moon,
  PhoneForwarded,
  PhoneIncoming,
  PhoneOff,
  MessageSquareText,
  MessagesSquare,
  Voicemail
} from "lucide-react";
import { getTranslations } from "next-intl/server";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import { CtaLink } from "@/components/marketing/CtaLink";
import { TrackedCtaLink } from "@/components/marketing/TrackedCtaLink";
import { JsonLd } from "@/components/marketing/JsonLd";
import {
  CtaBanner,
  FaqAccordion,
  FeatureGrid,
  PageHero,
  SectionHeading,
  StatBand,
  type Feature
} from "@/components/marketing/sections";
import { esAlternatesForRequest } from "@/lib/i18n/es-metadata";
import { SITE_URL } from "@/lib/marketing/site-url";

const PATH = "/ai-answering-service";

const FEATURE_DEFS: { key: string; Icon: Feature["Icon"] }[] = [
  { key: "afterHours", Icon: Moon },
  { key: "missedCall", Icon: PhoneForwarded },
  { key: "booking", Icon: CalendarCheck },
  { key: "followUp", Icon: MessageSquareText },
  { key: "overflow", Icon: PhoneIncoming },
  { key: "everyChannel", Icon: MessagesSquare }
];

const PROBLEM_DEFS: { key: string; Icon: Feature["Icon"] }[] = [
  {
    key: "problem1",
    Icon: PhoneOff
  },
  {
    key: "problem2",
    Icon: Voicemail
  },
  {
    key: "problem3",
    Icon: PhoneIncoming
  }
];

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("marketing.aiAnsweringServicePage");
  const alternates = await esAlternatesForRequest("/ai-answering-service");
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    alternates,
    openGraph: {
      title: t("ogTitle"),
      description: t("ogDescription"),
      url: alternates.canonical
    }
  };
}

export default async function AiAnsweringServicePage() {
  const t = await getTranslations("marketing.aiAnsweringServicePage");

  const features: Feature[] = FEATURE_DEFS.map(({ key, Icon }) => ({
    title: t(`${key}.title`),
    description: t(`${key}.description`),
    Icon
  }));

  const problems: Feature[] = PROBLEM_DEFS.map(({ key, Icon }) => ({
    title: t(`${key}.title`),
    description: t(`${key}.description`),
    Icon
  }));

  const faq = (
    [
      ["faq1", t("faq1.q"), t("faq1.a")],
      ["faq2", t("faq2.q"), t("faq2.a")],
      ["faq3", t("faq3.q"), t("faq3.a")],
      ["faq4", t("faq4.q"), t("faq4.a")],
      ["faq5", t("faq5.q"), t("faq5.a")]
    ] as const
  ).map(([, question, answer]) => ({
    question,
    plainAnswer: answer,
    answer: <>{answer}</>
  }));

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
      {
        "@type": "ListItem",
        position: 2,
        name: t("schemaName"),
        item: `${SITE_URL}${PATH}`
      }
    ]
  };

  const serviceJsonLd = {
    "@context": "https://schema.org",
    "@type": "Service",
    name: t("schemaName"),
    serviceType: t("schemaServiceType"),
    description: t("metaDescription"),
    url: `${SITE_URL}${PATH}`,
    provider: { "@id": `${SITE_URL}/#organization` }
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
      <JsonLd data={breadcrumbJsonLd} />
      <JsonLd data={serviceJsonLd} />
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
            {t("heroCta")}
          </TrackedCtaLink>
          <CtaLink href="/pricing" variant="secondary">
            {t("heroSecondaryCta")}
          </CtaLink>
        </div>
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
          eyebrow={t("handlesEyebrow")}
          title={t("handlesTitle")}
          subtitle={t("handlesSubtitle")}
        />
        <FeatureGrid features={features} />
      </section>

      <section className="mx-auto max-w-3xl px-6 pb-20 text-center">
        <SectionHeading eyebrow={t("compareEyebrow")} title={t("compareTitle")} />
        <p className="mx-auto max-w-2xl text-sm leading-relaxed text-parchment/60">
          {t("compareBody")}
        </p>
        <div className="mt-6">
          <CtaLink href="/compare/answering-service" variant="secondary">
            {t("compareLink")}
          </CtaLink>
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-6 pb-20">
        <SectionHeading eyebrow={t("faqEyebrow")} title={t("faqTitle")} />
        <FaqAccordion items={faq} />
      </section>

      <section className="mx-auto max-w-3xl px-6 pb-24 text-center">
        <p className="text-parchment/55">
          {t("contactPrompt")}{" "}
          <Link href="/contact" className="text-signal-teal hover:underline">
            {t("contactLink")}
          </Link>
          .
        </p>
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
