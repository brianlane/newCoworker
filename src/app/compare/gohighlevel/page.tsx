import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { Check, Minus, X } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import {
  CtaBanner,
  FaqAccordion,
  PageHero,
  SectionHeading,
  StatBand
} from "@/components/marketing/sections";
import { getPeriodPricing } from "@/lib/plans/tier";
import { formatPricePerMonth } from "@/lib/pricing";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("marketing.compareGhl");
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    alternates: { canonical: "/compare/gohighlevel" },
    openGraph: {
      title: t("ogTitle"),
      description: t("ogDescription"),
      url: "/compare/gohighlevel"
    }
  };
}

type RowVerdict = "us" | "them" | "tie";

/**
 * GoHighLevel figures reflect their published pricing and plan docs as of
 * July 2026 (gohighlevel.com pricing + HighLevel support portal: $97/$297/
 * $497 base plans; AI Employee Unlimited $97/mo per location; SMS, email,
 * voice, and premium AI usage billed separately). Keep sourced and current —
 * an inaccurate competitor claim hurts more than it helps. Copy lives under
 * marketing.compareGhl.row1..row10 in the message catalogs.
 */
const ROW_VERDICTS: RowVerdict[] = ["us", "us", "us", "tie", "us", "us", "us", "them", "them", "tie"];

function VerdictIcon({ verdict, side }: { verdict: RowVerdict; side: "us" | "them" }) {
  if (verdict === "tie") return <Minus className="h-4 w-4 shrink-0 text-parchment/40" />;
  if (verdict === side) return <Check className="h-4 w-4 shrink-0 text-claw-green" />;
  return <X className="h-4 w-4 shrink-0 text-parchment/30" />;
}

export default async function CompareGoHighLevelPage() {
  const t = await getTranslations("marketing.compareGhl");
  const standardMonthly = formatPricePerMonth(getPeriodPricing("standard", "biennial").monthlyCents);
  const starterMonthly = formatPricePerMonth(getPeriodPricing("starter", "biennial").monthlyCents);

  const rows = ROW_VERDICTS.map((verdict, index) => ({
    label: t(`row${index + 1}.label`),
    us: t(`row${index + 1}.us`),
    them: t(`row${index + 1}.them`),
    verdict
  }));

  const faq = [
    { question: t("faqCheaperQ"), answer: <>{t("faqCheaperA", { standardMonthly })}</> },
    { question: t("faqMetaQ"), answer: <>{t("faqMetaA")}</> },
    { question: t("faqBetterQ"), answer: <>{t("faqBetterA")}</> },
    { question: t("faqBothQ"), answer: <>{t("faqBothA")}</> },
    { question: t("faqSwitchQ"), answer: <>{t("faqSwitchA")}</> }
  ];

  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
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

      <StatBand
        stats={[
          { value: t("stat1Value"), label: t("stat1Label") },
          { value: t("stat2Value"), label: t("stat2Label") },
          { value: t("stat3Value"), label: t("stat3Label") },
          { value: starterMonthly, label: t("stat4Label") }
        ]}
      />

      {/* Comparison table */}
      <section className="mx-auto max-w-6xl px-6 pb-20">
        <SectionHeading
          eyebrow={t("tableEyebrow")}
          title={t("tableTitle")}
          subtitle={t("tableSubtitle")}
        />
        <div className="mobile-scroll-x overflow-x-auto rounded-2xl border border-parchment/10">
          <table className="w-full min-w-[720px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-parchment/10 bg-parchment/[0.03]">
                <th className="px-5 py-4 font-semibold text-parchment/60"> </th>
                <th className="px-5 py-4 font-semibold text-claw-green">{t("usColumn")}</th>
                <th className="px-5 py-4 font-semibold text-parchment/70">{t("themColumn")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label} className="border-b border-parchment/5 last:border-b-0">
                  <td className="px-5 py-4 align-top font-semibold text-parchment/80">{row.label}</td>
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

      {/* The real difference */}
      <section className="mx-auto max-w-6xl px-6 pb-20">
        <SectionHeading
          eyebrow={t("diffEyebrow")}
          title={t("diffTitle")}
        />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-8">
            <h3 className="text-lg font-bold text-parchment">{t("themCardTitle")}</h3>
            <ul className="mt-4 space-y-3 text-sm leading-relaxed text-parchment/55">
              <li>{t("themCard1")}</li>
              <li>{t("themCard2")}</li>
              <li>{t("themCard3")}</li>
              <li>{t("themCard4")}</li>
            </ul>
          </div>
          <div className="rounded-2xl border border-claw-green/25 bg-claw-green/[0.04] p-8">
            <h3 className="text-lg font-bold text-parchment">{t("usCardTitle")}</h3>
            <ul className="mt-4 space-y-3 text-sm leading-relaxed text-parchment/55">
              <li>{t("usCard1")}</li>
              <li>{t("usCard2")}</li>
              <li>{t("usCard3")}</li>
              <li>{t("usCard4")}</li>
            </ul>
          </div>
        </div>
        <p className="mx-auto mt-8 max-w-3xl text-center text-sm leading-relaxed text-parchment/45">
          {t.rich("reviewsNote", {
            em: (chunks: ReactNode) => <em>{chunks}</em>,
            link: (chunks: ReactNode) => (
              <Link href="/onboard" className="text-claw-green hover:underline">
                {chunks}
              </Link>
            )
          })}
        </p>
      </section>

      <section className="mx-auto max-w-3xl px-6 pb-20">
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
