"use client";

/**
 * Admin billing levers for a live tenant: pause collection, and move the next
 * billing date.
 *
 * Pausing comps the tenant (Stripe voids the invoices it generates) without
 * touching service: the subscription stays active, the box keeps running, and
 * nothing enters the cancellation grace window. Moving the billing date pushes
 * the next charge out, which also restarts the tenant's monthly usage window.
 *
 * Both actions require a Stripe-backed active subscription; the parent card
 * hides the panel otherwise.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";

/** Earliest date the pickers accept: tomorrow, in UTC. */
function tomorrowUtcDate(): string {
  const t = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return t.toISOString().slice(0, 10);
}

/** A `type="date"` value ("2026-09-01") as the UTC-midnight ISO the API wants. */
function dateInputToIso(value: string): string {
  return `${value}T00:00:00.000Z`;
}

export function BillingControlsPanel({
  businessId,
  initialPaused,
  initialResumesAt,
  nextChargeAt
}: {
  businessId: string;
  initialPaused: boolean;
  initialResumesAt: string | null;
  /** Cached Stripe period end, i.e. the current next-charge date. */
  nextChargeAt: string | null;
}) {
  const router = useRouter();
  // Two floors for the two date inputs. The billing-date move is rejected
  // server-side for any date before the paid-through (the M2 guard), so ITS
  // picker mirrors that: the day after the next charge when known, else
  // tomorrow (cosmetic, the server decides). A pause auto-resume has no
  // paid-through rule: resuming INSIDE the current cycle is valid, so its
  // floor stays plain tomorrow.
  const tomorrow = tomorrowUtcDate();
  const paidThroughFloor = nextChargeAt
    ? new Date(Date.parse(nextChargeAt) + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    : null;
  const billingDateMin =
    paidThroughFloor && paidThroughFloor > tomorrow ? paidThroughFloor : tomorrow;

  // Pause / resume
  const [resumeOn, setResumeOn] = useState(initialResumesAt?.slice(0, 10) ?? "");
  const [pauseConfirming, setPauseConfirming] = useState(false);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [pauseErr, setPauseErr] = useState<string | null>(null);
  const [pauseMsg, setPauseMsg] = useState<string | null>(null);

  // Next billing date
  const [nextDate, setNextDate] = useState("");
  const [dateConfirming, setDateConfirming] = useState(false);
  const [dateBusy, setDateBusy] = useState(false);
  const [dateErr, setDateErr] = useState<string | null>(null);
  const [dateMsg, setDateMsg] = useState<string | null>(null);

  async function submitPause(action: "pause" | "resume") {
    setPauseBusy(true);
    setPauseErr(null);
    setPauseMsg(null);
    try {
      const res = await fetch("/api/admin/billing-pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          action,
          resumesAt: action === "pause" && resumeOn ? dateInputToIso(resumeOn) : null
        })
      });
      const json = await res.json();
      if (!res.ok) {
        setPauseErr(json.error?.message ?? "Update failed");
      } else {
        setPauseMsg(action === "pause" ? "Billing paused." : "Billing resumed.");
        router.refresh();
      }
    } catch {
      setPauseErr("Network error");
    } finally {
      setPauseConfirming(false);
      setPauseBusy(false);
    }
  }

  async function submitDate() {
    setDateBusy(true);
    setDateErr(null);
    setDateMsg(null);
    try {
      const res = await fetch("/api/admin/billing-date", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, nextBillingAt: dateInputToIso(nextDate) })
      });
      const json = await res.json();
      if (!res.ok) {
        setDateErr(json.error?.message ?? "Update failed");
      } else {
        setDateMsg("Next billing date moved.");
        setNextDate("");
        router.refresh();
      }
    } catch {
      setDateErr("Network error");
    } finally {
      setDateConfirming(false);
      setDateBusy(false);
    }
  }

  const inputClass =
    "rounded-lg border border-parchment/20 bg-transparent px-3 py-1.5 text-sm text-parchment focus:border-signal-teal focus:outline-none";

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h3 className="text-xs font-medium text-parchment/60">Billing pause</h3>
        {initialPaused ? (
          <p className="text-xs text-parchment/50">
            Collection is paused: Stripe still issues invoices on schedule but voids them, so
            this tenant is comped. Service is untouched.{" "}
            {initialResumesAt ? (
              <>
                Stripe resumes charging on{" "}
                <LocalDateTime iso={initialResumesAt} style="date" />.
              </>
            ) : (
              "There is no auto-resume date, so it stays paused until you resume it."
            )}
          </p>
        ) : (
          <p className="text-xs text-parchment/50">
            Pausing stops the charges without stopping the service: the subscription stays
            active, the box keeps running, and nothing enters the cancellation grace window.
            Invoices generated while paused are voided, so the tenant is comped for that time.
          </p>
        )}

        {initialPaused ? (
          <Button size="sm" onClick={() => submitPause("resume")} loading={pauseBusy}>
            Resume billing
          </Button>
        ) : pauseConfirming ? (
          <div className="space-y-2 rounded-lg border border-spark-orange/30 bg-spark-orange/5 p-3">
            <p className="text-xs text-parchment/70">
              Pause collection on this tenant
              {resumeOn ? ` until ${resumeOn}` : " until you resume it"}? They keep full service
              and are not charged.
            </p>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => submitPause("pause")} loading={pauseBusy}>
                Confirm pause
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setPauseConfirming(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs text-parchment/40" htmlFor="billing-resume-on">
              Auto-resume on (optional)
            </label>
            <input
              id="billing-resume-on"
              type="date"
              min={tomorrow}
              value={resumeOn}
              onChange={(e) => {
                setResumeOn(e.target.value);
                setPauseErr(null);
                setPauseMsg(null);
              }}
              className={inputClass}
            />
            <Button size="sm" variant="secondary" onClick={() => setPauseConfirming(true)}>
              Pause billing
            </Button>
          </div>
        )}
        {pauseMsg && <p className="text-xs text-signal-teal">{pauseMsg}</p>}
        {pauseErr && <p className="text-xs text-spark-orange">{pauseErr}</p>}
      </div>

      <div className="space-y-2 border-t border-parchment/10 pt-4">
        <h3 className="text-xs font-medium text-parchment/60">Next billing date</h3>
        <p className="text-xs text-parchment/50">
          {nextChargeAt ? (
            <>
              Stripe charges next on <LocalDateTime iso={nextChargeAt} style="date" />.{" "}
            </>
          ) : null}
          Moving the date pushes the next charge out and re-anchors the cycle to it, with no
          proration either way. Future dates only. Note that the tenant&apos;s monthly usage
          allowances (voice minutes, AI budget) restart at the new anchor. Contract plans on a
          Stripe schedule have to be adjusted in the Stripe dashboard instead.
        </p>
        {dateConfirming ? (
          <div className="space-y-2 rounded-lg border border-spark-orange/30 bg-spark-orange/5 p-3">
            <p className="text-xs text-parchment/70">
              Move the next charge to {nextDate}? Everything between now and then is comped.
            </p>
            <div className="flex gap-2">
              <Button size="sm" onClick={submitDate} loading={dateBusy}>
                Confirm new date
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setDateConfirming(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="date"
              min={billingDateMin}
              value={nextDate}
              onChange={(e) => {
                setNextDate(e.target.value);
                setDateErr(null);
                setDateMsg(null);
              }}
              className={inputClass}
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={!nextDate}
              onClick={() => setDateConfirming(true)}
            >
              Move billing date
            </Button>
          </div>
        )}
        {dateMsg && <p className="text-xs text-signal-teal">{dateMsg}</p>}
        {dateErr && <p className="text-xs text-spark-orange">{dateErr}</p>}
      </div>
    </div>
  );
}
