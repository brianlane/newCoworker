import type { Metadata } from "next";
import Link from "next/link";
import { Briefcase, LifeBuoy, Mail, Users } from "lucide-react";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import { ContactForm } from "@/components/marketing/ContactForm";
import { JsonLd } from "@/components/marketing/JsonLd";
import { PageHero } from "@/components/marketing/sections";

const CONTACT_PAGE_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "ContactPage",
  name: "Contact New Coworker",
  url: "https://newcoworker.com/contact",
  description:
    "Contact New Coworker for sales, support, white-glove onboarding, and partnerships. Most inquiries receive a response within 24 hours.",
  about: { "@id": "https://newcoworker.com/#organization" }
};

export const metadata: Metadata = {
  title: "Contact",
  description:
    "Get in touch with New Coworker: sales for Enterprise plans, support for existing customers, and white-glove onboarding. Most inquiries receive a response within 24 hours.",
  alternates: { canonical: "/contact" },
  openGraph: {
    title: "Contact | New Coworker",
    description: "Sales, support, and white-glove onboarding. A human replies within 24 hours.",
    url: "/contact"
  }
};

const topics = [
  {
    title: "Support",
    description:
      "Existing customers get a human reply. Standard plans get priority handling; white-glove customers have a 30-day priority call & video line.",
    Icon: LifeBuoy
  },
  {
    title: "Enterprise sales",
    description:
      "Multi-location, agency, white-label, or custom compliance needs? Tell us about your business and we'll put a proposal together.",
    Icon: Briefcase
  },
  {
    title: "White-glove onboarding",
    description:
      "Want a specialist to set everything up live with you? Porting, training, and custom workflow buildout included.",
    Icon: Users
  },
  {
    title: "Everything else",
    description: "Partnerships, press, or a question that doesn't fit a box. We read it all.",
    Icon: Mail
  }
];

/**
 * Known ?topic= values map to a prefilled form subject so CTAs elsewhere
 * (e.g. the white-glove lead button on /pricing) land as labeled leads.
 */
const TOPIC_SUBJECTS: Record<string, string> = {
  "white-glove": "White-glove onboarding",
  enterprise: "Enterprise inquiry",
  support: "Support request"
};

export default async function ContactPage({
  searchParams
}: {
  searchParams: Promise<{ topic?: string }>;
}) {
  const { topic } = await searchParams;
  const defaultSubject = topic ? TOPIC_SUBJECTS[topic] : undefined;

  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
      <JsonLd data={CONTACT_PAGE_JSON_LD} />
      <MarketingNav />

      <PageHero
        eyebrow="Contact"
        title="Talk to a human"
        subtitle="Our coworker answers our phones too, but every message below lands with a person."
      />

      <section className="mx-auto max-w-6xl px-6 pb-20">
        <div className="flex flex-col items-start gap-10 lg:flex-row">
          <div className="min-w-0 flex-1">
            <h2 className="text-3xl font-bold text-parchment">
              Send us a <span className="text-claw-green">message</span>
            </h2>
            <p className="mt-4 leading-relaxed text-parchment/60">
              Whether you&apos;re evaluating plans, need help with setup or billing, or want a
              specialist to build everything out with you, use the form and we&apos;ll reply as
              quickly as possible. Most inquiries receive a response within 24 hours.
            </p>

            <div className="mt-8 grid grid-cols-1 gap-5 sm:grid-cols-2">
              {topics.map((t) => (
                <div key={t.title} className="rounded-xl border border-parchment/10 bg-parchment/[0.02] p-5">
                  <t.Icon className="mb-3 h-5 w-5 text-claw-green" />
                  <h3 className="text-sm font-semibold text-parchment">{t.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-parchment/50">{t.description}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="w-full flex-shrink-0 lg:max-w-md">
            <ContactForm defaultSubject={defaultSubject} />
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-6 pb-24 text-center">
        <p className="text-sm text-parchment/45">
          Looking for answers right now? The{" "}
          <Link href="/faq" className="text-signal-teal hover:underline">
            FAQ
          </Link>{" "}
          covers setup, billing, privacy, and porting, or see{" "}
          <Link href="/pricing" className="text-signal-teal hover:underline">
            plans and pricing
          </Link>
          .
        </p>
      </section>

      <MarketingFooter />
    </div>
  );
}
