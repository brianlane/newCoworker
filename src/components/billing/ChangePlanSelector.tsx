/**
 * Upgrade/downgrade + billing-period switcher. Renders a (tier × period)
 * grid; clicking a non-current combo opens a confirm sheet that spells
 * out the two-axis policy (entitlements now, Hostinger box until prepaid
 * lapse) and kicks off `/api/billing/change-plan`. On success the server
 * returns a Stripe Checkout URL which we hard-redirect to.
 *
 * After Stripe Checkout succeeds, the webhook drives the change-plan
 * orchestrator (see `src/lib/billing/change-plan-orchestrator.ts`). The
 * user just sees `?planChanged=1` on return.
 */

"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import {
  type BillingPeriod,
  type PlanTier,
  calculateSavingsPercentage,
  getPeriodPricing
} from "@/lib/plans/tier";
import {
  formatPriceCents,
  getExistingCustomerMonthlyCents,
  getExistingCustomerMonthlyDisplay,
  getRenewalRateDisplay
} from "@/lib/pricing";
import {
  MembershipPackAddOns,
  membershipPackAddOnsDueTodayCents
} from "@/components/billing/MembershipPackAddOns";
import type {
  MembershipPackAddonOption,
  MembershipPackAddonSelection
} from "@/lib/billing/membership-pack-addons";
import {
  formatPlanChangePaidThroughDate,
  parseablePaidThroughIso,
  planChangeConfirmHardwareKey,
  starterDowngradeLossIds,
  type StarterDowngradeLossId
} from "@/lib/billing/plan-change-copy";

type ChangeablePlan = Exclude<PlanTier, "enterprise">;

type Props = {
  currentTier: ChangeablePlan;
  currentBillingPeriod: BillingPeriod | null;
  disabled?: boolean;
  disabledReason?: string | null;
  packAddonOptions?: MembershipPackAddonOption[];
  /** Packs the tenant already carries, so the selector does not start empty. */
  currentPackAddons?: MembershipPackAddonSelection;
  /** `vps_inventory.expires_at` for the live Hostinger box, if known. */
  boxExpiresAt?: string | null;
  /** False when the tenant has no numeric Hostinger VM. */
  hasLiveBox?: boolean;
  /** Raw `businesses.vps_size` pin. */
  vpsSizePin?: string | null;
};

const TIERS: ChangeablePlan[] = ["starter", "standard"];
const PERIODS: BillingPeriod[] = ["monthly", "annual", "biennial"];

function tierLabel(tier: ChangeablePlan): string {
  return tier === "starter" ? "Starter" : "Standard";
}

function periodLabel(period: BillingPeriod): string {
  if (period === "monthly") return "Monthly";
  if (period === "annual") return "12 months";
  return "24 months";
}

// Existing customers don't get the first-month intro discount, so show (and
// they're charged) the regular rate for the period.
function monthlyRateLabel(tier: ChangeablePlan, period: BillingPeriod): string {
  return `${getExistingCustomerMonthlyDisplay(tier, period)}/mo`;
}

// Committed 12/24-month terms renew at a higher rate after the first cycle;
// null when the renewal equals what the customer pays now (monthly, where
// existing customers already pay the renewal rate).
function renewalRateLabel(tier: ChangeablePlan, period: BillingPeriod): string | null {
  // Existing monthly customers already pay the renewal rate, so the extra line
  // would be noise; compare in cents (display strings format differently).
  if (getPeriodPricing(tier, period).renewalMonthlyCents === getExistingCustomerMonthlyCents(tier, period)) {
    return null;
  }
  return getRenewalRateDisplay(tier, period); // already "/mo"-suffixed
}

