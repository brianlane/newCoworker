import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Check, Minus, X } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import {
  CtaBanner,
  FaqAccordion,
  PageHero,
  SectionHeading
} from "@/components/marketing/sections";
import { JsonLd } from "@/components/marketing/JsonLd";
import { getPeriodPricing } from "@/lib/plans/tier";
import { formatPricePerMonth } from "@/lib/pricing";
import { COMPARE_ROW_COUNT, COMPARISONS, getComparison, type RowVerdict } from "../data";
import { esAlternates } from "@/lib/i18n/es-routes";
import { SITE_URL } from "@/lib/marketing/site-url";

type Params = { slug: string };

/** Entries with their own hand-built page are excluded; Next would shadow them anyway. */
export function generateStaticParams(): Params[] {
  return COMPARISONS.filter((c) => !c.bespoke).map((c) => ({ slug: c.slug }));
}

// Only the comparisons defined in data.ts exist, anything else is a 404.
export const dynamicParams = false;

function templated(slug: string) {
  const entry = getComparison(slug);
  return entry && !entry.bespoke ? entry : undefined;
}

export async function generateMetadata({
  params
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const entry = templated((await params).slug);
  if (!entry) return {};
  const t = await getTranslations(`marketing.compare.${entry.i18nKey}`);
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    alternates: esAlternates(`/compare/${entry.slug}`),
    openGraph: {
      title: t("ogTitle"),
      description: t("ogDescription"),
      url: `/compare/${entry.slug}`
    }
  };
}

function VerdictIcon({ verdict, side }: { verdict: RowVerdict; side: "us" | "them" }) {
  if (verdict === "tie") return <Minus className="h-4 w-4 shrink-0 text-parchment/40" />;
  if (verdict === side) return <Check className="h-4 w-4 shrink-0 text-claw-green" />;
  return <X className="h-4 w-4 shrink-0 text-parchment/30" />;
}

export default async function ComparePage({ params }: { params: Promise<Params> }) {
  const entry = templated((await params).slug);
  if (!entry) notFound();

  const t = await getTranslations(`marketing.compare.${entry.i18nKey}`);
  const tPage = await getTranslations("marketing.comparePage");
  const starterMonthly = formatPricePerMonth(getPeriodPricing("starter", "biennial").monthlyCents);
  const standardMonthly = formatPricePerMonth(
    getPeriodPricing("standard", "biennial").monthlyCents
  );

  const rows = entry.verdicts.slice(0, COMPARE_ROW_COUNT).map((verdict, index) => ({
    label: t(`row${index + 1}.label`),
    us: t(`row${index + 1}.us`, { starterMonthly, standardMonthly }),
    them: t(`row${index + 1}.them`),
    verdict
  }));

  const faq = [1, 2, 3].map((n) => ({
    question: t(`faq${n}.q`),
    plainAnswer: t(`faq${n}.a`, { starterMonthly, standardMonthly }),
    answer: <>{t(`faq${n}.a`, { starterMonthly, standardMonthly })}</>
  }));

  const name = t("name");

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
      { "@type": "ListItem", position: 2, name: "Compare", item: `${SITE_URL}/compare` },
      {
        "@type": "ListItem",
        position: 3,
        name,
        item: `${SITE_URL}/compare/${entry.slug}`
      }
    ]
  };

  // The Q&A here is the part an assistant is most likely to quote verbatim.
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
      />

      <section className="mx-auto max-w-6xl px-6 pb-20">
        <SectionHeading
          eyebrow={tPage("tableEyebrow")}
          title={tPage("tableTitle", { name })}
          subtitle={tPage("tableSubtitle")}
        />
        <div className="mobile-scroll-x overflow-x-auto rounded-2xl border border-parchment/10">
          <table className="w-full min-w-[720px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-parchment/10 bg-parchment/[0.03]">
                <th className="px-5 py-4 font-semibold text-parchment/60"> </th>
                <th className="px-5 py-4 font-semibold text-claw-green">{tPage("usColumn")}</th>
                <th className="px-5 py-4 font-semibold text-parchment/70">{t("themColumn")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label} className="border-b border-parchment/5 last:border-b-0">
                  <td className="px-5 py-4 align-top font-semibold text-parchment/80">
                    {row.label}
                  </td>
                  <td className="px-5 py-4 align-top text-parchment/60">
                    <div className="flex items-start gap-2">
                      <span className="mt-0.5">
                        <VerdictIcon verdict={row.verdict} side="us" />
                      </span>
                      <span>{row.us}</span>
                    </div>
                  </td>
                  <td className="px-5 py-4 align-top text-parchment/60">
                    <div className="flex items-start gap-2">
                      <span className="mt-0.5">
                        <VerdictIcon verdict={row.verdict} side="them" />
                      </span>
                      <span>{row.them}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-20">
        <SectionHeading eyebrow={tPage("diffEyebrow")} title={tPage("diffTitle")} />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-8">
            <h3 className="text-lg font-bold text-parchment">{t("themCardTitle")}</h3>
            <ul className="mt-4 space-y-3 text-sm leading-relaxed text-parchment/55">
              <li>{t("themCard1")}</li>
              <li>{t("themCard2")}</li>
              <li>{t("themCard3")}</li>
            </ul>
          </div>
          <div className="rounded-2xl border border-claw-green/25 bg-claw-green/[0.04] p-8">
            <h3 className="text-lg font-bold text-parchment">{t("usCardTitle")}</h3>
            <ul className="mt-4 space-y-3 text-sm leading-relaxed text-parchment/55">
              <li>{t("usCard1")}</li>
              <li>{t("usCard2")}</li>
              <li>{t("usCard3")}</li>
            </ul>
          </div>
        </div>
        <p className="mx-auto mt-8 max-w-3xl text-center text-sm leading-relaxed text-parchment/45">
          {tPage("sourcedNote", { name })}
        </p>
      </section>

      <section className="mx-auto max-w-3xl px-6 pb-20">
        <SectionHeading eyebrow={tPage("faqEyebrow")} title={tPage("faqTitle")} />
        <FaqAccordion items={faq} />
      </section>

      <CtaBanner
        title={t("ctaTitle")}
        subtitle={t("ctaSubtitle")}
        ctaLabel={tPage("ctaLabel")}
        ctaHref="/onboard"
      />

      <MarketingFooter />
    </div>
  );
}
