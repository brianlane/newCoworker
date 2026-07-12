"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";

/**
 * "Sync now" for the platform cost tables (Admin → Costs). Runs the same
 * pull the daily cron performs via POST /api/admin/cost-sync; the optional
 * 90-day mode backfills history after first deploy.
 */
export function CostSyncButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const sync = async (telnyxRange?: "last_90_days") => {
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch("/api/admin/cost-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(telnyxRange ? { telnyxRange } : {})
      });
      const body = (await res.json().catch(() => null)) as {
        data?: { status?: { ok?: boolean; telnyxError?: string | null; hostingerError?: string | null } };
        error?: { message?: string };
      } | null;
      if (!res.ok) {
        setStatus(body?.error?.message ?? `Sync failed (HTTP ${res.status})`);
        return;
      }
      const result = body?.data?.status;
      if (result && result.ok === false) {
        setStatus(result.telnyxError ?? result.hostingerError ?? "Sync finished with errors");
      } else {
        setStatus("Synced");
      }
      router.refresh();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      {status && <span className="text-xs text-parchment/50">{status}</span>}
      <button
        type="button"
        onClick={() => void sync()}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-lg border border-parchment/15 px-3 py-1.5 text-xs font-medium text-parchment hover:border-signal-teal/50 disabled:opacity-50 transition-colors"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
        {busy ? "Syncing…" : "Sync now"}
      </button>
      <button
        type="button"
        onClick={() => void sync("last_90_days")}
        disabled={busy}
        className="rounded-lg border border-parchment/10 px-3 py-1.5 text-xs text-parchment/60 hover:border-signal-teal/40 disabled:opacity-50 transition-colors"
        title="Re-pull the last 90 days of Telnyx detail records (first-deploy backfill)"
      >
        Backfill 90d
      </button>
    </div>
  );
}
