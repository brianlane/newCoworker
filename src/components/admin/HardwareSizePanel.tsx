"use client";

/**
 * Admin hardware escalation control (Infrastructure card).
 *
 * Shows the tenant's effective box size and lets the operator move them to
 * a different size (kvm1/kvm2/kvm4/kvm8) without changing entitlements —
 * the panel replacement for debug/migrate-vps-size.ts. The API answers 202
 * and the migration runs unattended; progress arrives as ops emails
 * (started → completed/failed), so the panel only confirms the kickoff.
 */

import { useState } from "react";
import { Button } from "@/components/ui/Button";

const SIZES = ["kvm1", "kvm2", "kvm4", "kvm8"] as const;
type Size = (typeof SIZES)[number];

const SIZE_LABEL: Record<Size, string> = {
  kvm1: "KVM 1: 1 vCPU / 4GB (no local model)",
  kvm2: "KVM 2: 2 vCPU / 8GB",
  kvm4: "KVM 4: 4 vCPU / 16GB",
  kvm8: "KVM 8: 8 vCPU / 32GB"
};

export function HardwareSizePanel({
  businessId,
  currentSize,
  pinned
}: {
  businessId: string;
  /** Effective deployed size (resolveDeployedVpsSize on the server). */
  currentSize: Size;
  /** Whether businesses.vps_size carries an explicit pin. */
  pinned: boolean;
}) {
  const [target, setTarget] = useState<Size | "">("");
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handle() {
    if (!target) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/vps/${businessId}/migrate-size`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ size: target })
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? "Migration kickoff failed");
        setConfirming(false);
      } else {
        setStarted(true);
        setConfirming(false);
      }
    } catch {
      setError("Network error");
      setConfirming(false);
    } finally {
      setLoading(false);
    }
  }

  if (started) {
    return (
      <div className="space-y-1">
        <p className="text-sm text-signal-teal">
          Migration to {target} started. Watch the ops inbox; a
          &ldquo;completed&rdquo; or &ldquo;failed&rdquo; email arrives when it finishes
          (typically 10–20 min).
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-parchment/40">
        Current box: <span className="font-mono text-parchment">{currentSize}</span>
        {pinned ? " (pinned)" : " (tier default)"}. Entitlements stay on the tier; only
        hardware moves.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="rounded-md bg-deep-ink/80 border border-parchment/20 text-parchment text-sm px-2 py-1.5"
          value={target}
          onChange={(e) => {
            setTarget(e.target.value as Size | "");
            setConfirming(false);
            setError(null);
          }}
        >
          <option value="">Escalate / move hardware…</option>
          {SIZES.filter((s) => s !== currentSize).map((s) => (
            <option key={s} value={s}>
              {SIZE_LABEL[s]}
            </option>
          ))}
        </select>
        {target && !confirming && (
          <Button size="sm" variant="secondary" onClick={() => setConfirming(true)}>
            Migrate to {target}
          </Button>
        )}
      </div>
      {confirming && target && (
        <div className="space-y-2">
          <p className="text-xs text-spark-orange">
            Buys a fresh {target} box, backs up + migrates this tenant onto it, then stops
            the old box and lets its billing lapse. Runs unattended ~10–20 min; progress
            lands in the ops inbox.
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="danger" onClick={handle} loading={loading}>
              Confirm migration
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setConfirming(false)}>
              Back
            </Button>
          </div>
        </div>
      )}
      {error && <p className="text-xs text-spark-orange">{error}</p>}
    </div>
  );
}
