import type { Metadata } from "next";
import Link from "next/link";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import {
  CtaBanner,
  FaqAccordion,
  PageHero,
  SectionHeading,
  type FaqItem
} from "@/components/marketing/sections";
import { PlanCards } from "@/components/pricing/PlanCards";
import { TIER_LIMITS } from "@/lib/plans/limits";
import { getPeriodPricing } from "@/lib/plans/tier";
import { concurrentCallsLine, voiceMinutesLine } from "@/lib/plans/usage-copy";
import { CARRIER_REGISTRATION_FEE_CENTS } from "@/lib/plans/carrier-fee";
import { CANADA_MESSAGING_FEE_MONTHLY_CENTS } from "@/lib/plans/canadian-messaging";
import { formatPriceCents, formatPricePerMonth } from "@/lib/pricing";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Simple plans for a 24/7 AI employee: answered calls, texts, emails, and booked appointments. 30-day money-back guarantee on every plan.",
  alternates: { canonical: "/pricing" },
  openGraph: {
    title: "Pricing | New Coworker",
    description:
      "Simple plans for a 24/7 AI employee. Starter, Standard, and Enterprise, all with a 30-day money-back guarantee.",
    url: "/pricing"
  }
};

type ComparisonRow = {
  label: string;
  starter: string;
  standard: string;
  enterprise: string;
};

const CHECK = "✓";
const DASH = "–";

const comparisonRows: ComparisonRow[] = [
  {
    label: "Included voice minutes",
    starter: voiceMinutesLine("starter"),
    standard: voiceMinutesLine("standard"),
    enterprise: "Custom"
  },
  {
    label: "SMS per month",
    starter: `${TIER_LIMITS.starter.smsPerMonth}`,
    standard: `${TIER_LIMITS.standard.smsPerMonth}`,
    enterprise: "Custom"
  },
  {
    label: "Concurrent calls",
    starter: concurrentCallsLine(TIER_LIMITS.starter.maxConcurrentCalls),
    standard: concurrentCallsLine(TIER_LIMITS.standard.maxConcurrentCalls),
    enterprise: "Custom"
  },
  {
    label: "Monthly AI budget for agentic tasks",
    starter: "$5",
    standard: "$10",
    enterprise: "Custom"
  },
  {
    label: "AI image generation",
    starter: "3 per conversation",
    standard: "3 per conversation",
    enterprise: "Custom"
  },
  { label: "Dedicated phone number & email", starter: CHECK, standard: CHECK, enterprise: CHECK },
  { label: "Appointment booking & follow-ups", starter: CHECK, standard: CHECK, enterprise: CHECK },
  { label: "Lossless permanent memory", starter: CHECK, standard: CHECK, enterprise: CHECK },
  { label: "Bring your own number (port-in)", starter: DASH, standard: CHECK, enterprise: CHECK },
  { label: "RCS messaging (verified sender)", starter: DASH, standard: CHECK, enterprise: CHECK },
  { label: "Zapier (8,000+ apps) & developer API", starter: DASH, standard: CHECK, enterprise: CHECK },
  { label: "Texts during calls & missed-call auto-text", starter: DASH, standard: CHECK, enterprise: CHECK },
  { label: "Scheduled texts & message templates", starter: DASH, standard: CHECK, enterprise: CHECK },
  { label: "AI call summaries & caller sentiment", starter: DASH, standard: CHECK, enterprise: CHECK },
  { label: "Analytics dashboard & missed-call alerts", starter: DASH, standard: CHECK, enterprise: CHECK },
  { label: "Warm handoff call transfers", starter: DASH, standard: CHECK, enterprise: CHECK },
  {
    label: "Browser skills",
    starter: "Reads public web pages",
    standard: "Operates websites like a person",
    enterprise: "Operates websites like a person"
  },
  { label: "Support", starter: "Email", standard: "Priority email", enterprise: "SLA + dedicated" },
  { label: "White-label & multi-tenant setup", starter: DASH, standard: DASH, enterprise: CHECK }
];

