"use client";

/**
 * Admin-only "issue refund + start grace" button. Bypasses the customer
 * lifetime-refund eligibility checks that gate the self-serve path so
 * support can honor disputes / accidents. Identical downstream behavior
 * to a self-serve cancel & refund (grace window still opens, auth stays
 * enabled until the sweep fires), but does NOT touch Supabase Auth on
 * its own — operators use the separate Force-cancel button for
 * immediate wipes.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";

export function ForceRefundButton({
  businessId,
  businessName
}: {
  businessId: string;
  businessName: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handle() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/force-refund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId })
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? "Refund failed");
        setConfirming(false);
      } else {
        router.refresh();
        setConfirming(false);
      }
    } catch {
      setError("Network error");
      setConfirming(false);
    } finally {
      setLoading(false);
    }
  }

  if (confirming) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-spark-orange">
          Refund the latest Stripe charge on <strong>{businessName}</strong> and start the
          30-day grace window? This cancels Stripe + Hostinger billing, tears down the VPS,
          and stamps the customer&apos;s lifetime refund as used.
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="danger" onClick={handle} loading={loading}>
            Confirm force-refund
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setConfirming(false)}>
            Back
          </Button>
        </div>
        {error && <p className="text-xs text-spark-orange">{error}</p>}
      </div>
    );
  }

  return (
    <Button size="sm" variant="danger" onClick={() => setConfirming(true)}>
      Force-refund
    </Button>
  );
}
