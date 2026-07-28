"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";

/**
 * Admin business page: send the owner an onboarding-reminder email listing
 * whatever setup steps they haven't finished (checkout, website knowledge,
 * phone number, unpaid offers/deals).
 *
 * The open items are computed server-side and previewed here BEFORE the click,
 * so an operator can see what the email would say instead of having to send one
 * to find out. `openItems` comes from the same `computeOnboardingNudgeItems`
 * the API route runs, so the two can never describe the checks differently.
 *
 * The preview is a PAGE-LOAD SNAPSHOT and deliberately does not gate the send.
 * The offer and enterprise-deal panels above refresh their own state without
 * re-rendering this server component, so creating an unpaid offer leaves this
 * list stale. Disabling the button on a stale "nothing open" would block a
 * legitimate nudge for the offer just created. The route recomputes on every
 * request and is the authority: it refuses to send when nothing is open, and
 * the items it returns replace the snapshot below once we hear back.
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
  /** Authoritative items from the last send; null until we've sent once. */
  const [confirmedItems, setConfirmedItems] = useState<string[] | null>(null);

  const items = confirmedItems ?? openItems;
  const stale = confirmedItems === null;

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
      setConfirmedItems(json.data.items.map((item) => item.label));
      setMessage(
        json.data.sent
          ? `Reminder sent (${json.data.items.length} open item${json.data.items.length === 1 ? "" : "s"}).`
          : "Nothing to nudge about. Onboarding looks complete, so no email was sent."
      );
    } catch {
      setMessage("Network error.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      {items.length === 0 ? (
        <p className="text-xs text-parchment/50">
          {stale
            ? "Onboarding looked complete at page load, so there is probably nothing to nudge about. Send anyway to re-check: no email goes out if every step is done."
            : "Onboarding is complete: nothing to nudge this owner about."}
        </p>
      ) : (
        <div className="space-y-1">
          <p className="text-xs text-parchment/40">
            {stale
              ? "At page load, the reminder email would ask them to:"
              : "The reminder covered:"}
          </p>
          <ul className="space-y-0.5">
            {items.map((item) => (
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
