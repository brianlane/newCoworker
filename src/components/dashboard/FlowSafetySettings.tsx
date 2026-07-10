"use client";

import { useState } from "react";
import { Card } from "@/components/ui/Card";

/**
 * Settings card for AiFlow safety preferences. Currently one toggle:
 * staff-contact tag protection — whether automation `update_contact` steps
 * may write lead-state tags ("New Lead", "Engaged", ...) on owner/employee
 * contacts. Protection defaults ON; the classic trap it prevents is a
 * teammate testing a flow with their own number and ending up tagged as a
 * lead on the Contacts page.
 */
export function FlowSafetySettings({
  businessId,
  initialProtectStaffContacts
}: {
  businessId: string;
  initialProtectStaffContacts: boolean;
}) {
  const [protectStaff, setProtectStaff] = useState(initialProtectStaffContacts);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const toggle = async (next: boolean) => {
    setBusy(true);
    setStatus(null);
    const prev = protectStaff;
    setProtectStaff(next);
    try {
      const res = await fetch("/api/business/flow-safety", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, protectStaffContacts: next })
      });
      const json = (await res.json()) as { ok: boolean; error?: { message: string } };
      if (!json.ok) throw new Error(json.error?.message ?? "Save failed");
      setStatus("Saved.");
    } catch (e) {
      setProtectStaff(prev);
      setStatus(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <h2 className="text-sm font-semibold text-parchment mb-2">Automation safety</h2>
      <label className="flex items-start gap-3 text-sm text-parchment/80">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={protectStaff}
          disabled={busy}
          onChange={(ev) => toggle(ev.target.checked)}
        />
        <span>
          Protect team contacts from automation tags
          <span className="block text-xs text-parchment/40 mt-1">
            When on (recommended), AiFlow &quot;update the contact&apos;s tags&quot; steps skip the
            owner and roster employees, so lead-status tags like &quot;New Lead&quot; never land on
            your team — for example when a teammate tests a flow with their own number. Turn off
            only if you intentionally run automations over your own team&apos;s contacts.
          </span>
        </span>
      </label>
      {status && <p className="mt-2 text-xs text-parchment/50">{status}</p>}
    </Card>
  );
}
