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
import { TIER_LIMITS } from "@/lib/plans/limits";
import { getPeriodPricing } from "@/lib/plans/tier";
import { CARRIER_REGISTRATION_FEE_CENTS } from "@/lib/plans/carrier-fee";
import { formatPriceCents, formatPricePerMonth } from "@/lib/pricing";

export const metadata: Metadata = {
  title: "FAQ",
  description:
    "Frequently asked questions about New Coworker: how the AI employee works, setup, number porting, privacy, billing, usage limits, and support.",
  alternates: { canonical: "/faq" },
  openGraph: {
    title: "FAQ | New Coworker",
    description: "How New Coworker works: setup, porting, privacy, billing, limits, and support.",
    url: "/faq"
  }
};

type FaqSection = {
  title: string;
  items: (FaqItem & { plainAnswer: string })[];
};

function buildSections(): FaqSection[] {
  const starterPrice = formatPricePerMonth(getPeriodPricing("starter", "biennial").monthlyCents);
  const carrierFee = formatPriceCents(CARRIER_REGISTRATION_FEE_CENTS);

  return [
    {
      title: "The product",
      items: [
        {
          question: "What exactly is New Coworker?",
          plainAnswer:
            "New Coworker is a 24/7 AI employee for your business. It answers your business phone with human-level conversation, replies to texts and emails, books appointments on your calendar, qualifies leads, and remembers every customer — all monitored from a dashboard you control.",
          answer: (
            <>
              New Coworker is a 24/7 AI employee for your business. It answers your business phone
              with human-level conversation, replies to texts and emails, books appointments on
              your calendar, qualifies leads, and remembers every customer — all monitored from a
              dashboard you control.
            </>
          )
        },
        {
          question: "How is this different from an answering service or a chatbot?",
          plainAnswer:
            "An answering service takes messages; a chatbot follows scripts. Your coworker actually handles the interaction: it answers questions from your business's real knowledge, books appointments mid-call, sends follow-up texts and emails, and runs automated workflows. It also has permanent, lossless memory, so context builds instead of resetting every conversation.",
          answer: (
            <>
              An answering service takes messages; a chatbot follows scripts. Your coworker
              actually handles the interaction: it answers questions from your business&apos;s real
              knowledge, books appointments mid-call, sends follow-up texts and emails, and runs
              automated workflows. It also has permanent, lossless memory, so context builds
              instead of resetting every conversation.
            </>
          )
        },
        {
          question: "What does my coworker know about my business?",
          plainAnswer:
            "During onboarding you answer a short questionnaire, and your coworker can read your website to learn your services, pricing, and policies. From then on it learns from every conversation. You can review and edit its memory anytime from the dashboard.",
          answer: (
            <>
              During onboarding you answer a short questionnaire, and your coworker can read your
              website to learn your services, pricing, and policies. From then on it learns from
              every conversation. You can review and edit its memory anytime from the dashboard.
            </>
          )
        },
        {
          question: "Can it transfer calls to me or my team?",
          plainAnswer:
            "Yes. Standard plans include warm handoff transfers: when a caller needs a human, your coworker brings you onto the line with the context already gathered, so the caller never repeats themselves.",
          answer: (
            <>
              Yes. Standard plans include warm handoff transfers: when a caller needs a human, your
              coworker brings you onto the line with the context already gathered, so the caller
              never repeats themselves.
            </>
          )
        }
      ]
    },
    {
      title: "Setup & phone numbers",
      items: [
        {
          question: "How long does setup take?",
          plainAnswer:
            "Minutes. After checkout, provisioning is fully automated: your dedicated server, phone number, and email are created, and your coworker is trained from your questionnaire and website. No IT project, no sales call required.",
          answer: (
            <>
              Minutes. After checkout, provisioning is fully automated: your dedicated server,
              phone number, and email are created, and your coworker is trained from your
              questionnaire and website. No IT project, no sales call required.
            </>
          )
        },
        {
          question: "Can I keep my existing business number?",
          plainAnswer:
            "Yes — Standard and Enterprise plans support bring-your-own-number porting. We handle the port and your coworker answers on your existing number. Every plan also includes a dedicated number that works from day one.",
          answer: (
            <>
              Yes — Standard and Enterprise plans support bring-your-own-number porting. We handle
              the port and your coworker answers on your existing number. Every plan also includes
              a dedicated number that works from day one.
            </>
          )
        },
        {
          question: "Can someone set everything up for me?",
          plainAnswer:
            "Yes. White-glove setup ($750) gets you a specialist who configures everything live with you, handles number porting, and trains you 1:1. White-glove buildout ($2,000) adds a full custom workflow buildout. Both include 30 days of priority call and video support.",
          answer: (
            <>
              Yes. <b>White-glove setup ($750)</b> gets you a specialist who configures everything
              live with you, handles number porting, and trains you 1:1.{" "}
              <b>White-glove buildout ($2,000)</b> adds a full custom workflow buildout. Both
              include 30 days of priority call and video support. See{" "}
              <Link href="/pricing" className="text-signal-teal hover:underline">
                pricing
              </Link>{" "}
              for details.
            </>
          )
        },
        {
          question: `What is the one-time ${carrierFee} carrier registration fee?`,
          plainAnswer:
            "US carriers require every business that sends text messages to complete 10DLC registration. We pass this one-time fee through at cost. It is charged at signup and is non-refundable because carriers do not refund it to us.",
          answer: (
            <>
              US carriers require every business that sends text messages to complete 10DLC
              registration. We pass this one-time fee through at cost. It is charged at signup and
              is non-refundable because carriers do not refund it to us.
            </>
          )
        }
      ]
    },
    {
      title: "Privacy & security",
      items: [
        {
          question: "Where does my data live?",
          plainAnswer:
            "On a private server dedicated to your business. Conversation transcripts are stored on your server — not pooled in a shared cloud with thousands of other companies. Your dashboard receives activity metadata, not your raw sensitive conversations.",
          answer: (
            <>
              On a private server dedicated to your business. Conversation transcripts are stored
              on your server — not pooled in a shared cloud with thousands of other companies. Your
              dashboard receives activity metadata, not your raw sensitive conversations.
            </>
          )
        },
        {
          question: "Is my customer data used to train AI models?",
          plainAnswer:
            "No. Your coworker's memory belongs to your business and is used only to serve your customers. We follow a deny-by-default security posture with per-business credentials throughout the platform.",
          answer: (
            <>
              No. Your coworker&apos;s memory belongs to your business and is used only to serve
              your customers. We follow a deny-by-default security posture with per-business
              credentials throughout the platform.
            </>
          )
        },
        {
          question: "What about industry compliance?",
          plainAnswer:
            "Compliance guardrails are enforced in every conversation — including Fair Housing Act rules for real estate — and Enterprise plans support custom compliance modules for other regulated industries.",
          answer: (
            <>
              Compliance guardrails are enforced in every conversation — including Fair Housing Act
              rules for real estate — and Enterprise plans support custom compliance modules for
              other regulated industries.
            </>
          )
        }
      ]
    },
    {
      title: "Billing & plans",
      items: [
        {
          question: "How much does it cost?",
          plainAnswer: `Plans start at ${starterPrice} on the 24-month Starter plan. Standard adds higher usage caps, 10 concurrent calls, RCS, Zapier, analytics, and more. Enterprise is custom. Every plan has a 30-day money-back guarantee.`,
          answer: (
            <>
              Plans start at {starterPrice} on the 24-month Starter plan. Standard adds higher
              usage caps, 10 concurrent calls, RCS, Zapier, analytics, and more. Enterprise is
              custom. Every plan has a 30-day money-back guarantee — see the full breakdown on the{" "}
              <Link href="/pricing" className="text-signal-teal hover:underline">
                pricing page
              </Link>
              .
            </>
          )
        },
        {
          question: "Why is the full term billed upfront on 12 and 24-month plans?",
          plainAnswer:
            "Because your plan includes a dedicated private server that we prepay for your whole contract. Billing the term once is what makes the discounted monthly rate possible. Monthly plans are billed month-to-month.",
          answer: (
            <>
              Because your plan includes a dedicated private server that we prepay for your whole
              contract. Billing the term once is what makes the discounted monthly rate possible.
              Monthly plans are billed month-to-month.
            </>
          )
        },
        {
          question: "Can I cancel?",
          plainAnswer:
            "Yes — every plan has a 30-day money-back window from the initial purchase date (the one-time carrier registration fee is excluded). After the term, service continues month-to-month at the renewal rate unless you start a new contract.",
          answer: (
            <>
              Yes — every plan has a 30-day money-back window from the initial purchase date (the
              one-time carrier registration fee is excluded). After the term, service continues
              month-to-month at the renewal rate unless you start a new contract.
            </>
          )
        },
        {
          question: "What happens if I hit my monthly usage caps?",
          plainAnswer: `Included usage resets monthly: for example, Standard includes 250 voice minutes and ${TIER_LIMITS.standard.smsPerMonth} SMS per month. You're alerted before you run out; at the cap, metered voice calls and customer texts pause until the next cycle or an upgrade. Compliance messages are never blocked.`,
          answer: (
            <>
              Included usage resets monthly: for example, Standard includes 250 voice minutes and{" "}
              {TIER_LIMITS.standard.smsPerMonth} SMS per month. You&apos;re alerted before you run
              out; at the cap, metered voice calls and customer texts pause until the next cycle or
              an upgrade. Compliance messages are never blocked.
            </>
          )
        },
        {
          question: "What support is included?",
          plainAnswer:
            "Starter includes email support; Standard includes priority email support; Enterprise includes an SLA with dedicated support. Live call/video support is available through the white-glove onboarding packages.",
          answer: (
            <>
              Starter includes email support; Standard includes priority email support; Enterprise
              includes an SLA with dedicated support. Live call/video support is available through
              the white-glove onboarding packages.
            </>
          )
        }
      ]
    }
  ];
}

export default function FaqPage() {
  const sections = buildSections();

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: sections.flatMap((s) =>
      s.items.map((item) => ({
        "@type": "Question",
        name: item.question,
        acceptedAnswer: { "@type": "Answer", text: item.plainAnswer }
      }))
    )
  };

  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <MarketingNav />

      <PageHero
        eyebrow="FAQ"
        title="Questions, answered"
        subtitle="Everything owners ask before hiring their New Coworker. Something missing? Email us and a human replies."
      />

      {sections.map((section) => (
        <section key={section.title} className="mx-auto max-w-3xl px-6 pb-14">
          <SectionHeading title={section.title} />
          <FaqAccordion items={section.items} />
        </section>
      ))}

      <CtaBanner
        title="Still curious? Try it risk-free"
        subtitle="Every plan comes with a 30-day money-back guarantee."
        ctaLabel="Get Started"
        ctaHref="/onboard"
      />

      <MarketingFooter />
    </div>
  );
}
