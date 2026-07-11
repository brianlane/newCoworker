"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";

/**
 * Admin business page: send the owner an onboarding-reminder email listing
 * whatever setup steps they haven't finished (checkout, website knowledge,
 * unpaid offers/deals). The API computes the list server-side; when nothing
 * is open, no email goes out and the button reports that.
 */
export function NudgeOwnerButton({ businessId }: { businessId: string }) {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function nudge() {
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/nudge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId })
      });
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        data?: { sent: boolean; items: Array<{ label: string }> };
        error?: { message?: string };
      } | null;
      if (!res.ok || !json?.ok || !json.data) {
        setMessage(json?.error?.message ?? "Nudge failed.");
        return;
      }
      setMessage(
        json.data.sent
          ? `Reminder sent (${json.data.items.length} open item${json.data.items.length === 1 ? "" : "s"}).`
          : "Nothing to nudge about — onboarding looks complete."
      );
    } catch {
      setMessage("Network error.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button type="button" size="sm" variant="ghost" onClick={() => void nudge()} loading={loading}>
        Send onboarding nudge
      </Button>
      {message && <span className="text-xs text-parchment/60">{message}</span>}
    </div>
  );
}
