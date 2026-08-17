"use client";

/**
 * Priority support add-on card (Dashboard, Billing).
 *
 * Dumb client, same contract as PlanCard: every eligibility decision and all
 * the date math is done server-side and arrives as props. This component only
 * renders the state it is handed and dispatches to the billing route.
 *
 * The four states it can be in:
 *   none     never had it        -> "Add priority support"
 *   renewing paying, auto-renews -> countdown + "Cancel renewal"
 *   winding  canceled, still on  -> countdown + "Restart"
 *   lapsed   window closed       -> "Restart"
 *
 * Enterprise never renders this card at all (their window is permanent and
 * free); the billing page keeps its existing permanent copy for them.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

export type PrioritySupportCardState = "none" | "renewing" | "winding_down" | "lapsed";

type Props = {
  state: PrioritySupportCardState;
  /** Null when there is no countdown to show (state "none"). */
  daysLeft: number | null;
  /** Localized coverage end date, already formatted server-side. */
  coverageEndsLabel: string | null;
  /** Formatted price, e.g. "$400". Server-side so the catalog stays one source. */
  priceLabel: string;
  /** True when days left is at or under the low threshold: render amber. */
  lowDays: boolean;
  /**
   * Operator contact channels, shown only while coverage is open. A customer
   * paying $400/month has to be told HOW to reach priority support; unset
   * channels simply do not render, and the fallback copy covers the rest.
   */
  contact: { email: string | null; phone: string | null; bookingUrl: string | null };
};

export function PrioritySupportCard({
  state,
  daysLeft,
  coverageEndsLabel,
  priceLabel,
  lowDays,
  contact
}: Props) {
  const t = useTranslations("dashboard.billing.prioritySupport");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Two-step confirm on the destructive action, matching BillingControlsPanel.
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  const covered = state === "renewing" || state === "winding_down";

  async function post() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/billing/priority-support", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      const json = (await res.json().catch(() => null)) as
        | { ok: true; data: { checkoutUrl?: string; resumed?: boolean } }
        | { ok: false; error: { message: string } }
        | null;
      if (!res.ok || !json || json.ok === false) {
        setError(json && json.ok === false ? json.error.message : t("startFailed"));
        setBusy(false);
        return;
      }
      // Restarting a subscription that was merely winding down resumes it in
      // place: no Checkout, no new charge, so there is nothing to redirect to.
      if (!json.data.checkoutUrl) {
        window.location.reload();
        return;
      }
      window.location.assign(json.data.checkoutUrl);
    } catch {
      setError(t("startFailed"));
      setBusy(false);
    }
  }

  async function cancel() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/billing/priority-support", { method: "DELETE" });
      const json = (await res.json().catch(() => null)) as
        | { ok: true }
        | { ok: false; error: { message: string } }
        | null;
      if (!res.ok || !json || json.ok === false) {
        setError(json && json.ok === false ? json.error.message : t("cancelFailed"));
        setBusy(false);
        return;
      }
      window.location.reload();
    } catch {
      setError(t("cancelFailed"));
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="text-sm font-semibold text-parchment uppercase tracking-wider">
        {t("title")}
      </h2>

      {covered ? (
        <div className="mt-2 space-y-1">
          {/* A null countdown means we have no usable end date yet (the
              subscription was just created and Stripe has not reported a
              period end). Render the state without a number rather than
              falling back to 0, which would read as "expires today". */}
          {daysLeft !== null && (
            <p
              className={`text-sm font-semibold ${lowDays ? "text-amber-400" : "text-claw-green"}`}
            >
              {daysLeft <= 0 ? t("endsToday") : t("daysLeft", { days: daysLeft })}
              {coverageEndsLabel ? (
                <span className="ml-1 font-normal text-parchment/50">
                  {t("through", { date: coverageEndsLabel })}
                </span>
              ) : null}
            </p>
          )}
          <p className="text-xs text-parchment/60">
            {state === "renewing" ? t("renews", { price: priceLabel }) : t("endsOn")}
          </p>
        </div>
      ) : (
        <div className="mt-2 space-y-1">
          <p className="text-xs text-parchment/70">{t("blurb")}</p>
          {state === "lapsed" && <p className="text-xs text-parchment/50">{t("lapsed")}</p>}
          <p className="text-xs text-parchment/50">{t("terms", { price: priceLabel })}</p>
        </div>
      )}

      {covered && (
        <div className="mt-4 border-t border-parchment/10 pt-3">
          <p className="text-xs uppercase tracking-wider text-parchment/40">{t("reachUs")}</p>
          {contact.email || contact.phone || contact.bookingUrl ? (
            <div className="mt-1 space-y-1 text-sm">
              {contact.email && (
                <p>
                  <a href={`mailto:${contact.email}`} className="text-claw-green hover:underline">
                    {contact.email}
                  </a>
                </p>
              )}
              {contact.phone && (
                <p>
                  <a href={`tel:${contact.phone}`} className="text-claw-green hover:underline">
                    {contact.phone}
                  </a>
                </p>
              )}
              {contact.bookingUrl && (
                <p>
                  <a
                    href={contact.bookingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-claw-green hover:underline"
                  >
                    {t("bookCall")}
                  </a>
                </p>
              )}
            </div>
          ) : (
            <p className="mt-1 text-xs text-parchment/50">{t("reachFallback")}</p>
          )}
        </div>
      )}

      {error && <p className="mt-3 text-xs text-red-400">{error}</p>}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {state === "renewing" ? (
          confirmingCancel ? (
            <>
              <p className="w-full text-xs text-parchment/70">{t("cancelConfirm")}</p>
              <Button onClick={cancel} disabled={busy} variant="danger">
                {t("cancel")}
              </Button>
              <Button onClick={() => setConfirmingCancel(false)} disabled={busy}>
                {t("keepGoing")}
              </Button>
            </>
          ) : (
            <Button onClick={() => setConfirmingCancel(true)} disabled={busy} variant="ghost">
              {t("cancel")}
            </Button>
          )
        ) : (
          <Button onClick={post} disabled={busy}>
            {state === "none" ? t("add", { price: priceLabel }) : t("restart")}
          </Button>
        )}
      </div>
    </Card>
  );
}
