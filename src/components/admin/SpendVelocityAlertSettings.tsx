"use client";

import { useState } from "react";
import { Card } from "@/components/ui/Card";

/**
 * Admin → System card for the Gemini spend-velocity watchdog: toggle +
 * dollar threshold + window minutes. Saves through
 * POST /api/admin/spend-velocity; the Edge cron reads the stored config on
 * every 10-minute tick, so changes apply without a deploy.
 */

export type SpendVelocityConfigView = {
  enabled: boolean;
  thresholdMicros: number;
  windowMinutes: number;
};

export function SpendVelocityAlertSettings({
  initialConfig
}: {
  initialConfig: SpendVelocityConfigView;
}) {
  const [enabled, setEnabled] = useState(initialConfig.enabled);
  const [dollars, setDollars] = useState((initialConfig.thresholdMicros / 1_000_000).toString());
  const [minutes, setMinutes] = useState(String(initialConfig.windowMinutes));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const save = async (next?: { enabled?: boolean }) => {
    setBusy(true);
    setStatus(null);
    // Snapshot for rollback: an optimistic toggle that fails to persist
    // must revert, or the card lies about whether the watchdog is active.
    const prevEnabled = enabled;
    const thresholdMicros = Math.round(Number(dollars) * 1_000_000);
    const windowMinutes = Math.round(Number(minutes));
    if (!Number.isFinite(thresholdMicros) || thresholdMicros <= 0) {
      setStatus("Enter a dollar amount, e.g. 3");
      setBusy(false);
      return;
    }
    if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) {
      setStatus("Enter a window in minutes, e.g. 120");
      setBusy(false);
      return;
    }
    try {
      const res = await fetch("/api/admin/spend-velocity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: next?.enabled ?? enabled,
          thresholdMicros,
          windowMinutes
        })
      });
      const json = (await res.json()) as {
        ok: boolean;
        data?: { config: SpendVelocityConfigView };
        error?: { message: string };
      };
      if (!json.ok || !json.data) throw new Error(json.error?.message ?? "Save failed");
      setEnabled(json.data.config.enabled);
      setDollars((json.data.config.thresholdMicros / 1_000_000).toString());
      setMinutes(String(json.data.config.windowMinutes));
      setStatus("Saved.");
    } catch (e) {
      // Revert the optimistic toggle so the checkbox reflects what the
      // watchdog is ACTUALLY doing (Bugbot Medium on PR #504).
      setEnabled(prevEnabled);
      setStatus(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-parchment">AI spend velocity alert</h2>
        <label className="flex items-center gap-2 text-xs text-parchment/70">
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy}
            onChange={(ev) => {
              setEnabled(ev.target.checked);
              void save({ enabled: ev.target.checked });
            }}
          />
          Enabled
        </label>
      </div>
      <p className="text-xs text-parchment/40 mb-4">
        Emails the admin when any business burns more than the amount below within the rolling
        window — a rate watchdog on the shared Gemini budget, independent of the monthly cap.
        Checked every 10 minutes; at most one alert per business per window.
      </p>
      <div className="flex items-end gap-3">
        <label className="block text-xs text-parchment/70">
          Amount (USD)
          <input
            type="number"
            min="0.1"
            step="0.5"
            value={dollars}
            onChange={(ev) => setDollars(ev.target.value)}
            className="mt-1 w-28 rounded-lg bg-black/30 border border-parchment/10 p-2 text-sm text-parchment focus:outline-none focus:border-claw-green"
          />
        </label>
        <label className="block text-xs text-parchment/70">
          Window (minutes)
          <input
            type="number"
            min="10"
            step="10"
            value={minutes}
            onChange={(ev) => setMinutes(ev.target.value)}
            className="mt-1 w-28 rounded-lg bg-black/30 border border-parchment/10 p-2 text-sm text-parchment focus:outline-none focus:border-claw-green"
          />
        </label>
        <button
          type="button"
          disabled={busy}
          onClick={() => void save()}
          className="rounded-lg bg-claw-green text-deep-ink px-4 py-2 text-sm font-semibold hover:bg-opacity-90 transition-colors disabled:opacity-50"
        >
          Save
        </button>
      </div>
      {status && <p className="mt-3 text-xs text-parchment/50">{status}</p>}
    </Card>
  );
}
