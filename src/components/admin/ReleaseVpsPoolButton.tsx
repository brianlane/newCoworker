"use client";

/**
 * Admin action: return this tenant's Hostinger box to the `vps_inventory`
 * adopt pool (state=available) while the account keeps running on it. When
 * a new signup's adopt-first claim picks the box up, the adopt recreates it
 * and the OLD account is cascade-deleted (business row + all tenant data +
 * owner login). Two-step confirm mirrors DeleteClientButton — the eventual
 * effect is just as irreversible, only deferred to reuse time.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";

export function ReleaseVpsPoolButton({
  businessId,
  businessName,
  vpsId
}: {
  businessId: string;
  businessName: string;
  vpsId: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRelease() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/vps/${businessId}/release-to-pool`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? "Release failed");
        setConfirming(false);
      } else {
        setDone(true);
        router.refresh();
      }
    } catch {
      setError("Network error");
      setConfirming(false);
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <span className="text-xs text-claw-green">
        ✓ VPS {vpsId} released to pool — this account will be deleted when a new signup adopts it
      </span>
    );
  }

  if (confirming) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-spark-orange">
          Make VPS <strong>{vpsId}</strong> available for new signups?{" "}
          <strong>{businessName}</strong> keeps running on it for now — but the moment a new
          account adopts the box it is wiped and reinstalled, and this account (all data + owner
          login) is <strong>permanently deleted</strong>. Releasing also cancels this
          account&apos;s internal subscription and turns off the box&apos;s Hostinger
          auto-renewal (it lapses at period end unless adopted). This cannot be undone after
          reuse.
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="danger" onClick={handleRelease} loading={loading}>
            Confirm release to pool
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
    <div className="space-y-1">
      <Button size="sm" variant="secondary" onClick={() => setConfirming(true)}>
        Release VPS to pool
      </Button>
      {error && <p className="text-xs text-spark-orange">{error}</p>}
    </div>
  );
}
