"use client";

import { useState } from "react";
import {
  VIEW_AS_BANNER_HIDE_KEY,
  VIEW_AS_RETURN_TO_KEY
} from "@/components/admin/ViewAsBanner";

/**
 * Click-through from an admin feed row to the item itself: starts a view-as
 * session for the row's business (same POST + sessionStorage bookkeeping as
 * ViewAsButton) and lands on the item's page in the tenant dashboard —
 * the messages thread, flow run, contact, or the exact alert. The banner's
 * Exit returns the admin to the feed they clicked from.
 */
export function ViewAsItemLink({
  businessId,
  href,
  className,
  children
}: {
  businessId: string;
  /** Tenant-dashboard destination (e.g. /dashboard/messages/+1602…). */
  href: string;
  className?: string;
  children: React.ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async () => {
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
      // Exit returns the admin to the feed this click came from (path +
      // query, so see-all filters survive).
      sessionStorage.setItem(
        VIEW_AS_RETURN_TO_KEY,
        window.location.pathname + window.location.search
      );
      window.location.href = href;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start view-as");
      setBusy(false);
    }
  };

  return (
    <span className="min-w-0">
      <button
        type="button"
        onClick={open}
        disabled={busy}
        className={[
          "text-left cursor-pointer disabled:opacity-50",
          className ?? ""
        ].join(" ")}
      >
        {children}
      </button>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </span>
  );
}
