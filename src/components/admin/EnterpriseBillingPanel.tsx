"use client";

/**
 * Admin panel for enterprise billing: a cost/price calculator plus deal
 * management (create / copy pay link / revoke).
 *
 * The calculator runs the tier-economics cost model
 * (src/lib/plans/enterprise-pricing.ts) client-side: the admin enters the
 * hardware size + expected usage and a target margin, and gets an itemized
 * monthly cost with suggested setup/monthly prices. The suggestion can be
 * copied into the deal form with one click; the deal row created through
 * /api/admin/enterprise-deals is the pricing source of truth for the public
 * /enterprise-offer/<pay_token> payment link (Stripe subscription checkout).
 */

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import type { VpsSize } from "@/lib/vps/size";
import { VPS_SIZES } from "@/lib/vps/size";
import {
  ENTERPRISE_UNIT_COSTS,
  HOSTING_MONTHLY_CENTS_BY_SIZE,
  VOICE_ALL_IN_CENTS_PER_MINUTE,
  DEFAULT_ENTERPRISE_SETUP_LABOR_CENTS,
  estimateEnterpriseMonthlyCost,
  suggestEnterprisePrice
} from "@/lib/plans/enterprise-pricing";

export type EnterpriseDealView = {
  id: string;
  setup_cents: number;
  monthly_cents: number;
  status: "open" | "active" | "revoked" | "canceled";
  created_at: string;
  activated_at: string | null;
  payUrl: string;
};

function usd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** Per-unit rate rows shown next to the price fields (always visible). */
const UNIT_COST_ROWS: Array<{ label: string; value: string }> = [
  ...VPS_SIZES.map((size) => ({
    label: `Hosting ${size.toUpperCase()} (monthly SKU)`,
    value: `${usd(HOSTING_MONTHLY_CENTS_BY_SIZE[size])}/mo`
  })),
  {
    label: "SMS outbound (blended, incl. 10DLC fees)",
    value: `$${(ENTERPRISE_UNIT_COSTS.smsOutboundCentsPerMessage / 100).toFixed(4)}/msg`
  },
  {
    label: "Voice all-in (Telnyx + Gemini Live)",
    value: `$${(VOICE_ALL_IN_CENTS_PER_MINUTE / 100).toFixed(3)}/min`
  },
  { label: "Phone number (DID)", value: `${usd(ENTERPRISE_UNIT_COSTS.didMonthlyCents)}/mo` },
  {
    label: "Stripe",
    value: `${(ENTERPRISE_UNIT_COSTS.stripePercent * 100).toFixed(1)}% + ${usd(ENTERPRISE_UNIT_COSTS.stripeFixedCentsPerCharge)}/charge`
  }
];

