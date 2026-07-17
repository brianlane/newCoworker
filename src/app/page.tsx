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
import { getPeriodPricing } from "@/lib/plans/tier";
import { TIER_LIMITS } from "@/lib/plans/limits";
import { formatPricePerMonth } from "@/lib/pricing";

const features: Feature[] = [
  {
    title: "AI Voice Coworker",
    description:
      "Answers every call 24/7 with human-level conversation. It qualifies callers, checks your calendar, and books appointments on the spot.",
    Icon: Phone
  },
  {
    title: "Warm Call Transfers",
    description:
      "When a caller needs you, your coworker transfers the call to you or your team with full context. No cold handoffs.",
    Icon: PhoneForwarded
  },
  {
    title: "Texting, RCS & Auto-Replies",
    description:
      "Two-way SMS and RCS messaging, texts sent during live calls, auto-text on missed calls, plus scheduled texts and saved templates.",
    Icon: MessageSquareText
  },
  {
    title: "AI Call Summaries & Sentiment",
    description:
      "Every call lands on your dashboard with an AI summary and caller sentiment, so you know what happened without replaying audio.",
    Icon: Sparkles
  },
  {
    title: "Analytics & Alerts",
    description:
      "Call trends, peak hours, and answer rate at a glance, with alerts when callers are turned away so you never miss a spike.",
    Icon: BarChart3
  },
  {
    title: "Automated Workflows",
    description:
      "AiFlows capture leads from Meta (Facebook & Instagram) ads and text them back in seconds, follow up on schedule, route to your team, and run browser tasks.",
    Icon: Workflow
  },
  {
    title: "8,000+ App Integrations",
    description:
      "Connect your coworker to Zapier, Google Workspace, Microsoft 365, and your CRM. One connection unlocks 8,000+ everyday business apps.",
    Icon: Zap
  },
  {
    title: "Permanent Memory",
    description:
      "Lossless memory learns your business over time so every call, text, and email builds on real context. Nothing gets forgotten.",
    Icon: Brain
  },
  {
    title: "Appointment Booking",
    description:
      "Your coworker finds open slots on your Google or Microsoft calendar and books them mid-call, then sends the confirmation for you.",
    Icon: CalendarCheck
  },
  {
    title: "Compliance Guardrails",
    description:
      "Built-in compliance guardrails, including Fair Housing rules for real estate, protect your business from costly violations.",
    Icon: ShieldCheck
  },
  {
    title: "Your Dashboard",
    description:
      "Monitor calls, messages, and emails, review memory, manage notifications and billing. All in one place, on any device.",
    Icon: LayoutDashboard
  },
  {
    title: "Deploy in Minutes",
    description:
      "One-click provisioning: your tailored assistant, dedicated server, and phone number are live minutes after signup.",
    Icon: Rocket
  }
];

const steps: { step: string; title: string; description: string }[] = [
  {
    step: "1",
    title: "Tell us about your business",
    description:
      "Pick a plan and answer a short questionnaire. Your coworker learns your services, hours, and how you like to work. It can even read your website."
  },
  {
    step: "2",
    title: "We provision everything",
    description:
      "A dedicated private server, a phone number (or bring your own), email, and your trained AI coworker, all set up automatically."
  },
  {
    step: "3",
    title: "Your coworker gets to work",
    description:
      "Calls answered, texts returned, appointments booked, leads followed up, around the clock. You watch it all from your dashboard."
  }
];

export const metadata: Metadata = {
  description:
    "New Coworker gives your business a 24/7 AI employee to answer calls, handle messages, book appointments, and keep operations moving.",
  alternates: {
    canonical: "/"
  },
  openGraph: {
    title: "Your AI employee that never sleeps",
    description: "Answer calls, texts, and emails around the clock with New Coworker.",
    url: "/",
    images: ["/opengraph-image"]
  },
  twitter: {
    card: "summary_large_image",
    title: "Your AI employee that never sleeps",
    description: "Answer calls, texts, and emails around the clock with New Coworker.",
    images: ["/twitter-image"]
  }
};

