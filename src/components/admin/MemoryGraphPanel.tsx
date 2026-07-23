"use client";

/**
 * Admin knowledge-graph control for one tenant.
 *
 * Mode semantics (matching src/lib/memory/graph-db.ts):
 *   inherit — follow the fleet-wide default (set on /admin/memory-graph).
 *   off     — no graph writes, no graph retrieval, projection wiped from
 *             the box on the next sync.
 *   shadow  — graph is built and every lookup logs a graph-vs-memory
 *             comparison; live answers are byte-identical.
 *   active  — graph facts ride the knowledge-lookup prompt alongside
 *             ranked memory.
 *
 * The flip schedules a vault sync so the on-box projection ships/wipes
 * immediately. ResidencyPanel is the style precedent.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";

type ModeSetting = "inherit" | "off" | "shadow" | "active";

const MODE_COPY: Record<ModeSetting, { label: string; hint: string }> = {
  inherit: {
    label: "Inherit fleet default",
    hint: "Follows the platform-wide default mode set on the Memory graph admin page."
  },
  off: {
    label: "Off",
    hint: "No graph writes or retrieval; the on-box projection is wiped on the next sync."
  },
  shadow: {
    label: "Shadow (compare, don't use)",
    hint: "Graph builds and every lookup records a graph-vs-memory comparison; live answers are unchanged."
  },
  active: {
    label: "Active (graph feeds answers)",
    hint: "Graph facts ride the knowledge-lookup prompt alongside ranked memory. Flip only after the shadow comparison looks right."
  }
};

const ORDER: ModeSetting[] = ["inherit", "off", "shadow", "active"];

export function MemoryGraphPanel({
  businessId,
  initialMode,
  effectiveMode,
  entityCount,
  factCount,
  lastEventAt
}: {
  businessId: string;
  initialMode: ModeSetting;
  /** Post-inheritance mode the tenant is actually running. */
  effectiveMode: "off" | "shadow" | "active";
  entityCount: number;
  factCount: number;
  lastEventAt: string | null;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<ModeSetting>(initialMode);
  const [target, setTarget] = useState<ModeSetting | "">("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function applyMode() {
    if (!target || target === mode) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/memory-graph", {
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
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-parchment/70">
        <span>
          Mode: <span className="text-parchment">{MODE_COPY[mode].label}</span>
          {mode === "inherit" && (
            <span className="text-parchment/50"> → effective {effectiveMode}</span>
          )}
        </span>
        <span>
          Graph: <span className="text-parchment">{entityCount}</span> entities,{" "}
          <span className="text-parchment">{factCount}</span> facts
        </span>
        <span>
          Last lookup event:{" "}
          <span className="text-parchment">
            {lastEventAt ? new Date(lastEventAt).toLocaleString() : "none yet"}
          </span>
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value as ModeSetting | "")}
          className="rounded-lg border border-parchment/20 bg-ink px-3 py-2 text-sm text-parchment"
        >
          <option value="">Change mode…</option>
          {ORDER.filter((m) => m !== mode).map((m) => (
            <option key={m} value={m}>
              {MODE_COPY[m].label}
            </option>
          ))}
        </select>
        <Button onClick={applyMode} loading={loading} disabled={!target} variant="secondary">
          Apply
        </Button>
        <a
          href={`/admin/memory-graph?business=${businessId}`}
          className="text-sm text-claw-green underline underline-offset-2 hover:opacity-80"
        >
          Open comparison view
        </a>
      </div>

      {target && <p className="text-xs text-parchment/50">{MODE_COPY[target].hint}</p>}
      {error && <p className="text-xs text-rose-300">{error}</p>}
    </div>
  );
}
