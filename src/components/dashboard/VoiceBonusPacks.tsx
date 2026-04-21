"use client";

/**
 * Voice-bonus top-up card: lists the configured packs and redirects to Stripe
 * Checkout on click. The price-per-minute above each pack is the single source
 * of truth for the operator-set rate (`VOICE_BONUS_USD_PER_MINUTE`, default
 * $0.43/min); the pack list is whatever `listVoiceBonusPacks()` returned on
 * the server, so hiding a pack is a pure env-var change (no redeploy).
 *
 * Purchase flow:
 *   1. POST /api/billing/voice-bonus/checkout { packId }
 *   2. Server returns { checkoutUrl } → we window.location.href to it.
 *   3. Stripe webhook (`checkout.session.completed` + voice_bonus_seconds
 *      metadata) records the grant; tenant sees it in the balance card above.
 */

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import type { VoiceBonusPack } from "@/lib/billing/voice-bonus-packs";

type Props = {
  packs: VoiceBonusPack[];
  usdPerMinute: number;
  canPurchase: boolean;
  disabledReason?: string | null;
};

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

function formatRatePerMinute(usdPerMinute: number): string {
  return `${currency.format(usdPerMinute)} / min`;
}

export function VoiceBonusPacks({ packs, usdPerMinute, canPurchase, disabledReason }: Props) {
  const [loadingPackId, setLoadingPackId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleBuy(packId: string) {
    if (!canPurchase) return;
    setError(null);
    setLoadingPackId(packId);
    try {
      const res = await fetch("/api/billing/voice-bonus/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packId })
      });
      const json = (await res.json().catch(() => null)) as
        | { ok: true; data: { checkoutUrl: string } }
        | { ok: false; error: { message: string } }
        | null;
      if (!res.ok || !json || json.ok === false) {
        const msg =
          json && json.ok === false ? json.error.message : "Could not start checkout";
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
        <h2 className="text-sm font-semibold text-parchment uppercase tracking-wider">
          Buy more voice minutes
        </h2>
        <p className="mt-2 text-xs text-parchment/50">
          Top-up packs are not currently available. Contact support if you need more minutes this period.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-parchment uppercase tracking-wider">
          Buy more voice minutes
        </h2>
        <span className="text-xs font-mono text-parchment/60">
          {formatRatePerMinute(usdPerMinute)}
        </span>
      </div>
      <p className="mt-1 text-xs text-parchment/50">
        Packs add to your bonus balance on top of your plan&apos;s included minutes. Bonus minutes
        expire at the later of your current billing period end or 30 days after purchase.
      </p>

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
              <p className="text-xs text-parchment/50">
                {pack.minutes} min ({pack.seconds.toLocaleString()} sec)
              </p>
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