export function ChangePlanSelector({
  currentTier,
  currentBillingPeriod,
  disabled,
  disabledReason,
  packAddonOptions = [],
  currentPackAddons,
  boxExpiresAt = null,
  hasLiveBox,
  vpsSizePin = null
}: Props) {
  const t = useTranslations("dashboard.planCard");
  const locale = useLocale();
  const [selectedTier, setSelectedTier] = useState<ChangeablePlan | null>(null);
  const [selectedPeriod, setSelectedPeriod] = useState<BillingPeriod | null>(null);
  // Seed from what the tenant already carries. Starting empty meant a tenant
  // who switched billing period without touching the steppers lost their
  // packs: change-plan cancels the old Stripe subscription and rebuilds from
  // these lines alone.
  const [packAddonSelection, setPackAddonSelection] = useState<MembershipPackAddonSelection>(
    currentPackAddons ?? {}
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isCurrent = (tier: ChangeablePlan, period: BillingPeriod): boolean =>
    tier === currentTier && period === currentBillingPeriod;

  function handleChooseCell(tier: ChangeablePlan, period: BillingPeriod) {
    if (disabled) return;
    if (isCurrent(tier, period)) return;
    setSelectedTier(tier);
    setSelectedPeriod(period);
    // Re-seed rather than clear, for the same reason.
    setPackAddonSelection(currentPackAddons ?? {});
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
        body: JSON.stringify({
          tier: selectedTier,
          billingPeriod: selectedPeriod,
          ...(packAddonSelection.voicePacks?.length
            ? { voicePacks: packAddonSelection.voicePacks }
            : {}),
          ...(packAddonSelection.smsPacks?.length
            ? { smsPacks: packAddonSelection.smsPacks }
            : {}),
          ...(packAddonSelection.chatPacks?.length
            ? { chatPacks: packAddonSelection.chatPacks }
            : {})
        })
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
  const pendingSavings =
    pending && selectedPeriod !== "monthly"
      ? calculateSavingsPercentage(selectedTier, selectedPeriod)
      : 0;

  function hardwareConfirmText(): string {
    if (!selectedTier) return "";
    const key = planChangeConfirmHardwareKey({
      currentTier,
      selectedTier,
      vpsSizePin,
      expiresAt: boxExpiresAt,
      hasLiveBox
    });
    if (key === "confirmKeepDated") {
      const iso = parseablePaidThroughIso(boxExpiresAt);
      const date = iso ? formatPlanChangePaidThroughDate(iso, locale) : null;
      if (date) return t("confirmKeepDated", { date });
      return t("confirmKeepGeneric");
    }
    if (key === "confirmKeepGeneric") return t("confirmKeepGeneric");
    if (key === "confirmKeepSameHardware") return t("confirmKeepSameHardware");
    if (key === "confirmMigrate") return t("confirmMigrate");
    return t("confirmSameTier");
  }

  function starterLossLine(id: StarterDowngradeLossId): string {
    switch (id) {
      case "incoming_webhooks":
        return t("lossIncomingWebhooks");
      case "api_keys":
        return t("lossApiKeys");
      case "messenger_and_widget":
        return t("lossMessengerAndWidget");
      case "outbound_ai_calls":
        return t("lossOutboundAiCalls");
      case "prospecting":
        return t("lossProspecting");
      case "scheduled_outreach":
        return t("lossScheduledOutreach");
      case "team_chat_and_push":
        return t("lossTeamChatAndPush");
      case "call_intel_and_browser":
        return t("lossCallIntelAndBrowser");
    }
  }

  const starterLossIds = selectedTier ? starterDowngradeLossIds(currentTier, selectedTier) : [];

  return (
    <div className="space-y-4">
      {disabled && disabledReason && (
        <p className="text-xs text-parchment/60 rounded border border-parchment/15 bg-parchment/5 px-3 py-2">
          {disabledReason}
        </p>
      )}

      {/* Phone: no room for a label column, so the tier name becomes a
          full-width heading over its own row of three period cards, and each
          card carries its period label. From sm up it is the original
          (tier x period) matrix with a shared header row. */}
      <div className="grid grid-cols-1 gap-2 text-xs text-parchment/60 min-[360px]:grid-cols-3 sm:grid-cols-4">
        <div className="hidden sm:block" />
        {PERIODS.map((p) => (
          <div
            key={p}
            className="hidden text-center font-semibold uppercase tracking-wider sm:block"
          >
            {periodLabel(p)}
          </div>
        ))}

        {TIERS.map((tier) => (
          <div key={tier} className="contents">
            <div className="col-span-full flex items-center font-semibold text-parchment sm:col-span-1">
              {tierLabel(tier)}
            </div>
            {PERIODS.map((period) => {
              const current = isCurrent(tier, period);
              const selected = selectedTier === tier && selectedPeriod === period;
              return (
                <button
                  key={`${tier}-${period}`}
                  type="button"
                  onClick={() => handleChooseCell(tier, period)}
                  disabled={disabled || current}
                  className={[
                    "min-w-0 rounded-lg border p-2 text-center transition-all sm:p-3",
                    current
                      ? "border-claw-green/60 bg-claw-green/10 text-claw-green cursor-default"
                      : selected
                        ? "border-signal-teal/60 bg-signal-teal/10 text-parchment"
                        : "border-parchment/15 bg-deep-ink/50 text-parchment hover:border-parchment/30",
                    disabled && !current ? "opacity-50 cursor-not-allowed" : ""
                  ].join(" ")}
                >
                  <div className="text-[10px] uppercase tracking-wide text-parchment/50 sm:hidden">
                    {periodLabel(period)}
                  </div>
                  <div className="font-mono text-xs sm:text-sm">
                    {monthlyRateLabel(tier, period)}
                  </div>
                  {period !== "monthly" && (
                    <div className="text-[10px] text-parchment/50 mt-0.5">
                      save {calculateSavingsPercentage(tier, period)}%
                    </div>
                  )}
                  {renewalRateLabel(tier, period) && (
                    <div className="text-[10px] text-parchment/40 mt-0.5">
                      renews at {renewalRateLabel(tier, period)}
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

      {pending && (
        <div className="rounded-lg border border-signal-teal/40 bg-signal-teal/5 p-4 space-y-3">
          <p className="text-sm font-semibold text-parchment">
            Switch to {tierLabel(selectedTier!)} · {periodLabel(selectedPeriod!)}
          </p>
          <p className="text-xs text-parchment/60">
            You&apos;ll be charged <span className="font-mono">{monthlyRateLabel(selectedTier!, selectedPeriod!)}</span>
            {selectedPeriod !== "monthly" && pendingSavings > 0 ? ` (save ${pendingSavings}% vs. monthly)` : ""}
            {renewalRateLabel(selectedTier!, selectedPeriod!)
              ? `, renewing at ${renewalRateLabel(selectedTier!, selectedPeriod!)} after the first term`
              : ""}.
            Your current plan will be canceled immediately with no proration or refund.{" "}
            {hardwareConfirmText()}
          </p>
          {starterLossIds.length > 0 && (
            <div className="text-xs text-spark-orange space-y-1.5" role="status">
              <p className="font-semibold">{t("confirmStarterLossLead")}</p>
              <ul className="list-disc pl-4 space-y-1 text-spark-orange/90">
                {starterLossIds.map((id) => (
                  <li key={id}>{starterLossLine(id)}</li>
                ))}
              </ul>
              <p>{t("confirmStarterLossKeep")}</p>
            </div>
          )}
          {packAddonOptions.length > 0 && selectedPeriod && (
            <MembershipPackAddOns
              period={selectedPeriod}
              options={packAddonOptions}
              selection={packAddonSelection}
              onChange={setPackAddonSelection}
            />
          )}
          {selectedPeriod &&
            membershipPackAddOnsDueTodayCents(
              packAddonSelection,
              packAddonOptions,
              selectedPeriod
            ) > 0 && (
              <p className="text-xs text-parchment/70">
                Usage pack add-ons today:{" "}
                <span className="font-mono">
                  {formatPriceCents(
                    membershipPackAddOnsDueTodayCents(
                      packAddonSelection,
                      packAddonOptions,
                      selectedPeriod
                    )
                  )}
                </span>
              </p>
            )}
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
                setPackAddonSelection({});
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
