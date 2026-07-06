import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import {
  CtaBanner,
  FeatureGrid,
  PageHero,
  SectionHeading
} from "@/components/marketing/sections";
import { getIndustry, INDUSTRIES } from "../data";

type Params = { slug: string };

export function generateStaticParams(): Params[] {
  return INDUSTRIES.map((i) => ({ slug: i.slug }));
}

// Only the industries defined in data.tsx exist — anything else is a 404.
export const dynamicParams = false;

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const industry = getIndustry((await params).slug);
  if (!industry) return {};
  return {
    title: `${industry.name} | Industries`,
    description: industry.teaser,
    alternates: { canonical: `/industries/${industry.slug}` },
    openGraph: {
      title: `New Coworker for ${industry.name}`,
      description: industry.teaser,
      url: `/industries/${industry.slug}`
    }
  };
}

export default async function IndustryPage({ params }: { params: Promise<Params> }) {
  const industry = getIndustry((await params).slug);
  if (!industry) notFound();

  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
      <MarketingNav />

      <PageHero eyebrow={industry.name} title={industry.headline} subtitle={industry.subheadline}>
        <a
          href="/onboard"
          className="inline-block rounded-lg bg-claw-green px-8 py-3.5 text-sm font-semibold text-deep-ink transition-colors hover:bg-opacity-90"
        >
          Get Started
        </a>
      </PageHero>

      <section className="mx-auto max-w-6xl px-6 pb-20">
        <SectionHeading title={`What your coworker handles for ${industry.name.toLowerCase()}`} />
        <FeatureGrid features={industry.useCases} />
      </section>

      {/* Day in the life */}
      <section className="mx-auto max-w-3xl px-6 pb-20">
        <SectionHeading eyebrow="A day with your coworker" title="While you do the work, it works the phones" />
        <ol className="relative space-y-6 border-l border-parchment/15 pl-6">
          {industry.dayInTheLife.map((item) => (
            <li key={item.time} className="relative">
              <span className="absolute -left-[1.85rem] top-1.5 h-2.5 w-2.5 rounded-full bg-claw-green" />
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-signal-teal">{item.time}</p>
              <p className="mt-1 text-sm leading-relaxed text-parchment/65">{item.event}</p>
            </li>
          ))}
        </ol>
      </section>

      {industry.complianceNote && (
        <section className="mx-auto max-w-3xl px-6 pb-20">
          <div className="flex items-start gap-4 rounded-2xl border border-signal-teal/20 bg-signal-teal/[0.05] p-6">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-signal-teal" />
            <p className="text-sm leading-relaxed text-parchment/65">{industry.complianceNote}</p>
          </div>
        </section>
      )}

      <CtaBanner
        title={`Put a coworker to work in your ${industry.name.toLowerCase()} business`}
        subtitle="Live in minutes, with a 30-day money-back guarantee."
        ctaLabel="Choose your plan"
        ctaHref="/onboard"
      />

      <MarketingFooter />
    </div>
  );
}
