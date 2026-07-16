import type { Metadata } from "next";
import Link from "next/link";
import { Brain, Lock, Server, Sparkles } from "lucide-react";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import { CtaBanner, PageHero, SectionHeading } from "@/components/marketing/sections";

export const metadata: Metadata = {
  title: "About",
  description:
    "New Coworker builds privacy-first digital employees for small businesses: autonomous AI coworkers that run on dedicated infrastructure and act like a real extension of your team.",
  alternates: { canonical: "/about" },
  openGraph: {
    title: "About | New Coworker",
    description:
      "Privacy-first digital employees for small businesses, on infrastructure dedicated to each customer.",
    url: "/about"
  }
};

const principles = [
  {
    title: "Privacy is architecture, not a policy page",
    description:
      "Every business's AI coworker runs on its own dedicated server with its own credentials, and your data is isolated per business, never shared with other companies, and always yours to export. We built it this way because trust shouldn't require reading the fine print.",
    Icon: Lock
  },
  {
    title: "An employee, not a chatbot",
    description:
      "Chatbots respond; coworkers act. Ours books appointments, sends follow-ups, updates records, transfers calls with context, and runs workflows, because small business owners need the work done, not another inbox to manage.",
    Icon: Sparkles
  },
  {
    title: "Memory that compounds",
    description:
      "Typical AI tools forget everything between sessions. Your coworker keeps permanent, lossless memory of your business and customers, so every conversation makes the next one better.",
    Icon: Brain
  },
  {
    title: "Own the stack, own the promise",
    description:
      "We run the infrastructure end to end (voice, messaging, memory, and automation), so when we promise your calls get answered, no third-party black box can break that promise.",
    Icon: Server
  }
];

export default function AboutPage() {
  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
      <MarketingNav />

      <PageHero
        eyebrow="About"
        title={
          <>
            Small businesses deserve a <span className="text-claw-green">great first hire</span>
          </>
        }
        subtitle="New Coworker exists because the people who run small businesses are too busy running them to answer every call, chase every lead, and remember every detail. So we built an employee that does."
      />

      <section className="mx-auto max-w-3xl px-6 pb-20">
        <div className="space-y-5 leading-relaxed text-parchment/65">
          <p>
            The hardest part of a small business isn&apos;t the craft. It&apos;s the chaos around
            it. The call that comes in during a job. The lead that goes cold overnight. The
            follow-up that slips because the day ran long. Owners lose real revenue to work that
            is important but impossible to be present for.
          </p>
          <p>
            Big companies solve this with staff. We think small businesses deserve the same,
            without the payroll. New Coworker gives every business a digital employee that answers
            calls with human-level conversation, texts and emails customers, books appointments,
            qualifies leads, and follows up relentlessly, twenty-four hours a day.
          </p>
          <p>
            And because a coworker knows things a vendor never should, we made privacy the
            foundation: your business is strictly isolated from every other, business stays your
            business, and your coworker&apos;s memory works for you alone.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-20">
        <SectionHeading eyebrow="What we believe" title="The principles behind the product" />
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          {principles.map((p) => (
            <div key={p.title} className="rounded-xl border border-parchment/10 bg-parchment/[0.02] p-7">
              <p.Icon className="mb-4 h-6 w-6 text-claw-green" />
              <h3 className="font-semibold text-parchment">{p.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-parchment/50">{p.description}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-6 pb-24 text-center">
        <p className="text-parchment/55">
          Questions about the company, partnerships, or press?{" "}
          <Link href="/contact" className="text-signal-teal hover:underline">
            Get in touch
          </Link>
          .
        </p>
      </section>

      <CtaBanner
        title="Meet your first digital employee"
        subtitle="Live in minutes, learning from day one."
        ctaLabel="Get Started"
        ctaHref="/onboard"
      />

      <MarketingFooter />
    </div>
  );
}
