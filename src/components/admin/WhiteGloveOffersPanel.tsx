"use client";

/**
 * Admin panel for CUSTOM white-glove offers.
 *
 * Two modes:
 * - Business mode (business detail page): offers tied to one business; they
 *   also appear on that business's billing page.
 * - Prospect mode (admin overview, no businessId): pre-account offers keyed
 *   to an email — payable through the public /offer/<pay_token> link BEFORE
 *   the account exists.
 *
 * Every open offer exposes its durable, emailable payment link (the link
 * creates a fresh Stripe Checkout session per visit, so it never expires).
 * The stored row is the pricing source of truth. Open offers can be revoked;
 * paid ones are permanent (refunds go through the force-refund tooling).
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
  recipient_email: string | null;
  payUrl: string;
};

function usd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export function WhiteGloveOffersPanel({
  businessId,
  initialOffers
}: {
  /** Omit for prospect (pre-account) offers keyed to an email. */
  businessId?: string;
  initialOffers: OfferView[];
}) {
  const [offers, setOffers] = useState<OfferView[]>(initialOffers);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const prospectMode = !businessId;

  async function refresh() {
    const qs = prospectMode ? "prospect=1" : `businessId=${businessId}`;
    const res = await fetch(`/api/admin/white-glove-offers?${qs}`);
    const json = await res.json();
    if (res.ok) setOffers(json.data?.offers ?? []);
  }

  async function create() {
    const amountUsd = Number(amount);
    if (!name.trim() || !Number.isFinite(amountUsd) || amountUsd <= 0) {
      setError("Name and a positive dollar amount are required");
      return;
    }
    if (prospectMode && !email.trim()) {
      setError("Prospect offers need the recipient's email");
      return;
    }
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/white-glove-offers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(businessId ? { businessId } : {}),
          ...(email.trim() ? { recipientEmail: email.trim() } : {}),
          name: name.trim(),
          description: description.trim() || undefined,
          amountUsd
        })
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? "Creating the offer failed");
      } else {
        const emailedTo: string | null = json.data?.emailedTo ?? null;
        setNotice(
          emailedTo
            ? `Offer created and emailed to ${emailedTo} with the payment link.`
            : "Offer created — the email couldn't be sent automatically, so copy the pay link below and send it yourself."
        );
        setName("");
        setDescription("");
        setAmount("");
        setEmail("");
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

  async function copyLink(offer: OfferView) {
    try {
      await navigator.clipboard.writeText(offer.payUrl);
      setCopiedId(offer.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      setError("Copy failed — the link is shown below the offer");
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-parchment/40">
        {prospectMode
          ? "Create a bespoke, one-time offer for a PROSPECT (no account needed). The payment link is emailed to them automatically; they pay through Stripe before signup."
          : "Create a bespoke, one-time offer for this business. The payment link is emailed to the recipient (or the owner) automatically, and it appears on their billing page. Paying opens the standard 30-day priority support window."}
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
        <label className="flex flex-col gap-1 text-xs text-parchment/60">
          {prospectMode ? "Recipient email" : "Recipient email (optional)"}
          <input
            className="rounded-md bg-deep-ink/80 border border-parchment/20 text-parchment text-sm px-2 py-1.5 w-64"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="prospect@example.com"
            type="email"
            maxLength={320}
          />
        </label>
        <Button onClick={create} disabled={loading} size="sm">
          {loading ? "Working…" : "Create offer"}
        </Button>
      </div>
      <label className="flex flex-col gap-1 text-xs text-parchment/60">
        Description (shown on the payment page{prospectMode ? "" : " and their billing card"})
        <input
          className="rounded-md bg-deep-ink/80 border border-parchment/20 text-parchment text-sm px-2 py-1.5 w-full"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Full migration from your old provider plus three custom AiFlows."
          maxLength={500}
        />
      </label>

      {error && <p className="text-xs text-clay-red">{error}</p>}
      {notice && <p className="text-xs text-claw-green">{notice}</p>}

      {offers.length > 0 && (
        <ul className="space-y-1.5">
          {offers.map((o) => (
            <li
              key={o.id}
              className="rounded-md border border-parchment/10 bg-deep-ink/30 px-3 py-2 space-y-1"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm text-parchment truncate">
                    {o.name} — {usd(o.amount_cents)}
                    {o.recipient_email && (
                      <span className="ml-2 text-xs text-parchment/40">{o.recipient_email}</span>
                    )}
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
                  <div className="flex shrink-0 gap-2">
                    <Button onClick={() => copyLink(o)} disabled={loading} size="sm" variant="ghost">
                      {copiedId === o.id ? "Copied!" : "Copy pay link"}
                    </Button>
                    <Button onClick={() => revoke(o.id)} disabled={loading} size="sm" variant="ghost">
                      Revoke
                    </Button>
                  </div>
                )}
              </div>
              {o.status === "open" && (
                <p className="break-all font-mono text-[10px] text-parchment/30">{o.payUrl}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
