import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import { CtaBanner, PageHero } from "@/components/marketing/sections";
import { INDUSTRIES } from "./data";

export const metadata: Metadata = {
  title: "Industries",
  description:
    "New Coworker for real estate, home services, medical & dental, law firms, and small businesses — a 24/7 AI employee tuned to how your industry works.",
  alternates: { canonical: "/industries" },
  openGraph: {
    title: "Industries | New Coworker",
    description:
      "A 24/7 AI employee tuned to your industry: real estate, home services, medical & dental, law firms, and more.",
    url: "/industries"
  }
};

export default function IndustriesPage() {
  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
      <MarketingNav />

      <PageHero
        eyebrow="Industries"
        title={
          <>
            Built for how <span className="text-claw-green">your business</span> actually works
          </>
        }
        subtitle="Your coworker learns your services, your compliance rules, and your customers — starting with the industries where a missed call costs the most."
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
                <h2 className="text-lg font-semibold text-parchment">{industry.name}</h2>
              </div>
              <p className="flex-1 text-sm leading-relaxed text-parchment/50">{industry.teaser}</p>
              <span className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-signal-teal">
                See how it works
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </span>
            </Link>
          ))}
        </div>
      </section>

      <CtaBanner
        title="Don't see your industry?"
        subtitle="Your coworker is trained on YOUR business during onboarding — any business that takes calls and texts is a fit."
        ctaLabel="Get Started"
        ctaHref="/onboard"
      />

      <MarketingFooter />
    </div>
  );
}
