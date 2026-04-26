/**
 * Upgrade/downgrade + billing-period switcher. Renders a (tier × period)
 * grid; clicking a non-current combo opens a confirm sheet that spells
 * out the no-proration policy and kicks off
 * `/api/billing/change-plan`. On success the server returns a Stripe
 * Checkout URL which we hard-redirect to.
 *
 * After Stripe Checkout succeeds, the webhook drives the change-plan
 * orchestrator (see `src/lib/billing/change-plan-orchestrator.ts`): SSH
 * backup the old VPS, provision a new one at the new tier, restore data,
 * tear down the old Stripe/Hostinger sub. The user just sees
 * `?planChanged=1` on return.
 */

"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import {
  type BillingPeriod,
  type PlanTier,
  getPeriodPricing,
  calculateSavingsPercentage
} from "@/lib/plans/tier";

type ChangeablePlan = Exclude<PlanTier, "enterprise">;

type Props = {
  currentTier: ChangeablePlan;
  currentBillingPeriod: BillingPeriod | null;
  disabled?: boolean;
  disabledReason?: string | null;
};

const TIERS: ChangeablePlan[] = ["starter", "standard"];
const PERIODS: BillingPeriod[] = ["monthly", "annual", "biennial"];

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0
});

function tierLabel(tier: ChangeablePlan): string {
  return tier === "starter" ? "Starter" : "Standard";
}

function periodLabel(period: BillingPeriod): string {
  if (period === "monthly") return "Monthly";
  if (period === "annual") return "12 months";
  return "24 months";
}

function formatMonthlyDollars(cents: number): string {
  return `${currency.format(cents / 100)}/mo`;
}

export function ChangePlanSelector({
  currentTier,
  currentBillingPeriod,
  disabled,
  disabledReason
}: Props) {
  const [selectedTier, setSelectedTier] = useState<ChangeablePlan | null>(null);
  const [selectedPeriod, setSelectedPeriod] = useState<BillingPeriod | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isCurrent = (tier: ChangeablePlan, period: BillingPeriod): boolean =>
    tier === currentTier && period === currentBillingPeriod;

  function handleChooseCell(tier: ChangeablePlan, period: BillingPeriod) {
    if (disabled) return;
    if (isCurrent(tier, period)) return;
    setSelectedTier(tier);
    setSelectedPeriod(period);
    setError(null);
  }

  async function confirmChange() {
    if (!selectedTier || !selectedPeriod) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/change-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: selectedTier, billingPeriod: selectedPeriod })
      });
      const json = (await res.json().catch(() => null)) as
        | { ok: true; data: { checkoutUrl: string } }
        | { ok: false; error: { message: string } }
        | null;
      if (!res.ok || !json || json.ok === false) {
        setError(
          json && json.ok === false ? json.error.message : "Could not start change-plan checkout"
        );
        setSubmitting(false);
        return;
      }
      window.location.assign(json.data.checkoutUrl);
    } catch {
      setError("Network error starting change-plan checkout");
      setSubmitting(false);
    }
  }

  const pending = selectedTier && selectedPeriod;
  const pendingPricing = pending ? getPeriodPricing(selectedTier, selectedPeriod) : null;
  const pendingSavings =
    pending && selectedPeriod !== "monthly"
      ? calculateSavingsPercentage(selectedTier, selectedPeriod)
      : 0;

  return (
    <div className="space-y-4">
      {disabled && disabledReason && (
        <p className="text-xs text-parchment/60 rounded border border-parchment/15 bg-parchment/5 px-3 py-2">
          {disabledReason}
        </p>
      )}

      <div className="grid grid-cols-4 gap-2 text-xs text-parchment/60">
        <div />
        {PERIODS.map((p) => (
          <div key={p} className="text-center font-semibold uppercase tracking-wider">
            {periodLabel(p)}
          </div>
        ))}

        {TIERS.map((tier) => (
          <div key={tier} className="contents">
            <div className="flex items-center font-semibold text-parchment">{tierLabel(tier)}</div>
            {PERIODS.map((period) => {
              const pricing = getPeriodPricing(tier, period);
              const current = isCurrent(tier, period);
              const selected = selectedTier === tier && selectedPeriod === period;
              return (
                <button
                  key={`${tier}-${period}`}
                  type="button"
                  onClick={() => handleChooseCell(tier, period)}
                  disabled={disabled || current}
                  className={[
                    "rounded-lg border p-3 text-center transition-all",
                    current
                      ? "border-claw-green/60 bg-claw-green/10 text-claw-green cursor-default"
                      : selected
                        ? "border-signal-teal/60 bg-signal-teal/10 text-parchment"
                        : "border-parchment/15 bg-deep-ink/50 text-parchment hover:border-parchment/30",
                    disabled && !current ? "opacity-50 cursor-not-allowed" : ""
                  ].join(" ")}
                >
                  <div className="text-sm font-mono">{formatMonthlyDollars(pricing.monthlyCents)}</div>
                  {period !== "monthly" && (
                    <div className="text-[10px] text-parchment/50 mt-0.5">
                      save {calculateSavingsPercentage(tier, period)}%
                    </div>
                  )}
                  {current && (
                    <div className="text-[10px] text-claw-green mt-1 font-semibold">current</div>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {pending && pendingPricing && (
        <div className="rounded-lg border border-signal-teal/40 bg-signal-teal/5 p-4 space-y-3">
          <p className="text-sm font-semibold text-parchment">
            Switch to {tierLabel(selectedTier!)} · {periodLabel(selectedPeriod!)}
          </p>
          <p className="text-xs text-parchment/60">
            You&apos;ll be charged <span className="font-mono">{formatMonthlyDollars(pendingPricing.monthlyCents)}</span>
            {selectedPeriod !== "monthly" && pendingSavings > 0 ? ` (save ${pendingSavings}% vs. monthly)` : ""}.
            Your current plan will be canceled immediately with no proration or refund, and we&apos;ll
            migrate your workspace data to a fresh VPS at the new tier.
          </p>
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              variant="primary"
              loading={submitting}
              onClick={confirmChange}
              disabled={disabled}
            >
              Confirm &amp; continue to checkout
            </Button>
            <button
              type="button"
              className="text-xs text-parchment/50 hover:text-parchment underline"
              onClick={() => {
                setSelectedTier(null);
                setSelectedPeriod(null);
              }}
              disabled={submitting}
            >
              Cancel
            </button>
          </div>
          {error && (
            <p className="text-xs text-spark-orange" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
