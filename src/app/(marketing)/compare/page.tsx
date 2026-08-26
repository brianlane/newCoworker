import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import { CtaBanner, PageHero } from "@/components/marketing/sections";
import { JsonLd } from "@/components/marketing/JsonLd";
import { COMPARISONS } from "./data";
import { esAlternates } from "@/lib/i18n/es-routes";
import { SITE_URL } from "@/lib/marketing/site-url";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("marketing.comparePage");
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    alternates: esAlternates("/compare"),
    openGraph: {
      title: t("ogTitle"),
      description: t("ogDescription"),
      url: "/compare"
    }
  };
}

export default async function ComparePage() {
  const t = await getTranslations("marketing.comparePage");
  const tCompare = await getTranslations("marketing.compare");

  const entries = COMPARISONS.map((c) => ({
    slug: c.slug,
    name: tCompare(`${c.i18nKey}.name`),
    teaser: tCompare(`${c.i18nKey}.teaser`)
  }));

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
      { "@type": "ListItem", position: 2, name: "Compare", item: `${SITE_URL}/compare` }
    ]
  };

  const itemListJsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: t("ogTitle"),
    itemListElement: entries.map((entry, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: entry.name,
      url: `${SITE_URL}/compare/${entry.slug}`
    }))
  };

  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
      <JsonLd data={breadcrumbJsonLd} />
      <JsonLd data={itemListJsonLd} />
      <MarketingNav />

      <PageHero
        eyebrow={t("heroEyebrow")}
        title={
          <>
            {t("heroTitle")} <span className="text-claw-green">{t("heroHighlight")}</span>
          </>
        }
        subtitle={t("heroSubtitle")}
      />

      <section className="mx-auto max-w-6xl px-6 pb-24">
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {entries.map((entry) => (
            <Link
              key={entry.slug}
              href={`/compare/${entry.slug}`}
              className="group flex flex-col rounded-xl border border-parchment/10 bg-parchment/[0.02] p-6 transition-colors hover:border-claw-green/40"
            >
              <h2 className="text-lg font-semibold text-parchment">{entry.name}</h2>
              <p className="mt-3 flex-1 text-sm leading-relaxed text-parchment/50">
                {entry.teaser}
              </p>
              <span className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-signal-teal">
                {t("cardCta")}
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </span>
            </Link>
          ))}
        </div>
      </section>

      <CtaBanner
        title={t("indexCtaTitle")}
        subtitle={t("indexCtaSubtitle")}
        ctaLabel={t("ctaLabel")}
        ctaHref="/onboard"
      />

      <MarketingFooter />
    </div>
  );
}
