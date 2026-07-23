"use client";

/**
 * Fleet-wide knowledge-graph default mode. Every tenant whose per-business
 * setting is 'inherit' follows this value (resolveMemoryGraphMode).
 * Retrieval/ingest converge within the resolver's ~60s cache; each
 * inherit-tenant's on-box projection refreshes on its next vault sync.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";

type Mode = "off" | "shadow" | "active";

const HINTS: Record<Mode, string> = {
  off: "Graph writes, retrieval, and comparison logging stop for every inherit-mode tenant.",
  shadow:
    "Graphs build and comparisons record fleet-wide; live answers stay unchanged. The safe default.",
  active:
    "Graph facts feed answers for every inherit-mode tenant. Flip only after fleet-wide shadow numbers look right."
};

export function MemoryGraphDefaultToggle({ initialDefault }: { initialDefault: Mode }) {
  const router = useRouter();
  const [current, setCurrent] = useState<Mode>(initialDefault);
  const [target, setTarget] = useState<Mode | "">("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function apply() {
    if (!target || target === current) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/memory-graph", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultMode: target })
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? "Update failed");
      } else {
        setCurrent(target);
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
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-parchment/70">
          Fleet default (inherit-mode tenants):{" "}
          <span className="text-parchment font-semibold">{current}</span>
        </span>
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value as Mode | "")}
          className="rounded-lg border border-parchment/20 bg-ink px-3 py-2 text-sm text-parchment"
        >
          <option value="">Change default…</option>
          {(["off", "shadow", "active"] as Mode[])
            .filter((m) => m !== current)
            .map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
        </select>
        <Button onClick={apply} loading={loading} disabled={!target} variant="secondary">
          Apply to fleet
        </Button>
      </div>
      {target && <p className="text-xs text-parchment/50">{HINTS[target]}</p>}
      {error && <p className="text-xs text-rose-300">{error}</p>}
    </div>
  );
}
