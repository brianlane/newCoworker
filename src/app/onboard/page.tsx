"use client";

import Image from "next/image";
import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import type { BillingPeriod } from "@/lib/plans/tier";
import { formatPriceCents, formatPricePerMonth } from "@/lib/pricing";
import { getPeriodPricing, getCommitmentMonths, PlanTier, calculateSavingsPercentage } from "@/lib/plans/tier";

export const dynamic = "force-dynamic";

type PeriodOption = {
  id: BillingPeriod;
  label: string;
  months: number;
};

const PERIOD_OPTIONS: PeriodOption[] = [
  { id: "biennial", label: "24 months", months: 24 },
  { id: "annual", label: "12 months", months: 12 },
  { id: "monthly", label: "1 month", months: 1 }
];

const PERIOD_LABEL: Record<BillingPeriod, string> = {
  biennial: "24-month plan",
  annual: "12-month plan",
  monthly: "1-month plan"
};

function getTierPricingDisplay(tier: PlanTier, period: BillingPeriod) {
  const pricing = getPeriodPricing(tier, period);
  const months = getCommitmentMonths(period);
  return {
    monthly: formatPricePerMonth(pricing.monthlyCents),
    renewal: formatPricePerMonth(pricing.renewalMonthlyCents),
    total: formatPriceCents(pricing.monthlyCents * months)
  };
}

export default function OnboardPage() {
  const [period, setPeriod] = useState<BillingPeriod>("biennial");

  const starterPrice = getTierPricingDisplay("starter", period);
  const standardPrice = getTierPricingDisplay("standard", period);
  const biennialSavings = period === "biennial" ? calculateSavingsPercentage("starter", "biennial") : 0;

  const tiers = [
    {
      id: "starter" as const,
      name: "Starter",
      price: starterPrice.monthly,
      renewal: `Renews at ${starterPrice.renewal}`,
      total:
        period !== "monthly"
          ? `${starterPrice.total} total for ${PERIOD_LABEL[period]}`
          : undefined,
      setup: "No setup fee · 30-day money-back guarantee",
      features: [
        "AI voice coworker (inworld.ai)",
        "Twilio phone number",
        "Lossless memory",
        "1 hour voice / day",
        "100 SMS / day · 10 calls / day",
        "1 concurrent call",
        "Browser accessibility",
        "Dashboard access"
      ],
      cta: "Choose Starter",
      highlight: false,
      badge: period === "biennial" ? "Best Value" : undefined
    },
    {
      id: "standard" as const,
      name: "Standard",
      price: standardPrice.monthly,
      renewal: `Renews at ${standardPrice.renewal}`,
      total:
        period !== "monthly"
          ? `${standardPrice.total} total for ${PERIOD_LABEL[period]}`
          : undefined,
      setup: "No setup fee · 30-day money-back guarantee",
      features: [
        "Everything in Starter, plus:",
        "Unlimited voice, SMS, and calls",
        "3 concurrent calls",
        "Full Swarm reasoning + deep reasoning (35B-A3B)",
        "Custom soul injection",
        "Priority support & maintenance",
        "Lightpanda browser skills"
      ],
      cta: "Choose Standard",
      highlight: true,
      badge: "Most Popular"
    },
    {
      id: "enterprise" as const,
      name: "Enterprise",
      price: "Custom",
      renewal: undefined,
      total: undefined,
      setup: "Contact us for pricing",
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
      highlight: false,
      badge: undefined
    }
  ];

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

        {/* Billing period selector */}
        <div className="flex justify-center">
          <div className="inline-flex rounded-lg border border-parchment/20 p-1 gap-1">
            {PERIOD_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                onClick={() => setPeriod(opt.id)}
                className={[
                  "px-4 py-2 rounded-md text-sm font-medium transition-colors",
                  period === opt.id
                    ? "bg-claw-green text-deep-ink"
                    : "text-parchment/60 hover:text-parchment"
                ].join(" ")}
              >
                {opt.label}
                {opt.id === "biennial" && (
                  <span className="ml-1.5 text-xs bg-signal-teal/20 text-signal-teal rounded px-1">
                    Save {biennialSavings}%
                  </span>
                )}
              </button>
            ))}
          </div>
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
              {tier.badge && (
                <div className="mb-3">
                  <Badge variant="pending">{tier.badge}</Badge>
                </div>
              )}

              <h2 className="text-lg font-bold text-parchment">{tier.name}</h2>
              <p className="text-3xl font-bold text-claw-green mt-1">{tier.price}</p>

              {tier.renewal && (
                <p className="text-xs text-parchment/40 mt-0.5">{tier.renewal}</p>
              )}
              {tier.total && (
                <p className="text-xs text-parchment/30 mt-0.5">{tier.total}</p>
              )}
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
                    href="mailto:newcoworkerteam@gmail.com"
                    className="block w-full text-center rounded-lg border border-parchment/20 text-parchment px-4 py-2.5 text-sm font-semibold hover:bg-parchment/10 transition-colors"
                  >
                    {tier.cta}
                  </a>
                ) : (
                  <a
                    href={`/onboard/questionnaire?tier=${tier.id}&period=${period}`}
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