export function EnterpriseBillingPanel({
  businessId,
  currentVpsSize,
  initialDeals
}: {
  businessId: string;
  /** Prefills the calculator with the tenant's deployed/pinned hardware. */
  currentVpsSize: VpsSize;
  initialDeals: EnterpriseDealView[];
}) {
  // --- Calculator state ---
  const [vpsSize, setVpsSize] = useState<VpsSize>(currentVpsSize);
  const [sms, setSms] = useState("2000");
  const [voiceMin, setVoiceMin] = useState("2500");
  const [extraDids, setExtraDids] = useState("0");
  const [marginPct, setMarginPct] = useState("60");
  const [setupLaborUsd, setSetupLaborUsd] = useState(
    String(DEFAULT_ENTERPRISE_SETUP_LABOR_CENTS / 100)
  );

  const calc = useMemo(() => {
    const smsN = Number(sms);
    const voiceN = Number(voiceMin);
    const didsN = Number(extraDids);
    const marginN = Number(marginPct);
    const laborN = Number(setupLaborUsd);
    if (
      ![smsN, voiceN, didsN, marginN, laborN].every((n) => Number.isFinite(n) && n >= 0) ||
      marginN > 90
    ) {
      return null;
    }
    try {
      const cost = estimateEnterpriseMonthlyCost({
        vpsSize,
        smsPerMonth: smsN,
        voiceMinutesPerMonth: voiceN,
        extraDids: Math.floor(didsN)
      });
      const suggestion = suggestEnterprisePrice(cost.totalCents, marginN, Math.round(laborN * 100));
      return { cost, suggestion };
    } catch {
      return null;
    }
  }, [vpsSize, sms, voiceMin, extraDids, marginPct, setupLaborUsd]);

  // --- Deal state ---
  const [deals, setDeals] = useState<EnterpriseDealView[]>(initialDeals);
  const [setupUsd, setSetupUsd] = useState("");
  const [monthlyUsd, setMonthlyUsd] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const hasLiveDeal = deals.some((d) => d.status === "open" || d.status === "active");

  function useSuggestion() {
    if (!calc) return;
    setSetupUsd(String(calc.suggestion.setupCents / 100));
    setMonthlyUsd(String(calc.suggestion.monthlyCents / 100));
  }

  async function refresh() {
    const res = await fetch(`/api/admin/enterprise-deals?businessId=${businessId}`);
    const json = await res.json();
    if (res.ok) setDeals(json.data?.deals ?? []);
  }

  async function createDeal() {
    const setupN = Number(setupUsd || "0");
    const monthlyN = Number(monthlyUsd);
    if (!Number.isFinite(monthlyN) || monthlyN <= 0 || !Number.isFinite(setupN) || setupN < 0) {
      setError("Monthly price must be positive; setup fee can be 0");
      return;
    }
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/enterprise-deals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, setupUsd: setupN, monthlyUsd: monthlyN })
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? "Creating the deal failed");
      } else {
        setNotice("Deal created — copy the pay link below and send it to the owner.");
        setSetupUsd("");
        setMonthlyUsd("");
        await refresh();
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  async function revoke(dealId: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/enterprise-deals", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealId })
      });
      const json = await res.json();
      if (!res.ok) setError(json.error?.message ?? "Revoking the deal failed");
      await refresh();
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  async function copyLink(deal: EnterpriseDealView) {
    try {
      await navigator.clipboard.writeText(deal.payUrl);
      setCopiedId(deal.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      setError("Copy failed — the link is shown below the deal");
    }
  }

  const inputCls =
    "rounded-md bg-deep-ink/80 border border-parchment/20 text-parchment text-sm px-2 py-1.5";

  return (
    <div className="space-y-5 text-sm">
      {/* Calculator */}
      <div className="space-y-3">
        <p className="text-xs text-parchment/40">
          Estimate our monthly cost for this tenant from expected usage, then price the deal at a
          target margin. The suggestion accounts for Stripe fees; nothing here bills anything —
          the deal you create below is what the owner pays.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs text-parchment/60">
            VPS size
            <select
              className={`${inputCls} w-28`}
              value={vpsSize}
              onChange={(e) => setVpsSize(e.target.value as VpsSize)}
            >
              {VPS_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size.toUpperCase()}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-parchment/60">
            SMS / month
            <input
              className={`${inputCls} w-24`}
              value={sms}
              onChange={(e) => setSms(e.target.value)}
              inputMode="numeric"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-parchment/60">
            Voice min / month
            <input
              className={`${inputCls} w-24`}
              value={voiceMin}
              onChange={(e) => setVoiceMin(e.target.value)}
              inputMode="numeric"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-parchment/60">
            Extra DIDs
            <input
              className={`${inputCls} w-20`}
              value={extraDids}
              onChange={(e) => setExtraDids(e.target.value)}
              inputMode="numeric"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-parchment/60">
            Target margin %
            <input
              className={`${inputCls} w-20`}
              value={marginPct}
              onChange={(e) => setMarginPct(e.target.value)}
              inputMode="numeric"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-parchment/60">
            Setup labor (USD)
            <input
              className={`${inputCls} w-24`}
              value={setupLaborUsd}
              onChange={(e) => setSetupLaborUsd(e.target.value)}
              inputMode="numeric"
            />
          </label>
        </div>

        {calc ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="rounded-md border border-parchment/10 bg-deep-ink/30 p-3 space-y-1">
              <p className="text-xs font-semibold text-parchment/40 uppercase tracking-wider">
                Estimated monthly cost
              </p>
              {calc.cost.items.map((item) => (
                <p key={item.label} className="flex justify-between text-xs text-parchment/60">
                  <span>{item.label}</span>
                  <span className="font-mono">{usd(Math.round(item.cents))}</span>
                </p>
              ))}
              <p className="flex justify-between text-sm text-parchment border-t border-parchment/10 pt-1">
                <span>Total (before Stripe fees)</span>
                <span className="font-mono">{usd(calc.cost.totalCents)}</span>
              </p>
            </div>
            <div className="rounded-md border border-claw-green/25 bg-claw-green/5 p-3 space-y-1">
              <p className="text-xs font-semibold text-parchment/40 uppercase tracking-wider">
                Suggested pricing at {marginPct}% margin
              </p>
              <p className="flex justify-between text-sm text-parchment">
                <span>Monthly</span>
                <span className="font-mono">{usd(calc.suggestion.monthlyCents)}/mo</span>
              </p>
              <p className="flex justify-between text-sm text-parchment">
                <span>One-time setup</span>
                <span className="font-mono">{usd(calc.suggestion.setupCents)}</span>
              </p>
              <p className="flex justify-between text-xs text-parchment/60">
                <span>Expected net margin</span>
                <span className="font-mono">{usd(calc.suggestion.monthlyNetMarginCents)}/mo</span>
              </p>
              <Button size="sm" variant="secondary" onClick={useSuggestion} disabled={loading}>
                Use suggested prices
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-xs text-spark-orange">
            Enter non-negative numbers (margin at most 90%) to see the estimate.
          </p>
        )}

        <details className="text-xs text-parchment/50">
          <summary className="cursor-pointer text-parchment/40 hover:text-parchment/60">
            Per-unit cost reference (tier-economics Jul 2026)
          </summary>
          <div className="mt-2 space-y-0.5">
            {UNIT_COST_ROWS.map((row) => (
              <p key={row.label} className="flex justify-between">
                <span>{row.label}</span>
                <span className="font-mono">{row.value}</span>
              </p>
            ))}
          </div>
        </details>
      </div>

      {/* Deal creation */}
      <div className="space-y-3 border-t border-parchment/10 pt-4">
        <p className="text-xs text-parchment/40">
          Create the deal the owner will pay: a one-time setup fee plus a monthly subscription,
          collected through a durable Stripe payment link. Once paid, the tenant renews monthly
          like any other subscriber.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs text-parchment/60">
            Setup fee (USD, 0 = none)
            <input
              className={`${inputCls} w-32`}
              value={setupUsd}
              onChange={(e) => setSetupUsd(e.target.value)}
              placeholder="825"
              inputMode="decimal"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-parchment/60">
            Monthly price (USD)
            <input
              className={`${inputCls} w-32`}
              value={monthlyUsd}
              onChange={(e) => setMonthlyUsd(e.target.value)}
              placeholder="495"
              inputMode="decimal"
            />
          </label>
          <Button onClick={createDeal} disabled={loading || hasLiveDeal} size="sm">
            {loading ? "Working…" : "Create deal"}
          </Button>
        </div>
        {hasLiveDeal && (
          <p className="text-xs text-parchment/40">
            This business already has an open or active deal — revoke the open one (or wait for
            the active subscription to end) before creating a new deal.
          </p>
        )}

        {error && <p className="text-xs text-spark-orange">{error}</p>}
        {notice && <p className="text-xs text-claw-green">{notice}</p>}

        {deals.length > 0 && (
          <ul className="space-y-1.5">
            {deals.map((d) => (
              <li
                key={d.id}
                className="rounded-md border border-parchment/10 bg-deep-ink/30 px-3 py-2 space-y-1"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm text-parchment truncate">
                      {usd(d.monthly_cents)}/mo
                      {d.setup_cents > 0 && (
                        <span className="text-parchment/60"> + {usd(d.setup_cents)} setup</span>
                      )}
                    </p>
                    <p className="text-xs text-parchment/40">
                      {d.status === "active"
                        ? `Active${d.activated_at ? ` since ${new Date(d.activated_at).toLocaleDateString()}` : ""}`
                        : d.status === "revoked"
                          ? "Revoked"
                          : d.status === "canceled"
                            ? "Canceled"
                            : `Open since ${new Date(d.created_at).toLocaleDateString()}`}
                    </p>
                  </div>
                  {d.status === "open" && (
                    <div className="flex shrink-0 gap-2">
                      <Button onClick={() => copyLink(d)} disabled={loading} size="sm" variant="ghost">
                        {copiedId === d.id ? "Copied!" : "Copy pay link"}
                      </Button>
                      <Button onClick={() => revoke(d.id)} disabled={loading} size="sm" variant="ghost">
                        Revoke
                      </Button>
                    </div>
                  )}
                </div>
                {d.status === "open" && (
                  <p className="break-all font-mono text-[10px] text-parchment/30">{d.payUrl}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
