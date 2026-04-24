/**
 * Cancel/plan-end confirmation sheet opened from the billing page. Two
 * composable modes mirror the lifecycle planner:
 *
 *   - `refund`: immediate cancel + full refund + VPS teardown + 30-day
 *     data-grace. Only offered inside the customer-lifetime 30-day money-
 *     back window AND when the lifetime refund hasn't been used. The
 *     sever-side planner re-verifies both constraints; we just hide the
 *     button when we know it's ineligible.
 *   - `period_end`: keep access until `current_period_end`; at that
 *     boundary the subscription flips to canceled + grace. Does NOT burn
 *     the refund right — if the user later decides to claim the refund
 *     within the lifetime window they still can (until they burn it).
 *
 * Calls `/api/billing/cancel`. Refresh is a hard nav so server-rendered
 * banners (grace) reflect the new state immediately.
 */

"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";

type Mode = "refund" | "period_end";

type Props = {
  open: boolean;
  onClose: () => void;
  canRefund: boolean;
  refundBlockedReason?: string | null;
  periodEnd?: string | null;
  alreadyPeriodEnd: boolean;
  onUndoPeriodEnd?: () => Promise<void> | void;
};

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "end of current period";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric"
    });
  } catch {
    return iso;
  }
}

export function CancelSheet({
  open,
  onClose,
  canRefund,
  refundBlockedReason,
  periodEnd,
  alreadyPeriodEnd,
  onUndoPeriodEnd
}: Props) {
  const [submitting, setSubmitting] = useState<Mode | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  async function handleCancel(mode: Mode) {
    setError(null);
    setSubmitting(mode);
    try {
      const res = await fetch("/api/billing/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode })
      });
      const json = (await res.json().catch(() => null)) as
        | { ok: true; data: unknown }
        | { ok: false; error: { message: string } }
        | null;
      if (!res.ok || !json || json.ok === false) {
        setError(json && json.ok === false ? json.error.message : "Could not cancel");
        setSubmitting(null);
        return;
      }
      window.location.reload();
    } catch {
      setError("Network error");
      setSubmitting(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-deep-ink/70 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-md rounded-xl border border-parchment/10 bg-deep-ink p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-parchment">
            {alreadyPeriodEnd ? "Manage cancellation" : "Cancel subscription"}
          </h2>
          <p className="text-xs text-parchment/60 mt-1">
            {alreadyPeriodEnd ? (
              <>
                Your plan is scheduled to end on{" "}
                <span className="font-mono">{formatDate(periodEnd)}</span>. You can reverse
                this anytime before then, or switch to an immediate refund if you&apos;re still
                within your 30-day window.
              </>
            ) : (
              <>
                Choose how to stop your subscription. These are the only two options —
                prorated refunds are not offered.
              </>
            )}
          </p>
        </div>

        {canRefund ? (
          <div className="rounded-lg border border-claw-green/30 bg-claw-green/5 p-4 space-y-2">
            <p className="text-sm font-semibold text-parchment">Cancel now and refund</p>
            <p className="text-xs text-parchment/60">
              We refund your last charge, shut down your VPS immediately, and keep your
              data for 30 days so you can reactivate without losing anything. This is your
              one-time lifetime refund — it can only be used once.
            </p>
            <Button
              size="sm"
              variant="primary"
              loading={submitting === "refund"}
              disabled={submitting !== null}
              onClick={() => handleCancel("refund")}
            >
              Cancel &amp; refund
            </Button>
          </div>
        ) : (
          <div className="rounded-lg border border-parchment/15 bg-parchment/5 p-4">
            <p className="text-sm font-semibold text-parchment/80">
              Refund option unavailable
            </p>
            <p className="text-xs text-parchment/50 mt-1">
              {refundBlockedReason ??
                "You're past your 30-day money-back window or have already used your lifetime refund."}
            </p>
          </div>
        )}

        {alreadyPeriodEnd ? (
          <div className="rounded-lg border border-parchment/15 bg-parchment/5 p-4 space-y-2">
            <p className="text-sm font-semibold text-parchment">Keep my plan</p>
            <p className="text-xs text-parchment/60">
              Changed your mind? Turn off the scheduled cancellation and your plan will
              renew as normal.
            </p>
            <Button
              size="sm"
              variant="ghost"
              disabled={submitting !== null}
              onClick={() => onUndoPeriodEnd?.()}
            >
              Undo scheduled cancel
            </Button>
          </div>
        ) : (
          <div className="rounded-lg border border-parchment/15 bg-parchment/5 p-4 space-y-2">
            <p className="text-sm font-semibold text-parchment">End at period end</p>
            <p className="text-xs text-parchment/60">
              Keep full access until <span className="font-mono">{formatDate(periodEnd)}</span>.
              On that date we shut down your VPS and start the 30-day data-retention
              window. No refund.
            </p>
            <Button
              size="sm"
              variant="ghost"
              loading={submitting === "period_end"}
              disabled={submitting !== null}
              onClick={() => handleCancel("period_end")}
            >
              Schedule end of period
            </Button>
          </div>
        )}

        {error && (
          <p className="text-xs text-spark-orange" role="alert">
            {error}
          </p>
        )}

        <div className="pt-2 flex justify-end">
          <button
            type="button"
            className="text-xs text-parchment/50 hover:text-parchment underline"
            onClick={onClose}
            disabled={submitting !== null}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
