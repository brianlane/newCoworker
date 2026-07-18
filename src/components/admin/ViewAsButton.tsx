"use client";

import { useState } from "react";
import { Eye } from "lucide-react";
import { VIEW_AS_BANNER_HIDE_KEY, VIEW_AS_RETURN_TO_KEY } from "./ViewAsBanner";

/**
 * "View dashboard as tenant" — starts an admin view-as session for this
 * business and jumps to the owner dashboard. Rendered on the admin business
 * detail page (default bordered button) and in the All Clients table rows
 * (`variant="link"`, matching the compact "Details" link style).
 */
export function ViewAsButton({
  businessId,
  variant = "button"
}: {
  businessId: string;
  variant?: "button" | "link";
}) {
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
      // A previous session's Hide must not suppress the fresh session's
      // banner (it carries the only Exit button in this tab).
      sessionStorage.removeItem(VIEW_AS_BANNER_HIDE_KEY);
      // Remember where the session started (path + query, so table filters /
      // pagination survive) so the banner's Exit returns the admin here.
      sessionStorage.setItem(
        VIEW_AS_RETURN_TO_KEY,
        window.location.pathname + window.location.search
      );
      window.location.href = "/dashboard";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start view-as");
      setBusy(false);
    }
  };

  if (variant === "link") {
    return (
      <span className="inline-flex flex-col gap-0.5">
        <button
          onClick={start}
          disabled={busy}
          className="inline-flex items-center gap-1 text-xs text-signal-teal hover:underline disabled:opacity-50 transition-colors"
        >
          <Eye className="h-3 w-3" />
          {busy ? "Opening…" : "View as"}
        </button>
        {error && <p className="text-xs text-red-400">{error}</p>}
      </span>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={start}
        disabled={busy}
        className="flex items-center gap-1.5 rounded-md border border-signal-teal/40 px-3 py-1.5 text-sm font-medium text-signal-teal hover:bg-signal-teal/10 disabled:opacity-50 transition-colors"
      >
        <Eye className="h-3.5 w-3.5" />
        {busy ? "Opening…" : "View as tenant"}
      </button>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
