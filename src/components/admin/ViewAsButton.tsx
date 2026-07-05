"use client";

import { useState } from "react";
import { Eye } from "lucide-react";

/**
 * "View dashboard as tenant" — starts an admin view-as session for this
 * business and jumps to the owner dashboard. Rendered on the admin business
 * detail page.
 */
export function ViewAsButton({ businessId }: { businessId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/view-as", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId })
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }
      window.location.href = "/dashboard";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start view-as");
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={start}
        disabled={busy}
        className="flex items-center gap-1.5 rounded-lg border border-signal-teal/40 px-3 py-1.5 text-xs font-medium text-signal-teal hover:bg-signal-teal/10 disabled:opacity-50 transition-colors"
      >
        <Eye className="h-3.5 w-3.5" />
        {busy ? "Opening…" : "View as tenant"}
      </button>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
