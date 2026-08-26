"use client";

/**
 * Admin lever for discounting a membership that is ALREADY being billed:
 * a percentage or a dollar amount off, for one invoice, a number of months, or
 * forever.
 *
 * Distinct from /admin/promotions, which mints promo CODES redeemed at signup
 * and never touches a live subscription. This panel talks to
 * /api/admin/membership-discount, which attaches a Stripe coupon scoped to
 * this tenant's own plan product.
 *
 * The parent card hides the panel unless the subscription is active and
 * Stripe-backed, matching BillingControlsPanel: there is nothing to discount
 * on a row nobody is being charged for.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import {
  DISCOUNT_MAX_MONTHS,
  describeMembershipDiscount,
  type MembershipDiscountDuration,
  type MembershipDiscountState
} from "@/lib/billing/membership-discount";

const DURATION_OPTIONS: Array<{ value: MembershipDiscountDuration; label: string }> = [
  { value: "once", label: "Next invoice only" },
  { value: "repeating", label: "For a number of months" },
  { value: "forever", label: "Every invoice" }
];

export function MembershipDiscountPanel({
  businessId,
  discount
}: {
  businessId: string;
  /** The `subscriptions` mirror columns; all null when nothing is live. */
  discount: MembershipDiscountState;
}) {
  const router = useRouter();
  const live = describeMembershipDiscount(discount);

  const [kind, setKind] = useState<"percent" | "amount">("percent");
  const [percentOff, setPercentOff] = useState("");
  const [amountOffUsd, setAmountOffUsd] = useState("");
  const [duration, setDuration] = useState<MembershipDiscountDuration>("repeating");
  const [months, setMonths] = useState("3");
  const [label, setLabel] = useState("");

  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  function clearFeedback() {
    setErr(null);
    setMsg(null);
  }

  async function submitApply() {
    setBusy(true);
    clearFeedback();
    try {
      const res = await fetch("/api/admin/membership-discount", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          label,
          percentOff: kind === "percent" ? Number(percentOff) : null,
          amountOffUsd: kind === "amount" ? Number(amountOffUsd) : null,
          duration,
          durationInMonths: duration === "repeating" ? Number(months) : null
        })
      });
      const json = await res.json();
      if (!res.ok) {
        setErr(json.error?.message ?? "Could not apply the discount");
      } else {
        setMsg(
          json.data?.summary
            ? `Applied: ${json.data.summary}. It lands on the next invoice.`
            : "Discount applied. It lands on the next invoice."
        );
        setPercentOff("");
        setAmountOffUsd("");
        setLabel("");
        router.refresh();
      }
    } catch {
      setErr("Network error");
    } finally {
      setConfirming(false);
      setBusy(false);
    }
  }

  async function submitRemove() {
    setBusy(true);
    clearFeedback();
    try {
      const res = await fetch("/api/admin/membership-discount", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId })
      });
      const json = await res.json();
      if (!res.ok) {
        setErr(json.error?.message ?? "Could not remove the discount");
      } else {
        setMsg("Discount removed. The next invoice bills at full price.");
        router.refresh();
      }
    } catch {
      setErr("Network error");
    } finally {
      setConfirming(false);
      setBusy(false);
    }
  }

  const inputClass =
    "rounded-lg border border-parchment/20 bg-transparent px-3 py-1.5 text-sm text-parchment focus:border-signal-teal focus:outline-none";

  // The confirm step needs a value in the field it is going to send, a reason
  // (Stripe prints it on the customer's invoice), and a month count when the
  // discount repeats.
  const amountReady = kind === "percent" ? percentOff.trim() !== "" : amountOffUsd.trim() !== "";
  const ready = amountReady && label.trim() !== "" && (duration !== "repeating" || months !== "");

  const preview =
    kind === "percent"
      ? `${percentOff || "0"}% off`
      : `$${amountOffUsd || "0"} off`;
  const previewSpan =
    duration === "forever"
      ? "every invoice"
      : duration === "repeating"
        ? `the next ${months || "0"} ${months === "1" ? "month" : "months"}`
        : "the next invoice";

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-medium text-parchment/60">Membership discount</h3>

      {live ? (
        <div className="space-y-2 rounded-lg border border-signal-teal/30 bg-signal-teal/5 p-3">
          <p className="text-xs text-parchment">
            <span className="font-medium">{live}</span>
            {discount.discount_name ? ` (${discount.discount_name})` : null}
          </p>
          <p className="text-xs text-parchment/50">
            {discount.discount_started_at ? (
              <>
                Applied <LocalDateTime iso={discount.discount_started_at} style="date" />.{" "}
              </>
            ) : null}
            {discount.discount_ends_at ? (
              <>
                Runs out after{" "}
                <LocalDateTime iso={discount.discount_ends_at} style="date" />.
              </>
            ) : null}
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={submitRemove} loading={busy}>
              Remove discount
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-xs text-parchment/50">
          Takes a percentage or a dollar amount off this tenant&apos;s plan, going forward. The
          discount lands on the NEXT invoice: Stripe never credits the cycle they already paid,
          so use force refund for that. It is scoped to the plan line only, so the 10DLC carrier
          fee and the Canadian and Mexican messaging surcharges are still billed in full.
          Applying a second discount replaces the first rather than stacking.
        </p>
      )}

      {!live && confirming && (
        <div className="space-y-2 rounded-lg border border-spark-orange/30 bg-spark-orange/5 p-3">
          <p className="text-xs text-parchment/70">
            Give this tenant {preview} on {previewSpan}? Stripe prints &quot;{label.trim()}&quot;
            on their invoice.
          </p>
          <div className="flex gap-2">
            <Button size="sm" onClick={submitApply} loading={busy}>
              Confirm discount
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {!live && !confirming && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Discount type"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as "percent" | "amount");
                clearFeedback();
              }}
              className={inputClass}
            >
              <option value="percent">Percent off</option>
              <option value="amount">Amount off</option>
            </select>
            {kind === "percent" ? (
              <input
                aria-label="Percent off"
                type="number"
                min={1}
                max={100}
                placeholder="30"
                value={percentOff}
                onChange={(e) => {
                  setPercentOff(e.target.value);
                  clearFeedback();
                }}
                className={`${inputClass} w-24`}
              />
            ) : (
              <input
                aria-label="Amount off in dollars"
                type="number"
                min={1}
                placeholder="40"
                value={amountOffUsd}
                onChange={(e) => {
                  setAmountOffUsd(e.target.value);
                  clearFeedback();
                }}
                className={`${inputClass} w-24`}
              />
            )}
            <select
              aria-label="Discount duration"
              value={duration}
              onChange={(e) => {
                setDuration(e.target.value as MembershipDiscountDuration);
                clearFeedback();
              }}
              className={inputClass}
            >
              {DURATION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {duration === "repeating" && (
              <input
                aria-label="Number of months"
                type="number"
                min={1}
                max={DISCOUNT_MAX_MONTHS}
                value={months}
                onChange={(e) => {
                  setMonths(e.target.value);
                  clearFeedback();
                }}
                className={`${inputClass} w-20`}
              />
            )}
          </div>
          <input
            aria-label="Reason"
            type="text"
            placeholder="Reason, e.g. Retention: August outage credit"
            value={label}
            onChange={(e) => {
              setLabel(e.target.value);
              clearFeedback();
            }}
            className={`${inputClass} w-full`}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={!ready}
            onClick={() => setConfirming(true)}
          >
            Apply discount
          </Button>
        </div>
      )}

      <p className="text-xs text-parchment/30">
        Contract plans on a Stripe schedule have their discounts governed by the schedule phases,
        so those are adjusted in the Stripe dashboard instead. A coupon attached by hand in the
        Stripe dashboard does not show up here either.
      </p>
      {msg && <p className="text-xs text-signal-teal">{msg}</p>}
      {err && <p className="text-xs text-spark-orange">{err}</p>}
    </div>
  );
}
