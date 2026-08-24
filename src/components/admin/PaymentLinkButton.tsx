"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";

/**
 * Mint a Stripe Checkout link for a signup that has not paid, and show it
 * ready to copy.
 *
 * Sits next to Skip Payment because they answer the same situation from
 * opposite ends: skip provisions WITHOUT charging, this one lets the customer
 * pay. Before it existed the only way to hand someone a payment link was to
 * walk them back through the questionnaire.
 */
export function PaymentLinkButton({ businessId }: { businessId: string }) {
  const [loading, setLoading] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate() {
    setLoading(true);
    setError(null);
    setCopied(false);
    try {
      const res = await fetch("/api/admin/payment-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId })
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? "Could not create a payment link");
      } else {
        setUrl(json.data.url);
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
      // Clipboard permission denied: the textarea below still holds the link,
      // so the operator can select it by hand rather than losing it.
      setError("Could not copy. Select the link below instead.");
    }
  }

  return (
    <div className="space-y-2">
      <Button size="sm" variant="secondary" onClick={handleCreate} loading={loading}>
        {url ? "New payment link" : "Create payment link"}
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
            </span>
          </div>
          <p className="text-xs text-parchment/40">
            Charges the plan price plus any country surcharge and the one-time carrier fee.
            Promo codes and usage packs from the original signup are not carried over.
          </p>
        </div>
      )}
      {error && <p className="text-xs text-spark-orange">{error}</p>}
    </div>
  );
}
