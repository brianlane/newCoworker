"use client";

/**
 * Agency/multi-business switcher: picks which accessible business the
 * dashboard shows. Renders nothing for the common single-business login.
 * Selection POSTs /api/dashboard/active-business (validated server-side
 * against the accessible set) and refreshes the tree so every server
 * component re-resolves against the new cookie.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

export type SwitchableBusiness = {
  businessId: string;
  name: string;
  role: string;
};

export function BusinessSwitcher({
  businesses,
  activeBusinessId
}: {
  businesses: SwitchableBusiness[];
  activeBusinessId: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  if (businesses.length <= 1) return null;

  async function switchTo(businessId: string) {
    if (businessId === activeBusinessId) return;
    setBusy(true);
    try {
      const res = await fetch("/api/dashboard/active-business", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId })
      });
      if (res.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed left-0 right-0 top-0 z-40 border-b border-parchment/10 bg-deep-ink/95 px-4 py-2 backdrop-blur lg:left-56">
      <label className="flex items-center gap-2 text-xs text-parchment/50">
        Business
        <select
          className="rounded-md border border-parchment/20 bg-deep-ink px-2 py-1 text-sm text-parchment focus:border-signal-teal focus:outline-none"
          value={activeBusinessId ?? ""}
          onChange={(e) => switchTo(e.target.value)}
          disabled={busy}
        >
          {businesses.map((b) => (
            <option key={b.businessId} value={b.businessId}>
              {b.name} ({b.role})
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
