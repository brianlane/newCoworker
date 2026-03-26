import Image from "next/image";
import Link from "next/link";

const features = [
  {
    title: "AI Voice Coworker",
    description: "Answers calls, qualifies leads, books showings — 24/7 with human-level conversation.",
    icon: "🗣️",
  },
  {
    title: "Permanent Memory",
    description: "Lossless Claw memory learns your business over time — every interaction builds context.",
    icon: "🧠",
  },
  {
    title: "Multi-Model Reasoning",
    description: "Qwen + Llama swarm reasoning handles complex questions other bots can't.",
    icon: "⚡",
  },
  {
    title: "FHA Compliant",
    description: "Built-in Fair Housing Act guardrails protect your business from costly violations.",
    icon: "🛡️",
  },
  {
    title: "Your Dashboard",
    description: "Monitor activity, review memory, manage notifications — all in one place.",
    icon: "📊",
  },
  {
    title: "Deploy in Minutes",
    description: "One-click provisioning: VPS, voice agent, phone number — handled automatically.",
    icon: "🚀",
  },
];

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
            href="/signup"
            className="rounded-lg bg-claw-green text-deep-ink px-4 py-2 text-sm font-semibold hover:bg-opacity-90 transition-colors"
          >
            Get Started
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-4xl mx-auto px-6 pt-20 pb-24 text-center">
        <div className="inline-block rounded-full bg-claw-green/10 border border-claw-green/20 px-4 py-1.5 text-xs font-medium text-claw-green mb-6">
          Now accepting early customers
        </div>
        <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold leading-tight tracking-tight">
          Your AI employee that
          <span className="text-claw-green"> never sleeps</span>
        </h1>
        <p className="mt-6 text-lg text-parchment/60 max-w-2xl mx-auto leading-relaxed">
          New Coworker answers calls, qualifies leads, and updates your CRM around the clock.
          Built for real estate, dental, HVAC, and service businesses.
        </p>
        <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
          <Link
            href="/onboard"
            className="rounded-lg bg-claw-green text-deep-ink px-8 py-3.5 text-sm font-semibold hover:bg-opacity-90 transition-colors"
          >
            Start for $199/mo
          </Link>
          <Link
            href="/login"
            className="rounded-lg border border-parchment/20 px-8 py-3.5 text-sm font-semibold text-parchment hover:bg-parchment/5 transition-colors"
          >
            Sign in to dashboard
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
              <div className="text-2xl mb-3">{f.icon}</div>
              <h3 className="font-semibold text-parchment mb-1">{f.title}</h3>
              <p className="text-sm text-parchment/50 leading-relaxed">{f.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="max-w-3xl mx-auto px-6 pb-24 text-center">
        <div className="rounded-2xl border border-claw-green/20 bg-claw-green/5 p-10">
          <h2 className="text-2xl font-bold mb-3">Ready to hire your AI coworker?</h2>
          <p className="text-parchment/50 mb-8">
            No long-term contracts. Cancel anytime. Your coworker starts learning from day one.
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
            <a href="mailto:sales@newcoworker.com" className="hover:text-parchment/60 transition-colors">Contact</a>
            <Link href="/onboard" className="hover:text-parchment/60 transition-colors">Pricing</Link>
            <Link href="/login" className="hover:text-parchment/60 transition-colors">Sign in</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
