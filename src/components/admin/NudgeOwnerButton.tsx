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
 * The preview deliberately does not gate the send. The offer and
 * enterprise-deal panels re-render this card after a create or revoke
 * (`router.refresh()`), so the common way it went stale is closed, but a
 * payment landing by webhook or a second operator in another tab can still
 * move a step to done underneath it. Disabling the button on a stale
 * "nothing open" would block a legitimate nudge. The route recomputes on
 * every request and is the authority: it refuses to send when nothing is
 * open, and the items it returns replace the preview once we hear back.
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
  const sent = confirmedItems !== null;

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
          Onboarding is complete: nothing to nudge this owner about.
        </p>
      ) : (
        <div className="space-y-1">
          <p className="text-xs text-parchment/40">
            {sent ? "The reminder covered:" : "The reminder email will ask them to:"}
          </p>
          {/* Keyed by position, not by label: two open enterprise deals
              produce the identical "Complete your enterprise plan payment"
              line, and two offers can share a name, so labels are not
              unique. The list is static within a render, so position is a
              safe key. */}
          <ul className="space-y-0.5">
            {items.map((item, index) => (
              <li key={`${index}:${item}`} className="text-xs text-spark-orange">
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
