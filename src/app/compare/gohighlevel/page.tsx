import type { Metadata } from "next";
import Link from "next/link";
import { Check, Minus, X } from "lucide-react";
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

export const metadata: Metadata = {
  title: "New Coworker vs GoHighLevel",
  description:
    "GoHighLevel gives you software to run yourself. New Coworker gives you an AI employee that runs it for you: calls answered, Meta ad leads texted back in seconds, and follow-up handled — at a fraction of the all-in cost.",
  alternates: { canonical: "/compare/gohighlevel" },
  openGraph: {
    title: "New Coworker vs GoHighLevel",
    description:
      "A toolbox you operate vs an employee that operates itself. An honest comparison for small businesses.",
    url: "/compare/gohighlevel"
  }
};

type RowVerdict = "us" | "them" | "tie";

type CompareRow = {
  label: string;
  us: string;
  them: string;
  verdict: RowVerdict;
};

/**
 * GoHighLevel figures reflect their published pricing and plan docs as of
 * July 2026 (gohighlevel.com pricing + HighLevel support portal: $97/$297/
 * $497 base plans; AI Employee Unlimited $97/mo per location; SMS, email,
 * voice, and premium AI usage billed separately). Keep sourced and current —
 * an inaccurate competitor claim hurts more than it helps.
 */
const rows: CompareRow[] = [
  {
    label: "What you're buying",
    us: "An AI employee that answers, texts, books, and follows up on its own",
    them: "A software toolbox (CRM, funnels, workflows) you configure and operate",
    verdict: "us"
  },
  {
    label: "Setup",
    us: "A 15-minute guided interview; live the same day, done-for-you",
    them: "Agency + sub-account setup, phone/email wiring, workflow building — reviewers report weeks to feel comfortable",
    verdict: "us"
  },
  {
    label: "24/7 AI call answering",
    us: "Included on every plan, up to 10 concurrent calls on Standard",
    them: "Voice AI available, but per-minute usage or the AI Employee add-on, configured by you",
    verdict: "us"
  },
  {
    label: "Meta (Facebook/Instagram) lead capture",
    us: "Guided setup; lead texted back in seconds and conversation handled end-to-end",
    them: "Native integration into the CRM; you build the follow-up workflows yourself",
    verdict: "tie"
  },
  {
    label: "AI included in the price",
    us: "Yes — conversation AI, voice AI, summaries, and workflows are the product",
    them: "Extra: AI Employee is $97/mo per location (or metered per message/minute) on top of the plan",
    verdict: "us"
  },
  {
    label: "Usage billing",
    us: "Generous monthly quotas included; clear caps, no surprise per-message AI fees",
    them: "SMS, email, voice, and premium AI are metered on top of the subscription",
    verdict: "us"
  },
  {
    label: "Infrastructure",
    us: "A dedicated private server per business — isolated compute and credentials",
    them: "Shared multi-tenant SaaS",
    verdict: "us"
  },
  {
    label: "Funnels, websites & courses",
    us: "Not our product — we integrate with what you already use",
    them: "Full builder suite included; genuinely strong here",
    verdict: "them"
  },
  {
    label: "Agency white-labeling & resale",
    us: "Enterprise white-label exists, but agencies aren't our focus",
    them: "SaaS Mode resale is what GoHighLevel is built around",
    verdict: "them"
  },
  {
    label: "Who it's really for",
    us: "A business owner who wants outcomes without becoming a software operator",
    them: "Agencies managing many clients, or owners happy to build and maintain systems",
    verdict: "tie"
  }
];

function VerdictIcon({ verdict, side }: { verdict: RowVerdict; side: "us" | "them" }) {
  if (verdict === "tie") return <Minus className="h-4 w-4 shrink-0 text-parchment/40" />;
  if (verdict === side) return <Check className="h-4 w-4 shrink-0 text-claw-green" />;
  return <X className="h-4 w-4 shrink-0 text-parchment/30" />;
}