export default function HomePage() {
  const starterFrom = formatPricePerMonth(getPeriodPricing("starter", "biennial").monthlyCents);

  // Real plan bounds for search/answer engines: lowest effective monthly rate
  // (Starter biennial) to highest listed monthly rate (Standard monthly).
  const productJsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "New Coworker",
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    url: "https://newcoworker.com",
    description:
      "A 24/7 AI employee that answers business calls, texts, and emails, books appointments, qualifies leads, and remembers every customer.",
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

      {/* Hero */}
      <PageHero
        title={
          <>
            Your AI employee that
            <span className="text-claw-green"> never sleeps</span>
          </>
        }
        subtitle={
          <>
            New Coworker answers calls, texts, and emails around the clock: booking appointments,
            following up with leads, and remembering every customer. Built for all <b>businesses</b>.
          </>
        }
      >
        <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            href="/onboard"
            className="inline-block rounded-lg bg-claw-green px-8 py-3.5 text-sm font-semibold text-deep-ink transition-colors hover:bg-opacity-90"
          >
            Start for {starterFrom}
          </Link>
          <Link
            href="/pricing"
            className="inline-block rounded-lg border border-parchment/20 px-8 py-3.5 text-sm font-semibold text-parchment transition-colors hover:bg-parchment/10"
          >
            See pricing
          </Link>
        </div>
      </PageHero>

      {/* Proof band */}
      <StatBand
        stats={[
          { value: "24/7", label: "Every call and text answered: nights, weekends, holidays" },
          {
            value: `${TIER_LIMITS.standard.maxConcurrentCalls} calls`,
            label: "Handled at once, so there are no busy signals during your rush"
          },
          { value: "8,000+", label: "Everyday apps connected through Zapier, no code required" },
          { value: "1 server", label: "Dedicated to your business, so business stays your business" }
        ]}
      />

      {/* Live demo line */}
      <section className="mx-auto max-w-6xl px-6 pb-24">
        <div className="rounded-2xl border border-claw-green/25 bg-claw-green/[0.05] p-8 text-center sm:p-10">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.22em] text-claw-green">
            Try it right now
          </p>
          <h2 className="text-2xl font-bold text-parchment sm:text-3xl">
            Don&apos;t take our word for it — call our AI coworker
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-parchment/55">
            Our own coworker answers this line 24/7. Ask it anything about New Coworker: what it
            can do, pricing, how setup works. It can even text you a follow-up.
          </p>
          <a
            href="tel:+16023131823"
            className="mt-7 inline-flex items-center gap-3 rounded-lg bg-claw-green px-8 py-3.5 text-lg font-bold text-deep-ink transition-colors hover:bg-opacity-90"
          >
            <Phone className="h-5 w-5" aria-hidden />
            +1 (602) 313-1823
          </a>
        </div>
      </section>

      {/* Features */}
      <section className="mx-auto max-w-6xl px-6 pb-24">
        <SectionHeading
          title={
            <>
              Everything your business needs, <span className="text-signal-teal">handled</span>
            </>
          }
          subtitle="Not a chatbot. A trained coworker that answers, acts, books, and follows up across every channel."
        />
        <FeatureGrid features={features} />
      </section>

      {/* How it works */}
      <section className="mx-auto max-w-6xl px-6 pb-24">
        <SectionHeading
          eyebrow="How it works"
          title="Live in minutes, not weeks"
          subtitle="Signup to first answered call is fully automated. No IT project, no sales call required."
        />
        <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
          {steps.map((s) => (
            <div
              key={s.step}
              className="rounded-xl border border-parchment/10 bg-parchment/[0.02] p-6"
            >
              <div className="mb-4 flex h-9 w-9 items-center justify-center rounded-full bg-claw-green/15 text-sm font-bold text-claw-green">
                {s.step}
              </div>
              <h3 className="font-semibold text-parchment">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-parchment/50">{s.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Privacy / local-first */}
      <section className="mx-auto max-w-6xl px-6 pb-24">
        <div className="rounded-2xl border border-signal-teal/20 bg-signal-teal/[0.04] p-8 sm:p-10">
          <div className="grid grid-cols-1 items-center gap-8 lg:grid-cols-2">
            <div>
              <p className="mb-3 text-xs font-semibold uppercase tracking-[0.22em] text-signal-teal">
                Privacy-first by design
              </p>
              <h2 className="text-2xl font-bold text-parchment sm:text-3xl">
                Your business runs on its own private server
              </h2>
              <p className="mt-4 leading-relaxed text-parchment/60">
                Unlike shared AI platforms, every New Coworker business gets its own dedicated
                server running its AI coworker, with its own credentials and configuration. Your
                data is isolated per business, never shared with other companies, and always
                yours.
              </p>
            </div>
            <ul className="space-y-3">
              {[
                "Dedicated private server per business with no shared tenancy",
                "Conversations and business records isolated per business, exportable any time",
                "Permanent, lossless memory that stays under your control",
                "Deny-by-default security posture with per-business credentials"
              ].map((item) => (
                <li key={item} className="flex items-start gap-3 text-sm text-parchment/70">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-signal-teal" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* Pricing teaser */}
      <section className="mx-auto max-w-6xl px-6 pb-24">
        <div className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-8 text-center sm:p-10">
          <h2 className="text-2xl font-bold text-parchment">
            Plans from <span className="text-claw-green">{starterFrom}</span>
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-parchment/55">
            A fraction of the cost of a receptionist or answering service, with a 30-day
            money-back guarantee on every plan.
          </p>
          <Link
            href="/pricing"
            className="mt-7 inline-block rounded-lg border border-claw-green/40 px-8 py-3 text-sm font-semibold text-claw-green transition-colors hover:bg-claw-green/10"
          >
            Compare plans
          </Link>
        </div>
      </section>

      {/* CTA */}
      <CtaBanner
        title="Ready to hire your New Coworker?"
        subtitle="New coworker starts learning from day one."
        ctaLabel="Choose your plan"
        ctaHref="/onboard"
      />

      <MarketingFooter />
    </div>
  );
}
