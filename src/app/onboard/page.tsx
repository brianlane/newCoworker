import Image from "next/image";
import type { Metadata } from "next";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";

const tiers = [
  {
    id: "starter" as const,
    name: "Starter",
    price: "$199/mo",
    setup: "No setup fee",
    features: [
      "AI voice coworker",
      "Twilio phone number",
      "Basic memory",
      "Browser accessibility",
      "Dashboard access",
    ],
    cta: "Choose Starter",
    highlight: false
  },
  {
    id: "standard" as const,
    name: "Standard",
    price: "$299/mo",
    setup: "$499 one-time setup",
    features: [
      "Everything in Starter",
      "Full Lossless Claw memory",
      "Swarm reasoning",
      "Custom soul injection",
      "Priority support & maintenance",
      "Lightpanda browser skills",
      "Chat integration"
    ],
    cta: "Choose Standard",
    highlight: true
  },
  {
    id: "enterprise" as const,
    name: "Enterprise",
    price: "Custom",
    setup: "Contact us",
    features: [
      "Everything in Standard",
      "Multi-tenant agency setup",
      "White-label dashboard",
      "SLA + dedicated support",
      "Custom compliance modules",
      "Quarterly strategy reviews",
      "Analytics and reporting"
    ],
    cta: "Contact Sales",
    highlight: false
  }
];

export const metadata: Metadata = {
  title: "Pricing and Plans",
  description: "Compare Starter, Standard, and Enterprise plans to choose the right AI coworker setup for your business.",
  alternates: {
    canonical: "/onboard"
  },
  openGraph: {
    title: "New Coworker Pricing Plans",
    description: "Choose the plan that fits your business and launch your AI coworker quickly.",
    url: "/onboard",
    images: ["/opengraph-image"]
  },
  twitter: {
    card: "summary_large_image",
    title: "New Coworker Pricing Plans",
    description: "Choose the plan that fits your business and launch your AI coworker quickly.",
    images: ["/twitter-image"]
  }
};

export default function OnboardPage() {
  return (
    <div className="min-h-screen bg-deep-ink px-4 py-12">
      <div className="max-w-5xl mx-auto space-y-10">
        <div className="text-center space-y-3">
          <Image
            src="/logo.png"
            alt="New Coworker"
            width={56}
            height={56}
            className="rounded-full mx-auto"
          />
          <h1 className="text-3xl font-bold text-parchment">Choose your plan</h1>
          <p className="text-parchment/50 max-w-md mx-auto">
            Your new coworker will handle calls, texts, emails, and more, so you can focus on your business.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {tiers.map((tier) => (
            <Card
              key={tier.id}
              className={[
                "flex flex-col",
                tier.highlight ? "border-signal-teal/50 ring-1 ring-signal-teal/30" : ""
              ].join(" ")}
            >
              {tier.highlight && (
                <div className="mb-3">
                  <Badge variant="pending">Most Popular</Badge>
                </div>
              )}

              <h2 className="text-lg font-bold text-parchment">{tier.name}</h2>
              <p className="text-3xl font-bold text-claw-green mt-1">{tier.price}</p>
              <p className="text-xs text-parchment/40 mt-0.5">{tier.setup}</p>

              <ul className="mt-5 space-y-2 flex-1">
                {tier.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm text-parchment/70">
                    <span className="text-claw-green mt-0.5">✓</span>
                    {f}
                  </li>
                ))}
              </ul>

              <div className="mt-6">
                {tier.id === "enterprise" ? (
                  <a
                    href={`mailto:${process.env.CONTACT_EMAIL ?? "newcoworkerteam@gmail.com"}`}
                    className="block w-full text-center rounded-lg border border-parchment/20 text-parchment px-4 py-2.5 text-sm font-semibold hover:bg-parchment/10 transition-colors"
                  >
                    {tier.cta}
                  </a>
                ) : (
                  <a
                    href={`/onboard/questionnaire?tier=${tier.id}`}
                    className={[
                      "block w-full text-center rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors",
                      tier.highlight
                        ? "bg-signal-teal text-deep-ink hover:bg-opacity-90"
                        : "bg-claw-green text-deep-ink hover:bg-opacity-90"
                    ].join(" ")}
                  >
                    {tier.cta}
                  </a>
                )}
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
