"use client";

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import type { CiE2eMode } from "@/lib/admin/ci-e2e-mode";

/**
 * Admin → Gemini card for the CI live-e2e cost toggle. Saves through
 * PUT /api/admin/ci-e2e-mode; the GitHub e2e job reads the stored mode at
 * the start of every run (GET /api/public/ci-e2e-mode), so a flip applies
 * to the next run with no deploy.
 */

export function CiE2eModeSettings({ initialMode }: { initialMode: CiE2eMode }) {
  const [mode, setMode] = useState<CiE2eMode>(initialMode);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const save = async (next: CiE2eMode) => {
    setBusy(true);
    setStatus(null);
    // Snapshot for rollback: an optimistic switch that fails to persist
    // must revert, or the card lies about what CI is actually doing (same
    // rationale as the spend-velocity card, Bugbot on PR #504).
    const prev = mode;
    setMode(next);
    try {
      const res = await fetch("/api/admin/ci-e2e-mode", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: next })
      });
      const json = (await res.json()) as {
        ok: boolean;
        data?: { mode: CiE2eMode };
        error?: { message: string };
      };
      if (!json.ok || !json.data) throw new Error(json.error?.message ?? "Save failed");
      setMode(json.data.mode);
      setStatus("Saved — applies to the next CI run.");
    } catch (e) {
      setMode(prev);
      setStatus(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const perChange = mode === "per-change";
  return (
    <Card>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-parchment">CI live e2e (paid Gemini calls)</h2>
        <div className="flex items-center gap-2">
          <span className="text-xs text-parchment/70">Run on every change</span>
          {/* Same slider-switch pattern as the Margin Alert card. */}
          <button
            type="button"
            role="switch"
            aria-checked={perChange}
            aria-label="Run the live e2e suite on every change"
            disabled={busy}
            onClick={() => void save(perChange ? "nightly-only" : "per-change")}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50 ${
              perChange ? "bg-signal-teal" : "bg-parchment/20"
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 transform rounded-full bg-deep-ink transition-transform ${
                perChange ? "translate-x-5" : "translate-x-1"
              }`}
            />
          </button>
        </div>
      </div>
      <p className="text-xs text-parchment/40">
        {mode === "per-change" ? (
          <>
            <span className="text-parchment/70 font-medium">Per change (current):</span> every PR
            and push to main runs the live AI suite scoped to its diff, plus the nightly full run.
            Maximum coverage, highest spend on the internal-ci-debug key.
          </>
        ) : (
          <>
            <span className="text-spark-orange font-medium">Nightly only:</span> PRs and pushes
            skip ALL paid model calls (the e2e check still gates merges and reports success). The
            full suite runs once a day on the nightly cron and emails{" "}
            <span className="text-parchment/60">team@newcoworker.com</span> only when it fails.
          </>
        )}
      </p>
      <p className="text-xs text-parchment/30 mt-2">
        Read by GitHub Actions at the start of every e2e job; any read error fails open to
        per-change so an outage can never silently drop merge-time coverage.
      </p>
      {status && <p className="mt-3 text-xs text-parchment/50">{status}</p>}
    </Card>
  );
}
