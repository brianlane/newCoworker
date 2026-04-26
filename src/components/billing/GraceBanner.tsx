/**
 * Dashboard-wide banner shown whenever the current business is in the
 * post-cancellation grace window (status=`canceled` AND `grace_ends_at` in
 * the future). Explains the wipe deadline and gives a single call-to-
 * action to reactivate. The reactivate button POSTs to
 * `/api/billing/reactivate` with `mode: "resubscribe"` and redirects to
 * the returned Stripe Checkout URL.
 *
 * Rendered from the dashboard layout so every dashboard page surfaces the
 * warning, not just `/dashboard/billing`.
 */

"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";

type Props = {
  graceEndsAt: string;
  /**
   * Display hint so the CTA copy reads right depending on why we're in
   * grace. Accepts the full CancelReason union; we only branch on the
   * distinctions users care about.
   */
  reason?:
    | "user_refund"
    | "user_period_end"
    | "payment_failed"
    | "admin_force"
    | "upgrade_switch"
    | null;
};

function formatDate(iso: string): string {
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

function daysUntil(iso: string): number {
  try {
    const ms = new Date(iso).getTime() - Date.now();
    return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
  } catch {
    return 0;
  }
}

function headline(reason: Props["reason"]): string {
  if (reason === "payment_failed") return "Your last payment didn't go through — your workspace is paused";
  if (reason === "admin_force") return "Your account has been canceled";
  return "Your subscription is canceled";
}

export function GraceBanner({ graceEndsAt, reason }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const days = daysUntil(graceEndsAt);

  async function handleReactivate() {
    setLoading(true);
    setError(null);
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
        setError(json && json.ok === false ? json.error.message : "Could not start checkout");
        setLoading(false);
        return;
      }
      window.location.assign(json.data.checkoutUrl);
    } catch {
      setError("Network error starting checkout");
      setLoading(false);
    }
  }

  return (
    <div
      role="status"
      className="rounded-xl border border-spark-orange/40 bg-spark-orange/10 px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3"
    >
      <div className="flex-1">
        <p className="text-sm font-semibold text-spark-orange">{headline(reason)}</p>
        <p className="text-xs text-parchment/70 mt-1">
          Your data will be permanently wiped on{" "}
          <span className="font-mono">{formatDate(graceEndsAt)}</span>
          {days > 0 ? ` (${days} day${days === 1 ? "" : "s"} left).` : "."} Reactivate to cancel
          the wipe and bring your workspace back online.
        </p>
        {error && (
          <p className="mt-2 text-xs text-spark-orange" role="alert">
            {error}
          </p>
        )}
      </div>
      <Button
        size="sm"
        variant="primary"
        loading={loading}
        onClick={handleReactivate}
      >
        Reactivate
      </Button>
    </div>
  );
}
