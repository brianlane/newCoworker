/**
 * Plan card that replaces the lone "Manage billing" link on
 * `/dashboard/billing`. Consolidates:
 *   - status + period badge
 *   - current tier × billing-period summary
 *   - change-plan (upgrade/downgrade) inline selector
 *   - cancel sheet trigger (two modes during the 30-day window, one after)
 *   - undo-period-end when the user previously scheduled a cancellation
 *   - reactivate CTA in grace state
 *
 * Server-side props encode the lifecycle state + refund eligibility; the
 * client is dumb and just dispatches to the billing API routes. This
 * keeps the wire-protocol obvious: `PlanCard` never holds secrets or
 * does its own eligibility math.
 */

"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import type { BillingPeriod, PlanTier } from "@/lib/plans/tier";
import {
  formatCommitmentTotal,
  getMonthlyRateDisplay,
  getRenewalRateDisplay
} from "@/lib/pricing";
import { CancelSheet } from "./CancelSheet";
import { ChangePlanSelector } from "./ChangePlanSelector";

type StatusKind =
  | "active"
  | "active_cancel_at_period_end"
  | "canceled_in_grace"
  | "pending"
  | "canceled"
  | "wiped";

export type PlanCardProps = {
  tier: PlanTier | null;
  billingPeriod: BillingPeriod | null;
  status: StatusKind;
  renewalAt: string | null;
  periodEnd: string | null;
  graceEndsAt: string | null;
  canRefund: boolean;
  refundBlockedReason?: string | null;
  canChangePlan: boolean;
  changePlanBlockedReason?: string | null;
  stripeCustomerId: string | null;
  /** subscriptions.contract_auto_renew — term plans only. */
  contractAutoRenew: boolean;
  /**
   * True when a term plan's original commitment has passed and the sub is
   * rolling month-to-month at the renewal rate; unlocks the
   * "Start a new contract" CTA (server re-validates in change-plan).
   */
  commitmentElapsed: boolean;
};

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "–";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric"
    });
  } catch {
    return iso;
  }
}

function tierLabel(tier: PlanTier | null): string {
  if (!tier) return "–";
  if (tier === "starter") return "Starter";
  if (tier === "standard") return "Standard";
  return "Enterprise";
}

