"use client";

/**
 * Generic usage-pack top-up card (SMS texts / Gemini chat credit), mirroring
 * <VoiceBonusPacks>. Packs are env-derived server-side (fail-closed: a pack
 * without its Stripe Price ID env var never reaches this component) and the
 * purchase flow is identical: POST the checkout route → redirect to Stripe →
 * webhook records the grant.
 */

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

export type UsagePackItem = {
  id: string;
  label: string;
  priceUsd: number;
  /** Small line under the price, e.g. "$0.018/text" or "raises this period's budget". */
  subline?: string;
};

type Props = {
  title: string;
  description: string;
  checkoutPath: string;
  packs: UsagePackItem[];
  canPurchase: boolean;
  disabledReason?: string | null;
};

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

export function UsagePacks({
  title,
  description,
  checkoutPath,
  packs,
  canPurchase,
  disabledReason
}: Props) {
  const [loadingPackId, setLoadingPackId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleBuy(packId: string) {
    if (!canPurchase) return;
    setError(null);
    setLoadingPackId(packId);
    try {
      const res = await fetch(checkoutPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packId })
      });
      const json = (await res.json().catch(() => null)) as
        | { ok: true; data: { checkoutUrl: string } }
        | { ok: false; error: { message: string } }
        | null;
      if (!res.ok || !json || json.ok === false) {
        const msg = json && json.ok === false ? json.error.message : "Could not start checkout";
        setError(msg);
        setLoadingPackId(null);
        return;
      }
      window.location.assign(json.data.checkoutUrl);
    } catch {
      setError("Network error starting checkout");
      setLoadingPackId(null);
    }
  }

  if (packs.length === 0) {
    return (
      <Card>
        <h2 className="text-sm font-semibold text-parchment uppercase tracking-wider">{title}</h2>
        <p className="mt-2 text-xs text-parchment/50">
          Top-up packs are not currently available. Contact support if you need more this period.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <h2 className="text-sm font-semibold text-parchment uppercase tracking-wider">{title}</h2>
      <p className="mt-1 text-xs text-parchment/50">{description}</p>

      {!canPurchase && disabledReason && (
        <p className="mt-3 rounded-md border border-spark-orange/40 bg-spark-orange/10 px-3 py-2 text-xs text-spark-orange">
          {disabledReason}
        </p>
      )}

      <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
        {packs.map((pack) => {
          const isLoading = loadingPackId === pack.id;
          return (
            <div
              key={pack.id}
              className="rounded-lg border border-parchment/15 bg-deep-ink/40 p-4 flex flex-col gap-2"
            >
              <p className="text-xs text-parchment/50 uppercase tracking-wider">{pack.label}</p>
              <p className="text-2xl font-semibold text-parchment">
                {currency.format(pack.priceUsd)}
              </p>
              {pack.subline && <p className="text-[11px] text-parchment/40">{pack.subline}</p>}
              <Button
                size="sm"
                variant="primary"
                loading={isLoading}
                disabled={!canPurchase || (loadingPackId !== null && !isLoading)}
                onClick={() => handleBuy(pack.id)}
                className="mt-auto"
              >
                {isLoading ? "Redirecting…" : "Buy"}
              </Button>
            </div>
          );
        })}
      </div>

      {error && (
        <p className="mt-3 text-xs text-spark-orange" role="alert">
          {error}
        </p>
      )}
    </Card>
  );
}
