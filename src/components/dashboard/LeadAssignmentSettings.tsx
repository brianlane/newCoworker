"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/Card";

/**
 * Employees-page card for the lead assignment mode (Truly feedback Issue 7).
 * OFF (default): offer-and-claim, the next roster member in rotation is
 * texted an offer and accepts with "1", so a lead is never silently assigned
 * to someone unavailable. ON: the rotation pick is assigned immediately with
 * an FYI text; Tasks shows the lead as assigned instead of Unclaimed.
 */
export function LeadAssignmentSettings({
  businessId,
  initialLeadAutoAssign,
  soloOwner = false
}: {
  businessId: string;
  initialLeadAutoAssign: boolean;
  /**
   * True when the roster is exactly one ACTIVE member who is provably the
   * business owner. Routing then keeps every lead with them directly (no
   * offer, no claim), so the card says the toggle matters once a teammate
   * exists. The rest of this card's copy is legacy hardcoded English; the
   * new string lives in the catalogs per the i18n rule.
   */
  soloOwner?: boolean;
}) {
  const t = useTranslations("dashboard.leadAssignment");
  const [autoAssign, setAutoAssign] = useState(initialLeadAutoAssign);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const toggle = async (next: boolean) => {
    setBusy(true);
    setStatus(null);
    const prev = autoAssign;
    setAutoAssign(next);
    try {
      const res = await fetch("/api/business/lead-auto-assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, leadAutoAssign: next })
      });
      const json = (await res.json()) as { ok: boolean; error?: { message: string } };
      if (!json.ok) throw new Error(json.error?.message ?? "Save failed");
      setStatus("Saved.");
    } catch (e) {
      setAutoAssign(prev);
      setStatus(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <h2 className="text-sm font-semibold text-parchment mb-2">Lead assignment</h2>
      <label className="flex items-start gap-3 text-sm text-parchment/80">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={autoAssign}
          disabled={busy}
          onChange={(ev) => toggle(ev.target.checked)}
        />
        <span>
          Assign new leads automatically (round robin)
          <span className="block text-xs text-parchment/40 mt-1">
            When on, each new lead is assigned straight to the next available employee in
            rotation, they get a text with the details and the lead shows as theirs
            immediately. When off (default), the employee is offered the lead and accepts by
            replying &quot;1&quot;, so a lead is never assigned to someone who can&apos;t take
            it right now. Rotation, working hours, and time off are respected either way.
          </span>
        </span>
      </label>
      {soloOwner && <p className="mt-2 text-xs text-parchment/40">{t("soloHint")}</p>}
      {status && <p className="mt-2 text-xs text-parchment/50">{status}</p>}
    </Card>
  );
}
