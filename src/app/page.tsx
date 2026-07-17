import Link from "next/link";
import type { Metadata } from "next";
import {
  BarChart3,
  Brain,
  CalendarCheck,
  LayoutDashboard,
  MessageSquareText,
  Phone,
  PhoneForwarded,
  Rocket,
  ShieldCheck,
  Sparkles,
  Workflow,
  Zap
} from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import { JsonLd } from "@/components/marketing/JsonLd";
import {
  CtaBanner,
  FeatureGrid,
  PageHero,
  SectionHeading,
  StatBand,
  type Feature
} from "@/components/marketing/sections";
import type { AppLocale } from "@/i18n/routing";
import { formatPricePerMonthLocalized } from "@/lib/i18n/format";
import { getPeriodPricing } from "@/lib/plans/tier";
import { TIER_LIMITS } from "@/lib/plans/limits";

const FEATURE_DEFS: {
  key: string;
  Icon: Feature["Icon"];
}[] = [
  { key: "voiceCoworker", Icon: Phone },
  { key: "warmTransfer", Icon: PhoneForwarded },
  { key: "textingRcs", Icon: MessageSquareText },
  { key: "callSummaries", Icon: Sparkles },
  { key: "analyticsAlerts", Icon: BarChart3 },
  { key: "automatedWorkflows", Icon: Workflow },
  { key: "appIntegrations", Icon: Zap },
  { key: "permanentMemory", Icon: Brain },
  { key: "appointmentBooking", Icon: CalendarCheck },
  { key: "complianceGuardrails", Icon: ShieldCheck },
  { key: "yourDashboard", Icon: LayoutDashboard },
  { key: "deployMinutes", Icon: Rocket }
];

const STEP_KEYS = ["step1", "step2", "step3"] as const;
const PRIVACY_KEYS = ["dedicated", "isolated", "memory", "security"] as const;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("marketing.home");
  return {
    description: t("metaDescription"),
    alternates: {
      canonical: "/"
    },
    openGraph: {
      title: t("ogTitle"),
      description: t("ogDescription"),
      url: "/",
      images: ["/opengraph-image"]
    },
    twitter: {
      card: "summary_large_image",
      title: t("ogTitle"),
      description: t("ogDescription"),
      images: ["/twitter-image"]
    }
  };
}

