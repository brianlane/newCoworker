"use client";

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import type { BillingPeriod } from "@/lib/plans/tier";
import { formatPriceCents } from "@/lib/pricing";
import { listWhiteGlovePackages } from "@/lib/plans/white-glove";
import {
  getTierCards,
  getTierSavings,
  PERIOD_OPTIONS,
  PERIOD_SUMMARY
} from "@/lib/plans/tier-display";

/**
 * The plan-selection UI shared by /onboard (checkout entry) and the public
 * /pricing page: billing-period toggle, tier cards, and the white-glove
 * onboarding add-on grid. All display data comes from `tier-display.ts`.
 */
export function PlanCards() {
  const [period, setPeriod] = useState<BillingPeriod>("biennial");

  const starterSavings = getTierSavings("starter");
  const standardSavings = getTierSavings("standard");
  const tiers = getTierCards(period);

  return (
    <div className="space-y-10">
      {/* Billing period selector */}
      <div className="space-y-4">
        <div className="flex justify-center">
          <div className="grid w-full max-w-3xl grid-cols-3 rounded-2xl border border-parchment/15 bg-parchment/5 p-1.5 gap-1 shadow-[0_12px_32px_rgba(0,0,0,0.18)] md:inline-flex md:w-auto">
            {PERIOD_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                onClick={() => setPeriod(opt.id)}
                className={[
                  "min-w-0 rounded-xl px-2 py-3 text-center text-sm font-semibold transition-all duration-200 sm:px-4 md:px-5",
                  period === opt.id
                    ? "bg-claw-green text-deep-ink shadow-[0_8px_24px_rgba(27,217,106,0.28)]"
                    : "text-parchment/72 hover:bg-parchment/8 hover:text-parchment"
                ].join(" ")}
              >
                <span className="block leading-tight md:inline">{opt.label}</span>
                {opt.id !== "monthly" && (
                  <span
                    className={[
                      "mt-1 inline-flex max-w-full items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-tight transition-colors duration-200 sm:px-2 sm:text-[11px] md:ml-2 md:mt-0",
                      period === opt.id
                        ? "bg-deep-ink/14 text-deep-ink"
                        : "bg-signal-teal/18 text-signal-teal"
                    ].join(" ")}
                  >
                    Save up to {Math.max(starterSavings[opt.id], standardSavings[opt.id])}%
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        <div
          key={period}
          className="animate-fade-slide-up rounded-2xl border border-signal-teal/22 bg-parchment/4 px-4 py-4 sm:px-5"
        >
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-parchment">{PERIOD_SUMMARY[period].title}</p>
              <p className="mt-1 text-sm text-parchment/68">{PERIOD_SUMMARY[period].description}</p>
            </div>

            {period === "monthly" ? (
              <div className="rounded-xl bg-deep-ink/45 px-4 py-3 text-sm text-parchment/72 md:max-w-xs">
                Monthly billing keeps the commitment light while still applying a first-month intro discount.
              </div>
            ) : (
              <div className="grid gap-2 md:grid-cols-2 md:min-w-[320px]">
                <div className="rounded-xl bg-deep-ink/45 px-4 py-3">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-parchment/45">Standard savings</p>
                  <p className="mt-1 text-base font-bold text-claw-green sm:text-lg">
                    {standardSavings[period as "biennial" | "annual"]}% savings
                  </p>
                </div>
                <div className="rounded-xl bg-deep-ink/45 px-4 py-3">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-parchment/45">Starter savings</p>
                  <p className="mt-1 text-base font-bold text-claw-green sm:text-lg">
                    {starterSavings[period as "biennial" | "annual"]}% savings
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {tiers.map((tier) => (
          <Card
            key={tier.id}
            className={[
              "min-w-0 flex flex-col",
              tier.highlight ? "border-signal-teal/50 ring-1 ring-signal-teal/30" : ""
            ].join(" ")}
          >
            {tier.badge && (
              <div className="mb-3">
                <Badge variant="pending">{tier.badge}</Badge>
              </div>
            )}

            <h2 className="text-lg font-bold text-parchment">{tier.name}</h2>
            <div className="mt-1 flex min-w-0 flex-wrap items-end gap-x-3 gap-y-1">
              <p className="min-w-0 text-2xl font-bold text-claw-green sm:text-3xl">{tier.price}</p>
              {tier.originalPrice && (
                <p className="pb-1 text-sm font-semibold text-parchment/35 line-through break-words">
                  {tier.originalPrice}
                </p>
              )}
            </div>

            <div key={`${tier.id}-${period}`} className="animate-fade-slide-up mt-1 min-w-0 space-y-1.5">
              {tier.introOffer && (
                <div className="inline-flex max-w-full items-center rounded-full border border-spark-orange/25 bg-spark-orange/10 px-2.5 py-1 text-center text-[11px] font-semibold leading-snug text-spark-orange">
                  {tier.introOffer}
                </div>
              )}
              {tier.id !== "enterprise" && period !== "monthly" && (
                <div className="inline-flex max-w-full items-center rounded-full border border-claw-green/25 bg-claw-green/10 px-2.5 py-1 text-center text-[11px] font-semibold leading-snug text-claw-green">
                  Save{" "}
                  {tier.id === "starter"
                    ? starterSavings[period as "biennial" | "annual"]
                    : standardSavings[period as "biennial" | "annual"]}
                  % versus monthly
                </div>
              )}
              {tier.renewal && (
                <p className="text-xs text-parchment/58">{tier.renewal}</p>
              )}
              {tier.total && (
                <p className="text-xs font-medium text-parchment/80">{tier.total}</p>
              )}
              <p className="text-xs text-parchment/52">{tier.setup}</p>
            </div>

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
                  href="/contact"
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

      {/* White-glove onboarding add-on (Phase C5). Purchased after signup
          from Billing; shown here so buyers factor it into plan choice. */}
      <div className="rounded-2xl border border-parchment/15 bg-parchment/4 px-5 py-5">
        <h2 className="text-lg font-bold text-parchment">
          Want us to set everything up for you?
        </h2>
        <p className="mt-1 text-sm text-parchment/60">
          Add white-glove onboarding after signup (from your Billing page) and a specialist
          handles it live with you. Plans without it include email support.
        </p>
        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          {listWhiteGlovePackages().map((pkg) => (
            <div
              key={pkg.id}
              className="rounded-xl border border-parchment/15 bg-deep-ink/40 p-4"
            >
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-sm font-semibold text-parchment">{pkg.name}</p>
                <p className="text-lg font-bold text-claw-green">
                  {formatPriceCents(pkg.priceCents)}
                </p>
              </div>
              <p className="mt-1 text-xs text-parchment/55">{pkg.description}</p>
              <ul className="mt-3 space-y-1.5">
                {pkg.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-xs text-parchment/65">
                    <span className="text-claw-green mt-0.5">✓</span>
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
