import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import { CtaBanner, PageHero } from "@/components/marketing/sections";
import { INDUSTRIES } from "./data";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("marketing.industriesPage");
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    alternates: { canonical: "/industries" },
    openGraph: {
      title: t("ogTitle"),
      description: t("ogDescription"),
      url: "/industries"
    }
  };
}

export default async function IndustriesPage() {
  const t = await getTranslations("marketing.industriesPage");
  const tIndustries = await getTranslations("marketing.industries");

  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
      <MarketingNav />

      <PageHero
        eyebrow={t("heroEyebrow")}
        title={
          <>
            {t("heroTitle")} <span className="text-claw-green">{t("heroHighlight")}</span>{" "}
            {t("heroTitleEnd")}
          </>
        }
        subtitle={t("heroSubtitle")}
      />

      <section className="mx-auto max-w-6xl px-6 pb-24">
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {INDUSTRIES.map((industry) => (
            <Link
              key={industry.slug}
              href={`/industries/${industry.slug}`}
              className="group flex flex-col rounded-xl border border-parchment/10 bg-parchment/[0.02] p-6 transition-colors hover:border-claw-green/40"
            >
              <div className="mb-3 flex items-center gap-3">
                <industry.Icon className="h-6 w-6 shrink-0 text-claw-green" />
                <h2 className="text-lg font-semibold text-parchment">
                  {tIndustries(`${industry.i18nKey}.name`)}
                </h2>
              </div>
              <p className="flex-1 text-sm leading-relaxed text-parchment/50">
                {tIndustries(`${industry.i18nKey}.teaser`)}
              </p>
              <span className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-signal-teal">
                {t("seeHow")}
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </span>
            </Link>
          ))}
        </div>
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