export default async function HomePage() {
  const t = await getTranslations("marketing");
  const locale = (await getLocale()) as AppLocale;
  const starterFrom = formatPricePerMonthLocalized(
    getPeriodPricing("starter", "biennial").monthlyCents,
    locale
  );

  const features: Feature[] = FEATURE_DEFS.map(({ key, Icon }) => ({
    title: t(`features.${key}.title`),
    description: t(`features.${key}.description`),
    Icon
  }));

  const productJsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "New Coworker",
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    url: "https://newcoworker.com",
    description: t("home.metaDescription"),
    offers: {
      "@type": "AggregateOffer",
      priceCurrency: "USD",
      lowPrice: (getPeriodPricing("starter", "biennial").monthlyCents / 100).toFixed(2),
      highPrice: (getPeriodPricing("standard", "monthly").monthlyCents / 100).toFixed(2),
      offerCount: 3,
      url: "https://newcoworker.com/pricing"
    }
  };

  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
      <JsonLd data={productJsonLd} />
      <MarketingNav />

      <PageHero
        title={
          <>
            {t("home.heroTitle")}
            <span className="text-claw-green"> {t("home.heroHighlight")}</span>
          </>
        }
        subtitle={t("home.heroSubtitle")}
      >
        <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            href="/onboard"
            className="inline-block rounded-lg bg-claw-green px-8 py-3.5 text-sm font-semibold text-deep-ink transition-colors hover:bg-opacity-90"
          >
            {t("home.startFor", { price: starterFrom })}
          </Link>
          <Link
            href="/pricing"
            className="inline-block rounded-lg border border-parchment/20 px-8 py-3.5 text-sm font-semibold text-parchment transition-colors hover:bg-parchment/10"
          >
            {t("home.seePricing")}
          </Link>
        </div>
      </PageHero>

      <StatBand
        stats={[
          { value: t("stats.stat1Value"), label: t("stats.stat1Label") },
          {
            value: t("stats.stat2Value", {
              calls: TIER_LIMITS.standard.maxConcurrentCalls
            }),
            label: t("stats.stat2Label")
          },
          { value: t("stats.stat3Value"), label: t("stats.stat3Label") },
          { value: t("stats.stat4Value"), label: t("stats.stat4Label") }
        ]}
      />

      <section className="mx-auto max-w-6xl px-6 pb-24">
        <div className="rounded-2xl border border-claw-green/25 bg-claw-green/[0.05] p-8 text-center sm:p-10">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.22em] text-claw-green">
            {t("home.tryNow")}
          </p>
          <h2 className="text-2xl font-bold text-parchment sm:text-3xl">{t("home.callDemoTitle")}</h2>
          <p className="mx-auto mt-4 max-w-xl text-parchment/55">{t("home.callDemoBody")}</p>
          <a
            href="tel:+16023131823"
            className="mt-7 inline-flex items-center gap-3 rounded-lg bg-claw-green px-8 py-3.5 text-lg font-bold text-deep-ink transition-colors hover:bg-opacity-90"
          >
            <Phone className="h-5 w-5" aria-hidden />
            +1 (602) 313-1823
          </a>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-24">
        <SectionHeading
          title={
            <>
              {t("home.featuresTitle")}{" "}
              <span className="text-signal-teal">{t("home.featuresHighlight")}</span>
            </>
          }
          subtitle={t("home.featuresSubtitle")}
        />
        <FeatureGrid features={features} />
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-24">
        <SectionHeading
          eyebrow={t("home.howEyebrow")}
          title={t("home.howTitle")}
          subtitle={t("home.howSubtitle")}
        />
        <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
          {STEP_KEYS.map((key, index) => (
            <div
              key={key}
              className="rounded-xl border border-parchment/10 bg-parchment/[0.02] p-6"
            >
              <div className="mb-4 flex h-9 w-9 items-center justify-center rounded-full bg-claw-green/15 text-sm font-bold text-claw-green">
                {index + 1}
              </div>
              <h3 className="font-semibold text-parchment">{t(`steps.${key}.title`)}</h3>
              <p className="mt-2 text-sm leading-relaxed text-parchment/50">
                {t(`steps.${key}.description`)}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-24">
        <div className="rounded-2xl border border-signal-teal/20 bg-signal-teal/[0.04] p-8 sm:p-10">
          <div className="grid grid-cols-1 items-center gap-8 lg:grid-cols-2">
            <div>
              <p className="mb-3 text-xs font-semibold uppercase tracking-[0.22em] text-signal-teal">
                {t("home.privacyEyebrow")}
              </p>
              <h2 className="text-2xl font-bold text-parchment sm:text-3xl">
                {t("home.privacyTitle")}
              </h2>
              <p className="mt-4 leading-relaxed text-parchment/60">{t("home.privacyBody")}</p>
            </div>
            <ul className="space-y-3">
              {PRIVACY_KEYS.map((key) => (
                <li key={key} className="flex items-start gap-3 text-sm text-parchment/70">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-signal-teal" />
                  {t(`privacyBullets.${key}`)}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-24">
        <div className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-8 text-center sm:p-10">
          <h2 className="text-2xl font-bold text-parchment">
            {t("home.plansFrom")}{" "}
            <span className="text-claw-green">{starterFrom}</span>
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-parchment/55">{t("home.plansTeaser")}</p>
          <Link
            href="/pricing"
            className="mt-7 inline-block rounded-lg border border-claw-green/40 px-8 py-3 text-sm font-semibold text-claw-green transition-colors hover:bg-claw-green/10"
          >
            {t("home.comparePlans")}
          </Link>
        </div>
      </section>

      <CtaBanner
        title={t("home.ctaTitle")}
        subtitle={t("home.ctaSubtitle")}
        ctaLabel={t("home.ctaLabel")}
        ctaHref="/onboard"
      />

      <MarketingFooter />
    </div>
  );
}
