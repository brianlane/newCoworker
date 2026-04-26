"use client";

/**
 * Admin-only hard wipe button (rewired for the subscription lifecycle
 * overhaul, PR 10). Now dispatches `adminForceCancel` via
 * `/api/admin/delete-client` which:
 *   - cancels the Stripe subscription + releases any commitment schedule,
 *   - cancels Hostinger billing (stops paying for the VPS immediately),
 *   - takes a final SSH backup + snapshot,
 *   - wipes durable data, marks the business `status='wiped'`, and
 *   - deletes the owner's Supabase auth user so they can't log back in.
 *
 * No grace period — this is the "nuke now" path. Confirmation copy
 * reflects the irreversible nature of the action.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";

export function DeleteClientButton({ businessId, businessName }: { businessId: string; businessName: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/delete-client", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId })
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? "Delete failed");
        setConfirming(false);
      } else {
        router.push("/admin/clients");
        router.refresh();
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
          Force-cancel and wipe <strong>{businessName}</strong>? This cancels Stripe + Hostinger
          billing, tears down the VPS, wipes tenant data, and disables the owner&apos;s login.
          No grace period, no refund. This cannot be undone.
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="danger" onClick={handleDelete} loading={loading}>
            Confirm force-cancel
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
      Force-cancel &amp; wipe
    </Button>
  );
}
