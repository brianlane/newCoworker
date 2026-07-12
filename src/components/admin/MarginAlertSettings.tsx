"use client";

import { useState } from "react";
import { Card } from "@/components/ui/Card";

/**
 * Admin → Costs card for the margin watchdog: toggle + dollar floor.
 * Saves through POST /api/admin/margin-alert; the daily cost-sync run
 * reads the stored config, so changes apply without a deploy.
 */

export type MarginAlertConfigView = {
  enabled: boolean;
  thresholdCents: number;
};

export function MarginAlertSettings({
  initialConfig
}: {
  initialConfig: MarginAlertConfigView;
}) {
  const [enabled, setEnabled] = useState(initialConfig.enabled);
  const [dollars, setDollars] = useState((initialConfig.thresholdCents / 100).toString());
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const save = async (next?: { enabled?: boolean }) => {
    setBusy(true);
    setStatus(null);
    // Snapshot for rollback: an optimistic toggle that fails to persist
    // must revert, or the card lies about whether the watchdog is active.
    const prevEnabled = enabled;
    const thresholdCents = Math.round(Number(dollars) * 100);
    if (!Number.isFinite(thresholdCents)) {
      setStatus("Enter a dollar floor, e.g. 0 or 25");
      setBusy(false);
      return;
    }
    try {
      const nextEnabled = next?.enabled ?? enabled;
      if (next?.enabled !== undefined) setEnabled(next.enabled);
      const res = await fetch("/api/admin/margin-alert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: nextEnabled, thresholdCents })
      });
      const body = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      if (!res.ok) {
        setEnabled(prevEnabled);
        setStatus(body?.error?.message ?? `Save failed (HTTP ${res.status})`);
        return;
      }
      setStatus("Saved");
    } catch (err) {
      setEnabled(prevEnabled);
      setStatus(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider">
          Margin Alert
        </h2>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          disabled={busy}
          onClick={() => void save({ enabled: !enabled })}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50 ${
            enabled ? "bg-signal-teal" : "bg-parchment/20"
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-deep-ink transition-transform ${
              enabled ? "translate-x-5" : "translate-x-1"
            }`}
          />
        </button>
      </div>
      <p className="text-xs text-parchment/50 mb-3">
        Emails ops after the daily cost sync when a PAYING tenant&apos;s actual margin drops below
        the floor. Idle pilots and pool boxes are excluded — they live in the burn views above.
      </p>
      <div className="flex items-center gap-2">
        <label className="text-xs text-parchment/60" htmlFor="margin-alert-floor">
          Floor $/mo
        </label>
        <input
          id="margin-alert-floor"
          type="number"
          step="1"
          value={dollars}
          onChange={(e) => setDollars(e.target.value)}
          className="w-24 rounded-md border border-parchment/20 bg-deep-ink px-2 py-1.5 text-xs text-parchment focus:outline-none focus:ring-1 focus:ring-signal-teal"
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy}
          className="rounded-lg border border-parchment/15 px-3 py-1.5 text-xs font-medium text-parchment hover:border-signal-teal/50 disabled:opacity-50 transition-colors"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {status && <span className="text-xs text-parchment/50">{status}</span>}
      </div>
    </Card>
  );
}
