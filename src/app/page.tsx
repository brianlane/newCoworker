import Image from "next/image";
import Link from "next/link";
import type { Metadata } from "next";
import { Phone, Brain, Zap, ShieldCheck, LayoutDashboard, Rocket } from "lucide-react";
import type { ComponentType, SVGProps } from "react";

type FeatureItem = {
  title: string;
  description: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
};

const features: FeatureItem[] = [
  {
    title: "AI Voice Coworker",
    description: "Acts on your behalf as your virtual assistant 24/7 with human-level conversation.",
    Icon: Phone,
  },
  {
    title: "Permanent Memory",
    description: "Lossless Claw memory learns your business over time so every interaction builds context.",
    Icon: Brain,
  },
  {
    title: "Multi-Model Reasoning",
    description: "Multi-model swarm reasoning handles complex questions other bots can't.",
    Icon: Zap,
  },
  {
    title: "Compliance Guardrails",
    description: "Built-in compliance guardrails protect your business from costly violations.",
    Icon: ShieldCheck,
  },
  {
    title: "Your Dashboard",
    description: "Monitor activity, review memory, manage notifications — all in one place.",
    Icon: LayoutDashboard,
  },
  {
    title: "Deploy in Minutes",
    description: "One-click provisioning: VPS, voice agent, phone number all handled automatically.",
    Icon: Rocket,
  },
];

export const metadata: Metadata = {
  description: "New Coworker gives your business a 24/7 AI employee to answer calls, handle messages, and keep operations moving.",
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
  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
      {/* Nav */}
      <nav className="flex items-center justify-between max-w-6xl mx-auto px-6 py-5">
        <div className="flex items-center gap-3">
          <Image src="/logo.png" alt="New Coworker" width={36} height={36} className="rounded-full" />
          <span className="text-lg font-bold tracking-tight">New Coworker</span>
        </div>
        <div className="flex items-center gap-4">
          <Link href="/login" className="text-sm text-parchment/60 hover:text-parchment transition-colors">
            Sign in
          </Link>
          <Link
            href="/onboard"
            className="rounded-lg bg-claw-green text-deep-ink px-4 py-2 text-sm font-semibold hover:bg-opacity-90 transition-colors"
          >
            Get Started
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-4xl mx-auto px-6 pt-20 pb-24 text-center">
        <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold leading-tight tracking-tight">
          Your AI employee that
          <span className="text-claw-green"> never sleeps</span>
        </h1>
        <p className="mt-6 text-lg text-parchment/60 max-w-2xl mx-auto leading-relaxed">
          New Coworker answers calls, texts, emails, and more around the clock.
          Built for all <b>businesses</b>.
        </p>
        <div className="mt-10">
          <Link
            href="/onboard"
            className="inline-block rounded-lg bg-claw-green text-deep-ink px-8 py-3.5 text-sm font-semibold hover:bg-opacity-90 transition-colors"
          >
            Start for $9.99/mo
          </Link>
        </div>
      </section>

      {/* Features */}
      <section className="max-w-6xl mx-auto px-6 pb-24">
        <h2 className="text-center text-2xl font-bold mb-12">
          Everything your business needs, <span className="text-signal-teal">handled</span>
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((f) => (
            <div
              key={f.title}
              className="rounded-xl border border-parchment/10 bg-parchment/[0.02] p-6 hover:border-signal-teal/30 transition-colors"
            >
              <div className="flex items-center gap-2 mb-2">
                <f.Icon className="w-5 h-5 text-claw-green shrink-0" />
                <h3 className="font-semibold text-parchment">{f.title}</h3>
              </div>
              <p className="text-sm text-parchment/50 leading-relaxed">{f.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="max-w-3xl mx-auto px-6 pb-24 text-center">
        <div className="rounded-2xl border border-claw-green/20 bg-claw-green/5 p-10">
          <h2 className="text-2xl font-bold mb-3">Ready to hire your New Coworker?</h2>
          <p className="text-parchment/50 mb-8">
            New coworker starts learning from day one.
          </p>
          <Link
            href="/onboard"
            className="inline-block rounded-lg bg-claw-green text-deep-ink px-8 py-3.5 text-sm font-semibold hover:bg-opacity-90 transition-colors"
          >
            Choose your plan
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-parchment/10 py-8">
        <div className="max-w-6xl mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-xs text-parchment/30">&copy; {new Date().getFullYear()} New Coworker. All rights reserved.</p>
          <div className="flex gap-6 text-xs text-parchment/30">
            <a href={`mailto:${process.env.CONTACT_EMAIL ?? "newcoworkerteam@gmail.com"}`} className="hover:text-parchment/60 transition-colors">Contact</a>
            <Link href="/onboard" className="hover:text-parchment/60 transition-colors">Pricing</Link>
            <Link href="/privacy" className="hover:text-parchment/60 transition-colors">Privacy Policy</Link>
            <Link href="/terms" className="hover:text-parchment/60 transition-colors">Terms of Service</Link>
            <Link href="/login" className="hover:text-parchment/60 transition-colors">Sign in</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
