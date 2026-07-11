"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";

type Diagnostics = {
  dbSubscription: {
    status: string;
    billingPeriod: string | null;
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
    renewalAt: string | null;
    graceEndsAt: string | null;
    wipedAt: string | null;
  } | null;
  customer: {
    id?: string;
    email?: string | null;
    name?: string | null;
    created?: string | null;
    delinquent?: boolean | null;
    currency?: string | null;
    deleted?: boolean;
    error?: string;
  } | null;
  subscription: {
    id?: string;
    status?: string;
    cancelAtPeriodEnd?: boolean;
    currentPeriodStart?: string | null;
    currentPeriodEnd?: string | null;
    items?: Array<{
      priceId: string;
      nickname: string | null;
      amount: string | null;
      interval: string | null;
      quantity: number;
    }>;
    error?: string;
  } | null;
  schedule: {
    id?: string;
    status?: string;
    endBehavior?: string;
    phases?: Array<{ start: string | null; end: string | null; prices: string[] }>;
    error?: string;
  } | null;
  invoices: Array<{
    id: string;
    status: string | null;
    total: string | null;
    amountPaid: string | null;
    created: string | null;
    hostedInvoiceUrl: string | null;
  }>;
};

/**
 * Admin business page: live-Stripe diagnostics on demand (BizBlasts
 * `stripe_diagnostics` analog). Loaded only when the operator clicks — the
 * page render never pays the Stripe round-trips.
 */
export function StripeDiagnosticsPanel({ businessId }: { businessId: string }) {
  const [data, setData] = useState<Diagnostics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/stripe-diagnostics?businessId=${encodeURIComponent(businessId)}`,
        { cache: "no-store" }
      );
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        data?: Diagnostics;
        error?: { message?: string };
      } | null;
      if (!res.ok || !json?.ok || !json.data) {
        setError(json?.error?.message ?? "Could not load Stripe diagnostics.");
        return;
      }
      setData(json.data);
    } catch {
      setError("Network error loading Stripe diagnostics.");
    } finally {
      setLoading(false);
    }
  }

  if (!data) {
    return (
      <div className="space-y-2">
        <Button type="button" size="sm" variant="ghost" onClick={() => void load()} loading={loading}>
          Load Stripe diagnostics
        </Button>
        {error && <p className="text-xs text-spark-orange">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-4 text-sm" data-testid="stripe-diagnostics">
      {!data.dbSubscription ? (
        <p className="text-parchment/40 text-xs">No subscription row for this business.</p>
      ) : (
        <>
          <div>
            <h3 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-1">
              Platform row
            </h3>
            <p className="text-xs text-parchment/70 font-mono break-all">
              status={data.dbSubscription.status} · period=
              {data.dbSubscription.billingPeriod ?? "–"} · cust=
              {data.dbSubscription.stripeCustomerId ?? "–"} · sub=
              {data.dbSubscription.stripeSubscriptionId ?? "–"}
              {data.dbSubscription.graceEndsAt && ` · grace_ends=${data.dbSubscription.graceEndsAt}`}
              {data.dbSubscription.wipedAt && ` · wiped=${data.dbSubscription.wipedAt}`}
            </p>
          </div>

          <div>
            <h3 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-1">
              Stripe customer
            </h3>
            {!data.customer ? (
              <p className="text-xs text-parchment/40">None linked.</p>
            ) : data.customer.error ? (
              <p className="text-xs text-spark-orange">Stripe error: {data.customer.error}</p>
            ) : data.customer.deleted ? (
              <p className="text-xs text-spark-orange">
                Customer <span className="font-mono">{data.customer.id}</span> was deleted in
                Stripe.
              </p>
            ) : (
              <p className="text-xs text-parchment/70">
                <span className="font-mono">{data.customer.id}</span>
                {data.customer.email && ` · ${data.customer.email}`}
                {data.customer.name && ` · ${data.customer.name}`}
                {data.customer.created && ` · since ${data.customer.created.slice(0, 10)}`}
                {data.customer.delinquent && (
                  <>
                    {" "}
                    <Badge variant="error">delinquent</Badge>
                  </>
                )}
              </p>
            )}
          </div>

          <div>
            <h3 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-1">
              Stripe subscription
            </h3>
            {!data.subscription ? (
              <p className="text-xs text-parchment/40">None linked.</p>
            ) : data.subscription.error ? (
              <p className="text-xs text-spark-orange">Stripe error: {data.subscription.error}</p>
            ) : (
              <div className="space-y-1">
                <p className="text-xs text-parchment/70">
                  <Badge variant={data.subscription.status === "active" ? "success" : "pending"}>
                    {data.subscription.status}
                  </Badge>{" "}
                  <span className="font-mono">{data.subscription.id}</span>
                  {data.subscription.cancelAtPeriodEnd && " · cancels at period end"}
                </p>
                <p className="text-xs text-parchment/50">
                  period {data.subscription.currentPeriodStart ?? "–"} →{" "}
                  {data.subscription.currentPeriodEnd ?? "–"}
                </p>
                <ul className="text-xs text-parchment/60 list-disc list-inside">
                  {(data.subscription.items ?? []).map((item) => (
                    <li key={item.priceId} className="font-mono">
                      {item.priceId} {item.nickname ? `(${item.nickname})` : ""} — {item.amount ?? "?"}
                      {item.interval ? ` / ${item.interval}` : ""} ×{item.quantity}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {data.schedule && (
            <div>
              <h3 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-1">
                Commitment schedule
              </h3>
              {data.schedule.error ? (
                <p className="text-xs text-spark-orange">
                  Stripe error retrieving schedule{" "}
                  <span className="font-mono">{data.schedule.id}</span>: {data.schedule.error}
                </p>
              ) : (
              <p className="text-xs text-parchment/70 font-mono">
                {data.schedule.id} · {data.schedule.status} · end_behavior=
                {data.schedule.endBehavior}
              </p>
              )}
              <ul className="text-xs text-parchment/50 list-disc list-inside">
                {(data.schedule.phases ?? []).map((phase, i) => (
                  <li key={i}>
                    {phase.start ?? "–"} → {phase.end ?? "open"} :{" "}
                    <span className="font-mono">{phase.prices.join(", ")}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <h3 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-1">
              Recent invoices
            </h3>
            {data.invoices.length === 0 ? (
              <p className="text-xs text-parchment/40">None.</p>
            ) : (
              <ul className="text-xs text-parchment/60 space-y-0.5">
                {data.invoices.map((inv) => (
                  <li key={inv.id} className="flex flex-wrap items-center gap-2">
                    <span className="font-mono">{inv.id}</span>
                    <Badge variant={inv.status === "paid" ? "success" : "pending"}>
                      {inv.status ?? "?"}
                    </Badge>
                    <span>{inv.total ?? "?"}</span>
                    <span className="text-parchment/35">{inv.created?.slice(0, 10) ?? ""}</span>
                    {inv.hostedInvoiceUrl && (
                      <a
                        href={inv.hostedInvoiceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-signal-teal hover:underline"
                      >
                        view
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      <Button type="button" size="sm" variant="ghost" onClick={() => void load()} loading={loading}>
        Refresh
      </Button>
    </div>
  );
}
