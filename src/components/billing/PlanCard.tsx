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
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import type { BillingPeriod, PlanTier } from "@/lib/plans/tier";
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
};

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
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
  if (!tier) return "—";
  if (tier === "starter") return "Starter";
  if (tier === "standard") return "Standard";
  return "Enterprise";
}

function periodLabel(p: BillingPeriod | null): string {
  if (!p) return "—";
  if (p === "monthly") return "Monthly";
  if (p === "annual") return "12 months";
  return "24 months";
}

function statusBadge(
  status: StatusKind,
  periodEnd: string | null,
  graceEndsAt: string | null
): { variant: "success" | "pending" | "online" | "neutral"; text: string } {
  if (status === "active") return { variant: "success", text: "Active" };
  if (status === "active_cancel_at_period_end")
    return { variant: "pending", text: `Ends ${formatDate(periodEnd)}` };
  if (status === "canceled_in_grace")
    return { variant: "pending", text: `Grace · wipes ${formatDate(graceEndsAt)}` };
  if (status === "pending") return { variant: "pending", text: "Pending" };
  if (status === "wiped") return { variant: "neutral", text: "Wiped" };
  return { variant: "neutral", text: "Canceled" };
}

export function PlanCard(props: PlanCardProps) {
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
    stripeCustomerId
  } = props;

  const [showCancel, setShowCancel] = useState(false);
  const [undoLoading, setUndoLoading] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);
  const [resubLoading, setResubLoading] = useState(false);
  const [resubError, setResubError] = useState<string | null>(null);

  const badge = statusBadge(status, periodEnd, graceEndsAt);
  const cancelable =
    status === "active" || status === "active_cancel_at_period_end";
  const alreadyPeriodEnd = status === "active_cancel_at_period_end";
  const inGrace = status === "canceled_in_grace";

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
        setUndoError(
          json && json.ok === false ? json.error.message : "Could not undo scheduled cancel"
        );
        setUndoLoading(false);
        return;
      }
      window.location.reload();
    } catch {
      setUndoError("Network error");
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
        setResubError(
          json && json.ok === false ? json.error.message : "Could not start reactivation"
        );
        setResubLoading(false);
        return;
      }
      window.location.assign(json.data.checkoutUrl);
    } catch {
      setResubError("Network error");
      setResubLoading(false);
    }
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-parchment">Your plan</h2>
          <p className="text-xs text-parchment/50 mt-1">
            {tierLabel(tier)} · {periodLabel(billingPeriod)}
          </p>
        </div>
        <Badge variant={badge.variant}>{badge.text}</Badge>
      </div>

      <dl className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
        {status === "active" && renewalAt && (
          <div>
            <dt className="text-xs text-parchment/50 uppercase tracking-wider">Next renewal</dt>
            <dd className="mt-1 font-mono text-parchment">{formatDate(renewalAt)}</dd>
          </div>
        )}
        {status === "active_cancel_at_period_end" && (
          <div>
            <dt className="text-xs text-parchment/50 uppercase tracking-wider">Access ends</dt>
            <dd className="mt-1 font-mono text-parchment">{formatDate(periodEnd)}</dd>
          </div>
        )}
        {status === "canceled_in_grace" && (
          <div>
            <dt className="text-xs text-parchment/50 uppercase tracking-wider">Data wipes on</dt>
            <dd className="mt-1 font-mono text-spark-orange">{formatDate(graceEndsAt)}</dd>
          </div>
        )}
      </dl>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        {cancelable && (
          <Button size="sm" variant="ghost" onClick={() => setShowCancel(true)}>
            {alreadyPeriodEnd ? "Manage cancellation" : "Cancel subscription"}
          </Button>
        )}
        {alreadyPeriodEnd && (
          <Button
            size="sm"
            variant="primary"
            loading={undoLoading}
            onClick={undoPeriodEnd}
          >
            Keep my plan
          </Button>
        )}
        {inGrace && (
          <Button size="sm" variant="primary" loading={resubLoading} onClick={resubscribe}>
            Reactivate
          </Button>
        )}
        {stripeCustomerId && (
          <form action="/api/billing/portal" method="POST">
            <button type="submit" className="text-xs text-parchment/60 hover:text-parchment underline">
              Update payment method
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

      {tier && tier !== "enterprise" && billingPeriod && cancelable && (
        <div className="mt-6 pt-6 border-t border-parchment/10 space-y-2">
          <h3 className="text-sm font-semibold text-parchment">Change plan</h3>
          <p className="text-xs text-parchment/50">
            Upgrade, downgrade, or switch your billing period. Current plan is canceled
            immediately with no proration; your workspace data migrates to a new VPS at the
            new tier.
          </p>
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
