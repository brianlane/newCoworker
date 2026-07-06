import type { Metadata } from "next";
import Link from "next/link";
import { Briefcase, LifeBuoy, Mail, Users } from "lucide-react";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import { PageHero } from "@/components/marketing/sections";

export const metadata: Metadata = {
  title: "Contact",
  description:
    "Get in touch with New Coworker: sales for Enterprise plans, support for existing customers, and white-glove onboarding.",
  alternates: { canonical: "/contact" },
  openGraph: {
    title: "Contact | New Coworker",
    description: "Sales, support, and white-glove onboarding — a human replies.",
    url: "/contact"
  }
};

const CONTACT_EMAIL = process.env.CONTACT_EMAIL ?? "team@newcoworker.com";

const channels = [
  {
    title: "Support",
    description:
      "Existing customers: email us and a human replies. Standard plans get priority handling; white-glove customers have a 30-day priority call & video line.",
    email: CONTACT_EMAIL,
    subject: "Support request",
    Icon: LifeBuoy
  },
  {
    title: "Enterprise sales",
    description:
      "Multi-location, agency, white-label, or custom compliance needs? Tell us about your business and we'll put a proposal together.",
    email: "contact@newcoworker.com",
    subject: "Enterprise inquiry",
    Icon: Briefcase
  },
  {
    title: "White-glove onboarding",
    description:
      "Want a specialist to set everything up live with you — porting, training, and custom workflow buildout included?",
    email: CONTACT_EMAIL,
    subject: "White-glove onboarding",
    Icon: Users
  },
  {
    title: "Everything else",
    description: "Partnerships, press, or a question that doesn't fit a box — we read it all.",
    email: CONTACT_EMAIL,
    subject: "Hello",
    Icon: Mail
  }
];

export default function ContactPage() {
  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
      <MarketingNav />

      <PageHero
        eyebrow="Contact"
        title="Talk to a human"
        subtitle="Our coworker answers our phones too — but every email below lands with a person."
      />

      <section className="mx-auto max-w-4xl px-6 pb-20">
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          {channels.map((c) => (
            <a
              key={c.title}
              href={`mailto:${c.email}?subject=${encodeURIComponent(c.subject)}`}
              className="group rounded-xl border border-parchment/10 bg-parchment/[0.02] p-7 transition-colors hover:border-claw-green/40"
            >
              <c.Icon className="mb-4 h-6 w-6 text-claw-green" />
              <h2 className="font-semibold text-parchment">{c.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-parchment/50">{c.description}</p>
              <p className="mt-4 text-sm font-semibold text-signal-teal group-hover:underline">{c.email}</p>
            </a>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-6 pb-24 text-center">
        <p className="text-sm text-parchment/45">
          Looking for answers right now? The{" "}
          <Link href="/faq" className="text-signal-teal hover:underline">
            FAQ
          </Link>{" "}
          covers setup, billing, privacy, and porting — or see{" "}
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
