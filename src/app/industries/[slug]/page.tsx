import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import {
  CtaBanner,
  FeatureGrid,
  PageHero,
  SectionHeading
} from "@/components/marketing/sections";
import { JsonLd } from "@/components/marketing/JsonLd";
import { getIndustry, INDUSTRIES } from "../data";

const SITE_URL = "https://newcoworker.com";

type Params = { slug: string };

export function generateStaticParams(): Params[] {
  return INDUSTRIES.map((i) => ({ slug: i.slug }));
}

// Only the industries defined in data.tsx exist — anything else is a 404.
export const dynamicParams = false;

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const industry = getIndustry((await params).slug);
  if (!industry) return {};
  const t = await getTranslations("marketing.industriesPage");
  const tIndustries = await getTranslations("marketing.industries");
  const name = tIndustries(`${industry.i18nKey}.name`);
  const teaser = tIndustries(`${industry.i18nKey}.teaser`);
  return {
    title: t("detailMetaTitle", { name }),
    description: teaser,
    alternates: { canonical: `/industries/${industry.slug}` },
    openGraph: {
      title: t("detailOgTitle", { name }),
      description: teaser,
      url: `/industries/${industry.slug}`
    }
  };
}

export default async function IndustryPage({ params }: { params: Promise<Params> }) {
  const industry = getIndustry((await params).slug);
  if (!industry) notFound();

  const t = await getTranslations("marketing.industriesPage");
  const tIndustries = await getTranslations("marketing.industries");
  const k = industry.i18nKey;
  const name = tIndustries(`${k}.name`);
  const teaser = tIndustries(`${k}.teaser`);

  const useCases = industry.useCaseIcons.map((Icon, index) => ({
    title: tIndustries(`${k}.u${index + 1}.title`),
    description: tIndustries(`${k}.u${index + 1}.description`),
    Icon
  }));

  const dayInTheLife = industry.dayTimes.map((time, index) => ({
    time,
    event: tIndustries(`${k}.day${index + 1}`)
  }));

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
      { "@type": "ListItem", position: 2, name: "Industries", item: `${SITE_URL}/industries` },
      {
        "@type": "ListItem",
        position: 3,
        name,
        item: `${SITE_URL}/industries/${industry.slug}`
      }
    ]
  };

  const serviceJsonLd = {
    "@context": "https://schema.org",
    "@type": "Service",
    name: t("detailOgTitle", { name }),
    serviceType: "AI answering and scheduling service",
    description: teaser,
    url: `${SITE_URL}/industries/${industry.slug}`,
    provider: { "@id": `${SITE_URL}/#organization` },
    audience: { "@type": "BusinessAudience", name }
  };

  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
      <JsonLd data={breadcrumbJsonLd} />
      <JsonLd data={serviceJsonLd} />
      <MarketingNav />

      <PageHero
        eyebrow={name}
        title={tIndustries(`${k}.headline`)}
        subtitle={tIndustries(`${k}.subheadline`)}
      >
        <a
          href="/onboard"
          className="inline-block rounded-lg bg-claw-green px-8 py-3.5 text-sm font-semibold text-deep-ink transition-colors hover:bg-opacity-90"
        >
          {t("detailGetStarted")}
        </a>
      </PageHero>

      <section className="mx-auto max-w-6xl px-6 pb-20">
        <SectionHeading title={t("detailHandlesTitle", { name: name.toLowerCase() })} />
        <FeatureGrid features={useCases} />
      </section>

      {/* Day in the life */}
      <section className="mx-auto max-w-3xl px-6 pb-20">
        <SectionHeading eyebrow={t("dayEyebrow")} title={t("dayTitle")} />
        <ol className="relative space-y-6 border-l border-parchment/15 pl-6">
          {dayInTheLife.map((item) => (
            <li key={item.time} className="relative">
              <span className="absolute -left-[1.85rem] top-1.5 h-2.5 w-2.5 rounded-full bg-claw-green" />
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-signal-teal">{item.time}</p>
              <p className="mt-1 text-sm leading-relaxed text-parchment/65">{item.event}</p>
            </li>
          ))}
        </ol>
      </section>

      {industry.hasComplianceNote && (
        <section className="mx-auto max-w-3xl px-6 pb-20">
          <div className="flex items-start gap-4 rounded-2xl border border-signal-teal/20 bg-signal-teal/[0.05] p-6">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-signal-teal" />
            <p className="text-sm leading-relaxed text-parchment/65">
              {tIndustries(`${k}.complianceNote`)}
            </p>
          </div>
        </section>
      )}

      <CtaBanner
        title={t("detailCtaTitle", { noun: tIndustries(`${k}.ctaNoun`) })}
        subtitle={t("detailCtaSubtitle")}
        ctaLabel={t("detailCtaLabel")}
        ctaHref="/onboard"
      />

      <MarketingFooter />
    </div>
  );
}
