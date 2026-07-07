"use client";

/**
 * Admin data-residency control (enterprise businesses only).
 *
 * Drives the rollout progression for the enterprise data-residency
 * program: supabase → dual → vps, and back. The server enforces the
 * enterprise tier gate (updateDataResidencyMode → assertResidencyModeAllowed);
 * this panel is the operator's console for it.
 *
 * Mode semantics (matching src/lib/residency):
 *   supabase — off (default). All content central, code path unchanged.
 *   dual     — journal replication ON: every content write copies to the
 *              tenant box (~1 min lag). Reads stay central. Run the
 *              backfill after flipping.
 *   vps      — dashboard content reads come FROM THE BOX (no fallback).
 *              Flip only after the parity gate passes.
 *
 * The purge (removing central history) is deliberately CLI-only
 * (debug/residency-purge.ts): it is destructive on central and parity-gated,
 * so it stays a deliberate operator action, not a button.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";

type Mode = "supabase" | "dual" | "vps";

const MODE_COPY: Record<Mode, { label: string; hint: string }> = {
  supabase: {
    label: "Off (central)",
    hint: "All content in central Supabase. Safe rollback target at any time before a purge."
  },
  dual: {
    label: "Dual (replicating)",
    hint: "Writes journal to the tenant box (~1 min lag). Next: run debug/residency-backfill.ts, then verify with debug/residency-parity.ts."
  },
  vps: {
    label: "VPS (box is read source)",
    hint: "Dashboard content reads come from the box — a down box means visible errors, never stale central data. Flip only after the parity gate passes."
  }
};

const ORDER: Mode[] = ["supabase", "dual", "vps"];

export function ResidencyPanel({
  businessId,
  initialMode
}: {
  businessId: string;
  initialMode: Mode;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [target, setTarget] = useState<Mode | "">("");
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function applyMode() {
    if (!target || target === mode) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/data-residency", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, mode: target })
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? "Mode change failed");
      } else {
        setMode(target);
        setTarget("");
        router.refresh();
      }
    } catch {
      setError("Network error");
    } finally {
      setConfirming(false);
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <span className="text-xs text-parchment/40">Current mode</span>
        <span className="rounded-full border border-signal-teal/40 bg-signal-teal/10 px-3 py-0.5 text-xs font-medium text-signal-teal">
          {MODE_COPY[mode].label}
        </span>
      </div>
      <p className="text-xs text-parchment/50">{MODE_COPY[mode].hint}</p>

      <div className="flex flex-wrap items-center gap-2">
        {ORDER.filter((m) => m !== mode).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              setTarget(m);
              setConfirming(false);
              setError(null);
            }}
            className={[
              "rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
              target === m
                ? "border-signal-teal bg-signal-teal/15 text-signal-teal"
                : "border-parchment/20 text-parchment/50 hover:border-parchment/40"
            ].join(" ")}
          >
            → {MODE_COPY[m].label}
          </button>
        ))}
      </div>

      {target && !confirming && (
        <Button size="sm" variant="secondary" onClick={() => setConfirming(true)}>
          Review change
        </Button>
      )}
      {target && confirming && (
        <div className="space-y-2 rounded-lg border border-spark-orange/30 bg-spark-orange/5 p-3">
          <p className="text-xs text-parchment/70">{MODE_COPY[target].hint}</p>
          <div className="flex gap-2">
            <Button size="sm" onClick={applyMode} loading={loading}>
              Confirm: set {MODE_COPY[target].label}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setTarget("");
                setConfirming(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {error && <p className="text-xs text-spark-orange">{error}</p>}
      <p className="text-[11px] text-parchment/35">
        Purging central history stays CLI-only: debug/residency-purge.ts (parity-gated,
        dry-run by default). Backups: encrypted dumps every 6h, restore via
        debug/residency-restore.ts.
      </p>
    </div>
  );
}
