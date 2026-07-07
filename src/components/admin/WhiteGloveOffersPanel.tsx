"use client";

/**
 * Admin panel for CUSTOM white-glove offers (business detail page).
 *
 * The operator names a bespoke deal and sets a custom dollar amount; the
 * offer appears on that business's billing page where the owner pays it via
 * Stripe Checkout (inline price_data — the row created here is the pricing
 * source of truth). Open offers can be revoked; paid ones are permanent
 * (refunds go through the force-refund tooling).
 */

import { useState } from "react";
import { Button } from "@/components/ui/Button";

export type OfferView = {
  id: string;
  name: string;
  description: string;
  amount_cents: number;
  status: "open" | "paid" | "revoked";
  created_at: string;
  paid_at: string | null;
};

function usd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export function WhiteGloveOffersPanel({
  businessId,
  initialOffers
}: {
  businessId: string;
  initialOffers: OfferView[];
}) {
  const [offers, setOffers] = useState<OfferView[]>(initialOffers);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const res = await fetch(`/api/admin/white-glove-offers?businessId=${businessId}`);
    const json = await res.json();
    if (res.ok) setOffers(json.data?.offers ?? json.offers ?? []);
  }

  async function create() {
    const amountUsd = Number(amount);
    if (!name.trim() || !Number.isFinite(amountUsd) || amountUsd <= 0) {
      setError("Name and a positive dollar amount are required");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/white-glove-offers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          name: name.trim(),
          description: description.trim() || undefined,
          amountUsd
        })
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? "Creating the offer failed");
      } else {
        setName("");
        setDescription("");
        setAmount("");
        await refresh();
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  async function revoke(offerId: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/white-glove-offers", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offerId })
      });
      const json = await res.json();
      if (!res.ok) setError(json.error?.message ?? "Revoking the offer failed");
      await refresh();
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-parchment/40">
        Create a bespoke, one-time offer for this business. It appears on their billing page
        and is paid through Stripe; paying opens the standard 30-day priority support window.
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-parchment/60">
          Offer name
          <input
            className="rounded-md bg-deep-ink/80 border border-parchment/20 text-parchment text-sm px-2 py-1.5 w-64"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="White-glove migration + 3 AiFlows"
            maxLength={120}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-parchment/60">
          Amount (USD)
          <input
            className="rounded-md bg-deep-ink/80 border border-parchment/20 text-parchment text-sm px-2 py-1.5 w-28"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="1250"
            inputMode="decimal"
          />
        </label>
        <Button onClick={create} disabled={loading} size="sm">
          {loading ? "Working…" : "Create offer"}
        </Button>
      </div>
      <label className="flex flex-col gap-1 text-xs text-parchment/60">
        Description (shown on their billing card)
        <input
          className="rounded-md bg-deep-ink/80 border border-parchment/20 text-parchment text-sm px-2 py-1.5 w-full"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Full migration from your old provider plus three custom AiFlows."
          maxLength={500}
        />
      </label>

      {error && <p className="text-xs text-clay-red">{error}</p>}

      {offers.length > 0 && (
        <ul className="space-y-1.5">
          {offers.map((o) => (
            <li
              key={o.id}
              className="flex items-center justify-between gap-2 rounded-md border border-parchment/10 bg-deep-ink/30 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-sm text-parchment truncate">
                  {o.name} — {usd(o.amount_cents)}
                </p>
                <p className="text-xs text-parchment/40">
                  {o.status === "paid"
                    ? `Paid ${o.paid_at ? new Date(o.paid_at).toLocaleDateString() : ""}`
                    : o.status === "revoked"
                      ? "Revoked"
                      : `Open since ${new Date(o.created_at).toLocaleDateString()}`}
                </p>
              </div>
              {o.status === "open" && (
                <Button onClick={() => revoke(o.id)} disabled={loading} size="sm" variant="ghost">
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