function buildPricingFaq(): FaqItem[] {
  // Same env-driven address the footer uses, so the two can't diverge.
  const contactEmail = process.env.CONTACT_EMAIL ?? "team@newcoworker.com";
  const carrierFee = formatPriceCents(CARRIER_REGISTRATION_FEE_CENTS);
  const canadaFeeMonthly = formatPriceCents(CANADA_MESSAGING_FEE_MONTHLY_CENTS);
  const starterRenewal = formatPricePerMonth(getPeriodPricing("starter", "biennial").renewalMonthlyCents);
  const standardRenewal = formatPricePerMonth(getPeriodPricing("standard", "biennial").renewalMonthlyCents);

  return [
    {
      question: "How does billing work for 12 and 24-month plans?",
      answer: (
        <>
          The full term is billed once at checkout at the discounted effective monthly rate.
          That is how we lock in your dedicated server for the whole contract. Included usage
          (voice minutes, SMS, AI budget) still resets every month.
        </>
      )
    },
    {
      question: "What happens when my term ends?",
      answer: (
        <>
          Service continues month-to-month at the renewal rate shown on your plan card (for
          example, {starterRenewal} for Starter or {standardRenewal} for Standard after a 24-month
          term), unless you start a new contract at the contract rate.
        </>
      )
    },
    {
      question: `What is the one-time ${carrierFee} carrier registration fee?`,
      answer: (
        <>
          US carriers require every business that sends text messages to register (10DLC brand
          and campaign registration). We pass this one-time {carrierFee} fee through at cost.
          It is charged once at signup and is non-refundable, since carriers do not refund it
          to us.
        </>
      )
    },
    {
      question: "Is there a money-back guarantee?",
      answer: (
        <>
          Yes. Every plan has a 30-day money-back window from the initial purchase date. The
          one-time carrier registration fee is excluded, because carriers do not refund it.
          On 12/24-month plans the refund deducts one month of service at the monthly rate,
          so the time you used is billed as if uncommitted.
        </>
      )
    },
    {
      question: `What is the ${canadaFeeMonthly}/mo Canadian messaging surcharge?`,
      answer: (
        <>
          Canadian mobile carriers (Bell, Rogers, Telus, and others) charge per-message fees for
          business texting that US carriers structure differently. Canadian-based businesses pay
          a flat {canadaFeeMonthly}/mo surcharge that covers these carrier pass-through fees, so
          your coworker can text your Canadian customers with no per-message surprises. It
          appears as its own line item at checkout and renews with your plan; US-based businesses
          never pay it.
        </>
      )
    },
    {
      question: "Can I keep my existing business number?",
      answer: (
        <>
          Yes. Standard and Enterprise plans support bring-your-own-number: we port your
          existing number in and your coworker answers on it. Every plan also includes a
          dedicated number out of the box.
        </>
      )
    },
    {
      question: "Can I get more than one phone number?",
      answer: (
        <>
          Every plan includes one dedicated number. Extra numbers are $5/mo each. Contact{" "}
          <a href={`mailto:${contactEmail}`} className="text-signal-teal hover:underline">
            {contactEmail}
          </a>{" "}
          to add one to your account.
        </>
      )
    },
    {
      question: "What happens if I use up my included voice minutes or SMS?",
      answer: (
        <>
          Your coworker stops placing metered voice calls or sending customer texts once the
          monthly cap is reached, and you get an alert well before that happens. Caps reset
          every month, and you can upgrade your plan at any time from the dashboard.
        </>
      )
    },
    {
      question: "What does white-glove onboarding include?",
      answer: (
        <>
          Two one-time packages: <b>White-glove setup</b> covers guided setup, number porting,
          and a live 1:1 training call; <b>White-glove buildout</b> adds everything in setup
          plus a full custom AiFlow buildout. Both include 30 days of priority call and video
          support.{" "}
          <Link href="/contact?topic=white-glove" className="text-signal-teal hover:underline">
            Tell us you&apos;re interested
          </Link>{" "}
          and a specialist will reach out.
        </>
      )
    }
  ];
}

export default function PricingPage() {
  const faq = buildPricingFaq();

  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
      <MarketingNav />

      <PageHero
        eyebrow="Pricing"
        title="One coworker. Every channel. Simple plans."
        subtitle="Every plan includes a dedicated private server, phone number, email, and a trained AI coworker, backed by a 30-day money-back guarantee."
      />

      <section className="mx-auto max-w-5xl px-6 pb-20">
        <PlanCards />
      </section>

      {/* Comparison table */}
      <section className="mx-auto max-w-5xl px-6 pb-20">
        <SectionHeading title="Compare plans in detail" />
        <div className="mobile-scroll-x rounded-xl border border-parchment/10">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-parchment/10 bg-parchment/[0.03] text-left">
                <th className="px-4 py-3 font-semibold text-parchment/60">Feature</th>
                <th className="px-4 py-3 font-semibold text-parchment">Starter</th>
                <th className="px-4 py-3 font-semibold text-signal-teal">Standard</th>
                <th className="px-4 py-3 font-semibold text-parchment">Enterprise</th>
              </tr>
            </thead>
            <tbody>
              {comparisonRows.map((row) => (
                <tr key={row.label} className="border-b border-parchment/5 last:border-b-0">
                  <td className="px-4 py-3 text-parchment/70">{row.label}</td>
                  <td className={`px-4 py-3 ${row.starter === DASH ? "text-parchment/30" : "text-parchment/85"}`}>
                    {row.starter}
                  </td>
                  <td className={`px-4 py-3 ${row.standard === DASH ? "text-parchment/30" : "text-parchment/85"}`}>
                    {row.standard}
                  </td>
                  <td className={`px-4 py-3 ${row.enterprise === DASH ? "text-parchment/30" : "text-parchment/85"}`}>
                    {row.enterprise}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Pricing FAQ */}
      <section className="mx-auto max-w-3xl px-6 pb-24">
        <SectionHeading title="Pricing questions, answered" />
        <FaqAccordion items={faq} />
      </section>

      <CtaBanner
        title="Ready to hire your New Coworker?"
        subtitle="Pick a plan and your coworker is live in minutes."
        ctaLabel="Choose your plan"
        ctaHref="/onboard"
      />

      <MarketingFooter />
    </div>
  );
}
