"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";

/**
 * Mint a Stripe Checkout resubscribe link for a canceled-in-grace tenant.
 * Sits on the admin client page next to Stripe diagnostics so ops do not
 * have to open the Stripe Dashboard to recover a payment-failed cancel.
 */
export function ResubscribeCheckoutButton({ businessId }: { businessId: string }) {
  const [loading, setLoading] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ tier: string; billingPeriod: string } | null>(null);

  async function handleCreate() {
    setLoading(true);
    setError(null);
    setCopied(false);
    try {
      const res = await fetch("/api/admin/resubscribe-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId })
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? "Could not create a resubscribe link");
      } else {
        setUrl(json.data.url);
        setMeta({ tier: json.data.tier, billingPeriod: json.data.billingPeriod });
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  async function handleCopy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setError("Could not copy. Select the link below instead.");
    }
  }

  return (
    <div className="space-y-2">
      <Button size="sm" variant="secondary" onClick={handleCreate} loading={loading}>
        {url ? "New resubscribe link" : "Create resubscribe Checkout"}
      </Button>
      {url && (
        <div className="space-y-1">
          <textarea
            readOnly
            value={url}
            rows={3}
            onFocus={(e) => e.currentTarget.select()}
            className="w-full rounded border border-parchment/10 bg-ink/40 p-2 font-mono text-[10px] text-parchment/80"
          />
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={handleCopy}>
              {copied ? "Copied" : "Copy link"}
            </Button>
            <span className="text-xs text-parchment/40">
              Stripe expires it 24 hours after creation.
              {meta ? ` ${meta.tier} / ${meta.billingPeriod}.` : ""}
            </span>
          </div>
          <p className="text-xs text-parchment/40">
            Attaches the existing Stripe customer and the current plan price.
            Paying this Checkout restores the subscriptions row via webhook.
          </p>
        </div>
      )}
      {error && <p className="text-xs text-spark-orange">{error}</p>}
    </div>
  );
}
