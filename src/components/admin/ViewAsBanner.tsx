"use client";

import { useEffect, useState } from "react";
import { Eye, EyeOff, X } from "lucide-react";

/**
 * Key is per-tab (sessionStorage): hiding the banner lasts for this browser
 * tab only. A new tab shows the banner (and its Exit button) again, and the
 * view-as cookie itself still expires on its own 4h cap. The flag is cleared
 * whenever a view-as session starts (ViewAsButton) or exits (here), so a
 * NEW session in the same tab always gets the banner back.
 */
export const VIEW_AS_BANNER_HIDE_KEY = "admin-view-as-banner-hidden";

/**
 * Sticky banner shown at the top of the owner dashboard while the admin is
 * impersonating a tenant (view-as). Exit clears the cookie server-side and
 * returns to the admin's business detail page. Hide dismisses the banner for
 * this tab's session; without the banner the only ways out of view-as are
 * closing the tab or the cookie's own expiry.
 */
export function ViewAsBanner({
  businessId,
  businessName,
  tier,
  selfOwned = false
}: {
  businessId: string;
  businessName: string;
  tier: string;
  /** Admin viewing their OWN business (HQ): writes are allowed. */
  selfOwned?: boolean;
}) {
  const [exiting, setExiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Read sessionStorage after mount (not in the initializer) so the server
  // and first client render agree and hydration stays clean.
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    if (sessionStorage.getItem(VIEW_AS_BANNER_HIDE_KEY) === "1") setHidden(true);
  }, []);

  const exit = async () => {
    setExiting(true);
    setError(null);
    try {
      // Navigate only after the cookie is actually cleared — otherwise the
      // next /dashboard visit would silently still be impersonating.
      const res = await fetch("/api/admin/view-as", { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      sessionStorage.removeItem(VIEW_AS_BANNER_HIDE_KEY);
      window.location.href = `/admin/${businessId}`;
    } catch {
      setError("Couldn't exit view-as; try again.");
      setExiting(false);
    }
  };

  const hide = () => {
    sessionStorage.setItem(VIEW_AS_BANNER_HIDE_KEY, "1");
    setHidden(true);
  };

  if (hidden) return null;

  return (
    <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-claw-green/50 bg-claw-green/10 px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <Eye className="h-4 w-4 shrink-0 text-claw-green" />
        <span className="truncate text-parchment">
          Viewing as <span className="font-semibold">{businessName}</span>
          <span className="ml-1.5 text-parchment/50 uppercase text-xs tracking-wider">
            {tier}
          </span>
          <span className="ml-2 text-parchment/40 text-xs">
            {selfOwned
              ? "your own business — changes are enabled"
              : "account & billing changes are disabled"}
          </span>
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {error && <span className="text-xs text-red-400">{error}</span>}
        <button
          onClick={hide}
          title="Hide this banner for this tab; exit view-as by closing the tab or reopening the dashboard in a new one"
          className="flex shrink-0 items-center gap-1 rounded-md border border-parchment/20 px-2.5 py-1 text-xs font-medium text-parchment/60 hover:bg-parchment/10 transition-colors"
        >
          <EyeOff className="h-3 w-3" />
          Hide
        </button>
        <button
          onClick={exit}
          disabled={exiting}
          className="flex shrink-0 items-center gap-1 rounded-md border border-claw-green/40 px-2.5 py-1 text-xs font-medium text-claw-green hover:bg-claw-green/20 disabled:opacity-50 transition-colors"
        >
          <X className="h-3 w-3" />
          {exiting ? "Exiting…" : "Exit view-as"}
        </button>
      </div>
    </div>
  );
}
