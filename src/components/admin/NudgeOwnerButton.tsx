"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";

/**
 * Admin business page: send the owner an onboarding-reminder email listing
 * whatever setup steps they haven't finished (checkout, website knowledge,
 * phone number, unpaid offers/deals).
 *
 * The open items are computed server-side and shown here BEFORE the click, so
 * an operator can see exactly what the email would say instead of having to
 * send one to find out. `openItems` comes from the same
 * `computeOnboardingNudgeItems` the API route uses, so the preview and the
 * email can never disagree.
 */
export function NudgeOwnerButton({
  businessId,
  openItems
}: {
  businessId: string;
  openItems: string[];
}) {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const nothingOpen = openItems.length === 0;

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
          : "Nothing to nudge about. Onboarding looks complete."
      );
    } catch {
      setMessage("Network error.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      {nothingOpen ? (
        <p className="text-xs text-parchment/50">
          Onboarding looks complete: nothing to nudge this owner about.
        </p>
      ) : (
        <div className="space-y-1">
          <p className="text-xs text-parchment/40">
            The reminder email would ask them to:
          </p>
          <ul className="space-y-0.5">
            {openItems.map((item) => (
              <li key={item} className="text-xs text-spark-orange">
                • {item}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={nothingOpen}
          onClick={() => void nudge()}
          loading={loading}
        >
          Send onboarding nudge
        </Button>
        {message && <span className="text-xs text-parchment/60">{message}</span>}
      </div>
    </div>
  );
}