export default function CompareGoHighLevelPage() {
  const standardMonthly = formatPricePerMonth(getPeriodPricing("standard", "biennial").monthlyCents);
  const starterMonthly = formatPricePerMonth(getPeriodPricing("starter", "biennial").monthlyCents);

  const faq = [
    {
      question: "Isn't GoHighLevel cheaper at $97/month?",
      answer: (
        <>
          The $97 Starter plan is the entry ticket, not the running cost. To match what New
          Coworker does out of the box you&apos;d add the AI Employee plan ($97/mo per location per
          HighLevel&apos;s published pricing), plus metered SMS, email, and voice usage — and your
          own hours configuring and maintaining it. New Coworker Standard is {standardMonthly} with
          the AI, the phone number, and generous usage quotas included, working on day one.
        </>
      )
    },
    {
      question: "Can New Coworker capture my Facebook and Instagram ad leads like GoHighLevel?",
      answer: (
        <>
          Yes. A guided in-dashboard setup connects your Meta lead ads in about 15 minutes, and
          from then on every lead is texted back within seconds, filed with full context, routed to
          your team if you want, and followed up automatically. The difference is what happens after
          capture: GoHighLevel stores the lead and runs the workflows you built; your coworker
          handles the actual conversation.
        </>
      )
    },
    {
      question: "When is GoHighLevel the better choice?",
      answer: (
        <>
          If you&apos;re an agency reselling software to clients, or you want to build funnels,
          websites, and courses inside one platform and have the time to run it, GoHighLevel is a
          strong product — that&apos;s what it was built for. New Coworker is built for the business
          owner who wants the phone answered and the leads worked without operating software.
        </>
      )
    },
    {
      question: "Can I use both?",
      answer: (
        <>
          Yes. Plenty of businesses keep their existing CRM and let New Coworker do the answering
          and follow-up. Zapier, webhooks, and our API push every call, text, and lead into
          whatever system you run — including GoHighLevel.
        </>
      )
    },
    {
      question: "What does switching involve?",
      answer: (
        <>
          Signup to live coworker takes minutes: pick a plan, answer a 15-minute interview, and
          your number, email, and trained coworker are provisioned automatically. You can port your
          existing business number in, import contacts by CSV, and there&apos;s a 30-day money-back
          guarantee.
        </>
      )
    }
  ];

  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
      <MarketingNav />

      <PageHero
        eyebrow="New Coworker vs GoHighLevel"
        title={
          <>
            One sells you software. <span className="text-claw-green">We show up to work.</span>
          </>
        }
        subtitle="GoHighLevel is a powerful toolbox — if you have the time to learn it, build in it, and run it. New Coworker is an AI employee that answers your calls, texts your ad leads back in seconds, and follows up on its own, starting the day you sign up."
      />

      <StatBand
        stats={[
          { value: "15 min", label: "Guided setup vs weeks of platform ramp-up" },
          { value: "Seconds", label: "Meta ad lead to personal text-back, automatically" },
          { value: "Included", label: "AI answering & follow-up — no $97/mo AI add-on" },
          { value: starterMonthly, label: "Plans start here, all-in, 30-day guarantee" }
        ]}
      />

      {/* Comparison table */}
      <section className="mx-auto max-w-6xl px-6 pb-20">
        <SectionHeading
          eyebrow="Side by side"
          title="An honest comparison"
          subtitle="GoHighLevel details reflect their published pricing and plan documentation as of July 2026. Where they're stronger, we say so."
        />
        <div className="mobile-scroll-x overflow-x-auto rounded-2xl border border-parchment/10">
          <table className="w-full min-w-[720px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-parchment/10 bg-parchment/[0.03]">
                <th className="px-5 py-4 font-semibold text-parchment/60"> </th>
                <th className="px-5 py-4 font-semibold text-claw-green">New Coworker</th>
                <th className="px-5 py-4 font-semibold text-parchment/70">GoHighLevel</th>
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
          eyebrow="The real difference"
          title="Tools wait for you. Employees don't."
        />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-8">
            <h3 className="text-lg font-bold text-parchment">With GoHighLevel, a Meta lead means…</h3>
            <ul className="mt-4 space-y-3 text-sm leading-relaxed text-parchment/55">
              <li>The lead lands in your CRM pipeline.</li>
              <li>The workflows you built (and maintain) fire — if you built them.</li>
              <li>Replies come back to your unified inbox, waiting for a human.</li>
              <li>You (or staff you pay) work the conversation to a booking.</li>
            </ul>
          </div>
          <div className="rounded-2xl border border-claw-green/25 bg-claw-green/[0.04] p-8">
            <h3 className="text-lg font-bold text-parchment">With New Coworker, the same lead means…</h3>
            <ul className="mt-4 space-y-3 text-sm leading-relaxed text-parchment/55">
              <li>The lead is texted back within seconds, from your business number.</li>
              <li>Your coworker holds the conversation: answers questions, qualifies, books.</li>
              <li>The lead is filed with full context and routed to your team if you want.</li>
              <li>You get a summary. That&apos;s your whole job in the loop.</li>
            </ul>
          </div>
        </div>
        <p className="mx-auto mt-8 max-w-3xl text-center text-sm leading-relaxed text-parchment/45">
          Independent reviews consistently describe GoHighLevel as powerful but dense — built for
          agencies, with a learning curve owners should plan weeks for. That&apos;s not a knock;
          it&apos;s a different product. If you want to <em>run</em> a marketing platform, buy the
          platform. If you want your phone answered and your leads worked,{" "}
          <Link href="/onboard" className="text-claw-green hover:underline">
            hire the coworker
          </Link>
          .
        </p>
      </section>

      <section className="mx-auto max-w-3xl px-6 pb-20">
        <SectionHeading eyebrow="FAQ" title="Common questions" />
        <FaqAccordion items={faq} />
      </section>

      <CtaBanner
        title="Put an employee on it, not another login"
        subtitle="Live in minutes, Meta leads answered in seconds, 30-day money-back guarantee."
        ctaLabel="Get Started"
        ctaHref="/onboard"
      />

      <MarketingFooter />
    </div>
  );
}