export function PlanCard(props: PlanCardProps) {
  const t = useTranslations("dashboard.planCard");

  function periodLabel(p: BillingPeriod | null): string {
    if (!p) return "–";
    if (p === "monthly") return t("monthly");
    if (p === "annual") return t("months12");
    return t("months24");
  }

  function statusBadge(
    status: StatusKind,
    periodEnd: string | null,
    graceEndsAt: string | null
  ): { variant: "success" | "pending" | "online" | "neutral"; text: string } {
    if (status === "active") return { variant: "success", text: t("active") };
    if (status === "active_cancel_at_period_end")
      return { variant: "pending", text: t("endsOn", { date: formatDate(periodEnd) }) };
    if (status === "canceled_in_grace")
      return { variant: "pending", text: t("graceWipes", { date: formatDate(graceEndsAt) }) };
    if (status === "pending") return { variant: "pending", text: t("pending") };
    if (status === "wiped") return { variant: "neutral", text: t("wiped") };
    return { variant: "neutral", text: t("canceled") };
  }

  const {
    tier,
    billingPeriod,
    status,
    renewalAt,
    periodEnd,
    graceEndsAt,
    canRefund,
    refundBlockedReason,
    canChangePlan,
    changePlanBlockedReason,
    stripeCustomerId,
    contractAutoRenew,
    commitmentElapsed
  } = props;

  const [showCancel, setShowCancel] = useState(false);
  const [undoLoading, setUndoLoading] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);
  const [resubLoading, setResubLoading] = useState(false);
  const [resubError, setResubError] = useState<string | null>(null);
  const [autoRenewLoading, setAutoRenewLoading] = useState(false);
  const [autoRenewError, setAutoRenewError] = useState<string | null>(null);
  const [recontractLoading, setRecontractLoading] = useState(false);
  const [recontractError, setRecontractError] = useState<string | null>(null);

  const badge = statusBadge(status, periodEnd, graceEndsAt);
  const cancelable =
    status === "active" || status === "active_cancel_at_period_end";
  const alreadyPeriodEnd = status === "active_cancel_at_period_end";
  const inGrace = status === "canceled_in_grace";

  const isTermPlan =
    tier !== null &&
    tier !== "enterprise" &&
    (billingPeriod === "annual" || billingPeriod === "biennial");
  // Toggle only matters while the commitment is still running; once it has
  // elapsed the plan is already month-to-month and the re-contract CTA takes
  // over.
  const showAutoRenew = isTermPlan && status === "active" && !commitmentElapsed;
  const showRecontract = isTermPlan && status === "active" && commitmentElapsed;
  const termMonthsLabel = billingPeriod === "annual" ? t("months12") : t("months24");
  const contractRate = isTermPlan ? getMonthlyRateDisplay(tier, billingPeriod!) : null;
  const contractTotal = isTermPlan ? formatCommitmentTotal(tier, billingPeriod!) : null;
  const rolloverRate = isTermPlan ? getRenewalRateDisplay(tier, billingPeriod!) : null;

  async function undoPeriodEnd() {
    setUndoLoading(true);
    setUndoError(null);
    try {
      const res = await fetch("/api/billing/reactivate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "undoPeriodEnd" })
      });
      const json = (await res.json().catch(() => null)) as
        | { ok: true; data: unknown }
        | { ok: false; error: { message: string } }
        | null;
      if (!res.ok || !json || json.ok === false) {
        setUndoError(json && json.ok === false ? json.error.message : t("undoFailed"));
        setUndoLoading(false);
        return;
      }
      window.location.reload();
    } catch {
      setUndoError(t("networkError"));
      setUndoLoading(false);
    }
  }

  async function resubscribe() {
    setResubLoading(true);
    setResubError(null);
    try {
      const res = await fetch("/api/billing/reactivate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "resubscribe" })
      });
      const json = (await res.json().catch(() => null)) as
        | { ok: true; data: { checkoutUrl: string } }
        | { ok: false; error: { message: string } }
        | null;
      if (!res.ok || !json || json.ok === false) {
        setResubError(json && json.ok === false ? json.error.message : t("reactivateFailed"));
        setResubLoading(false);
        return;
      }
      window.location.assign(json.data.checkoutUrl);
    } catch {
      setResubError(t("networkError"));
      setResubLoading(false);
    }
  }

  async function toggleAutoRenew() {
    setAutoRenewLoading(true);
    setAutoRenewError(null);
    try {
      const res = await fetch("/api/billing/auto-renew", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoRenew: !contractAutoRenew })
      });
      const json = (await res.json().catch(() => null)) as
        | { ok: true; data: { autoRenew: boolean } }
        | { ok: false; error: { message: string } }
        | null;
      if (!res.ok || !json || json.ok === false) {
        setAutoRenewError(json && json.ok === false ? json.error.message : t("autoRenewFailed"));
        setAutoRenewLoading(false);
        return;
      }
      window.location.reload();
    } catch {
      setAutoRenewError(t("networkError"));
      setAutoRenewLoading(false);
    }
  }

  async function startRecontract() {
    setRecontractLoading(true);
    setRecontractError(null);
    try {
      const res = await fetch("/api/billing/change-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier, billingPeriod })
      });
      const json = (await res.json().catch(() => null)) as
        | { ok: true; data: { checkoutUrl: string } }
        | { ok: false; error: { message: string } }
        | null;
      if (!res.ok || !json || json.ok === false) {
        setRecontractError(json && json.ok === false ? json.error.message : t("recontractFailed"));
        setRecontractLoading(false);
        return;
      }
      window.location.assign(json.data.checkoutUrl);
    } catch {
      setRecontractError(t("networkError"));
      setRecontractLoading(false);
    }
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-parchment">{t("yourPlan")}</h2>
          <p className="text-xs text-parchment/50 mt-1">
            {tierLabel(tier)} · {periodLabel(billingPeriod)}
          </p>
        </div>
        <Badge variant={badge.variant}>{badge.text}</Badge>
      </div>

      <dl className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
        {status === "active" && renewalAt && (
          <div>
            <dt className="text-xs text-parchment/50 uppercase tracking-wider">{t("nextRenewal")}</dt>
            <dd className="mt-1 font-mono text-parchment">{formatDate(renewalAt)}</dd>
          </div>
        )}
        {status === "active_cancel_at_period_end" && (
          <div>
            <dt className="text-xs text-parchment/50 uppercase tracking-wider">{t("accessEnds")}</dt>
            <dd className="mt-1 font-mono text-parchment">{formatDate(periodEnd)}</dd>
          </div>
        )}
        {status === "canceled_in_grace" && (
          <div>
            <dt className="text-xs text-parchment/50 uppercase tracking-wider">{t("dataWipesOn")}</dt>
            <dd className="mt-1 font-mono text-spark-orange">{formatDate(graceEndsAt)}</dd>
          </div>
        )}
      </dl>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        {cancelable && (
          <Button size="sm" variant="ghost" onClick={() => setShowCancel(true)}>
            {alreadyPeriodEnd ? t("manageCancellation") : t("cancelSubscription")}
          </Button>
        )}
        {alreadyPeriodEnd && (
          <Button
            size="sm"
            variant="primary"
            loading={undoLoading}
            onClick={undoPeriodEnd}
          >
            {t("keepMyPlan")}
          </Button>
        )}
        {inGrace && (
          <Button size="sm" variant="primary" loading={resubLoading} onClick={resubscribe}>
            {t("reactivate")}
          </Button>
        )}
        {stripeCustomerId && (
          <form action="/api/billing/portal" method="POST">
            <button type="submit" className="text-xs text-parchment/60 hover:text-parchment underline">
              {t("updatePayment")}
            </button>
          </form>
        )}
      </div>
      {undoError && (
        <p className="mt-2 text-xs text-spark-orange" role="alert">
          {undoError}
        </p>
      )}
      {resubError && (
        <p className="mt-2 text-xs text-spark-orange" role="alert">
          {resubError}
        </p>
      )}

      {showAutoRenew && (
        <div className="mt-6 pt-6 border-t border-parchment/10 space-y-2">
          <div className="flex items-center justify-between gap-4">
            <h3 className="text-sm font-semibold text-parchment">{t("contractAutoRenew")}</h3>
            <button
              type="button"
              role="switch"
              aria-checked={contractAutoRenew}
              disabled={autoRenewLoading}
              onClick={toggleAutoRenew}
              className={[
                "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
                contractAutoRenew ? "bg-claw-green" : "bg-parchment/20",
                autoRenewLoading ? "opacity-50 cursor-wait" : ""
              ].join(" ")}
            >
              <span
                className={[
                  "inline-block h-4 w-4 rounded-full bg-deep-ink transition-transform",
                  contractAutoRenew ? "translate-x-[18px]" : "translate-x-0.5"
                ].join(" ")}
              />
            </button>
          </div>
          <p className="text-xs text-parchment/50">
            {contractAutoRenew
              ? t.rich("autoRenewOn", {
                  date: formatDate(renewalAt),
                  term: termMonthsLabel,
                  rate: () => <span className="font-mono">{contractRate}</span>,
                  total: () => <span className="font-mono">{contractTotal}</span>
                })
              : t.rich("autoRenewOff", {
                  date: formatDate(renewalAt),
                  term: termMonthsLabel,
                  rollover: () => <span className="font-mono">{rolloverRate}</span>,
                  rate: () => <span className="font-mono">{contractRate}</span>,
                  total: () => <span className="font-mono">{contractTotal}</span>
                })}
          </p>
          {autoRenewError && (
            <p className="text-xs text-spark-orange" role="alert">
              {autoRenewError}
            </p>
          )}
        </div>
      )}

      {showRecontract && (
        <div className="mt-6 pt-6 border-t border-parchment/10 space-y-2">
          <h3 className="text-sm font-semibold text-parchment">{t("startNewContract")}</h3>
          <p className="text-xs text-parchment/50">
            {t.rich("recontractBody", {
              term: termMonthsLabel,
              rollover: () => <span className="font-mono">{rolloverRate}</span>,
              rate: () => <span className="font-mono">{contractRate}</span>,
              total: () => <span className="font-mono">{contractTotal}</span>
            })}
          </p>
          <Button
            size="sm"
            variant="primary"
            loading={recontractLoading}
            onClick={startRecontract}
          >
            {t("startNewContractCta", { term: termMonthsLabel })}
          </Button>
          {recontractError && (
            <p className="text-xs text-spark-orange" role="alert">
              {recontractError}
            </p>
          )}
        </div>
      )}

      {tier && tier !== "enterprise" && billingPeriod && cancelable && (
        <div className="mt-6 pt-6 border-t border-parchment/10 space-y-2">
          <h3 className="text-sm font-semibold text-parchment">{t("changePlan")}</h3>
          <p className="text-xs text-parchment/50">{t("changePlanBody")}</p>
          <ChangePlanSelector
            currentTier={tier as Exclude<PlanTier, "enterprise">}
            currentBillingPeriod={billingPeriod}
            disabled={!canChangePlan}
            disabledReason={changePlanBlockedReason}
          />
        </div>
      )}

      <CancelSheet
        open={showCancel}
        onClose={() => setShowCancel(false)}
        canRefund={canRefund}
        refundBlockedReason={refundBlockedReason ?? null}
        periodEnd={periodEnd}
        alreadyPeriodEnd={alreadyPeriodEnd}
        onUndoPeriodEnd={async () => {
          setShowCancel(false);
          await undoPeriodEnd();
        }}
      />
    </Card>
  );
}
