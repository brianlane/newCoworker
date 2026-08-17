"use client";

/**
 * Admin controls for a tenant's $400/month priority support add-on.
 *
 * Three actions, and the missing fourth is deliberate:
 *
 *   pay_link  generate the tenant's Checkout URL to send them
 *   comp      grant a coverage window with NO charge, or clear one
 *   cancel    wind the paid subscription down at period end
 *
 * There is no "start billing them now". The card on file was collected under
 * the MEMBERSHIP's subscription mandate, which does not cover starting a
 * second recurring charge on the owner's behalf, so the owner completes
 * Checkout themselves. Same shape as admin-authored white-glove offers.
 *
 * Hardcoded English, matching every other admin panel in this repo.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import type { PrioritySupportStatus } from "@/lib/plans/priority-support";

type Props = {
  businessId: string;
  status: PrioritySupportStatus;
  /** Null for enterprise (permanent) and for tenants with no coverage. */
  daysLeft: number | null;
  coverageUntilIso: string | null;
  /** True when a paid subscription exists and is not winding down. */
  renewing: boolean;
  /** True when a paid subscription exists at all (renewing or winding down). */
  subscribed: boolean;
  priceLabel: string;
};

/** One renderer for the badge, shared with the clients list via statusBadge(). */
export function prioritySupportBadge(status: PrioritySupportStatus, daysLeft: number | null) {
  switch (status) {
    case "permanent":
      return <Badge variant="success">Permanent (Enterprise)</Badge>;
    case "active":
      return <Badge variant="success">{daysLeft}d left</Badge>;
    // `high_load` is the spark-orange amber in this palette; there is no
    // dedicated "warning" variant.
    case "expiring_soon":
      return <Badge variant="high_load">{daysLeft}d left</Badge>;
    case "expired":
      return <Badge variant="offline">Expired</Badge>;
    case "none":
      return <Badge variant="neutral">None</Badge>;
  }
}

export function PrioritySupportPanel({
  businessId,
  status,
  daysLeft,
  coverageUntilIso,
  renewing,
  subscribed,
  priceLabel
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [payUrl, setPayUrl] = useState<string | null>(null);
  const [compUntil, setCompUntil] = useState(coverageUntilIso?.slice(0, 10) ?? "");
  const [cancelConfirming, setCancelConfirming] = useState(false);
  const [clearConfirming, setClearConfirming] = useState(false);

  async function post(body: Record<string, unknown>, okMessage: string) {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/priority-support", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, ...body })
      });
      const json = (await res.json().catch(() => null)) as
        | { ok: true; data: { checkoutUrl?: string } }
        | { ok: false; error: { message: string } }
        | null;
      if (!res.ok || !json || json.ok === false) {
        setErr(json && json.ok === false ? json.error.message : "Request failed");
        return;
      }
      if (json.data?.checkoutUrl) setPayUrl(json.data.checkoutUrl);
      setMsg(okMessage);
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        {prioritySupportBadge(status, daysLeft)}
        <span className="text-xs text-parchment/50">
          {subscribed
            ? renewing
              ? `Paid subscription, renews at ${priceLabel}/month`
              : "Paid subscription, winding down at period end"
            : status === "none"
              ? "No coverage"
              : "Comped or lapsed window, no paid subscription"}
        </span>
      </div>

      {status === "permanent" ? (
        <p className="text-xs text-parchment/50">
          Enterprise tenants hold a permanent priority window, so there is nothing to sell or
          comp here.
        </p>
      ) : (
        <>
          {/* Pay link */}
          <div className="space-y-2">
            <p className="text-xs text-parchment/50">
              Generate a Checkout link for the owner to pay. We cannot start the charge for
              them: the card on file is under the membership mandate only.
            </p>
            <Button
              onClick={() => post({ action: "pay_link" }, "Pay link generated")}
              disabled={busy || subscribed}
            >
              Generate {priceLabel}/month pay link
            </Button>
            {payUrl && (
              <input
                readOnly
                value={payUrl}
                onFocus={(e) => e.currentTarget.select()}
                className="w-full rounded-md border border-parchment/15 bg-deep-ink/60 px-2 py-1 text-xs text-parchment"
              />
            )}
          </div>

          {/* Comp */}
          <div className="space-y-2 border-t border-parchment/10 pt-3">
            <label className="block text-xs text-parchment/50">
              Comp a coverage window (no charge)
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="date"
                value={compUntil}
                onChange={(e) => setCompUntil(e.target.value)}
                className="rounded-md border border-parchment/15 bg-deep-ink/60 px-2 py-1 text-sm text-parchment"
              />
              <Button
                onClick={() =>
                  post(
                    { action: "comp", compUntil: `${compUntil}T00:00:00.000Z` },
                    "Coverage window set"
                  )
                }
                disabled={busy || !compUntil}
              >
                Set window
              </Button>
              {clearConfirming ? (
                <>
                  <span className="text-xs text-parchment/70">
                    Clear the window? Coverage ends immediately.
                  </span>
                  <Button
                    variant="danger"
                    onClick={() => {
                      setClearConfirming(false);
                      void post({ action: "comp", compUntil: null }, "Coverage window cleared");
                    }}
                    disabled={busy}
                  >
                    Clear
                  </Button>
                  <Button onClick={() => setClearConfirming(false)} disabled={busy}>
                    Keep
                  </Button>
                </>
              ) : (
                <Button variant="ghost" onClick={() => setClearConfirming(true)} disabled={busy}>
                  Clear window
                </Button>
              )}
            </div>
          </div>

          {/* Cancel the paid subscription */}
          {subscribed && renewing && (
            <div className="space-y-2 border-t border-parchment/10 pt-3">
              {cancelConfirming ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-parchment/70">
                    Stop renewal? They keep the days already paid for.
                  </span>
                  <Button
                    variant="danger"
                    onClick={() => {
                      setCancelConfirming(false);
                      void post({ action: "cancel" }, "Renewal stopped");
                    }}
                    disabled={busy}
                  >
                    Stop renewal
                  </Button>
                  <Button onClick={() => setCancelConfirming(false)} disabled={busy}>
                    Keep it
                  </Button>
                </div>
              ) : (
                <Button variant="ghost" onClick={() => setCancelConfirming(true)} disabled={busy}>
                  Stop renewal
                </Button>
              )}
            </div>
          )}
        </>
      )}

      {err && <p className="text-xs text-spark-orange">{err}</p>}
      {msg && <p className="text-xs text-claw-green">{msg}</p>}
    </div>
  );
}
