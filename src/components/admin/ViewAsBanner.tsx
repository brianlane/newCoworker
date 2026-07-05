"use client";

import { useState } from "react";
import { Eye, X } from "lucide-react";

/**
 * Sticky banner shown at the top of the owner dashboard while the admin is
 * impersonating a tenant (view-as). Exit clears the cookie server-side and
 * returns to the admin's business detail page.
 */
export function ViewAsBanner({
  businessId,
  businessName,
  tier
}: {
  businessId: string;
  businessName: string;
  tier: string;
}) {
  const [exiting, setExiting] = useState(false);

  const exit = async () => {
    setExiting(true);
    try {
      await fetch("/api/admin/view-as", { method: "DELETE" });
    } finally {
      // Even if the DELETE failed, navigate back — the admin section never
      // honors the cookie, and it expires on its own.
      window.location.href = `/admin/${businessId}`;
    }
  };

  return (
    <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-spark-orange/50 bg-spark-orange/10 px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <Eye className="h-4 w-4 shrink-0 text-spark-orange" />
        <span className="truncate text-parchment">
          Viewing as <span className="font-semibold">{businessName}</span>
          <span className="ml-1.5 text-parchment/50 uppercase text-xs tracking-wider">
            {tier}
          </span>
        </span>
      </div>
      <button
        onClick={exit}
        disabled={exiting}
        className="flex shrink-0 items-center gap-1 rounded-md border border-spark-orange/40 px-2.5 py-1 text-xs font-medium text-spark-orange hover:bg-spark-orange/20 disabled:opacity-50 transition-colors"
      >
        <X className="h-3 w-3" />
        {exiting ? "Exiting…" : "Exit view-as"}
      </button>
    </div>
  );
}
